import type { GatekeeperEffect, PolicyDecisionRequest } from "@hobo/contracts";

import {
	isJsonArray,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

export type { JsonObject, JsonValue } from "./json.js";

// The OPA/Rego policy engine behind the broker's gate-plane port, extracted
// from `@hobo/broker` (the broker re-exports this
// adapter, so `createOpaGatePlane` keeps its original import surface). Rego
// is the broker's first-class external policy language
// (contracts-policy-flags.md: the policy-engine port genuinely accepts
// OPA/Rego and Cedar providers; the in-proc TypeScript policy pack stays the
// default). This adapter maps the broker's Policy IR decision request onto an
// OPA `input` document, queries the OPA Data API decision at
// `hobo/broker/decision`, and lowers the Rego result back onto the
// engine-neutral gate decision.
//
// The types below are STRUCTURAL mirrors of the broker's gate-plane port
// (`@hobo/broker` planes.ts) — declared here so the dependency points
// provider→contracts only and the broker can depend on this package without
// a cycle. TypeScript's structural typing keeps them assignable.
//
// The Rego decision document contract (see docs/design/hobo-broker.md
// §Policy languages for the reference policy):
//   input:  { request: <Policy IR decision request>, costQuota: {...} }
//   result: { effect: "allow"|"allow-degraded"|"deny"|"require-approval",
//             reasons: [{ code, message, plane? }], policyIds?: [string] }
//
// Fail-closed: transport errors, non-200s, and undefined results DENY with
// `policy-engine-unavailable` — an unreachable policy engine never allows.

// public-contract: the Rego decision path the broker queries on the OPA Data API.
export const OPA_DECISION_PATH = "hobo/broker/decision";
// public-contract: the engine id recorded on OPA-evaluated policy.Decided facts.
export const OPA_ENGINE_ID = "opa/rego@v1";

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

export type OpaInputDocument = {
	readonly input: {
		readonly request: PolicyDecisionRequest;
		readonly costQuota: CostQuota;
	};
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

export interface OpaGatePlaneOptions {
	endpoint: string;
	fetchFn: PolicyEngineFetch;
	decisionPath?: string;
	// Resolves the OPA credential out of the token broker when the sidecar or
	// remote OPA requires one; never a raw secret held here.
	tokenProvider?: () => Promise<string> | string;
}

export function buildOpaInput(input: {
	request: PolicyDecisionRequest;
	costQuota: CostQuota;
}): OpaInputDocument {
	return { input: { request: input.request, costQuota: input.costQuota } };
}

function isGateEffect(value: string): value is GatekeeperEffect {
	switch (value) {
		case "allow":
		case "allow-degraded":
		case "deny":
		case "require-approval":
			return true;
		default:
			return false;
	}
}

function isPolicyEnginePlane(value: string): value is PolicyEnginePlane {
	switch (value) {
		case "policy":
		case "contracts":
		case "billing":
		case "placement":
		case "connectors":
		case "residency":
			return true;
		default:
			return false;
	}
}

function stringIds(value: JsonValue | undefined): string[] {
	if (!isJsonArray(value)) return [];
	const ids: string[] = [];
	for (const id of value) {
		if (isJsonString(id)) ids.push(id);
	}
	return ids;
}

function unavailable(message: string): PolicyEngineDecision {
	return {
		effect: "deny",
		reasons: [
			{
				plane: "policy",
				code: "policy-engine-unavailable",
				message,
			},
		],
		events: [],
	};
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
		engine: OPA_ENGINE_ID,
		policyIds: [...policyIds],
		subject: policySubject(request.subject),
		action: request.action,
		resource: {
			kind: request.resource.kind,
			id: request.resource.id,
		},
	};
}

// Parse-don't-validate over the untrusted Rego result: only well-formed
// reasons survive, and an unknown effect fails closed to deny.
function parseRegoResult(
	raw: JsonValue | undefined,
	request: PolicyDecisionRequest,
): PolicyEngineDecision {
	if (!isJsonObject(raw)) {
		return unavailable("the Rego decision returned no result document");
	}
	const effectValue = raw.effect;
	const effect =
		isJsonString(effectValue) && isGateEffect(effectValue)
			? effectValue
			: "deny";
	const reasons: PolicyEngineReason[] = [];
	if (isJsonArray(raw.reasons)) {
		for (const entry of raw.reasons) {
			if (!isJsonObject(entry)) continue;
			const code = entry.code;
			if (!isJsonString(code) || code.length === 0) continue;
			const planeValue = entry.plane;
			const messageValue = entry.message;
			reasons.push({
				plane:
					isJsonString(planeValue) && isPolicyEnginePlane(planeValue)
						? planeValue
						: "policy",
				code,
				message:
					isJsonString(messageValue) && messageValue.length > 0
						? messageValue
						: code,
			});
		}
	}
	if (effect === "deny" && reasons.length === 0) {
		reasons.push({
			plane: "policy",
			code: "policy-denied",
			message: "denied by the Rego decision with no reason document",
		});
	}
	const policyIds = stringIds(raw.policyIds);
	return {
		effect,
		reasons,
		events: [policyDecidedEvent(effect, policyIds, request)],
	};
}

export function createOpaGatePlane(
	options: OpaGatePlaneOptions,
): PolicyEnginePlanePort {
	const decisionPath = options.decisionPath ?? OPA_DECISION_PATH;
	const url = `${options.endpoint.replace(/\/$/u, "")}/v1/data/${decisionPath}`;
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
					body: JSON.stringify(buildOpaInput(input)),
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return unavailable(`OPA transport failed: ${message}`);
			}
			if (response.status !== 200) {
				return unavailable(`OPA Data API returned HTTP ${response.status}`);
			}
			const body = await response.json();
			if (!isJsonObject(body)) {
				return parseRegoResult(undefined, input.request);
			}
			return parseRegoResult(body.result, input.request);
		},
	};
}
