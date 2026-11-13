/**
 * The journal event store on `FLEET_JOURNAL` (L36).
 * Signature frozen by the fleet contract commit (ADR-0182).
 */
import type { FleetEventStore, Outcome } from "@hobo/fleet";
import {
	importJournal,
	type JournalImportItem,
	type JournalImportResult,
} from "./import.js";
import { connectJournalTransport } from "./nats.js";
import { openJournalStore } from "./store.js";

/** Every append is one message holding the batch, with `Nats-Expected-Last-Subject-Sequence` as the compare-and-set. */
export async function createJournalEventStore(
	input: Readonly<{ servers: readonly string[]; credentials: string }>,
): Promise<FleetEventStore> {
	return openJournalStore(await connectJournalTransport(input));
}

/**
 * Internal (L41, for the high-availability restore): writes archived
 * envelopes into `FLEET_JOURNAL` unchanged, in `readAll` order, keeping their
 * ids and, where the archive kept positions, their batches. Refuses a journal
 * holding anything but a prefix of `items` (`conflict`); a second call after
 * a partial import finishes it. See `import.ts`.
 */
export async function importJournalEvents(
	input: Readonly<{ servers: readonly string[]; credentials: string }>,
	items: readonly JournalImportItem[],
): Promise<Outcome<JournalImportResult>> {
	const transport = await connectJournalTransport(input);
	try {
		return await importJournal(transport, items);
	} finally {
		await transport.close();
	}
}
