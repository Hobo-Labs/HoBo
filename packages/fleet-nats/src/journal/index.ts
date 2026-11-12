/**
 * The journal event store on `FLEET_JOURNAL` (L36).
 * Signature frozen by the fleet contract commit (ADR-0182).
 */
import { type FleetEventStore, FleetNotImplemented } from "@hobo/fleet";

/** Every append is one message holding the batch, with `Nats-Expected-Last-Subject-Sequence` as the compare-and-set. */
export function createJournalEventStore(
	input: Readonly<{ servers: readonly string[]; credentials: string }>,
): Promise<FleetEventStore> {
	void input;
	throw new FleetNotImplemented("createJournalEventStore");
}
