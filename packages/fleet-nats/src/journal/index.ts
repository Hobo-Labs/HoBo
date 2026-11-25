import type { FleetEventStore, Outcome } from "@hobo/fleet";
import {
	importJournal,
	type JournalImportItem,
	type JournalImportResult,
} from "./import.js";
import { connectJournalTransport } from "./nats.js";
import { openJournalStore } from "./store.js";

export async function createJournalEventStore(
	input: Readonly<{ servers: readonly string[]; credentials: string }>,
): Promise<FleetEventStore> {
	return openJournalStore(await connectJournalTransport(input));
}

export async function importJournalEvents(
	input: Readonly<{ servers: readonly string[]; credentials: string }>,
	items: readonly JournalImportItem[],
): Promise<Outcome<JournalImportResult>> {
	const transport = await connectJournalTransport(input, false);
	try {
		return await importJournal(transport, items);
	} finally {
		await transport.close();
	}
}
