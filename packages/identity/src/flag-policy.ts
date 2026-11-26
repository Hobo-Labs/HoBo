/**
 * Policy-gated flag / rollout mutations (ADR-0044 / ADR-0015 / ADR-0074).
 * Evaluation is high-volume / low-privilege; mutations are policy-gated.
 * Emits policy.Decided-compatible records; production high-risk may require approval.
 */

import { randomUUID } from "node:crypto";
import type { JsonObject, JsonValue } from "./json.js";

// public-contract: flag mutation action for PolicyEngine.
export const FLAG_CHANGE_ACTION = "hobo:flag:change" as const;
// public-contract: rollout start action for PolicyEngine.
export const ROLLOUT_START_ACTION = "hobo:rollout:start" as const;
// public-contract: flag mutation policy decision schema version.
export const FLAG_POLICY_SCHEMA = "hobo.flag-mutation-policy/v1" as const;

export type FlagMutationRiskReason =
	| "prod-kill-switch"
	| "large-percent-jump"
	| "prod-enable"
	| "prod-high-risk-canary"
	| "dev-local";

export type FlagMutationEffect =
	| "allow"
	| "deny"
	| "require-approval"
	| "allow-with-obligation";

export type FlagMutationRequest = Readonly<{
	action: typeof FLAG_CHANGE_ACTION | typeof ROLLOUT_START_ACTION;
	flagKey: string;
	environment: string;
	/** 0–100 intended percentage (when applicable). */
	toPercent?: number;
	fromPercent?: number;
	killSwitch?: boolean;
	enabled?: boolean;
	actor?: string;
	tenant?: string;
}>;

export type FlagMutationObligation = Readonly<{
	kind: "flag.auto-revert-on-slo-burn" | "human-approval" | "canary-required";
	flagKey: string;
	detail?: string;
}>;

export type FlagMutationDecision = Readonly<{
	schemaVersion: typeof FLAG_POLICY_SCHEMA;
	effect: FlagMutationEffect;
	allowed: boolean;
	reason: string;
	riskReasons: readonly FlagMutationRiskReason[];
	obligations: readonly FlagMutationObligation[];
	/** policy.Decided-compatible audit record. */
	policyDecided: Readonly<{
		id: string;
		type: "policy.Decided";
		time: string;
		data: JsonObject;
	}>;
}>;

const PROD_ENVS = new Set(["prod", "production", "prd"]);

/**
 * Classify mutation risk for deny-ceiling / approval composition.
 */
export function classifyFlagMutationRisk(
	req: FlagMutationRequest,
): readonly FlagMutationRiskReason[] {
	const reasons: FlagMutationRiskReason[] = [];
	const isProd = PROD_ENVS.has(req.environment.toLowerCase());
	if (!isProd) {
		reasons.push("dev-local");
		return Object.freeze(reasons);
	}
	if (req.killSwitch === true) reasons.push("prod-kill-switch");
	if (req.enabled === true) reasons.push("prod-enable");
	const from = req.fromPercent ?? 0;
	const to = req.toPercent ?? from;
	const jump = Math.abs(to - from);
	if (jump >= 25) reasons.push("large-percent-jump");
	if (to > 0 && to < 100 && jump >= 10) reasons.push("prod-high-risk-canary");
	return Object.freeze(reasons);
}

/**
 * Gate a flag or rollout mutation. Fail closed on unknown prod risk shapes.
 * Dev/local is always allow (hands-off local DevX).
 */
export function gateFlagMutation(
	req: FlagMutationRequest,
	options?: { readonly now?: () => string },
): FlagMutationDecision {
	const now = options?.now ?? (() => new Date().toISOString());
	const riskReasons = classifyFlagMutationRisk(req);
	const t = now();
	const id = `pol_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

	if (riskReasons.includes("dev-local")) {
		return decide({
			id,
			t,
			req,
			effect: "allow",
			allowed: true,
			reason: "dev/local flag mutation ungated",
			riskReasons,
			obligations: [],
		});
	}

	if (riskReasons.includes("prod-kill-switch")) {
		return decide({
			id,
			t,
			req,
			effect: "require-approval",
			allowed: false,
			reason: "prod kill-switch flip requires human approval",
			riskReasons,
			obligations: [
				Object.freeze({
					kind: "human-approval" as const,
					flagKey: req.flagKey,
					detail: "role=flag-governor",
				}),
			],
		});
	}

	if (
		riskReasons.includes("large-percent-jump") ||
		riskReasons.includes("prod-high-risk-canary")
	) {
		return decide({
			id,
			t,
			req,
			effect: "allow-with-obligation",
			allowed: true,
			reason: "risky percent flip allowed with auto-revert obligation",
			riskReasons,
			obligations: [
				Object.freeze({
					kind: "flag.auto-revert-on-slo-burn" as const,
					flagKey: req.flagKey,
					detail: "trigger=slo.BudgetBurned",
				}),
			],
		});
	}

	if (riskReasons.includes("prod-enable")) {
		return decide({
			id,
			t,
			req,
			effect: "allow",
			allowed: true,
			reason: "ordinary prod enable passed policy",
			riskReasons,
			obligations: [],
		});
	}

	// Fail closed on unclassified production mutation
	return decide({
		id,
		t,
		req,
		effect: "deny",
		allowed: false,
		reason: "unclassified production flag mutation denied (fail-closed)",
		riskReasons,
		obligations: [],
	});
}

export interface FlagDefineInput {
	readonly key: string;
	readonly percentage?: number;
	readonly enabled?: boolean;
	readonly killSwitch?: boolean;
	readonly state?: "ENABLED" | "DISABLED";
	readonly [k: string]: JsonValue | undefined;
}

export interface FlagPolicyDefineInput extends FlagDefineInput {
	readonly environment: string;
	readonly actor?: string;
	readonly tenant?: string;
	readonly approvalSatisfied?: boolean;
}

export interface FlagPolicyDefineResult {
	readonly decision: FlagMutationDecision;
	readonly defined: JsonValue | null;
}

/**
 * Apply store.define only when policy allows (or approval already satisfied).
 */
export function applyPolicyGatedDefine(
	store: {
		define: (input: FlagDefineInput) => JsonValue;
		get: (key: string) => { percentage?: number } | undefined;
	},
	input: FlagPolicyDefineInput,
): FlagPolicyDefineResult {
	const existing = store.get(input.key);
	const decision = gateFlagMutation({
		action: FLAG_CHANGE_ACTION,
		flagKey: input.key,
		environment: input.environment,
		toPercent: input.percentage,
		fromPercent: existing?.percentage,
		killSwitch: input.killSwitch,
		enabled: input.enabled,
		actor: input.actor,
		tenant: input.tenant,
	});

	if (!decision.allowed && !input.approvalSatisfied) {
		return { decision, defined: null };
	}
	if (decision.effect === "require-approval" && !input.approvalSatisfied) {
		return { decision, defined: null };
	}

	const {
		environment: _e,
		actor: _a,
		tenant: _t,
		approvalSatisfied: _ap,
		...rest
	} = input;
	// SAFETY: assertion to `st as Parameters<typeof store.define>[0]);` is required at this boundary.
	const defined = store.define(rest as Parameters<typeof store.define>[0]);
	return { decision, defined };
}

function decide(input: {
	id: string;
	t: string;
	req: FlagMutationRequest;
	effect: FlagMutationEffect;
	allowed: boolean;
	reason: string;
	riskReasons: readonly FlagMutationRiskReason[];
	obligations: readonly FlagMutationObligation[];
}): FlagMutationDecision {
	// SAFETY: frozen decision is FlagMutationDecision at this policy boundary.
	return Object.freeze({
		schemaVersion: FLAG_POLICY_SCHEMA,
		effect: input.effect,
		allowed: input.allowed,
		reason: input.reason,
		riskReasons: input.riskReasons,
		obligations: Object.freeze([...input.obligations]),
		policyDecided: Object.freeze({
			id: input.id,
			type: "policy.Decided" as const,
			time: input.t,
			data: Object.freeze({
				action: input.req.action,
				flagKey: input.req.flagKey,
				environment: input.req.environment,
				effect: input.effect,
				allowed: input.allowed,
				reason: input.reason,
				riskReasons: input.riskReasons,
				obligations: input.obligations,
				...(input.req.actor !== undefined
					? { actor: input.req.actor }
					: undefined),
				...(input.req.tenant !== undefined
					? { tenant: input.req.tenant }
					: undefined),
			}),
		}),
	}) as never;
}
