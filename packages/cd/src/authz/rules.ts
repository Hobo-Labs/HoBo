// The CD baseline policy pack (D15, I10): exactly one `@hobo/contracts` policy
// rule per `CdAction`. Each rule is pure over the decision request the
// authorizer builds, so a decision replays from its recorded input (I8).
//
// What the baseline decides (most-restrictive-wins with the caller's pack):
//   - Agent principals — or any principal delegated by an agent — are
//     proposal-only (`require-approval`) unless granted the action
//     (`cd:<action>` or `cd:*` scope; ADR-0094). `failover.propose` is itself
//     a proposal, so an agent may make it without a grant.
//   - The two enrollment grants (`reconciler.approve-key`,
//     `reconciler.accept`) must come from separate principals (R14, I24):
//     the principal that holds one grant for a reconciler is denied the other.
//   - Everything else is allowed by the baseline and left to the caller's pack.
import {
	definePolicyRule,
	type PolicyDecisionRequest,
	type PolicyPack,
	type PolicyRule,
	type PolicyRuleOutcome,
} from "@hobo/contracts";
import type { CdAction } from "../ports.js";
import { isJsonObject, isText } from "./json.js";

// public-contract: the policy-IR phases a CD action is evaluated in.
export type CdPolicyPhase = "apply" | "promote" | "runtime" | "repair";

export type CdActionSpec = Readonly<{
	action: CdAction;
	phase: CdPolicyPhase;
	/** Policy resource kind (`cd.<noun>`). Decisions are recorded per resource. */
	resourceKind: string;
	/** Subject members that identify the resource, first non-empty wins. */
	resourceKeys: readonly string[];
	/** Whether an ungranted agent may perform the action outright. */
	agentMayAct: boolean;
	/** The other half of a separation-of-duties pair, when there is one. */
	separateFrom: CdAction | undefined;
}>;

function spec(
	action: CdAction,
	phase: CdPolicyPhase,
	resourceKind: string,
	resourceKeys: readonly string[],
	extra: Readonly<{ agentMayAct?: boolean; separateFrom?: CdAction }> = {},
): CdActionSpec {
	return Object.freeze({
		action,
		phase,
		resourceKind,
		resourceKeys: Object.freeze([...resourceKeys]),
		agentMayAct: extra.agentMayAct ?? false,
		separateFrom: extra.separateFrom,
	});
}

// public-contract: one spec per CdAction. `Record<CdAction, …>` makes a new
// frozen CdAction a compile error here until it has a rule.
export const CD_ACTION_SPECS: Readonly<Record<CdAction, CdActionSpec>> =
	Object.freeze({
		"freight.record": spec("freight.record", "promote", "cd.freight", [
			"freightId",
			"bindle",
		]),
		"freight.yank": spec("freight.yank", "promote", "cd.freight", [
			"freightId",
		]),
		"freight.approve": spec("freight.approve", "promote", "cd.freight", [
			"freightId",
		]),
		"publisher.trust": spec("publisher.trust", "apply", "cd.publisher", [
			"publisher",
			"name",
		]),
		"source.define": spec("source.define", "apply", "cd.source", ["name"]),
		"pipeline.apply": spec("pipeline.apply", "apply", "cd.pipeline", [
			"pipeline",
			"name",
		]),
		"window.define": spec("window.define", "apply", "cd.window", [
			"window",
			"name",
		]),
		"window.override": spec("window.override", "promote", "cd.window", [
			"window",
			"name",
		]),
		promote: spec("promote", "promote", "cd.freight", ["freightId"]),
		rollback: spec("rollback", "promote", "cd.camp", ["campId", "freightId"]),
		approve: spec("approve", "promote", "cd.promotion", [
			"promotionId",
			"freightId",
		]),
		"preview.create": spec("preview.create", "promote", "cd.freight", [
			"freightId",
		]),
		"reconciler.enroll": spec("reconciler.enroll", "apply", "cd.campset", [
			"campSet",
		]),
		"reconciler.revoke": spec("reconciler.revoke", "runtime", "cd.reconciler", [
			"reconcilerId",
		]),
		"reconciler.approve-key": spec(
			"reconciler.approve-key",
			"apply",
			"cd.reconciler",
			["reconcilerId"],
			{ separateFrom: "reconciler.accept" },
		),
		"reconciler.accept": spec(
			"reconciler.accept",
			"apply",
			"cd.reconciler",
			["reconcilerId"],
			{ separateFrom: "reconciler.approve-key" },
		),
		"drift.remediate": spec("drift.remediate", "repair", "cd.camp", ["campId"]),
		"campset.define": spec("campset.define", "apply", "cd.campset", [
			"name",
			"campSet",
		]),
		"camp.taint": spec("camp.taint", "runtime", "cd.camp", ["campId"]),
		"camp.untaint": spec("camp.untaint", "runtime", "cd.camp", ["campId"]),
		"camp.manage": spec("camp.manage", "apply", "cd.camp", ["campId"]),
		"placement.define": spec("placement.define", "apply", "cd.placement", [
			"name",
			"placement",
		]),
		"placement.scores": spec("placement.scores", "runtime", "cd.placement", [
			"placement",
			"source",
			"name",
		]),
		"fanout.halt": spec("fanout.halt", "runtime", "cd.fanout", ["fanoutId"]),
		"fanout.resume": spec("fanout.resume", "runtime", "cd.fanout", [
			"fanoutId",
		]),
		"fanout.rollback": spec("fanout.rollback", "runtime", "cd.fanout", [
			"fanoutId",
		]),
		"failover.propose": spec(
			"failover.propose",
			"runtime",
			"cd.camp",
			["sourceCampId", "campId", "failoverId"],
			{ agentMayAct: true },
		),
		"failover.approve": spec("failover.approve", "runtime", "cd.failover", [
			"failoverId",
		]),
		rebalance: spec("rebalance", "runtime", "cd.placement", [
			"placement",
			"name",
		]),
		"posture.enforce": spec("posture.enforce", "repair", "cd.camp", [
			"campId",
			"rail",
		]),
		"rail.promote": spec("rail.promote", "promote", "cd.rail", [
			"rail",
			"bindle",
			"freightId",
		]),
	});

// public-contract: every CdAction, in declaration order.
export const CD_ACTIONS: readonly CdAction[] = Object.freeze(
	Object.values(CD_ACTION_SPECS).map((s) => s.action),
);

// public-contract: policy action names are namespaced (`cd.<action>`).
export const CD_POLICY_ACTION_PREFIX = "cd." as const;

// public-contract: baseline pack identity recorded in every decision's evidence.
export const CD_BASELINE_PACK_ID = "hobo.cd/baseline" as const;
// public-contract: baseline pack version (bump on any rule change).
export const CD_BASELINE_PACK_VERSION = "1.0.0" as const;

// public-contract: grant scope that lets an agent act outright (ADR-0094).
export function agentGrantScope(action: CdAction | "*"): string {
	return `cd:${action}`;
}

export function policyActionName(action: CdAction): string {
	return `${CD_POLICY_ACTION_PREFIX}${action}`;
}

export function isCdAction(value: string): value is CdAction {
	return Object.hasOwn(CD_ACTION_SPECS, value);
}

/** Context members the authorizer adds before evaluation (pure rule input). */
export type CdRuleContext = Readonly<{
	/** True when the principal or any delegator is an agent. */
	agentClass: boolean;
	/** Principals holding the separation-of-duties counterpart grant. */
	counterpartHolders: readonly string[];
	/** The acting principal key (`kind:id`). */
	principalKey: string;
	/** Whether R14 separation of duties is enforced. */
	separateEnrollmentApprovers: boolean;
}>;

function ruleContext(request: PolicyDecisionRequest): CdRuleContext {
	const cd = request.context?.cd;
	const value = isJsonObject(cd) ? cd : {};
	const holders = value.counterpartHolders;
	const principal = value.principalKey;
	return {
		agentClass: value.agentClass === true,
		counterpartHolders: Array.isArray(holders) ? holders.filter(isText) : [],
		principalKey: isText(principal) ? principal : "",
		separateEnrollmentApprovers: value.separateEnrollmentApprovers !== false,
	};
}

function decideFor(
	s: CdActionSpec,
	request: PolicyDecisionRequest,
): PolicyRuleOutcome {
	const ctx = ruleContext(request);
	if (
		s.separateFrom !== undefined &&
		ctx.separateEnrollmentApprovers &&
		ctx.counterpartHolders.includes(ctx.principalKey)
	)
		return {
			effect: "deny",
			reason: `separation of duties: ${ctx.principalKey} already holds ${s.separateFrom} for this reconciler; ${s.action} must come from a different principal (R14)`,
			violations: ["separation-of-duties"],
		};
	const scopes = request.subject.scopes ?? [];
	const granted =
		scopes.includes(agentGrantScope(s.action)) ||
		scopes.includes(agentGrantScope("*"));
	if (ctx.agentClass && !s.agentMayAct && !granted)
		return {
			effect: "require-approval",
			reason: `agent principals may only propose ${s.action} (ADR-0094); grant ${agentGrantScope(s.action)} to let this agent act`,
			obligations: [{ kind: "human-approval", action: s.action }],
		};
	return {
		effect: "allow",
		reason: `${s.action} permitted by the CD baseline`,
	};
}

/** One rule per CdAction, in CD_ACTIONS order. */
export function cdBaselineRules(): PolicyRule[] {
	return CD_ACTIONS.map((action) => {
		const s = CD_ACTION_SPECS[action];
		const name = policyActionName(action);
		return definePolicyRule({
			id: `${CD_BASELINE_PACK_ID}/${action}`,
			when: (request) => request.action === name,
			decide: (request) => decideFor(s, request),
		});
	});
}

export function createCdBaselinePack(): PolicyPack {
	return {
		id: CD_BASELINE_PACK_ID,
		version: CD_BASELINE_PACK_VERSION,
		rules: cdBaselineRules(),
	};
}
