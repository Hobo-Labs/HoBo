import { type ContinuityPolicy, continuity, readContinuity } from "@hobo/bindles";

// HoBo CD's continuity policies, declared once and attached to its Bindle
// (`bindle.ts`) with `.with(...)`. Each is the cheapest tier that keeps what
// the data is for:
//
// - **`cd-journal`: `standard`, with two standbys.** This is a desired
//   policy for the rollout ledger, not evidence that the requested recovery
//   point, independent failure domains, safe failover or backups exist. The
//   experimental fleet still needs a commit-boundary fence and scheduled
//   backups before it can provide those guarantees.
// - **`cd-config`: `rebuildable`.** It holds references into the owner's
//   secret store, not values; the store keeps its own replicas, and `hobo cd
//   up` rebuilds the references idempotently. Copying it would buy nothing.

export const CD_CONTINUITY = Object.freeze({
	journal: continuity({ tier: "standard", standbys: 2 }),
	config: continuity({ tier: "rebuildable" }),
});

/** The journal's parsed policy, for the fleet that runs it. */
export function cdJournalContinuity(): ContinuityPolicy {
	const policy = readContinuity([CD_CONTINUITY.journal]);
	if (policy === null) throw new Error("the CD journal declares no continuity");
	return policy;
}
