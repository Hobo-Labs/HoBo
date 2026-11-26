import type {
	EventEnvelope as CoreEventEnvelope,
	EventStore,
} from "@hobo/core";

import { cloneAsJson } from "../json.js";
import type { EventEnvelope } from "./types.js";

export interface EventStoreReader {
	readStream(streamId: string): Promise<EventEnvelope[]>;
	readBySeq(streamId: string, seq: number): Promise<EventEnvelope | null>;
}

export function createEventStoreReader(store: EventStore): EventStoreReader {
	return {
		async readStream(streamId) {
			const events: EventEnvelope[] = [];
			for await (const event of store.read(streamId)) {
				events.push(toReplayEnvelope(event));
			}
			return events;
		},
		async readBySeq(streamId, seq) {
			for await (const event of store.read(streamId, seq)) {
				if (event.seq === seq) {
					return toReplayEnvelope(event);
				}
			}
			return null;
		},
	};
}

function toReplayEnvelope(event: CoreEventEnvelope): EventEnvelope {
	const envelope: EventEnvelope = {
		id: event.id,
		streamId: event.streamId,
		seq: event.seq,
		type: event.type,
		v: event.v,
		data: cloneAsJson(event.data),
		ts: event.ts,
	};
	if (event.meta !== undefined) {
		envelope.meta = event.meta;
	}
	return Object.freeze(envelope);
}

export interface EventStoreWriter extends EventStoreReader {
	append(envelope: EventEnvelope, expectedSeq?: number): Promise<void>;
}

export function createInMemoryEventStore(): EventStoreWriter {
	const streams = new Map<string, EventEnvelope[]>();

	return {
		async append(envelope, expectedSeq) {
			const events = streams.get(envelope.streamId) ?? [];
			const currentSeq = events.at(-1)?.seq ?? 0;
			if (expectedSeq !== undefined && currentSeq !== expectedSeq) {
				throw new Error(
					`OCC failure on ${envelope.streamId}: expected ${expectedSeq}, got ${currentSeq}`,
				);
			}
			if (envelope.seq !== currentSeq + 1) {
				throw new Error(`invalid seq ${envelope.seq} on ${envelope.streamId}`);
			}
			events.push(Object.freeze({ ...envelope }));
			streams.set(envelope.streamId, events);
		},

		async readStream(streamId) {
			return [...(streams.get(streamId) ?? [])];
		},

		async readBySeq(streamId, seq) {
			return (
				(streams.get(streamId) ?? []).find((event) => event.seq === seq) ?? null
			);
		},
	};
}
