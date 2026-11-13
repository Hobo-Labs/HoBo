import type { GatekeeperEffect, PolicyDecisionRequest } from "@hobo/contracts";

import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

export type { JsonObject, JsonValue } from "./json.js";

// The Cedar policy engine behind the same gate-plane port the Rego adapter
// uses, extracted from `@hobo/broker` (the broker
// re-exports this adapter, so `createCedarGatePlane` keeps its original
// import surface). contracts-policy-flags.md names Cedar as the ABAC-style
// external language beside OPA/Rego. The broker maps its Policy IR decision
// request onto a Cedar authorization request (principal / action / resource /
// context) against the cedar-agent `is_authorized` API, and lowers the
// Allow/Deny verdict onto the engine-neutral gate decision.
//
// The types below are STRUCTURAL mirrors of the broker's gate-plane port —
// declared here so the dependency points provider→contracts only and the
// broker can depend on this package without a cycle.
//
// Fail-closed: transport errors and non-200s DENY with
// `policy-engine-unavailable`, exactly like the OPA adapter — an unreachable
// policy engine never allows.

// public-contract: the engine id recorded on Cedar-evaluated policy.Decided facts.
export const CEDAR_ENGINE_ID = "cedar@v1";

// Structural mirror of the broker's RejectionPlane union.
export type PolicyEnginePlane =
	| "policy"
	| "contracts"
	| "billing"
	| "placement"
	| "connectors"
	| "residency";

// Structural mirror of the broker's RejectionReason.
export interface PolicyEngineReason {
	plane: PolicyEnginePlane;
	code: string;
	message: string;
}

export type PolicyDecidedEvent = JsonObject;

// Structural mirror of the broker's GateDecision.
export interface PolicyEngineDecision {
	effect: GatekeeperEffect;
	reasons: PolicyEngineReason[];
	events: PolicyDecidedEvent[];
}

export type CostQuota = { quota: string; used: number; limit: number };

export type CedarAuthorizationRequest = {
	readonly principal: string;
	readonly action: string;
	readonly resource: string;
	readonly context: JsonObject;
};

export type PolicyEngineHeaders = { readonly [key: string]: string };

export interface PolicyEngineResponse {
	status: number;
	json(): Promise<JsonValue>;
}

// Structural mirror of the broker's GatePlane port.
export interface PolicyEnginePlanePort {
	evaluate(input: {
		request: PolicyDecisionRequest;
		costQuota: CostQuota;
	}): PolicyEngineDecision | Promise<PolicyEngineDecision>;
}

// Structural mirror of the broker's FetchLike (injected transport — the
// adapter never reaches for a global fetch).
export type PolicyEngineFetch = (
	url: string,
	init: {
		method: string;
		headers: PolicyEngineHeaders;
		body: string;
	},
) => Promise<PolicyEngineResponse>;

export interface CedarGatePlaneOptions {
	endpoint: string;
	fetchFn: PolicyEngineFetch;
	// Resolves the engine credential out of the token broker; never a raw
	// secret held here.
	tokenProvider?: () => Promise<string> | string;
}

function cedarEntity(kind: string, id: string): string {
	const type = kind.length > 0 ? kind[0]?.toUpperCase() + kind.slice(1) : "Any";
	return `${type}::"${id}"`;
}

function jsonObjectFromContext(
	context: PolicyDecisionRequest["context"],
): JsonObject {
	if (context === undefined) return {};
	const entries: Array<[string, JsonValue]> = [];
	for (const [key, value] of Object.entries(context)) {
		// SAFETY: policy context is JSON-serializable at the Cedar wire boundary.
		entries.push([key, value as JsonValue]);
	}
	return Object.fromEntries(entries);
}

export function buildCedarRequest(input: {
	request: PolicyDecisionRequest;
	costQuota: CostQuota;
}): CedarAuthorizationRequest {
	return {
		principal: cedarEntity(
			input.request.subject.kind,
			input.request.subject.id,
		),
		action: `Action::"${input.request.action}"`,
		resource: cedarEntity(
			input.request.resource.kind,
			input.request.resource.id,
		),
		context: {
			phase: input.request.phase,
			...jsonObjectFromContext(input.request.context),
			costQuota: input.costQuota,
		},
	};
}

function unavailable(message: string): PolicyEngineDecision {
	return {
		effect: "deny",
		reasons: [{ plane: "policy", code: "policy-engine-unavailable", message }],
		events: [],
	};
}

function stringIds(value: JsonValue | undefined): string[] {
	if (!isJsonArray(value)) return [];
	const ids: string[] = [];
	for (const id of value) {
		if (isJsonString(id)) ids.push(id);
	}
	return ids;
}

function policySubject(subject: PolicyDecisionRequest["subject"]): JsonObject {
	return {
		kind: subject.kind,
		id: subject.id,
		...(subject.roles === undefined
			? undefined
			: { roles: [...subject.roles] }),
		...(subject.scopes === undefined
			? undefined
			: { scopes: [...subject.scopes] }),
	};
}

function policyDecidedEvent(
	effect: GatekeeperEffect,
	policyIds: readonly string[],
	request: PolicyDecisionRequest,
): PolicyDecidedEvent {
	return {
		type: "policy.Decided",
		effect,
		engine: CEDAR_ENGINE_ID,
		policyIds: [...policyIds],
		subject: policySubject(request.subject),
		action: request.action,
		resource: {
			kind: request.resource.kind,
			id: request.resource.id,
		},
	};
}

export function createCedarGatePlane(
	options: CedarGatePlaneOptions,
): PolicyEnginePlanePort {
	const url = `${options.endpoint.replace(/\/$/u, "")}/v1/is_authorized`;
	return {
		async evaluate(input) {
			const token = options.tokenProvider
				? await options.tokenProvider()
				: undefined;
			let response: PolicyEngineResponse;
			try {
				response = await options.fetchFn(url, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						...(token !== undefined
							? { authorization: `Bearer ${token}` }
							: undefined),
					},
					body: JSON.stringify(buildCedarRequest(input)),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return unavailable(`Cedar transport failed: ${message}`);
			}
			if (response.status !== 200) {
				return unavailable(`Cedar engine returned HTTP ${response.status}`);
			}
			// Parse-don't-validate over the untrusted verdict: only an explicit
			// "Allow" allows; anything else fails closed to deny.
			const body = await response.json();
			const document = isJsonObject(body) ? body : {};
			const allow = document.decision === "Allow";
			const diagnostics = isJsonObject(document.diagnostics)
				? document.diagnostics
				: undefined;
			const policyIds = stringIds(diagnostics?.reason);
			const effect: PolicyEngineDecision["effect"] = allow ? "allow" : "deny";
			return {
				effect,
				reasons: allow
					? []
					: [
							{
								plane: "policy",
								code: "policy-denied",
								message:
									policyIds.length > 0
										? `denied by Cedar policies ${policyIds.join(", ")}`
										: "denied by the Cedar authorization decision",
							},
						],
				events: [policyDecidedEvent(effect, policyIds, input.request)],
			};
		},
	};
}
