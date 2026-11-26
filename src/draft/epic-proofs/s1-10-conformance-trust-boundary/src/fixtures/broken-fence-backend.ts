import { type JsonValue, isJsonString } from "../json.js";
import { createRuntimeLocalDurabilityBackend } from "./reference-backend.js";
import type { RuntimeDurabilityBackend } from "../runtime-port/types.js";

export function createBrokenFenceRuntimeBackend(): RuntimeDurabilityBackend {
  const base = createRuntimeLocalDurabilityBackend();

  return Object.freeze({
    ...base,
    name: "runtime-local",
    actorHost: createBrokenFenceActorHost(),
  });
}

type BrokenStreamEvent = {
  type: string;
  amount?: number;
  streamId: string;
  seq: number;
  fenceToken?: bigint;
};

function createBrokenFenceActorHost() {
  const streams = new Map<string, { events: BrokenStreamEvent[] }>();
  const leases = new Map();

  return Object.freeze({
    acquire(key: string, request: { holderId?: string } = {}) {
      const actorKey = requireNonEmptyString(key, "key");
      const holderId = requireNonEmptyString(request.holderId, "request.holderId");
      const prior = leases.get(actorKey);
      const lease = Object.freeze({
        key: actorKey,
        holderId,
        fenceToken: (prior?.fenceToken ?? 0n) + 1n,
        expiresAt: "9999-12-31T23:59:59.999Z",
        renew() {
          return this;
        },
        release() {},
      });
      leases.set(actorKey, lease);
      return lease;
    },

    state<T>(key: string, request: { fold?: (state: T, event: { type: string; amount?: number }) => T; initialState?: T } = {}) {
      const actorKey = requireNonEmptyString(key, "key");
      if (!(request.fold instanceof Function)) {
        throw new TypeError("request.fold must be a function");
      }
      const stream = getBrokenStream(streams, actorKey);
      const initialState = clone(request.initialState);

      return Object.freeze({
        append(lease: { fenceToken?: bigint }, event: { type: string; amount?: number }) {
          const record = Object.freeze({
            ...clone(event),
            streamId: actorKey,
            seq: stream.events.length + 1,
            fenceToken: lease?.fenceToken,
          });
          stream.events.push(record);
          return Object.freeze({
            streamId: actorKey,
            seq: record.seq,
            fenceToken: record.fenceToken,
          });
        },
        read() {
          let state = clone(initialState);
          for (const event of stream.events) {
            // SAFETY: fold is generic over T; clone(initialState) starts as T | undefined.
            const current: T = state as T;
            state = request.fold!(current, clone(event));
          }
          return Object.freeze({
            streamId: actorKey,
            seq: stream.events.length,
            state,
          });
        },
        passivate() {
          return this.read();
        },
      });
    },
  });
}

function getBrokenStream(streams: Map<string, { events: BrokenStreamEvent[] }>, key: string) {
  if (!streams.has(key)) {
    streams.set(key, { events: [] });
  }
  return streams.get(key)!;
}

function requireNonEmptyString(value: JsonValue, fieldName: string): string {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function clone<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return structuredClone instanceof Function
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}
