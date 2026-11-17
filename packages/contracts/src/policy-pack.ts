import { mustGet } from "@hobo/core/total-access";
import {
	createDecision,
	createDecisionRequest,
	createPolicyDecidedEvent,
	POLICY_DECIDED_EVENT_TYPE,
	POLICY_IR_SCHEMA_VERSION,
} from "@hobo/policy";
import { isJsonString, type JsonObject } from "./json.js";

export const POLICY_PACK_ENGINE_ID = "hobo.contracts/policy-pack@0.1.0";

export type PolicyEffect =
	| "allow"
	| "allow-degraded"
	| "deny"
	| "warn"
	| "mutate"
	| "require-approval";

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

	const outcomes: { rule: PolicyRule; outcome: PolicyRuleOutcome }[] = [];
	for (const rule of pack.rules) {
		try {
			const applies = rule.when(input.request);
			if (applies === false) continue;
			if (applies !== true) throw new Error("invalid policy predicate");
			const outcome = rule.decide(input.request);
			if (
				!outcome ||
				!EFFECT_RANK.has(outcome.effect) ||
				!isJsonString(outcome.reason) ||
				outcome.reason.trim() === ""
			)
				throw new Error("invalid policy outcome");
			const validated = createDecision(request, {
				effect: outcome.effect,
				reason: outcome.reason,
				obligations: outcome.obligations ?? [],
				violations: outcome.violations ?? [],
				evidence: { policyIds: [rule.id], engine: POLICY_PACK_ENGINE_ID },
			});
			if (!validated.violations.every(isJsonString))
				throw new Error("invalid policy violations");
			outcomes.push({
				rule,
				outcome: {
					effect: validated.effect,
					reason: validated.reason,
					obligations: validated.obligations,
					violations: validated.violations,
				},
			});
		} catch {
			outcomes.push({
				rule,
				outcome: {
					effect: "deny",
					reason: `policy rule ${rule.id} could not be evaluated`,
					violations: [`policy-rule-evaluation-failed:${rule.id}`],
				},
			});
		}
	}
	const matched = outcomes.map(({ rule }) => rule);

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
	return EFFECT_RANK.get(effect) ?? mustGet(EFFECT_RANK, "deny");
}
