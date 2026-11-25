import type { EventEnvelope } from "./types.js";
import type { EventStoreWriter } from "./store.js";
import { type JsonValue, type JsonObject } from "./json.js";


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
  return Object.freeze({
    id: options.id ?? `${streamId}-${seq}`,
    streamId,
    seq,
    type,
    data,
    ts: options.ts,
    meta: options.meta,
  });
}
