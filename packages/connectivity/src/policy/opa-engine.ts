import { spawnSync } from "node:child_process";
import {
	allowDecision,
	createUsageEvent,
	denyDecision,
	type MeteringBus,
	type PolicyDecision,
	type PolicyEngine,
	type PolicyRequest,
} from "@hobo/core";
import {
	cloneAsJson,
	isJsonBoolean,
	isJsonObject,
	type JsonObject,
	type JsonValue,
} from "../json.js";

import {
	evaluateRegoLite,
	HOBO_DEFAULT_POLICY_DOCUMENT,
	type RegoLiteDocument,
} from "./rego-lite.js";

// public-contract: engine id for the OPA/Rego PolicyEngine adapter.
export const OPA_POLICY_ENGINE_ID = "hobo.policy.opa-rego/v1" as const;

export interface OpaPolicyEngineOptions {
	readonly metering?: MeteringBus;
	/**
	 * OPA REST data URL that accepts POST { input } → { result: { allow?: bool, reasons?: string[] } }.
	 * Example: http://127.0.0.1:8181/v1/data/hobo/authz/allow
	 */
	readonly opaUrl?: string;
	readonly fetchImpl?: typeof fetch;
	/** Inline Rego package path for `opa eval` CLI (optional). */
	readonly regoPackage?: string;
	readonly regoModulePath?: string;
	readonly opaBin?: string;
	/**
	 * In-process JSON policy document (rego-lite). Used when OPA HTTP/CLI
	 * unavailable. Default: HOBO_DEFAULT_POLICY_DOCUMENT.
	 */
	readonly policyDocument?: RegoLiteDocument;
	/**
	 * In-process fallback evaluator used when OPA is unavailable.
	 * Default: rego-lite document + require:* tag checks.
	 */
	readonly fallback?: (request: PolicyRequest) => PolicyDecision;
}

/**
 * OPA/Rego PolicyEngine adapter.
 * Prefers HTTP to a running OPA; falls back to `opa eval` CLI; then in-process
 * rego-lite document evaluation (tenant-aware, auditable).
 */
export function createOpaPolicyEngine(
	options: OpaPolicyEngineOptions = {},
): PolicyEngine {
	const fetchImpl = options.fetchImpl ?? fetch;
	const fallback =
		options.fallback ??
		((request: PolicyRequest) =>
			defaultRegoLikeEval(request, options.policyDocument));

	return {
		engineId: OPA_POLICY_ENGINE_ID,
		async evaluate(request: PolicyRequest): Promise<PolicyDecision> {
			let decision: PolicyDecision | null = null;

			if (options.opaUrl) {
				try {
					const res = await fetchImpl(options.opaUrl, {
						method: "POST",
						headers: { "content-type": "application/json" },
						body: JSON.stringify({ input: toOpaInput(request) }),
					});
					if (res.ok) {
						// SAFETY: assertion required at this I/O or test boundary.
						const body = (await res.json()) as {
							result?:
								| boolean
								| {
										allow?: boolean;
										reasons?: string[];
										obligations?: string[];
								  };
						};
						decision = fromOpaResult(request, cloneAsJson(body.result));
					}
				} catch {
					// fall through
				}
			}

			if (decision === null && options.regoModulePath) {
				decision = evalViaOpaCli(request, {
					bin: options.opaBin ?? "opa",
					modulePath: options.regoModulePath,
					packagePath: options.regoPackage ?? "data.hobo.authz",
				});
			}

			if (decision === null) {
				decision = fallback(request);
			}

			if (options.metering) {
				await options.metering.emit(
					createUsageEvent({
						tenantId: request.subject.tenantId,
						eventType: "policy.evaluate",
						resource: `${request.resource.kind}:${request.resource.id}`,
						metadata: {
							effect: decision.effect,
							action: request.action,
							engineId: OPA_POLICY_ENGINE_ID,
						},
					}),
				);
			}
			return decision;
		},
	};
}

function toOpaInput(request: PolicyRequest): JsonObject {
	const json = cloneAsJson({
		subject: {
			identity: request.subject.identity,
			tenant_id: request.subject.tenantId,
			tags: [...request.subject.tags],
			attributes: { ...request.subject.attributes },
		},
		action: request.action,
		resource: {
			kind: request.resource.kind,
			id: request.resource.id,
			tenant_id: request.resource.tenantId,
			tags: [...(request.resource.tags ?? [])],
			attributes: { ...request.resource.attributes },
		},
		context: request.context ?? {},
	});
	return isJsonObject(json) ? json : {};
}

function fromOpaResult(
	request: PolicyRequest,
	result: JsonValue,
): PolicyDecision {
	if (isJsonBoolean(result)) {
		return result
			? allowDecision(OPA_POLICY_ENGINE_ID, request, ["opa:allow"])
			: denyDecision(OPA_POLICY_ENGINE_ID, request, ["opa:deny"]);
	}
	if (result && isJsonObject(result)) {
		// SAFETY: assertion required at this I/O or test boundary.
		const obj = result as {
			allow?: boolean;
			reasons?: string[];
			obligations?: string[];
		};
		if (obj.allow === true) {
			return allowDecision(
				OPA_POLICY_ENGINE_ID,
				request,
				obj.reasons ?? ["opa:allow"],
				obj.obligations,
			);
		}
		return denyDecision(
			OPA_POLICY_ENGINE_ID,
			request,
			obj.reasons ?? ["opa:deny"],
		);
	}
	return denyDecision(OPA_POLICY_ENGINE_ID, request, ["opa:empty-result"]);
}

function evalViaOpaCli(
	request: PolicyRequest,
	opts: { bin: string; modulePath: string; packagePath: string },
): PolicyDecision | null {
	const inputJson = JSON.stringify(toOpaInput(request));
	const result = spawnSync(
		opts.bin,
		[
			"eval",
			"-f",
			"json",
			"-d",
			opts.modulePath,
			"-I",
			`${opts.packagePath}.allow`,
		],
		{
			encoding: "utf8",
			input: inputJson,
		},
	);
	if (result.status !== 0) return null;
	try {
		// SAFETY: assertion required at this I/O or test boundary.
		const parsed = JSON.parse(result.stdout) as {
			result?: readonly { expressions?: readonly { value?: unknown }[] }[];
		};
		const value = parsed.result?.[0]?.expressions?.[0]?.value;
		return fromOpaResult(request, cloneAsJson(value));
	} catch {
		return null;
	}
}

/**
 * In-process fallback: rego-lite document + require:* resource tag checks.
 */
export function defaultRegoLikeEval(
	request: PolicyRequest,
	document?: RegoLiteDocument,
): PolicyDecision {
	const required = (request.resource.tags ?? []).filter((t) =>
		t.startsWith("require:"),
	);
	const missing = required.filter(
		(tag) => !request.subject.tags.includes(tag.slice("require:".length)),
	);
	if (missing.length > 0) {
		return denyDecision(OPA_POLICY_ENGINE_ID, request, [
			`rego-lite: missing tags ${missing.join(", ")}`,
		]);
	}

	if (
		request.action.endsWith(".admin") &&
		!request.subject.tags.includes("role:admin")
	) {
		return denyDecision(OPA_POLICY_ENGINE_ID, request, [
			"rego-lite: role:admin required for *.admin",
		]);
	}

	return evaluateRegoLite(
		document ?? HOBO_DEFAULT_POLICY_DOCUMENT,
		request,
		OPA_POLICY_ENGINE_ID,
	);
}

/** Sample Rego module string operators can drop into OPA. */
export const SAMPLE_HOBO_AUTHZ_REGO = `package hobo.authz

default allow := false

allow if {
  input.subject.tenant_id == input.resource.tenant_id
}

allow if {
  input.resource.attributes.shared == "true"
}

allow if {
  "shared:true" in input.resource.tags
}
`;
