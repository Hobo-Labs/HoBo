// `createCdAuthorizer` (WP19, D15, I10): every mutating CdAction is decided by
// the CD baseline pack (one rule per action) composed with the Station's
// policy pack, most-restrictive-wins, through `@hobo/contracts`'
// `evaluatePolicyPack` — the same evaluator the Gatekeeper runs. Every
// decision, allow or deny, is recorded before it is returned; a decision that
// cannot be recorded is a refusal (fail closed).
//
// Command → event: `authorize(action, subject, ctx)` is the command; the
// recorded `policy.Decided` event on the resource's decision stream is its
// only effect. `readDecisions` is the read-side projection over the event
// store (no snapshot is needed: decision streams are per resource and short).
import { createHash } from "node:crypto";
import {
	evaluatePolicyPack,
	type PolicyDecisionRequest,
	type PolicyPack,
} from "@hobo/contracts";
import {
	type DurableEventStore,
	EventStoreError,
	type JsonObject,
	type JsonValue,
	type PrincipalRef,
} from "@hobo/core";
import { CD_DEFAULTS } from "../events.js";
import type {
	CdAction,
	CdAuthorizer,
	CdBase,
	CdContext,
	Outcome,
	TelemetrySink,
} from "../ports.js";
import { CD_METRICS } from "../telemetry/semconv.js";
import { authzRefusal } from "./errors.js";
import {
	AUTHZ_DECIDED_EVENT,
	AUTHZ_DECISION_SCHEMA,
	AUTHZ_STREAMS,
	type AuthzDecision,
	type AuthzEffect,
	authzDecisionJson,
	isGrant,
	parseAuthzDecision,
} from "./events.js";
import {
	agentGrantScope,
	CD_ACTION_SPECS,
	CD_BASELINE_PACK_ID,
	type CdActionSpec,
	cdBaselineRules,
	isCdAction,
	policyActionName,
} from "./rules.js";

// public-contract: authorization metric names.
export const AUTHZ_METRICS = Object.freeze({
	decisions: CD_METRICS.authzDecisions,
	refusals: CD_METRICS.authzRefusals,
});

/** Agent grants: principal id → actions it may perform outright (ADR-0094). */
export type AgentGrants = Readonly<Record<string, readonly (CdAction | "*")[]>>;

export type CdAuthorizerDeps = CdBase &
	Readonly<{
		policyPack: PolicyPack;
		agentGrants?: AgentGrants;
		/** R14 separation of duties for enrollment; default `CD_DEFAULTS`. */
		separateEnrollmentApprovers?: boolean;
		telemetry?: TelemetrySink;
	}>;

export type CdDecisionAuthorizer = CdAuthorizer &
	Readonly<{
		/** Recorded decisions for one governed resource, oldest first. */
		decisions(
			resource: Readonly<{ kind: string; id: string }>,
		): Promise<readonly AuthzDecision[]>;
	}>;

const APPEND_ATTEMPTS = 3;
const SECRET_MEMBER = /secret|token|password|passwd|credential|private/iu;

export function principalKey(principal: PrincipalRef): string {
	return `${principal.kind}:${principal.id}`;
}

function agentClass(principal: PrincipalRef | undefined): boolean {
	let current = principal;
	while (current !== undefined) {
		if (current.kind === "agent") return true;
		current = current.delegatedBy;
	}
	return false;
}

function canonical(value: JsonValue | undefined): string {
	if (value === undefined) return "null";
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	const keys = Object.keys(value).sort();
	return `{${keys
		.map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
		.join(",")}}`;
}

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Drop secret-looking members (I9); records stay secret-free. */
function scrub(subject: JsonObject): { clean: JsonObject; redacted: string[] } {
	const redacted: string[] = [];
	const walk = (value: JsonValue, path: string): JsonValue => {
		if (value === null || typeof value !== "object") return value;
		if (Array.isArray(value))
			return value.map((v, i) => walk(v, `${path}[${i}]`));
		const out: Record<string, JsonValue> = {};
		for (const key of Object.keys(value).sort()) {
			const member = value[key];
			if (member === undefined) continue;
			const at = path === "" ? key : `${path}.${key}`;
			if (SECRET_MEMBER.test(key)) {
				redacted.push(at);
				continue;
			}
			out[key] = walk(member, at);
		}
		return out;
	};
	const clean = walk(subject, "");
	return {
		clean:
			clean !== null && typeof clean === "object" && !Array.isArray(clean)
				? clean
				: {},
		redacted,
	};
}

function resourceOf(
	s: CdActionSpec,
	subject: JsonObject,
): { kind: string; id: string } {
	for (const key of s.resourceKeys) {
		const value = subject[key];
		if (typeof value === "string" && value !== "")
			return { kind: s.resourceKind, id: value };
	}
	// No identifying member: the resource is the subject itself.
	return {
		kind: s.resourceKind,
		id: `sha256:${sha256Hex(canonical(subject))}`,
	};
}

function grantedScopes(
	grants: AgentGrants | undefined,
	principal: PrincipalRef,
): string[] {
	const actions = grants?.[principal.id] ?? [];
	return actions.map((a) => agentGrantScope(a));
}

export function createCdAuthorizer(d: CdAuthorizerDeps): CdDecisionAuthorizer {
	const separate =
		d.separateEnrollmentApprovers ?? CD_DEFAULTS.enrollmentSeparateApprovers;
	const pack: PolicyPack = {
		id: d.policyPack.id,
		version: d.policyPack.version,
		rules: [...cdBaselineRules(), ...d.policyPack.rules],
	};

	function metric(
		name: string,
		atMs: number,
		attributes: Readonly<Record<string, string>>,
	): void {
		if (!d.telemetry) return;
		d.telemetry
			.metrics([
				{ name, kind: "counter", value: 1, unit: "1", atMs, attributes },
			])
			.catch(() => undefined);
	}

	async function history(
		store: DurableEventStore,
		streamId: string,
	): Promise<{ seq: number; decisions: AuthzDecision[] }> {
		let seq = 0;
		const decisions: AuthzDecision[] = [];
		for await (const event of store.read(streamId)) {
			seq = event.seq;
			if (event.type !== AUTHZ_DECIDED_EVENT) continue;
			// SAFETY: journal bodies are JSON; parseAuthzDecision narrows them.
			const parsed = parseAuthzDecision(event.data as JsonValue);
			if (parsed) decisions.push(parsed);
		}
		return { seq, decisions };
	}

	async function record(
		streamId: string,
		decision: AuthzDecision,
		actor: PrincipalRef,
	): Promise<boolean> {
		for (let attempt = 0; attempt < APPEND_ATTEMPTS; attempt += 1) {
			const { seq } = await history(d.store, streamId);
			try {
				await d.store.append(
					streamId,
					[
						{
							type: AUTHZ_DECIDED_EVENT,
							data: authzDecisionJson(decision),
							meta: { idempotencyKey: decision.decisionId },
						},
					],
					{ expectedSeq: seq, actor, tenant: d.tenant },
				);
				return true;
			} catch (error) {
				if (
					error instanceof EventStoreError &&
					error.code === "OPTIMISTIC_SEQUENCE_CONFLICT"
				)
					continue;
				return false;
			}
		}
		return false;
	}

	async function authorize(
		action: CdAction,
		subject: JsonObject,
		ctx: CdContext,
	): Promise<Outcome<Readonly<{ decisionId: string; proposalOnly: boolean }>>> {
		const atMs = ctx.now();
		if (!isCdAction(action)) {
			metric(AUTHZ_METRICS.refusals, atMs, {
				reason: "cd-authz-unknown-action",
			});
			return authzRefusal(
				"cd-authz-unknown-action",
				`${String(action)} is not a CdAction`,
				String(action),
			);
		}
		if (ctx.tenant !== d.tenant) {
			metric(AUTHZ_METRICS.refusals, atMs, {
				action,
				reason: "cd-authz-tenant-mismatch",
			});
			return authzRefusal(
				"cd-authz-tenant-mismatch",
				`authorizer serves tenant ${d.tenant}, request names ${ctx.tenant}`,
				action,
			);
		}
		const s = CD_ACTION_SPECS[action];
		const who = principalKey(ctx.principal);
		const { clean, redacted } = scrub(subject);
		const resource = resourceOf(s, clean);
		const streamId = AUTHZ_STREAMS.resource(resource.kind, resource.id);

		let counterpartHolders: string[] = [];
		try {
			if (s.separateFrom !== undefined) {
				const { decisions } = await history(d.store, streamId);
				counterpartHolders = decisions
					.filter((x) => x.action === s.separateFrom && isGrant(x))
					.map((x) => x.principal);
			}
		} catch {
			metric(AUTHZ_METRICS.refusals, atMs, {
				action,
				reason: "cd-authz-unrecorded",
			});
			return authzRefusal(
				"cd-authz-unrecorded",
				`decision history for ${resource.kind} ${resource.id} is unreadable`,
				action,
			);
		}

		const request: PolicyDecisionRequest = {
			subject: {
				kind: ctx.principal.kind,
				id: ctx.principal.id,
				scopes: grantedScopes(d.agentGrants, ctx.principal),
			},
			action: policyActionName(action),
			resource,
			phase: s.phase,
			context: {
				tenant: d.tenant,
				subject: clean,
				cd: {
					agentClass: agentClass(ctx.principal),
					counterpartHolders,
					principalKey: who,
					separateEnrollmentApprovers: separate,
				},
			},
		};

		let effect: AuthzEffect;
		let reason: string;
		let policyIds: string[];
		let inputHash: string;
		let violations: readonly JsonValue[] = [];
		let policyError = false;
		try {
			const evaluation = evaluatePolicyPack({ request, pack });
			effect = evaluation.decision.effect;
			reason = evaluation.decision.reason;
			policyIds = [...evaluation.decision.evidence.policyIds];
			inputHash = evaluation.decision.evidence.inputHash;
			violations = evaluation.decision.violations;
		} catch (error) {
			policyError = true;
			effect = "deny";
			reason = `policy evaluation failed: ${error instanceof Error ? error.message : String(error)}`;
			policyIds = [`${CD_BASELINE_PACK_ID}/${action}`];
			inputHash = `sha256:${sha256Hex(canonical(request.context))}`;
		}
		const proposalOnly = effect === "require-approval";
		const decisionId = `authz_${sha256Hex(
			canonical({
				action,
				principal: who,
				resource,
				subject: clean,
				atMs,
				tenant: d.tenant,
			}),
		).slice(0, 32)}`;
		const decision: AuthzDecision = {
			schemaVersion: AUTHZ_DECISION_SCHEMA,
			decisionId,
			action,
			principal: who,
			effect,
			proposalOnly,
			reason,
			resource,
			decidedAt: new Date(atMs).toISOString(),
			policyIds,
			packId: pack.id,
			packVersion: pack.version,
			inputHash,
			subject: clean,
			redacted,
		};

		const recorded = await record(streamId, decision, ctx.principal).catch(
			() => false,
		);
		if (!recorded) {
			metric(AUTHZ_METRICS.refusals, atMs, {
				action,
				reason: "cd-authz-unrecorded",
			});
			return authzRefusal(
				"cd-authz-unrecorded",
				`decision ${decisionId} for ${action} could not be recorded`,
				decisionId,
			);
		}
		metric(AUTHZ_METRICS.decisions, atMs, {
			action,
			effect,
			"principal.kind": ctx.principal.kind,
		});
		if (effect === "deny") {
			const code = policyError
				? "cd-authz-policy-error"
				: violations.includes("separation-of-duties")
					? "separation-of-duties"
					: "cd-authz-denied";
			metric(AUTHZ_METRICS.refusals, atMs, { action, reason: code });
			return authzRefusal(
				code,
				`${who} may not ${action}: ${reason}`,
				decisionId,
			);
		}
		return { ok: true, value: { decisionId, proposalOnly } };
	}

	return {
		authorize,
		async decisions(resource) {
			const { decisions } = await history(
				d.store,
				AUTHZ_STREAMS.resource(resource.kind, resource.id),
			);
			return decisions;
		},
	};
}
