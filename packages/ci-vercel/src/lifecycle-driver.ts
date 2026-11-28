import type { Lease } from "@hobo/ci";
import type { HostedLeaseStepKind } from "@hobo/ci-gh-actions";
import type { RelayLeaseChange } from "@hobo/ci-gh-actions/relay-cache";
import { RELAY_LIFECYCLE_OFFERS } from "./_generated-assets/relay-offers.js";

// public-contract: capability profile id the registry resolves.
export const LIFECYCLE_LEASE_DRIVER_PROFILE =
	"lifecycle.lease-driver/v1" as const;

export interface LeaseLifecycleDriver {
	changed(change: RelayLeaseChange): Promise<void>;
	next(lease: Lease, step: HostedLeaseStepKind, n: number): Promise<boolean>;
}

export type LifecycleDriverId =
	(typeof RELAY_LIFECYCLE_OFFERS)[number]["driver"];

export type LifecycleDriverDecision = Readonly<{
	driver: LifecycleDriverId;
	considered: readonly string[];
}>;

export function chooseLifecycleDriver(today: string): LifecycleDriverDecision {
	const day = today.slice(0, 10);
	const considered: string[] = [];
	let chosen: LifecycleDriverId | undefined;
	for (const offer of RELAY_LIFECYCLE_OFFERS) {
		const blocked = [
			...(offer.built ? [] : ["not built"]),
			...(day < offer.availableFrom
				? [`available from ${offer.availableFrom}`]
				: []),
		];
		const reason =
			blocked.length > 0
				? blocked.join("; ")
				: chosen
					? "eligible, later in budget order"
					: "chosen";
		if (reason === "chosen") chosen = offer.driver;
		considered.push(
			`${offer.driver}: ${reason}${offer.unrated ? " (price unverified)" : ""}`,
		);
	}
	if (!chosen) throw new Error("no lease lifecycle driver is available");
	return { driver: chosen, considered };
}
