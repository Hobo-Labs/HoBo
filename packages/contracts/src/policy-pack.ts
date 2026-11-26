import { mustGet } from "@hobo/core/total-access";
import {
	createDecision,
	createDecisionRequest,
	createPolicyDecidedEvent,
	POLICY_DECIDED_EVENT_TYPE,
	POLICY_IR_SCHEMA_VERSION,
} from "@hobo/policy";
import type { JsonObject } from "./json.js";

// This module COMPOSES @hobo/policy — it does not reimplement the policy engine.
// @hobo/policy owns the decision model (the Policy IR: request/decision/effect/
// obligations/evidence + the `policy.Decided` event). Here a small policy-pack
// evaluator runs a set of typed TypeScript rules over a decision request and
// LOWERS the outcome onto @hobo/policy's `createDecision` / `createPolicyDecided
// Event`, so every deploy — even one a permissive default pack allows — records a
// `policy.Decided` fact (governed-by-default without blocking, FR-051/NFR-017).

export const POLICY_PACK_ENGINE_ID = "hobo.contracts/policy-pack@0.1.0";

export type PolicyEffect =
	| "allow"
	| "allow-degraded"
	| "deny"
	| "warn"
	| "mutate"
	| "require-approval";

// Most-restrictive-wins ordering shared with the Gatekeeper composition.
export const EFFECT_RANK: ReadonlyMap<string, number> = new Map([
	["deny", 0],
	["require-approval", 1],
	["allow-degraded", 2],
	["warn", 3],
	["mutate", 4],
	["allow", 5],
]);

export interface PolicyDecisionRequest {
	subject: { kind: string; id: string; roles?: string[]; scopes?: string[] };
	action: string;
	resource: { kind: string; id: string };
	phase: string;
	context?: JsonObject;
}

export interface PolicyRuleOutcome {
	effect: PolicyEffect;
	reason: string;
	obligations?: Array<JsonObject>;
	violations?: string[];
}

export interface PolicyRule {
	id: string;
	when: (request: PolicyDecisionRequest) => boolean;
	decide: (request: PolicyDecisionRequest) => PolicyRuleOutcome;
}

export interface PolicyPack {
	id: string;
	version: string;
	rules: PolicyRule[];
}

export interface PolicyEvaluation {
	decision: ReturnType<typeof createDecision>;
	event: ReturnType<typeof createPolicyDecidedEvent>;
	matchedRuleIds: string[];
}

// The permissive default pack: no rules, so every request lands on `allow`, yet
// still produces a recorded `policy.Decided` — the "governed by default without
// blocking" default the design requires of every deploy.
export function createPermissiveDefaultPack(): PolicyPack {
	return { id: "hobo.default/permissive", version: "1.0.0", rules: [] };
}

export function definePolicyRule(rule: PolicyRule): PolicyRule {
	return rule;
}

export function evaluatePolicyPack(input: {
	request: PolicyDecisionRequest;
	pack?: PolicyPack;
}): PolicyEvaluation {
	const pack = input.pack ?? createPermissiveDefaultPack();
	const request = createDecisionRequest({
		schemaVersion: POLICY_IR_SCHEMA_VERSION,
		subject: input.request.subject,
		action: input.request.action,
		resource: input.request.resource,
		phase: input.request.phase,
		context: input.request.context ?? {},
	});

	const matched = pack.rules.filter((rule) => safeMatch(rule, input.request));
	const outcomes = matched.map((rule) => ({
		rule,
		outcome: rule.decide(input.request),
	}));

	// Most-restrictive-wins: the lowest-ranked effect across matching rules is the
	// pack's effect; an empty pack yields `allow`.
	const winning = outcomes.reduce<{
		rule: PolicyRule;
		outcome: PolicyRuleOutcome;
	} | null>((worst, current) => {
		if (worst === null) return current;
		return rank(current.outcome.effect) < rank(worst.outcome.effect)
			? current
			: worst;
	}, null);

	const effect: PolicyEffect = winning?.outcome.effect ?? "allow";
	const reason =
		winning?.outcome.reason ??
		`permitted by policy pack ${pack.id}@${pack.version} (no rule denied)`;
	const obligations = outcomes.flatMap(
		({ outcome }) => outcome.obligations ?? [],
	);
	const violations = outcomes.flatMap(
		({ outcome }) => outcome.violations ?? [],
	);
	const policyIds =
		matched.length > 0
			? matched.map((rule) => rule.id)
			: [`${pack.id}:default-allow`];

	const decision = createDecision(request, {
		effect,
		reason,
		violations,
		obligations,
		evidence: {
			engine: POLICY_PACK_ENGINE_ID,
			policyIds,
			packId: pack.id,
			packVersion: pack.version,
		},
	});

	const event = createPolicyDecidedEvent({ request, decision });

	return { decision, event, matchedRuleIds: matched.map((rule) => rule.id) };
}

export { POLICY_DECIDED_EVENT_TYPE };

function rank(effect: string): number {
	return EFFECT_RANK.get(effect) ?? mustGet(EFFECT_RANK, "allow");
}

function safeMatch(rule: PolicyRule, request: PolicyDecisionRequest): boolean {
	try {
		return rule.when(request) === true;
	} catch {
		return false;
	}
}
