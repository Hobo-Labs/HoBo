import { isJsonString, isJsonObject } from "./json.js";
export const CAMP_EVENTSTORE_RUNTIME_PORT_CONTRACT_VERSION =
  "hobo.camp-eventstore-runtime-port/v1";

export class OptimisticSequenceConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "OptimisticSequenceConflictError";
  }
}

export function createManualClock(startInstant = "2026-06-26T00:00:00.000Z") {
  let nowMs = normalizeInstant(startInstant, "startInstant");

  return Object.freeze({
    now() {
      return new Date(nowMs).toISOString();
    },
    advance(deltaMs) {
      if (!Number.isSafeInteger(deltaMs) || deltaMs < 0) {
        throw new TypeError("deltaMs must be a non-negative safe integer");
      }
      nowMs += deltaMs;
      return this.now();
    },
  });
}

export function createRuntimeLocalEventStore(options = {}) {
  const clock = options.clock ?? createManualClock();
  const streams = new Map();
  const subscriptions = new Set();

  return Object.freeze({
    async append(streamId, events, appendOptions = {}) {
      const stream = getStream(streams, streamId);
      const inputs = normalizeEventInputs(events);
      const deduped = [];
      const pending = [];
      const pendingByIdempotencyKey = new Map();
      const pendingDuplicateKeys = [];
      for (const input of inputs) {
        const idempotencyKey = getIdempotencyKey(input);
        const previous = idempotencyKey ? stream.idempotency.get(idempotencyKey) : undefined;
        if (previous) {
          deduped.push(previous);
        } else if (idempotencyKey && pendingByIdempotencyKey.has(idempotencyKey)) {
          pendingDuplicateKeys.push(idempotencyKey);
        } else {
          pending.push(input);
          if (idempotencyKey) {
            pendingByIdempotencyKey.set(idempotencyKey, input);
          }
        }
      }

      if (pending.length === 0) {
        return Object.freeze({
          streamId: stream.id,
          appended: [],
          deduped: clone(deduped),
        });
      }

      const expectedSeq = normalizeSeq(appendOptions.expectedSeq, "appendOptions.expectedSeq");
      if (stream.events.length !== expectedSeq) {
        throw new OptimisticSequenceConflictError(
          `stale expectedSeq for ${stream.id}: expected ${expectedSeq}, actual ${stream.events.length}`,
        );
      }

      const appended = [];
      const appendedByIdempotencyKey = new Map();
      for (const input of pending) {
        const envelope = createEnvelope({
          streamId: stream.id,
          seq: stream.events.length + 1,
          input,
          appendOptions,
          clock,
        });
        stream.events.push(envelope);
        const idempotencyKey = getIdempotencyKey(input);
        if (idempotencyKey) {
          stream.idempotency.set(idempotencyKey, envelope);
          appendedByIdempotencyKey.set(idempotencyKey, envelope);
        }
        appended.push(envelope);
        publish(subscriptions, envelope);
      }
      for (const idempotencyKey of pendingDuplicateKeys) {
        deduped.push(appendedByIdempotencyKey.get(idempotencyKey));
      }

      return Object.freeze({
        streamId: stream.id,
        appended: clone(appended),
        deduped: clone(deduped),
      });
    },

    async read(streamId, fromSeq = 1) {
      const stream = getStream(streams, streamId);
      const startSeq = normalizeSeq(fromSeq, "fromSeq");
      return clone(stream.events.filter((event) => event.seq >= startSeq));
    },

    subscribe(filter, handler) {
      if (!(handler instanceof Function)) {
        throw new TypeError("handler must be a function");
      }
      const normalized = normalizeFilter(filter);
      const subscription = { filter: normalized, handler };
      subscriptions.add(subscription);
      return Object.freeze({
        unsubscribe() {
          subscriptions.delete(subscription);
        },
      });
    },

    async snapshot(streamId, state, seq) {
      const stream = getStream(streams, streamId);
      const snapshotSeq = normalizeSeq(seq, "seq");
      if (snapshotSeq > stream.events.length) {
        throw new OptimisticSequenceConflictError(
          `snapshot seq ${snapshotSeq} is ahead of ${stream.id}@${stream.events.length}`,
        );
      }

      stream.snapshot = Object.freeze({
        streamId: stream.id,
        seq: snapshotSeq,
        state: clone(state),
        savedAt: clock.now(),
      });
      return clone(stream.snapshot);
    },

    async fold(streamId, foldOptions = {}) {
      const stream = getStream(streams, streamId);
      const handlers = normalizeHandlers(foldOptions.handlers);
      let state = cloneRequired(foldOptions.initialState, "foldOptions.initialState");
      const quarantined = [];

      for (const event of stream.events) {
        if (isQuarantineEvent(event) || stream.quarantinedSeqs.has(event.seq)) {
          continue;
        }
        const handler = handlers.get(event.type);
        if (!handler) {
          continue;
        }

        try {
          state = clone(handler(clone(state), clone(event)));
        } catch (cause) {
          const quarantine = appendQuarantine({ stream, event, cause, clock, subscriptions });
          quarantined.push({
            offendingSeq: event.seq,
            quarantineSeq: quarantine.seq,
            type: quarantine.type,
            reason: quarantine.data.reason,
          });
        }
      }

      return Object.freeze({
        streamId: stream.id,
        seq: stream.events.length,
        state: clone(state),
        quarantined,
      });
    },
  });
}

export async function runEventStoreConformance(createStore) {
  if (!(createStore instanceof Function)) {
    throw new TypeError("createStore must be a function");
  }

  return Object.freeze({
    contract: CAMP_EVENTSTORE_RUNTIME_PORT_CONTRACT_VERSION,
    backend: "runtime-local",
    assertions: Object.freeze({
      seqConditionalAppend: (await provesSeqConditionalAppend(createStore)) ? "pass" : "fail",
      idempotencyKeyDedup: (await provesIdempotencyKeyDedup(createStore)) ? "pass" : "fail",
      poisonEventQuarantine: (await provesPoisonEventQuarantine(createStore)) ? "pass" : "fail",
      idempotencyCollisionScopedPerStream: (await provesIdempotencyCollisionScope(createStore)) ? "pass" : "fail",
    }),
  });
}

async function provesSeqConditionalAppend(createStore) {
  const store = createStore();
  await store.append("conformance:seq", [{ type: "seq.Started", data: {} }], conformanceOptions(0));
  try {
    await store.append("conformance:seq", [{ type: "seq.Raced", data: {} }], conformanceOptions(0));
    return false;
  } catch (error) {
    return error instanceof OptimisticSequenceConflictError && (await store.read("conformance:seq")).length === 1;
  }
}

async function provesIdempotencyKeyDedup(createStore) {
  const store = createStore();
  const event = {
    type: "payment.Captured",
    data: { amount: 10 },
    meta: { idempotencyKey: "capture-1" },
  };
  await store.append("conformance:dedup", [event], conformanceOptions(0));
  const retry = await store.append("conformance:dedup", [event], conformanceOptions(0));
  return retry.appended.length === 0 && retry.deduped.length === 1 && (await store.read("conformance:dedup")).length === 1;
}

async function provesPoisonEventQuarantine(createStore) {
  const store = createStore();
  await store.append(
    "conformance:poison",
    [
      { type: "ticket.Opened", data: {} },
      { type: "ticket.Commented", data: {} },
    ],
    conformanceOptions(0),
  );
  const folded = await store.fold("conformance:poison", {
    initialState: { comments: 0 },
    handlers: {
      "ticket.Opened": () => {
        throw new Error("missing title");
      },
      "ticket.Commented": (state) => ({ comments: state.comments + 1 }),
    },
  });
  return folded.state.comments === 1 && folded.quarantined.length === 1 && (await store.read("conformance:poison")).length === 3;
}

async function provesIdempotencyCollisionScope(createStore) {
  const store = createStore();
  const event = {
    type: "email.Sent",
    data: { to: "user@example.test" },
    meta: { idempotencyKey: "send-1" },
  };
  await store.append("conformance:stream-a", [event], conformanceOptions(0));
  await store.append("conformance:stream-b", [event], conformanceOptions(0));
  return (await store.read("conformance:stream-a")).length === 1 && (await store.read("conformance:stream-b")).length === 1;
}

function conformanceOptions(expectedSeq) {
  return {
    expectedSeq,
    actor: { kind: "system", id: "conformance" },
    tenant: "conformance-tenant",
  };
}

function appendQuarantine({ stream, event, cause, clock, subscriptions }) {
  if (stream.quarantinedSeqs.has(event.seq)) {
    const existing = stream.events.find(
      (candidate) => isQuarantineEvent(candidate) && candidate.data.offendingSeq === event.seq,
    );
    return existing;
  }

  stream.quarantinedSeqs.add(event.seq);
  const reason = cause instanceof Error ? cause.message : String(cause);
  const quarantine = createEnvelope({
    streamId: stream.id,
    seq: stream.events.length + 1,
    input: {
      type: `${event.type.split(".")[0]}.Quarantined`,
      data: {
        offendingSeq: event.seq,
        offendingType: event.type,
        reason,
      },
      meta: {
        quarantines: event.id,
      },
    },
    appendOptions: {
      actor: { kind: "system", id: "runtime-local" },
      tenant: event.tenant,
      causationId: event.id,
      correlationId: event.correlationId,
    },
    clock,
  });
  stream.events.push(quarantine);
  publish(subscriptions, quarantine);
  return quarantine;
}

function createEnvelope({ streamId, seq, input, appendOptions, clock }) {
  const type = requireNonEmptyString(input.type, "event.type");
  return Object.freeze({
    id: `${streamId}:${seq}:${type}`,
    streamId,
    seq,
    type,
    v: normalizeVersion(input.v ?? 1),
    ts: clock.now(),
    actor: clone(appendOptions.actor),
    tenant: requireNonEmptyString(appendOptions.tenant, "appendOptions.tenant"),
    causationId: optionalString(appendOptions.causationId, "appendOptions.causationId"),
    correlationId: optionalString(appendOptions.correlationId, "appendOptions.correlationId"),
    data: clone(input.data ?? {}),
    meta: Object.freeze(clone(input.meta ?? {})),
  });
}

function publish(subscriptions, envelope) {
  for (const subscription of subscriptions) {
    if (matches(subscription.filter, envelope)) {
      subscription.handler(clone(envelope));
    }
  }
}

function matches(filter, envelope) {
  return (
    (!filter.streamId || filter.streamId === envelope.streamId) &&
    (!filter.type || filter.type === envelope.type)
  );
}

function getStream(streams, streamId) {
  const id = requireNonEmptyString(streamId, "streamId");
  if (!streams.has(id)) {
    streams.set(id, {
      id,
      events: [],
      snapshot: null,
      idempotency: new Map(),
      quarantinedSeqs: new Set(),
    });
  }
  return streams.get(id);
}

function normalizeHandlers(handlers) {
  if (!handlers || !isJsonObject(handlers) || Array.isArray(handlers)) {
    throw new TypeError("foldOptions.handlers must be an object");
  }
  return new Map(Object.entries(handlers).filter(([, handler]) => handler instanceof Function));
}

function isQuarantineEvent(event) {
  return event.type.endsWith(".Quarantined");
}

function getIdempotencyKey(input) {
  const key = input?.meta?.idempotencyKey;
  if (key === undefined) {
    return undefined;
  }
  return requireNonEmptyString(key, "event.meta.idempotencyKey");
}

function normalizeEventInputs(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new TypeError("events must be a non-empty array");
  }
  return events.map((event) => {
    if (!event || !isJsonObject(event) || Array.isArray(event)) {
      throw new TypeError("event must be an object");
    }
    return event;
  });
}

function normalizeFilter(filter) {
  if (!filter || !isJsonObject(filter) || Array.isArray(filter)) {
    throw new TypeError("filter must be an object");
  }
  return Object.freeze({
    streamId: optionalString(filter.streamId, "filter.streamId"),
    type: optionalString(filter.type, "filter.type"),
  });
}

function normalizeVersion(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("event.v must be a positive safe integer");
  }
  return value;
}

function normalizeSeq(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer`);
  }
  return value;
}

function normalizeInstant(value, fieldName) {
  const ms = Date.parse(value);
  if (!isJsonString(value) || Number.isNaN(ms)) {
    throw new TypeError(`${fieldName} must be a valid ISO-8601 string`);
  }
  return ms;
}

function optionalString(value, fieldName) {
  if (value === undefined) {
    return undefined;
  }
  return requireNonEmptyString(value, fieldName);
}

function requireNonEmptyString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone instanceof Function ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function cloneRequired(value, fieldName) {
  if (value === undefined) {
    throw new TypeError(`${fieldName} is required`);
  }
  return clone(value);
}
