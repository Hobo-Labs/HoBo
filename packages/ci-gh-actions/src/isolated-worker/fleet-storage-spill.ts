import type { Account, Job, Lease } from "@hobo/ci";
import {
	type FleetMember,
	isOverflowRunnerLabel,
	providerOffer,
	queuedDemandLabels,
	selectFleetBackend,
} from "@hobo/ci";

export type StorageSpillSelection = Readonly<{
	memberId: string;
	runsOn: string;
	backend: FleetMember["backend"];
}>;

/** Map configured offers to fleet members for pure overflow selection. */
export function fleetMembersFromAccount(
	account: Account,
	input: Readonly<{
		hoboFreeSlots: number;
		overflowSlots?: Readonly<Record<string, number>>;
	}>,
): FleetMember[] {
	const overflowSlots = input.overflowSlots ?? {};
	return account.offers.map((offer) => {
		let backend: FleetMember["backend"] = "hobo";
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
	const selection = selectFleetBackend({
		members: fleetMembersFromAccount(
			account,
			overflowSlots === undefined
				? { hoboFreeSlots }
				: { hoboFreeSlots, overflowSlots },
		),
		currentLabels: job.labels,
	});
	if (!selection || !selection.spilled) return undefined;
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

export function spillDemandLabelsForLease(lease: Lease, account: Account): string[] {
	const offer = providerOffer(account, lease);
	return queuedDemandLabels(lease.provider, offer.backend, offer.runsOn, [
		"hobo",
	]);
}
