/**
 * The journal event store on `FLEET_JOURNAL` (L36).
 * Signature frozen by the fleet contract commit (ADR-0182).
 */
import type { FleetEventStore } from "@hobo/fleet";
import { connectJournalTransport } from "./nats.js";
import { openJournalStore } from "./store.js";

/** Every append is one message holding the batch, with `Nats-Expected-Last-Subject-Sequence` as the compare-and-set. */
export async function createJournalEventStore(
	input: Readonly<{ servers: readonly string[]; credentials: string }>,
): Promise<FleetEventStore> {
	return openJournalStore(await connectJournalTransport(input));
}
