import {
	type EventEnvelope,
	type EventPosition,
	type JsonValue,
	parseEventEnvelope,
	parseEventPosition,
} from "@hobo/core";
import {
	DiscardPolicy,
	RetentionPolicy,
	StorageType,
	type StreamConfig,
} from "@nats-io/jetstream";

// public-contract: the stream and subject names of the topology table.
export const JOURNAL_STREAM = "FLEET_JOURNAL";
// public-contract: every journal subject; one token per stream id follows the prefix.
export const JOURNAL_SUBJECTS = "fleet.journal.>";
const SUBJECT_PREFIX = "fleet.journal.";

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
	return parseEventPosition(
		(BigInt(streamSequence) << POSITION_SHIFT) + BigInt(index + 1),
	);
}

export function streamSequenceOf(position: EventPosition): number {
	return Number(position >> POSITION_SHIFT);
}

export type JournalBatch = Readonly<{
	ownerEpoch: bigint;
	events: readonly EventEnvelope[];
}>;

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
