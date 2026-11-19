
import {
	type BudgetPolicy,
	type BudgetPolicyEvaluationContext,
	evaluateBudgetPolicy,
} from "@hobo/core";
import { decideDispatchV2 } from "@hobo/dispatcher";
import type {
	FleetBinding,
	FleetRole,
	RunnerFinancialModel,
} from "./models.js";
import {
	type RunnerCommercialState,
	runnerQuoteScenario,
	usdToMicrosCeil,
} from "./pricing.js";

export type FleetMemberState = Readonly<{
	model: RunnerFinancialModel;
	enabled: boolean;
	role?: FleetRole;
	concurrency?: number;
	activeJobs: number;
	healthy: boolean;
	commercial: RunnerCommercialState;
	publicRepositoriesEnabled?: boolean;
	payer: string;
	payerExposureMicros: number;
	payerBudgetMicros?: number;
	servesLabels?: readonly string[];
}>;

export type FleetDemand = Readonly<{
	id: string;
	minutes: number;
	repository: Readonly<{
		visibility: "public" | "private";
		ownerType: "organization" | "user";
	}>;
	forkPullRequest: boolean;
	needsDocker: boolean;
	machine?: Readonly<{ vcpus?: number; memoryGb?: number }>;
	isolationRequired: boolean;
	queuedOnLabel?: string;
	queueDurationMs?: number;
	attempt?: number;
}>;

export type FleetBalanceInput = Readonly<{
	members: readonly FleetMemberState[];
	demand: FleetDemand;
	policy: BudgetPolicy;
	exposureMicros: number;
	activeWork: number;
	ceilingMicros?: number;
	now: string;
	allowNewProviderAgreements: boolean;
	phase?: "plan" | "admit";
}>;

export type FleetChoice = Readonly<{
	memberId: string;
	provider: string;
	binding: FleetBinding;
	role: FleetRole;
	runsOn: string;
	incrementalBilledMicros: number;
	usesAllowance: boolean;
	quoteHash: string;
}>;

/**
 * The codes the fleet's own gates refuse a member with: what each means, and
 * whether asking again can help.
 * One list: the gates below can only use a code that is in it, and the docs
 * site's error reference is generated from it. Pricing and budget refusals
 * carry their own engines' codes behind a `pricing.` or `budget.` prefix.
 */
// public-contract: stable refusal codes callers and the docs site rely on.
export const FLEET_REFUSAL_CODES = {
	"fleet.disabled": {
		meaning: "The provider is not enabled in policy",
		retry: "No: enable the provider",
	},
	"fleet.unhealthy": {
		meaning: "The provider's host is critically short of a resource",
		retry: "Yes, when the host recovers",
	},
	"fleet.label-bound": {
		meaning:
			"The job is already queued on a label this provider does not serve",
		retry: "No: the label is fixed once queued",
	},
	"fleet.visibility": {
		meaning:
			"The provider does not serve this repository's visibility, or public repositories are not turned on there",
		retry: "No: a fact about the provider",
	},
	"fleet.organization-only": {
		meaning: "The provider serves organization-owned repositories only",
		retry: "No: a fact about the provider",
	},
	"fleet.docker": {
		meaning: "The job needs Docker and the provider has none",
		retry: "No: a fact about the provider",
	},
	"fleet.fork": {
		meaning: "The provider does not run jobs from forks",
		retry: "No: a fact about the provider",
	},
	"fleet.isolation": {
		meaning: "The job needs its own machine and this provider is shared",
		retry: "No: a fact about the provider",
	},
	"fleet.machine": {
		meaning:
			"The job needs more CPU or memory than this provider's machine class has",
		retry: "No: a fact about the machine class",
	},
	"fleet.runtime": {
		meaning:
			"The job's reserved minutes exceed the longest the provider lets one machine run",
		retry: "No: a fact about the provider",
	},
	"fleet.capacity": {
		meaning: "Every slot is in use",
		retry: "Yes, when a slot frees",
	},
	"fleet.agreement.new-denied": {
		meaning: "Placing the job would open a new paid plan",
		retry: "No: open the plan, or allow it",
	},
	"fleet.payer-budget": {
		meaning:
			"The job would exceed the operator's ceiling for that provider account",
		retry: "No: raise the ceiling or wait for the period",
	},
	"fleet.account-budget": {
		meaning: "The job would exceed the account's ceiling",
		retry: "No: raise the ceiling or wait for the period",
	},
} as const;

export type FleetRefusalCode = keyof typeof FLEET_REFUSAL_CODES;

export type FleetRefusal = Readonly<{
	memberId: string;
	code: string;
	reason: string;
}>;

export type FleetBalance = Readonly<{
	selected: FleetChoice | undefined;
	ranking: readonly FleetChoice[];
	refusals: readonly FleetRefusal[];
}>;

const ROLE_ORDER: readonly FleetRole[] = ["primary", "overflow", "last-resort"];
function roleOf(member: FleetMemberState): FleetRole {
	return member.role ?? member.model.role;
}

function ceilingOf(member: FleetMemberState): number | undefined {
	const authored = member.concurrency;
	const provider = member.model.concurrency;
	if (authored === undefined) return provider;
	if (provider === undefined) return authored;
	return Math.min(authored, provider);
}

function ineligible(
	member: FleetMemberState,
	input: FleetBalanceInput,
): Omit<FleetRefusal, "memberId"> | undefined {
	const { model } = member;
	const { demand } = input;
	const refuse = (code: FleetRefusalCode, reason: string) => ({ code, reason });
	if (!member.enabled)
		return refuse("fleet.disabled", "member is not enabled in policy");
	if (!member.healthy)
		return refuse("fleet.unhealthy", "member's circuit breaker is open");
	if (
		demand.queuedOnLabel !== undefined &&
		demand.queuedOnLabel !== model.runsOn &&
		member.servesLabels?.includes(demand.queuedOnLabel) !== true
	)
		return refuse(
			"fleet.label-bound",
			`job is already queued on ${demand.queuedOnLabel}; this member serves ${model.runsOn}`,
		);
	const { eligibility } = model;
	if (demand.repository.visibility === "public") {
		if (eligibility.publicRepositories === "no")
			return refuse(
				"fleet.visibility",
				"provider does not serve public repositories",
			);
		if (
			eligibility.publicRepositories === "opt-in" &&
			member.publicRepositoriesEnabled !== true
		)
			return refuse(
				"fleet.visibility",
				"public repositories are off at this provider until the owner turns them on",
			);
	} else if (!eligibility.privateRepositories)
		return refuse(
			"fleet.visibility",
			"this machine class serves public repositories only",
		);
	if (
		eligibility.organizationOnly &&
		demand.repository.ownerType !== "organization"
	)
		return refuse(
			"fleet.organization-only",
			"provider serves organization-owned repositories only",
		);
	if (demand.needsDocker && !eligibility.docker)
		return refuse("fleet.docker", "member has no Docker daemon");
	if (demand.forkPullRequest && !eligibility.forkPullRequests)
		return refuse("fleet.fork", "member does not run jobs from forks");
	if (demand.isolationRequired && !eligibility.isolated)
		return refuse(
			"fleet.isolation",
			"job requires a machine nothing else shares; this member is shared",
		);
	const { machine } = model;
	const needs = demand.machine;
	if (needs?.vcpus !== undefined && needs.vcpus > machine.vcpus)
		return refuse(
			"fleet.machine",
			`job needs ${needs.vcpus} vCPU; this machine class has ${machine.vcpus}`,
		);
	if (needs?.memoryGb !== undefined && needs.memoryGb > machine.memoryGb)
		return refuse(
			"fleet.machine",
			`job needs ${needs.memoryGb} GB; this machine class has ${machine.memoryGb}`,
		);
	const longest = model.capabilities?.maxRuntimeMinutes;
	if (longest !== undefined && demand.minutes > longest)
		return refuse(
			"fleet.runtime",
			`job reserves ${demand.minutes} minutes; one machine runs at most ${longest}`,
		);
	const ceiling = ceilingOf(member);
	if (ceiling !== undefined && member.activeJobs >= ceiling)
		return refuse("fleet.capacity", `all ${ceiling} slots are in use`);
	if (
		model.monthlyFeeUsd !== undefined &&
		!member.commercial.subscribed &&
		!input.allowNewProviderAgreements
	)
		return refuse(
			"fleet.agreement.new-denied",
			"placing this job would open a new paid provider account",
		);
	return undefined;
}

function policyContext(
	member: FleetMemberState,
	input: FleetBalanceInput,
	costBoundMicros: number,
	payerExposure: ReadonlyMap<string, number>,
): BudgetPolicyEvaluationContext {
	const { demand, policy } = input;
	return {
		workload: "ci",
		tenantId: policy.tenantId,
		budgetId: policy.budgetId,
		periodId: policy.periodId,
		policyRevision: policy.revision,
		nowMs: Date.parse(input.now),
		costBoundMicros,
		exposureMicros: input.exposureMicros,
		boundKind: "conservative",
		phase: input.phase ?? "plan",
		measurements: [
			{ key: "work.cost", unit: "USD.micros", value: costBoundMicros },
			{ key: "work.duration", unit: "ms", value: demand.minutes * 60_000 },
			{ key: "work.concurrent", unit: "count", value: input.activeWork + 1 },
			...[...payerExposure].map(([target, value]) => ({
				key: "provider.cost",
				unit: "USD.micros",
				target,
				value: value + (target === member.payer ? costBoundMicros : 0),
			})),
			...(demand.attempt === undefined
				? []
				: [{ key: "ci.attempts", unit: "count", value: demand.attempt }]),
			...(demand.queueDurationMs === undefined
				? []
				: [
						{
							key: "ci.queue.duration",
							unit: "ms",
							value: demand.queueDurationMs,
						},
					]),
		],
	};
}

export function balanceFleet(input: FleetBalanceInput): FleetBalance {
	if (!Number.isFinite(Date.parse(input.now)))
		throw new TypeError("fleet balancing requires an authoritative time");
	const ids = input.members.map((member) => member.model.id);
	if (new Set(ids).size !== ids.length)
		throw new TypeError("fleet member ids must be unique");

	const refusals: FleetRefusal[] = [];
	const eligible: FleetMemberState[] = [];
	for (const member of input.members) {
		const refusal = ineligible(member, input);
		if (refusal) refusals.push({ memberId: member.model.id, ...refusal });
		else eligible.push(member);
	}

	const payerExposure = new Map<string, number>();
	for (const member of input.members)
		payerExposure.set(
			member.payer,
			Math.max(
				payerExposure.get(member.payer) ?? 0,
				member.payerExposureMicros,
			),
		);
	const authoredOrder = new Map(ids.map((id, index) => [id, index]));
	const ranking: FleetChoice[] = [];

	for (const role of ROLE_ORDER) {
		const tier = eligible.filter((member) => roleOf(member) === role);
		if (tier.length === 0) continue;
		const decision = decideDispatchV2({
			dispatchId: input.demand.id,
			category: "runner",
			candidates: tier.map((member) => ({
				providerId: member.model.id,
				scenario: runnerQuoteScenario({
					model: member.model,
					state: member.commercial,
					tenantId: input.policy.tenantId,
					minutes: input.demand.minutes,
					at: input.now,
				}),
			})),
		});
		for (const rejected of decision.rejectedCandidates)
			refusals.push({
				memberId: rejected.providerId,
				code: `pricing.${rejected.code}`,
				reason: rejected.reason,
			});
		const admitted: FleetChoice[] = [];
		for (const entry of decision.ranking) {
			const member = tier.find(
				(candidate) => candidate.model.id === entry.providerId,
			);
			if (!member) throw new Error("dispatcher ranked an unknown member");
			const micros = usdToMicrosCeil(entry.incrementalBilled.decimal);
			if (micros === undefined) {
				refusals.push({
					memberId: member.model.id,
					code: "pricing.INVALID_AMOUNT",
					reason: "quote is not a nonnegative bounded amount",
				});
				continue;
			}
			const payerSpent = payerExposure.get(member.payer) ?? 0;
			if (
				member.payerBudgetMicros !== undefined &&
				payerSpent + micros > member.payerBudgetMicros
			) {
				refusals.push({
					memberId: member.model.id,
					code: "fleet.payer-budget" satisfies FleetRefusalCode,
					reason: "job would exceed the operator's ceiling for this payer",
				});
				continue;
			}
			if (
				input.ceilingMicros !== undefined &&
				input.exposureMicros + micros > input.ceilingMicros
			) {
				refusals.push({
					memberId: member.model.id,
					code: "fleet.account-budget" satisfies FleetRefusalCode,
					reason: "job would exceed the account's legacy ceiling",
				});
				continue;
			}
			const verdict = evaluateBudgetPolicy(
				input.policy,
				policyContext(member, input, micros, payerExposure),
			);
			if (!verdict.ok) {
				refusals.push({
					memberId: member.model.id,
					code: verdict.code,
					reason: verdict.reason,
				});
				continue;
			}
			admitted.push({
				memberId: member.model.id,
				provider: member.model.provider,
				binding: member.model.binding,
				role,
				runsOn: member.model.runsOn,
				incrementalBilledMicros: micros,
				usesAllowance: entry.quote.consumption.some(
					(consumed) => consumed.kind === "allowance",
				),
				quoteHash: entry.quote.quoteHash,
			});
		}
		admitted.sort((left, right) => {
			if (
				input.policy.objective === "maximize-credits" &&
				left.usesAllowance !== right.usesAllowance
			)
				return left.usesAllowance ? -1 : 1;
			if (left.incrementalBilledMicros !== right.incrementalBilledMicros)
				return left.incrementalBilledMicros - right.incrementalBilledMicros;
			return (
				(authoredOrder.get(left.memberId) ?? 0) -
				(authoredOrder.get(right.memberId) ?? 0)
			);
		});
		ranking.push(...admitted);
	}

	return { selected: ranking[0], ranking, refusals };
}
