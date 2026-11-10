/**
 * Pure fleet balancing: which member should take a job, and why not the rest.
 *
 * Three questions, asked in this order and never merged:
 *
 *   1. Can this member run the job at all? Visibility, ownership, Docker,
 *      forks, health, free slots, and whether the job's label can still reach
 *      it. These are facts about the provider, not about money.
 *   2. What does the job cost there? The pricing engine answers, through
 *      dispatcher v2, as the incremental billed amount for this account in
 *      this month. No rate is multiplied here.
 *   3. Does the budget policy allow that cost? `evaluateBudgetPolicy` answers
 *      for every candidate, with the same measurements CI admission supplies.
 *
 * Roles order the tiers: capacity already paid for, then rented capacity by
 * price, then the last resort. A cheaper member in a later tier never jumps
 * the queue, and a member the policy refuses is skipped, not retried.
 *
 * No I/O, no clock. Callers pass resolved member state and the current time.
 */

import {
	type BudgetPolicy,
	type BudgetPolicyEvaluationContext,
	evaluateBudgetPolicy,
} from "@hobo/core";
import { decideDispatchV2 } from "@hobo/dispatcher";
import { parseDecimal } from "@hobo/pricing";
import type {
	FleetBinding,
	FleetRole,
	RunnerFinancialModel,
} from "./models.js";
import { type RunnerCommercialState, runnerQuoteScenario } from "./pricing.js";

export type FleetMemberState = Readonly<{
	model: RunnerFinancialModel;
	enabled: boolean;
	/** Authored override of the model's tier. */
	role?: FleetRole;
	/** Authored ceiling on jobs at once; intersects the provider's own. */
	concurrency?: number;
	/** Jobs this member is running or holding a reservation for. */
	activeJobs: number;
	/** False while the member's circuit breaker is open. */
	healthy: boolean;
	commercial: RunnerCommercialState;
	/** The owner turned on public repositories at an opt-in provider. */
	publicRepositoriesEnabled?: boolean;
	/** Exact payer the budget policy's `provider.cost` constraint names. */
	payer: string;
	/** That payer's spend and held commitments this budget period. */
	payerExposureMicros: number;
}>;

export type FleetDemand = Readonly<{
	/** Stable dispatch identity, for example `owner/repo:run:job:attempt`. */
	id: string;
	/** Reserved runner minutes, startup included. */
	minutes: number;
	repository: Readonly<{
		visibility: "public" | "private";
		ownerType: "organization" | "user";
	}>;
	forkPullRequest: boolean;
	needsDocker: boolean;
	/**
	 * The label the job is already queued on. GitHub does not let a queued job
	 * change `runs-on`, so only a member serving that label can still take it.
	 * Absent for a job that has not been queued yet.
	 */
	queuedOnLabel?: string;
	queueDurationMs?: number;
	attempt?: number;
}>;

export type FleetBalanceInput = Readonly<{
	members: readonly FleetMemberState[];
	demand: FleetDemand;
	policy: BudgetPolicy;
	/** Spend and held commitments against the whole budget this period. */
	exposureMicros: number;
	/** CI work already held by the admitting authority. */
	activeWork: number;
	now: string;
	/** Opening a new provider account to place this job is permitted. */
	allowNewProviderAgreements: boolean;
	phase?: "plan" | "admit";
}>;

export type FleetChoice = Readonly<{
	memberId: string;
	provider: string;
	binding: FleetBinding;
	role: FleetRole;
	runsOn: string;
	/** Conservative whole microdollars the job adds to this month's bill. */
	incrementalBilledMicros: number;
	/** The job is covered by included minutes. */
	usesAllowance: boolean;
	quoteHash: string;
}>;

export type FleetRefusal = Readonly<{
	memberId: string;
	code: string;
	reason: string;
}>;

export type FleetBalance = Readonly<{
	/** Best admitted member, or undefined when the job must wait. */
	selected: FleetChoice | undefined;
	/** Every admitted member, best first. */
	ranking: readonly FleetChoice[];
	refusals: readonly FleetRefusal[];
}>;

const ROLE_ORDER: readonly FleetRole[] = ["primary", "overflow", "last-resort"];
const MICROS_SCALE = 6;

/** Whole microdollars, rounded up: a bound must never understate a charge. */
function usdToMicrosCeil(decimal: string): number | undefined {
	const parsed = parseDecimal(decimal);
	if (parsed === undefined || parsed.coefficient < 0n) return undefined;
	const shift = MICROS_SCALE - parsed.scale;
	let micros: bigint;
	if (shift >= 0) micros = parsed.coefficient * 10n ** BigInt(shift);
	else {
		const divisor = 10n ** BigInt(-shift);
		micros = parsed.coefficient / divisor;
		if (parsed.coefficient % divisor !== 0n) micros += 1n;
	}
	return micros <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(micros) : undefined;
}

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

/** Why this member cannot run the job, or undefined when it can. */
function ineligible(
	member: FleetMemberState,
	input: FleetBalanceInput,
): Omit<FleetRefusal, "memberId"> | undefined {
	const { model } = member;
	const { demand } = input;
	const refuse = (code: string, reason: string) => ({ code, reason });
	if (!member.enabled)
		return refuse("fleet.disabled", "member is not enabled in policy");
	if (!member.healthy)
		return refuse("fleet.unhealthy", "member's circuit breaker is open");
	if (
		demand.queuedOnLabel !== undefined &&
		demand.queuedOnLabel !== model.runsOn
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
		// A vendor's published rate is not a provider-enforced ceiling.
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

	// One payer can back several members; its exposure is counted once.
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
		// The dispatcher orders by billed amount. Under `maximize-credits`,
		// included minutes are spent before money; equal choices keep the order
		// the operator authored the members in.
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
