/**
 * Storage spill is runner provider routing (design §8.5), not fleet state.
 * Not wired into the relay yet: nothing outside this module's tests calls it.
 * A caller would be `HostedRelay`'s reserve pass, when box storage admission
 * refuses a job whose connection is not isolated-only: pick an ARC or
 * GitHub-hosted offer here and reserve the job on it. Today a job the box
 * cannot start waits or is deferred to the rest of the fleet (finding 152).
 */
import type { Account, Job, Lease } from "@hobo/ci";
import {
	isOverflowRunnerLabel,
	providerOffer,
	queuedDemandLabels,
	type RunnerTierState,
	selectRunnerTier,
} from "@hobo/ci";

export type StorageSpillSelection = Readonly<{
	memberId: string;
	runsOn: string;
	backend: RunnerTierState["backend"];
}>;

/** Map configured offers to runner tiers for pure overflow selection. */
export function runnerTiersFromAccount(
	account: Account,
	input: Readonly<{
		hoboFreeSlots: number;
		overflowSlots?: Readonly<Record<string, number>>;
	}>,
): RunnerTierState[] {
	const overflowSlots = input.overflowSlots ?? {};
	return account.offers.map((offer) => {
		let backend: RunnerTierState["backend"] = "hobo";
		if (offer.provider === "github") backend = "github";
		else if (offer.provider === "kubernetes" && offer.backend === "gh-actions")
			backend = "arc";
		const freeSlots =
			backend === "hobo"
				? input.hoboFreeSlots
				: (overflowSlots[offer.id] ?? (offer.enabled ? offer.concurrency : 0));
		return {
			id: offer.id,
			backend,
			enabled: offer.enabled,
			runsOn: offer.runsOn,
			freeSlots,
		};
	});
}

export function selectStorageSpillBackend(
	account: Account,
	job: Job,
	hoboFreeSlots: number,
	overflowSlots?: Readonly<Record<string, number>>,
): StorageSpillSelection | undefined {
	if (job.isolatedRequired) return undefined;
	const selection = selectRunnerTier({
		members: runnerTiersFromAccount(
			account,
			overflowSlots === undefined
				? { hoboFreeSlots }
				: { hoboFreeSlots, overflowSlots },
		),
		currentLabels: job.labels,
	});
	if (!selection?.spilled) return undefined;
	if (isOverflowRunnerLabel([selection.runsOn])) return selection;
	return undefined;
}

/** Disable box/isolated offers so `reserve` can only pick ARC or GitHub-hosted. */
export function accountForStorageOverflowReserve(account: Account): Account {
	return {
		...account,
		offers: account.offers.map((offer) => ({
			...offer,
			enabled:
				offer.enabled &&
				(offer.provider === "github" ||
					(offer.provider === "kubernetes" && offer.backend === "gh-actions")),
		})),
	};
}

export function spillDemandLabelsForLease(
	lease: Lease,
	account: Account,
): string[] {
	const offer = providerOffer(account, lease);
	return queuedDemandLabels(lease.provider, offer.backend, offer.runsOn, [
		"hobo",
	]);
}
