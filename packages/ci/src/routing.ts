import { evaluateBudgetPolicy } from "@hobo/core";
import { createDispatcherRegistry, decideDispatch } from "@hobo/dispatcher";
import type {
	Account,
	CiRoutingRefusal as CiRoutingRefusalWire,
	Lease,
	Offer,
	SandboxAllowance,
} from "./_generated/ci_pb.js";
import { allocationQuote } from "./accounting.js";
import {
	ciBudgetIdentity,
	ciBudgetPolicy,
	ciRoutingObjective,
} from "./policy.js";
import { sandboxReservationQuote } from "./sandbox-pricing.js";

export const ACTIVE_STATES = new Set([
	"reserved",
	"dispatching",
	"dispatched",
	"claiming",
	"running",
	"uncertain",
]);

export interface CiRoutingCandidateCost {
	paidMicros: number;
	freeMinutes: number;
	sandboxReservedAllowance?: SandboxAllowance | undefined;
}
export type CiRoutingRefusal = Pick<
	CiRoutingRefusalWire,
	"code" | "reason" | "offerId"
>;
export interface CiRoutingOptions {
	/** A plan requiring a native bound is never execution authorization. */
	phase?: "plan" | "admit";
	attempt?: number;
	queueDurationMs?: number;
	onRefusal?: (refusal: CiRoutingRefusal) => void;
}

/** Shared by admission and pre-dispatch repricing. Negative means left wins.
 * A partly free job can still cost more than an entirely paid alternative. */
export function compareCiRoutingCandidates(
	left: CiRoutingCandidateCost,
	right: CiRoutingCandidateCost,
	strategy = "min-cost",
): number {
	if (
		![
			"",
			"min-cost",
			"lowest-total-incremental-cost",
			"maximize-credits",
		].includes(strategy)
	)
		throw new Error("unsupported CI routing objective");
	function consumesFree(candidate: CiRoutingCandidateCost): boolean {
		const allowance = candidate.sandboxReservedAllowance;
		return (
			candidate.freeMinutes > 0 ||
			(allowance !== undefined &&
				[
					allowance.cpuVcpuMs,
					allowance.memoryMbMs,
					allowance.egressBytes,
					allowance.creations,
					allowance.proxyBytes,
					allowance.proxySessions,
					allowance.proxyControlCalls,
				].some((value) => value > 0))
		);
	}
	const freeDifference =
		Number(consumesFree(right)) - Number(consumesFree(left));
	if (strategy === "maximize-credits" && freeDifference !== 0)
		return freeDifference;
	if (left.paidMicros !== right.paidMicros)
		return left.paidMicros - right.paidMicros;
	return freeDifference;
}

// Timestamp-only snapshots cannot prove that a later completion at the same
// clock tick was included. Count equality (and unknown timestamps) until a
// strictly newer observation establishes coverage.
export function shouldCountLocalUsage(
	lease: Lease,
	observedAt: string,
): boolean {
	const completed = Date.parse(lease.usageCompletedAt || lease.settledAt);
	return !Number.isFinite(completed) || completed >= Date.parse(observedAt);
}

/** Pure ranking input; availability is measured per customer-owned account. */
export function route(
	account: Account,
	leases: readonly Lease[],
	now: string,
	options: CiRoutingOptions = {},
) {
	const refuse = (code: string, reason: string, offerId = "") => {
		options.onRefusal?.({ code, reason, offerId });
	};
	if (!Number.isFinite(Date.parse(now))) {
		refuse(
			"budget.invalid-time",
			"CI routing requires an authoritative current time",
		);
		return undefined;
	}
	let common: ReturnType<typeof ciBudgetPolicy>;
	try {
		common = ciBudgetPolicy(account);
		ciBudgetIdentity(account, now);
		if (common && !common.workloads.includes("ci"))
			throw new Error("budget policy does not cover CI");
		ciRoutingObjective(account.routingStrategy);
		if (
			common &&
			account.routingStrategy &&
			ciRoutingObjective(account.routingStrategy) !== common.objective
		)
			throw new Error("CI routing objective disagrees with budget policy");
	} catch (error) {
		refuse(
			"budget.invalid-policy",
			error instanceof Error ? error.message : "invalid CI budget policy",
		);
		return undefined;
	}
	const strategy = common?.objective ?? account.routingStrategy;
	if (
		account.usageObservedAt &&
		(!Number.isFinite(Date.parse(account.usageObservedAt)) ||
			Date.parse(account.usageObservedAt) > Date.parse(now))
	)
		return undefined;
	const financialScope = (lease: Lease) =>
		common && lease.budgetId
			? lease.budgetTenantId === common.tenantId &&
				lease.budgetId === common.budgetId &&
				lease.budgetPeriodId === common.periodId
			: lease.accountId === account.id;
	const active = leases.filter(
		(lease) => financialScope(lease) && ACTIVE_STATES.has(lease.state),
	);
	const settled = leases.filter(
		(lease) => financialScope(lease) && lease.state === "completed",
	);
	const minutes = account.maxRuntimeMinutes + account.startupMinutes;
	const held = active.reduce((sum, lease) => sum + lease.reservedPaidMicros, 0);
	const spent =
		account.spentMicros +
		settled
			.filter(
				(lease) =>
					!account.usageObservedAt ||
					shouldCountLocalUsage(lease, account.usageObservedAt),
			)
			.reduce((sum, lease) => sum + lease.paidMicros, 0);
	const providerAccounting = new Map(
		account.offers.map((offer) => {
			const same = (lease: Lease) =>
				lease.providerAccountId
					? lease.provider === offer.provider &&
						lease.providerAccountId === offer.providerAccountId
					: lease.accountId === account.id &&
						(lease.offerId === offer.id || lease.provider === offer.provider);
			const reserved = leases.filter(
				(lease) => same(lease) && ACTIVE_STATES.has(lease.state),
			);
			const used = leases.filter(
				(lease) => same(lease) && lease.state === "completed",
			);
			const providerSpent =
				offer.spentMicros +
				used
					.filter((lease) => shouldCountLocalUsage(lease, offer.observedAt))
					.reduce((sum, lease) => sum + lease.paidMicros, 0) +
				reserved.reduce((sum, lease) => sum + lease.reservedPaidMicros, 0);
			return [offer, { reserved, used, providerSpent }] as const;
		}),
	);
	const providerExposures = new Map<string, number>();
	const accounted = new Set<string>();
	for (const [offer, accounting] of providerAccounting) {
		const key = JSON.stringify([offer.provider, offer.providerAccountId]);
		if (accounted.has(key)) continue;
		accounted.add(key);
		providerExposures.set(
			offer.providerAccountId,
			(providerExposures.get(offer.providerAccountId) ?? 0) +
				accounting.providerSpent,
		);
	}
	const candidates = account.offers.flatMap((offer) => {
		if (
			!offer.enabled ||
			!offer.bridgeAcknowledged ||
			!Number.isFinite(Date.parse(offer.observedAt)) ||
			!Number.isFinite(Date.parse(offer.validUntil)) ||
			Date.parse(offer.observedAt) > Date.parse(now) ||
			Date.parse(offer.validUntil) <= Date.parse(now) ||
			Date.parse(offer.validUntil) < Date.parse(now) + minutes * 60000
		)
			return [];
		const accounting = providerAccounting.get(offer);
		if (!accounting) throw new Error("missing provider accounting");
		const { reserved, used, providerSpent } = accounting;
		if (reserved.length >= offer.concurrency) return [];
		const usedFree = used
			.filter((lease) => shouldCountLocalUsage(lease, offer.observedAt))
			.map((lease) => lease.billedFreeMinutes);
		// Sandbox charges are multidimensional and cannot consume host-minute credits.
		if (
			offer.backend === "sandbox" &&
			(!offer.sandboxPricing ||
				offer.freeMinutes !== 0 ||
				(offer.sandboxPricing.proxyVmRequired &&
					offer.priceMicrosPerMinute !== 0))
		)
			return [];
		const allocation = allocationQuote(
			offer.freeMinutes,
			[...usedFree, ...reserved.map((lease) => lease.reservedFreeMinutes)],
			minutes,
			offer.priceMicrosPerMinute,
		);
		let { free, reservedFree, paid } = allocation;
		let sandboxReservedAllowance: SandboxAllowance | undefined;
		if (offer.backend === "sandbox") {
			if (
				offer.sandboxAllowance &&
				(reserved.some((lease) => !lease.sandboxReservedAllowance) ||
					used.some(
						(lease) =>
							shouldCountLocalUsage(lease, offer.observedAt) &&
							!lease.sandboxUsedAllowance,
					))
			)
				return [];
			if (!offer.sandboxPricing) return [];
			const extraMs = offer.sandboxPricing.proxyVmRequired
				? offer.sandboxPricing.proxyVmExtraMs
				: 0;
			if (
				Date.parse(offer.validUntil) <
				Date.parse(now) + minutes * 60000 + extraMs
			)
				return [];
			try {
				const quote = sandboxReservationQuote(
					offer.sandboxPricing,
					minutes,
					offer.priceMicrosPerMinute,
					offer.sandboxAllowance,
					[
						...reserved.flatMap((lease) =>
							lease.sandboxReservedAllowance
								? [lease.sandboxReservedAllowance]
								: [],
						),
						...used
							.filter((lease) => shouldCountLocalUsage(lease, offer.observedAt))
							.flatMap((lease) =>
								lease.sandboxUsedAllowance ? [lease.sandboxUsedAllowance] : [],
							),
					],
				);
				paid = quote.paidMicros;
				sandboxReservedAllowance = quote.reservedAllowance;
			} catch {
				return [];
			}
			free = 0;
			reservedFree = 0;
		}
		if (
			spent + held + paid > account.budgetMicros ||
			providerSpent + paid > offer.budgetMicros
		)
			return [];
		if (common) {
			const durationMs =
				minutes * 60000 +
				(offer.sandboxPricing?.proxyVmRequired
					? offer.sandboxPricing.proxyVmExtraMs
					: 0);
			if (
				common.periodKind === "fixed-window" &&
				(common.periodEndsAtMs === undefined ||
					Date.parse(now) + durationMs > common.periodEndsAtMs)
			) {
				refuse(
					"budget.period-uncovered",
					"CI host duration extends beyond the funded period",
					offer.id,
				);
				return [];
			}
			const measurements = [
				{ key: "work.cost", unit: "USD.micros", value: paid },
				{ key: "work.duration", unit: "ms", value: durationMs },
				{ key: "work.concurrent", unit: "count", value: active.length + 1 },
				...[...providerExposures].map(([target, value]) => ({
					key: "provider.cost",
					unit: "USD.micros",
					target,
					value: value + (target === offer.providerAccountId ? paid : 0),
				})),
				...(options.attempt !== undefined
					? [{ key: "ci.attempts", unit: "count", value: options.attempt }]
					: []),
				...(options.queueDurationMs !== undefined
					? [
							{
								key: "ci.queue.duration",
								unit: "ms",
								value: options.queueDurationMs,
							},
						]
					: []),
			];
			const verdict = evaluateBudgetPolicy(common, {
				workload: "ci",
				tenantId: common.tenantId,
				budgetId: common.budgetId,
				periodId: common.periodId,
				policyRevision: String(common.revision),
				nowMs: Date.parse(now),
				costBoundMicros: paid,
				exposureMicros: spent + held,
				boundKind: "conservative",
				phase: options.phase ?? "admit",
				measurements,
			});
			if (!verdict.ok) {
				refuse(verdict.code, verdict.reason, offer.id);
				return [];
			}
		}
		return [{ offer, free, reservedFree, paid, sandboxReservedAllowance }];
	});
	// Legacy fleet routing prefers the box, then ARC, then GitHub overflow.
	// An authored shared policy ranks every admitted offer by its objective.
	const preferred = common ? candidates : preferFleetCandidates(candidates);
	if (preferred.length === 0) return undefined;
	const cost = (
		candidate: (typeof candidates)[number],
	): CiRoutingCandidateCost => ({
		paidMicros: candidate.paid,
		freeMinutes: candidate.reservedFree,
		sandboxReservedAllowance: candidate.sandboxReservedAllowance,
	});
	const prioritized = [...preferred].sort((left, right) =>
		compareCiRoutingCandidates(cost(left), cost(right), strategy),
	);
	const best = prioritized[0];
	if (!best) return undefined;
	const eligible = prioritized.filter(
		(candidate) =>
			compareCiRoutingCandidates(cost(candidate), cost(best), strategy) === 0,
	);
	// Dispatcher ranks the lowest-cost shortlist, retaining its native credit
	// rationale and deterministic tie-breaking.
	const decision = decideDispatch({
		category: "runner",
		dispatchId: "ci-route",
		units: minutes,
		registry: createDispatcherRegistry(
			eligible.map((candidate) => ({
				providerId: candidate.offer.id,
				category: "runner",
				listUnitCost: candidate.offer.priceMicrosPerMinute,
			})),
		),
		ledgerView: {
			view: "CreditLedgerView",
			seq: 0,
			accounts: eligible.map((candidate) => ({
				providerId: candidate.offer.id,
				dimension: "runner.minutes",
				freeHeadroom: candidate.free,
				listUnitCost: candidate.offer.priceMicrosPerMinute,
				concurrencyHeadroom: 1,
			})),
		},
	});
	if (!decision.ok) return undefined;
	const selected = eligible.find(
		(candidate) => candidate.offer.id === decision.selectedProvider,
	);
	if (!selected) throw new Error("dispatcher selected an unregistered offer");
	return {
		offer: selected.offer,
		minutes,
		freeMinutes: selected.reservedFree,
		paidMicros: selected.paid,
		sandboxReservedAllowance: selected.sandboxReservedAllowance,
		decision: decision.dispatchEvent,
		requiresNativeBound: common?.enforcement === "strict",
	};
}

/**
 * 0 isolated box, 1 kubernetes gh-actions (ARC), 2 GitHub-hosted.
 * For legacy accounts, unranked providers are kept and a worse fleet tier is
 * dropped when a better one remains.
 */
function fleetCandidateRank(offer: Offer): number | undefined {
	if (
		offer.provider === "hobo-box-worker" ||
		offer.backend === "isolated-container"
	)
		return 0;
	if (offer.provider === "kubernetes" && offer.backend === "gh-actions")
		return 1;
	if (offer.provider === "github") return 2;
	return undefined;
}

function preferFleetCandidates<T extends { offer: Offer }>(
	candidates: readonly T[],
): T[] {
	let best: number | undefined;
	for (const candidate of candidates) {
		const rank = fleetCandidateRank(candidate.offer);
		if (rank === undefined) continue;
		if (best === undefined || rank < best) best = rank;
	}
	if (best === undefined) return [...candidates];
	return candidates.filter((candidate) => {
		const rank = fleetCandidateRank(candidate.offer);
		return rank === undefined || rank === best;
	});
}

export function providerOffer(account: Account, lease: Lease): Offer {
	const offer = account.offers.find(
		(candidate) => candidate.id === lease.offerId,
	);
	if (!offer) throw new Error("lease offer missing from configuration");
	return offer;
}
