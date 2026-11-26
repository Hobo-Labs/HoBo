/**
 * The lease lifecycle driver (ADR-0179 amendment): what advances each job's
 * lifecycle steps (dispatch check, claim timeout, reconcile). Its offers are
 * provider manifests in `offers/` (`vercel-queues`, `vercel-workflows`),
 * lowered into the relay's pricing catalog; each satisfies
 * `lifecycle.lease-driver/v1`.
 *
 * Only the Vercel Queues driver is built (`createLeaseStepScheduler`). The
 * Workflows driver is phase 4d: it needs `workflow` 5.4.0 or later, which
 * the repository's two-week pin rule allows from 2026-11-18, so its offer is
 * listed and never chosen until it is built and available.
 */
import type { Lease } from "@hobo/ci";
import type { HostedLeaseStepKind } from "@hobo/ci-gh-actions";
import type { RelayLeaseChange } from "@hobo/ci-gh-actions/relay-cache";
import { RELAY_LIFECYCLE_OFFERS } from "./_generated-assets/relay-offers.js";

// public-contract: capability profile id the registry resolves.
export const LIFECYCLE_LEASE_DRIVER_PROFILE =
	"lifecycle.lease-driver/v1" as const;

/** The port both drivers implement over the same relay transition logic. */
export interface LeaseLifecycleDriver {
	/** A lease record was written: start the chain its new state belongs to. */
	changed(change: RelayLeaseChange): Promise<void>;
	/** The step that ran is rung `n`: schedule rung `n + 1` of its chain. */
	next(lease: Lease, step: HostedLeaseStepKind, n: number): Promise<boolean>;
}

export type LifecycleDriverId =
	(typeof RELAY_LIFECYCLE_OFFERS)[number]["driver"];

export type LifecycleDriverDecision = Readonly<{
	driver: LifecycleDriverId;
	/** Every offer, with why it was or was not eligible: the logged policy decision. */
	considered: readonly string[];
}>;

/**
 * Choose the driver for jobs admitted now: among the offers that are built
 * and available on `today` (an ISO date), the first in catalog order, which
 * is the budget order the amendment sets (the Queue driver, then Workflows
 * on the managed World). Throws when none is eligible: the relay cannot run.
 */
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
