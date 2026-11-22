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

export type JournalImportItem = Readonly<{
	event: EventEnvelope;
	position?: EventPosition;
}>;

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
