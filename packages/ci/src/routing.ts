import { createDispatcherRegistry, decideDispatch } from "@hobo/dispatcher";
import type {
	Account,
	Lease,
	Offer,
	SandboxAllowance,
} from "./_generated/ci_pb.js";
import { allocationQuote } from "./accounting.js";
import { sandboxReservationQuote } from "./sandbox-pricing.js";

export const ACTIVE_STATES = new Set([
	"reserved",
	"dispatching",
	"dispatched",
	"claiming",
	"running",
	"uncertain",
]);

/** Pure ranking input; availability is measured per customer-owned account. */
export function route(account: Account, leases: readonly Lease[], now: string) {
	if (
		account.usageObservedAt &&
		Date.parse(account.usageObservedAt) > Date.parse(now)
	)
		return undefined;
	const active = leases.filter(
		(lease) => lease.accountId === account.id && ACTIVE_STATES.has(lease.state),
	);
	const settled = leases.filter(
		(lease) => lease.accountId === account.id && lease.state === "completed",
	);
	const minutes = account.maxRuntimeMinutes + account.startupMinutes;
	const held = active.reduce((sum, lease) => sum + lease.reservedPaidMicros, 0);
	const spent =
		account.spentMicros +
		settled
			.filter(
				(lease) =>
					!account.usageObservedAt ||
					Date.parse(lease.usageCompletedAt || lease.settledAt) >
						Date.parse(account.usageObservedAt),
			)
			.reduce((sum, lease) => sum + lease.paidMicros, 0);
	const candidates = account.offers.flatMap((offer) => {
		if (
			!offer.enabled ||
			!offer.bridgeAcknowledged ||
			Date.parse(offer.observedAt) > Date.parse(now) ||
			Date.parse(offer.validUntil) <= Date.parse(now) ||
			Date.parse(offer.validUntil) < Date.parse(now) + minutes * 60000
		)
			return [];
		const reserved = active.filter((lease) => lease.offerId === offer.id);
		if (reserved.length >= offer.concurrency) return [];
		const used = settled.filter((lease) => lease.offerId === offer.id);
		const usedFree = used
			.filter(
				(lease) =>
					Date.parse(lease.usageCompletedAt || lease.settledAt) >
					Date.parse(offer.observedAt),
			)
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
							Date.parse(lease.usageCompletedAt || lease.settledAt) >
								Date.parse(offer.observedAt) && !lease.sandboxUsedAllowance,
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
							.filter(
								(lease) =>
									Date.parse(lease.usageCompletedAt || lease.settledAt) >
									Date.parse(offer.observedAt),
							)
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
		const providerSpent =
			offer.spentMicros +
			used
				.filter(
					(lease) =>
						Date.parse(lease.usageCompletedAt || lease.settledAt) >
						Date.parse(offer.observedAt),
				)
				.reduce((sum, lease) => sum + lease.paidMicros, 0) +
			reserved.reduce((sum, lease) => sum + lease.reservedPaidMicros, 0);
		if (
			spent + held + paid > account.budgetMicros ||
			providerSpent + paid > offer.budgetMicros
		)
			return [];
		return [{ offer, free, reservedFree, paid, sandboxReservedAllowance }];
	});
	// After concurrency and budget filters: an isolated box that still has a
	// slot beats ARC, which beats GitHub-hosted. Other providers stay eligible.
	const preferred = preferFleetCandidates(candidates);
	// Prefer consuming available free allocation, then compare the full paid
	// reservation within that group. A single job cannot split across offers.
	if (preferred.length === 0) return undefined;
	const freeCandidates = preferred.filter((candidate) => {
		const allowance = candidate.sandboxReservedAllowance;
		return (
			candidate.reservedFree > 0 ||
			(allowance !== undefined &&
				(allowance.cpuVcpuMs > 0 ||
					allowance.memoryMbMs > 0 ||
					allowance.egressBytes > 0 ||
					allowance.creations > 0 ||
					allowance.proxyBytes > 0 ||
					allowance.proxySessions > 0 ||
					allowance.proxyControlCalls > 0))
		);
	});
	const prioritized = freeCandidates.length > 0 ? freeCandidates : preferred;
	const lowestPaidMicros = prioritized.reduce(
		(lowest, candidate) => Math.min(lowest, candidate.paid),
		Number.POSITIVE_INFINITY,
	);
	const eligible = prioritized.filter(
		(candidate) => candidate.paid === lowestPaidMicros,
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
	};
}

/**
 * 0 isolated box, 1 kubernetes gh-actions (ARC), 2 GitHub-hosted.
 * Unranked providers are kept. A worse fleet tier is dropped when a better
 * one remains, so a free GitHub offer cannot beat a box that still has a slot.
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
