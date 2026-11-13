/**
 * Importing envelopes into `FLEET_JOURNAL` for a high-availability restore
 * (L41). The store's `append` mints fresh envelope ids, and the audit log
 * names envelopes by id, so a restore writes the archived envelopes
 * themselves, unchanged, in the archive's `readAll` order.
 *
 * - **Batches.** Consecutive items of one stream whose positions fall in one
 *   stream sequence were one append and become one message again, so a
 *   journal archived with `readAll` comes back with the same positions. An
 *   item without a position is a message of its own.
 * - **Checked first.** Every envelope parses; ids are unique; each stream's
 *   `seq` runs 1, 2, 3, … Nothing is written unless all of it holds.
 * - **Conflict.** The journal must hold nothing, or exactly the first
 *   envelopes of this import (same ids, same order): that is a partial import,
 *   and the import resumes after it. Anything else is `conflict`.
 * - **Compare-and-set.** Each message is published with the subject's last
 *   sequence as read, so a concurrent writer fails the import instead of
 *   interleaving with it.
 *
 * Owner epochs (fencing) are not part of an envelope, so every imported
 * stream starts unfenced (epoch 0); its next fenced append sets the epoch.
 */
import {
	type EventEnvelope,
	type EventPosition,
	parseEventEnvelope,
} from "@hobo/core";
import type { Outcome } from "@hobo/fleet";
import {
	decodeBatch,
	encodeBatch,
	JOURNAL_SUBJECTS,
	MAX_BATCH_EVENTS,
	streamIdOfSubject,
	streamSequenceOf,
	subjectOfStream,
} from "./codec.js";
import type { JournalTransport } from "./transport.js";

/** One archived envelope, with its `readAll` position when the archive kept it. */
export type JournalImportItem = Readonly<{
	event: EventEnvelope;
	position?: EventPosition;
}>;

/** `imported`: envelopes written by this run; `present`: envelopes a previous run had already written. */
export type JournalImportResult = Readonly<{
	imported: number;
	present: number;
}>;

const failure = (
	code: "conflict" | "invalid-request",
	message: string,
): Outcome<JournalImportResult> => ({
	ok: false,
	error: { code, message: `journal import: ${message}` },
});

/** The items, parsed and checked; a message on failure. */
function checked(
	items: readonly JournalImportItem[],
): EventEnvelope[] | string {
	const seen = new Set<string>();
	const lastSeq = new Map<string, number>();
	const events: EventEnvelope[] = [];
	for (const [index, item] of items.entries()) {
		let event: EventEnvelope;
		try {
			event = parseEventEnvelope(item.event);
		} catch (cause) {
			return `item ${index} is not an event envelope: ${cause instanceof Error ? cause.message : String(cause)}`;
		}
		if (seen.has(event.id)) return `envelope ${event.id} appears twice`;
		seen.add(event.id);
		const expected = (lastSeq.get(event.streamId) ?? 0) + 1;
		if (event.seq !== expected)
			return `stream ${event.streamId} has seq ${event.seq} where ${expected} belongs`;
		lastSeq.set(event.streamId, event.seq);
		events.push(event);
	}
	return events;
}

/** The import's messages: runs of one stream within one archived stream sequence. */
function batchesOf(
	items: readonly JournalImportItem[],
	events: readonly EventEnvelope[],
): EventEnvelope[][] {
	const batches: EventEnvelope[][] = [];
	let current: EventEnvelope[] = [];
	let key: string | undefined;
	for (const [index, event] of events.entries()) {
		const position = items[index]?.position;
		const next =
			position === undefined
				? undefined
				: `${event.streamId}\u0000${streamSequenceOf(position)}`;
		if (
			current.length > 0 &&
			(next === undefined || next !== key || current.length >= MAX_BATCH_EVENTS)
		) {
			batches.push(current);
			current = [];
		}
		current.push(event);
		key = next;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}

/**
 * Writes `items` (in `readAll` order) into the journal behind `transport`,
 * keeping every envelope as it is. Resumes a partial import of the same
 * items; refuses a journal holding anything else with `conflict`. Throws
 * only what the transport throws (the journal then holds a prefix, and a
 * second call finishes it).
 */
export async function importJournal(
	transport: JournalTransport,
	items: readonly JournalImportItem[],
): Promise<Outcome<JournalImportResult>> {
	const events = checked(items);
	if (!Array.isArray(events)) return failure("invalid-request", events);

	const lastOfSubject = new Map<string, number>();
	let present = 0;
	for await (const message of transport.messages(JOURNAL_SUBJECTS, 1)) {
		const streamId = streamIdOfSubject(message.subject);
		for (const stored of decodeBatch(message.data, streamId).events) {
			if (events[present]?.id !== stored.id)
				return failure(
					"conflict",
					`the journal is not empty and envelope ${stored.id} at place ${present + 1} is not this import's`,
				);
			present += 1;
		}
		lastOfSubject.set(message.subject, message.seq);
	}

	const remaining = events.slice(present);
	const batches = batchesOf(items.slice(present), remaining);
	for (const batch of batches) {
		const first = batch[0];
		if (first === undefined) continue;
		const subject = subjectOfStream(first.streamId);
		const published = await transport.publish(
			subject,
			encodeBatch({ ownerEpoch: 0n, events: batch }),
			lastOfSubject.get(subject) ?? 0,
		);
		lastOfSubject.set(subject, published.seq);
	}
	return { ok: true, value: { imported: remaining.length, present } };
}
