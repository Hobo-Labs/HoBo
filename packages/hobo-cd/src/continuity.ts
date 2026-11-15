import {
	type ContinuityPolicy,
	continuity,
	readContinuity,
} from "@hobo/bindles";

// HoBo CD's continuity policies, declared once and attached to its Bindle
// (`bindle.ts`) with `.with(...)`. Each is the cheapest tier that keeps what
// the data is for:
//
// - **`cd-journal`: `standard`, with two standbys.** The rollout ledger: a
//   copy to each standby within the five-minute recovery point, writes fenced
//   at the commit boundary so a move loses none, and a daily backup (seven
//   kept) on the fleet's witness. What the fleet cannot verify (independent
//   vendors, a placed witness) it reports as a shortfall when it opens.
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
