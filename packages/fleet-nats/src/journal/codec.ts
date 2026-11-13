/**
 * How the journal lays events out on `FLEET_JOURNAL` (L36, design §6.16):
 * one message per append on `fleet.journal.<streamId>`, holding the batch.
 *
 * - **Subject.** A stream id becomes one subject token: every character
 *   outside `[A-Za-z0-9_:-]` (including `%` itself, `.`, `*`, `>` and
 *   whitespace) is written as `%XX` per UTF-8 byte, so the mapping is
 *   injective and reversible and never adds a token or a wildcard.
 * - **Payload.** `{ v: 1, ownerEpoch, events }`: the stream's fencing epoch
 *   after this append (a decimal string, 64-bit safe) and the batch's full
 *   envelopes, numbered with their stream seq. Reads parse every envelope.
 * - **Position.** `readAll` positions are the message's stream sequence
 *   shifted left 20 bits plus the event's place in the batch plus one, so they
 *   increase in stream order and a resume point names one event exactly.
 */
import {
	type EventEnvelope,
	type EventPosition,
	type JsonValue,
	parseEventEnvelope,
} from "@hobo/core";
import {
	DiscardPolicy,
	RetentionPolicy,
	StorageType,
	type StreamConfig,
} from "@nats-io/jetstream";

// public-contract: the stream and subject names of the topology table (design §6.7).
export const JOURNAL_STREAM = "FLEET_JOURNAL";
// public-contract: every journal subject; one token per stream id follows the prefix.
export const JOURNAL_SUBJECTS = "fleet.journal.>";
const SUBJECT_PREFIX = "fleet.journal.";

/**
 * `FLEET_JOURNAL` as the journal needs it, whoever creates it: no expiry,
 * append-only, new messages refused rather than old ones dropped. The store
 * creates it with one replica when missing; `provisionTopology` creates it
 * with the deployment's replica count from this same configuration.
 */
export const JOURNAL_STREAM_CONFIG = {
	name: JOURNAL_STREAM,
	subjects: [JOURNAL_SUBJECTS],
	retention: RetentionPolicy.Limits,
	storage: StorageType.File,
	discard: DiscardPolicy.New,
	max_age: 0,
	deny_delete: true,
	deny_purge: true,
} as const satisfies Partial<StreamConfig>;

/** At most this many events in one append (the position's batch field). */
export const MAX_BATCH_EVENTS = (1 << 20) - 2;
const POSITION_SHIFT = 20n;

const PLAIN = /^[A-Za-z0-9_:-]$/;

export function subjectOfStream(streamId: string): string {
	let token = "";
	for (const char of streamId) {
		if (PLAIN.test(char)) {
			token += char;
			continue;
		}
		for (const byte of new TextEncoder().encode(char))
			token += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return `${SUBJECT_PREFIX}${token}`;
}

export function streamIdOfSubject(subject: string): string {
	if (!subject.startsWith(SUBJECT_PREFIX))
		throw new JournalCorrupt(`subject ${subject} is not a journal subject`);
	try {
		return decodeURIComponent(subject.slice(SUBJECT_PREFIX.length));
	} catch {
		throw new JournalCorrupt(`subject ${subject} does not decode`);
	}
}

export function positionOf(
	streamSequence: number,
	index: number,
): EventPosition {
	// SAFETY: a stream sequence and a batch index are non-negative integers; the shift keeps batch places apart.
	return ((BigInt(streamSequence) << POSITION_SHIFT) +
		BigInt(index + 1)) as EventPosition;
}

/** The stream sequence a position falls in. */
export function streamSequenceOf(position: EventPosition): number {
	return Number(position >> POSITION_SHIFT);
}

export type JournalBatch = Readonly<{
	ownerEpoch: bigint;
	events: readonly EventEnvelope[];
}>;

/** A journal message that is not a batch of the stream it is filed under. */
export class JournalCorrupt extends Error {
	constructor(message: string) {
		super(`journal: ${message}`);
		this.name = "JournalCorrupt";
	}
}

export function encodeBatch(batch: JournalBatch): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify({
			v: 1,
			ownerEpoch: batch.ownerEpoch.toString(),
			events: batch.events,
		}),
	);
}

/** Parses a journal message filed under `streamId`; throws `JournalCorrupt` unless every event is that stream's. */
export function decodeBatch(data: Uint8Array, streamId: string): JournalBatch {
	let parsed: JsonValue;
	try {
		parsed = JSON.parse(new TextDecoder().decode(data));
	} catch {
		throw new JournalCorrupt(`a message of ${streamId} is not JSON`);
	}
	const fields = new Map<string, JsonValue>(
		parsed !== null &&
			!Array.isArray(parsed) &&
			Object.prototype.toString.call(parsed) === "[object Object]"
			? Object.entries(parsed)
			: [],
	);
	const epoch = fields.get("ownerEpoch");
	const events = fields.get("events");
	if (fields.get("v") !== 1 || !Array.isArray(events) || !isDecimal(epoch))
		throw new JournalCorrupt(
			`a message of ${streamId} is not a version-1 batch`,
		);
	const envelopes = events.map((event) => {
		let envelope: EventEnvelope;
		try {
			envelope = parseEventEnvelope(event);
		} catch (cause) {
			throw new JournalCorrupt(
				`a message of ${streamId} holds an event that does not parse: ${cause instanceof Error ? cause.message : String(cause)}`,
			);
		}
		if (envelope.streamId !== streamId)
			throw new JournalCorrupt(
				`a message of ${streamId} holds an event of another stream (${envelope.streamId})`,
			);
		return envelope;
	});
	return { ownerEpoch: BigInt(epoch), events: envelopes };
}

function isDecimal(value: JsonValue | undefined): value is string {
	return (
		Object.prototype.toString.call(value) === "[object String]" &&
		/^\d+$/.test(String(value))
	);
}
