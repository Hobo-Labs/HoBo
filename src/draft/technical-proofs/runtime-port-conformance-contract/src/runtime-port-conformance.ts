import {
  createManualClock as createEventStoreClock,
  createRuntimeLocalEventStore,
} from "../../camp-eventstore-runtime-port-contract/src/camp-eventstore-runtime-port.js";
import {
  createRuntimeLocalQueueClock,
} from "../../queue-clock-runtime-port-contract/src/queue-clock-runtime-port.js";
import {
  createInMemoryActorHost,
} from "../../actor-host-runtime-port-contract/src/actor-host-runtime-port.js";
import { isJsonString, isJsonObject } from "./json.js";


export const RUNTIME_PORT_CONFORMANCE_VERSION =
  "hobo.runtime-port-conformance/v1";

export function createRuntimeLocalDurabilityBackend() {
  return Object.freeze({
    name: "runtime-local",
    eventStore: createRuntimeLocalEventStore({
      clock: createEventStoreClock("2026-06-26T00:00:00.000Z"),
    }),
    queueClock: createRuntimeLocalQueueClock({
      seed: "runtime-port-conformance",
      startInstant: "2026-06-26T00:00:00.000Z",
    }),
    actorHost: createInMemoryActorHost(),
  });
}

export function createBrokenFenceRuntimeBackend() {
  const base = createRuntimeLocalDurabilityBackend();

  return Object.freeze({
    ...base,
    name: "runtime-local",
    actorHost: createBrokenFenceActorHost(),
  });
}

export async function runRuntimePortDurabilitySuite(createBackend) {
  if (!(createBackend instanceof Function)) {
    throw new TypeError("createBackend must be a function");
  }

  const probe = createBackend();
  const checks = [];
  const failures = [];

  for (const definition of CHECKS) {
    const backend = createBackend();
    let passed = false;
    let message = definition.failureMessage;

    try {
      passed = await definition.run(backend);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    checks.push(Object.freeze({
      checkId: definition.checkId,
      port: definition.port,
      tag: "local",
      status: passed ? "pass" : "fail",
    }));

    if (!passed) {
      failures.push(Object.freeze({
        checkId: definition.checkId,
        message,
      }));
    }
  }

  return Object.freeze({
    contract: RUNTIME_PORT_CONFORMANCE_VERSION,
    backend: probe.name,
    status: failures.length === 0 ? "pass" : "fail",
    checks: Object.freeze(checks),
    failures: Object.freeze(failures),
    coverage: Object.freeze({
      local: Object.freeze({
        status: failures.length === 0 ? "pass" : "fail",
        passed: checks.filter((check) => check.status === "pass").length,
        failed: failures.length,
        total: checks.length,
      }),
    }),
  });
}

export async function proveCheckoutDurability(backend) {
  const runId = "checkout:run-1";
  const streamId = runId;
  const { eventStore, queueClock, actorHost } = backend;

  await eventStore.append(
    streamId,
    [{ type: "checkout.Started", data: { runId } }],
    appendOptions(0, "checkout-started"),
  );

  const cart = actorHost.state(`cart:${runId}`, {
    initialState: { reservedItems: [] },
    fold: (state, event) =>
      event.type === "cart.ItemReserved"
        ? { reservedItems: [...state.reservedItems, event.sku] }
        : state,
  });
  const cartLease = actorHost.acquire(`cart:${runId}`, { holderId: "checkout-worker" });
  cart.append(cartLease, { type: "cart.ItemReserved", sku: "sku-hobo-mug" });

  await eventStore.append(
    streamId,
    [{ type: "checkout.ItemReserved", data: { sku: "sku-hobo-mug" } }],
    appendOptions(1, "checkout-reserved"),
  );

  queueClock.clock.sleep(runId, 30_000, {
    idempotencyKey: `timeout:${runId}`,
    label: "payment-timeout",
  });
  const queued = await queueClock.queue.enqueue(
    "payments",
    { runId, cents: 4200 },
    { idempotencyKey: `charge:${runId}` },
  );
  await queueClock.queue.enqueue(
    "payments",
    { runId, cents: 4200 },
    { idempotencyKey: `charge:${runId}` },
  );

  const queueEffects = [];
  await queueClock.queue.handle("payments", async (message) => {
    queueEffects.push(message.idempotencyKey);
    await eventStore.append(
      streamId,
      [{ type: "checkout.PaymentCaptured", data: { cents: message.body.cents } }],
      appendOptions(2, "checkout-paid"),
    );
  });
  queueClock.queue.simulateRedelivery(queued.messageId);
  await queueClock.queue.handle("payments", async (message) => {
    queueEffects.push(message.idempotencyKey);
  });

  queueClock.clock.advance(30_000);

  await eventStore.append(
    streamId,
    [{ type: "checkout.Completed", data: { status: "paid" } }],
    appendOptions(3, "checkout-completed"),
  );

  const live = await eventStore.fold(streamId, {
    initialState: checkoutInitialState(runId),
    handlers: checkoutHandlers(),
  });
  const events = await eventStore.read(streamId);
  const replayState = foldCheckoutEvents(events, runId);

  return Object.freeze({
    liveState: live.state,
    replayState,
    queueEffects: Object.freeze(queueEffects),
    clockTrace: Object.freeze(
      queueClock.clock
        .trace()
        .filter((entry) => entry.type.startsWith("clock.") || entry.type.startsWith("timer.")),
    ),
  });
}

const CHECKS = Object.freeze([
  Object.freeze({
    checkId: "eventStore.local.seq-conditional-append",
    port: "EventStore",
    failureMessage: "stale expectedSeq append was accepted",
    run: provesSeqConditionalAppend,
  }),
  Object.freeze({
    checkId: "eventStore.local.idempotency-key-dedup",
    port: "EventStore",
    failureMessage: "duplicate EventStore idempotency key was appended twice",
    run: provesEventStoreIdempotency,
  }),
  Object.freeze({
    checkId: "queue.local.idempotency-key-dedup",
    port: "Queue",
    failureMessage: "duplicate Queue idempotency key was enqueued twice",
    run: provesQueueIdempotency,
  }),
  Object.freeze({
    checkId: "actorHost.local.stale-fence-rejected",
    port: "ActorHost",
    failureMessage: "stale lease append was accepted",
    run: provesActorHostStaleFence,
  }),
  Object.freeze({
    checkId: "runtime.local.checkout-replay-equals-live",
    port: "Runtime",
    failureMessage: "checkout replay state diverged from live state",
    run: provesCheckoutReplayEqualsLive,
  }),
]);

async function provesSeqConditionalAppend(backend) {
  const { eventStore } = backend;
  await eventStore.append(
    "seq-check",
    [{ type: "seq.Started", data: {} }],
    appendOptions(0, "seq-started"),
  );

  try {
    await eventStore.append(
      "seq-check",
      [{ type: "seq.Raced", data: {} }],
      appendOptions(0, "seq-raced"),
    );
    return false;
  } catch {
    return (await eventStore.read("seq-check")).length === 1;
  }
}

async function provesEventStoreIdempotency(backend) {
  const { eventStore } = backend;
  const event = {
    type: "payment.Captured",
    data: { cents: 4200 },
    meta: { idempotencyKey: "payment-1" },
  };

  await eventStore.append("eventstore-dedup", [event], appendOptions(0, "payment"));
  const retry = await eventStore.append(
    "eventstore-dedup",
    [event],
    appendOptions(0, "payment-retry"),
  );

  return retry.appended.length === 0 &&
    retry.deduped.length === 1 &&
    (await eventStore.read("eventstore-dedup")).length === 1;
}

async function provesQueueIdempotency(backend) {
  const { queueClock } = backend;
  const first = await queueClock.queue.enqueue(
    "payments",
    { cents: 4200 },
    { idempotencyKey: "charge-1" },
  );
  const retry = await queueClock.queue.enqueue(
    "payments",
    { cents: 4200 },
    { idempotencyKey: "charge-1" },
  );

  return retry.deduped === true && retry.messageId === first.messageId;
}

function provesActorHostStaleFence(backend) {
  const key = "actor:checkout:stale-fence";
  const state = backend.actorHost.state(key, {
    initialState: { value: 0 },
    fold: (current, event) =>
      event.type === "counter.Added"
        ? { value: current.value + event.amount }
        : current,
  });
  const firstLease = backend.actorHost.acquire(key, { holderId: "worker-a" });
  state.append(firstLease, { type: "counter.Added", amount: 1 });
  firstLease.release();
  const secondLease = backend.actorHost.acquire(key, { holderId: "worker-b" });

  try {
    state.append(firstLease, { type: "counter.Added", amount: 100 });
    return false;
  } catch {
    state.append(secondLease, { type: "counter.Added", amount: 2 });
    return state.read().state.value === 3;
  }
}

async function provesCheckoutReplayEqualsLive(backend) {
  const proof = await proveCheckoutDurability(backend);
  return stableStringify(proof.liveState) === stableStringify(proof.replayState);
}

function checkoutInitialState(runId) {
  return {
    runId,
    status: "pending",
    reservedItems: [],
    chargedCents: 0,
    duplicateCharges: 0,
    timedOut: false,
  };
}

function checkoutHandlers() {
  return {
    "checkout.Started": (state) => ({ ...state, status: "started" }),
    "checkout.ItemReserved": (state, event) => ({
      ...state,
      reservedItems: [...state.reservedItems, event.data.sku],
    }),
    "checkout.PaymentCaptured": (state, event) => ({
      ...state,
      status: "paid",
      duplicateCharges: state.chargedCents > 0 ? state.duplicateCharges + 1 : state.duplicateCharges,
      chargedCents: state.chargedCents + event.data.cents,
    }),
    "checkout.Completed": (state, event) => ({ ...state, status: event.data.status }),
    "checkout.TimedOut": (state) => ({ ...state, status: "timed-out", timedOut: true }),
  };
}

function foldCheckoutEvents(events, runId) {
  const handlers = checkoutHandlers();
  let state = checkoutInitialState(runId);

  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    const handler = handlers[event.type];
    if (handler) {
      state = handler(state, event);
    }
  }

  return state;
}

function appendOptions(expectedSeq, correlationId) {
  return {
    expectedSeq,
    actor: { kind: "system", id: "runtime-port-conformance" },
    tenant: "conformance-tenant",
    correlationId,
  };
}

function createBrokenFenceActorHost() {
  const streams = new Map();
  const leases = new Map();

  return Object.freeze({
    acquire(key, request = {}) {
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

    state(key, request = {}) {
      const actorKey = requireNonEmptyString(key, "key");
      if (!(request.fold instanceof Function)) {
        throw new TypeError("request.fold must be a function");
      }
      const stream = getBrokenStream(streams, actorKey);
      const initialState = clone(request.initialState);

      return Object.freeze({
        append(lease, event) {
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
            state = request.fold(state, clone(event));
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

function getBrokenStream(streams, key) {
  if (!streams.has(key)) {
    streams.set(key, { events: [] });
  }
  return streams.get(key);
}

function requireNonEmptyString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  }
  return value;
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone instanceof Function
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}
