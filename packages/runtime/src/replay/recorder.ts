import type { JsonObject, JsonValue } from "../json.js";
import type { EventStoreWriter } from "./store.js";
import type { EventEnvelope } from "./types.js";

export async function recordEffect(
	store: EventStoreWriter,
	envelope: EventEnvelope,
	expectedSeq?: number,
): Promise<EventEnvelope> {
	await store.append(envelope, expectedSeq);
	return envelope;
}

export function nextEnvelope(
	streamId: string,
	seq: number,
	type: string,
	data: JsonValue,
	options: { id?: string; meta?: JsonObject; ts?: string } = {},
): EventEnvelope {
	const envelope: EventEnvelope = {
		id: options.id ?? `${streamId}-${seq}`,
		streamId,
		seq,
		type,
		data,
	};
	if (options.ts !== undefined) {
		envelope.ts = options.ts;
	}
	if (options.meta !== undefined) {
		envelope.meta = options.meta;
	}
	return Object.freeze(envelope);
}
