import assert from "node:assert/strict";
import { isJsonString } from "./json.js";


export const QUEUE_CLOCK_RUNTIME_PORT_CONTRACT_VERSION =
  "hobo.queue-clock-runtime-port/v1";

export class QueueLeaseLostError extends Error {
  constructor(message) {
    super(message);
    this.name = "QueueLeaseLostError";
  }
}

export class NondeterministicClockError extends Error {
  constructor(message) {
    super(message);
    this.name = "NondeterministicClockError";
  }
}

export function createRuntimeLocalQueueClock(options = {}) {
  const store = normalizeStore(options);

  return Object.freeze({
    queue: createQueuePort(store),
    clock: createClockPort(store),
    snapshot() {
      return clone(store);
    },
  });
}

export function replayClockTrace(trace, options = {}) {
  const entries = cloneRequiredArray(trace, "trace");
  const started = entries.find((entry) => entry.type === "clock.started");

  if (!started) {
    throw new NondeterministicClockError("trace is missing clock.started");
  }
  if (options.seed !== undefined && options.seed !== started.seed) {
    throw new NondeterministicClockError(
      `seed mismatch: expected ${started.seed}, got ${options.seed}`,
    );
  }

  const replay = createRuntimeLocalQueueClock({
    seed: started.seed,
    startInstant: formatInstant(started.atMs),
  });
  const actualFires = [];

  for (const entry of entries) {
    if (entry.type === "timer.scheduled") {
      replay.clock.sleep(entry.runId, entry.delayMs, {
        idempotencyKey: entry.idempotencyKey,
        label: entry.label,
      });
    } else if (entry.type === "cron.scheduled") {
      replay.clock.cron(entry.scheduleId, {
        everyMs: entry.everyMs,
        startAtMs: entry.startAtMs,
      });
    } else if (entry.type === "clock.advanced") {
      actualFires.push(...replay.clock.advance(entry.deltaMs).map(normalizeFiredTraceEntry));
    }
  }

  const expectedFires = entries
    .filter((entry) => entry.type === "timer.fired" || entry.type === "cron.fired")
    .map(normalizeFiredTraceEntry);

  try {
    assert.deepEqual(actualFires, expectedFires);
  } catch {
    throw new NondeterministicClockError("replay fire facts diverged from live trace");
  }

  return Object.freeze({
    seed: started.seed,
    fireOrder: Object.freeze(actualFires.map((fire) => fire.fireId)),
    finalNow: replay.clock.now(),
  });
}

export async function runQueueClockConformance(createRuntime = createRuntimeLocalQueueClock) {
  if (!(createRuntime instanceof Function)) {
    throw new TypeError("createRuntime must be a function");
  }

  return Object.freeze({
    contract: QUEUE_CLOCK_RUNTIME_PORT_CONTRACT_VERSION,
    backend: "runtime-local",
    assertions: Object.freeze({
      queueIdempotencyKeyDedup: (await provesQueueIdempotencyKeyDedup(createRuntime)) ? "pass" : "fail",
      atLeastOnceRetry: (await provesAtLeastOnceRetry(createRuntime)) ? "pass" : "fail",
      redeliveryDedup: (await provesRedeliveryDedup(createRuntime)) ? "pass" : "fail",
      durableTimerRestart: provesDurableTimerRestart(createRuntime) ? "pass" : "fail",
      durableCronRestart: provesDurableCronRestart(createRuntime) ? "pass" : "fail",
      seededClockReplay: provesSeededClockReplay(createRuntime) ? "pass" : "fail",
    }),
  });
}

function createQueuePort(store) {
  return Object.freeze({
    async enqueue(queueName, body, options = {}) {
      const queue = getQueue(store, queueName);
      const idempotencyKey = requireNonEmptyString(options.idempotencyKey, "options.idempotencyKey");
      const previous = queue.messages.find((message) => message.idempotencyKey === idempotencyKey);

      if (previous) {
        appendTrace(store, {
          type: "queue.enqueue.deduped",
          queueName: queue.name,
          messageId: previous.messageId,
          idempotencyKey,
        });
        return queueEnqueueResult(previous, true);
      }

      const message = {
        messageId: `msg-${store.nextMessageSeq++}`,
        queueName: queue.name,
        idempotencyKey,
        body: clone(body),
        state: "pending",
        availableAtMs: normalizeNonNegativeInteger(options.availableAtMs ?? store.nowMs, "options.availableAtMs"),
        deliveryAttempt: 0,
        leaseId: null,
        leaseExpiresAtMs: null,
        completedAtMs: null,
        processing: false,
      };
      queue.messages.push(message);
      appendTrace(store, {
        type: "queue.enqueued",
        queueName: queue.name,
        messageId: message.messageId,
        idempotencyKey,
      });

      return queueEnqueueResult(message, false);
    },

    dequeue(queueName, options = {}) {
      const queue = getQueue(store, queueName);
      const maxMessages = normalizePositiveInteger(options.maxMessages ?? 1, "options.maxMessages");
      const visibilityTimeoutMs = normalizePositiveInteger(
        options.visibilityTimeoutMs ?? 30_000,
        "options.visibilityTimeoutMs",
      );
      const leased = [];

      for (const message of queue.messages) {
        if (leased.length >= maxMessages) {
          break;
        }
        if (!isAvailableForLease(message, store.nowMs)) {
          continue;
        }

        message.state = "leased";
        message.deliveryAttempt += 1;
        message.leaseId = `lease-${store.nextLeaseSeq++}`;
        message.leaseExpiresAtMs = store.nowMs + visibilityTimeoutMs;
        leased.push(publicMessage(message));
      }

      return Object.freeze(leased);
    },

    async handle(queueName, handler, options = {}) {
      if (!(handler instanceof Function)) {
        throw new TypeError("handler must be a function");
      }
      const leased = this.dequeue(queueName, options);
      const handled = [];
      const deduped = [];

      for (const message of leased) {
        const record = findMessageById(store, message.messageId);
        if (record.completedAtMs !== null) {
          this.complete(message.messageId, message.leaseId);
          deduped.push(message.messageId);
          continue;
        }

        try {
          record.processing = true;
          await handler(message);
          this.complete(message.messageId, message.leaseId);
          handled.push(message.messageId);
        } catch (error) {
          record.processing = false;
          releaseForRetry(record, store, message.leaseId);
          throw error;
        }
      }

      return Object.freeze({
        handled: Object.freeze(handled),
        deduped: Object.freeze(deduped),
      });
    },

    complete(messageId, leaseId) {
      const message = findMessageById(store, messageId);
      if (message.completedAtMs !== null) {
      message.state = "completed";
      message.leaseId = null;
      message.leaseExpiresAtMs = null;
      message.processing = false;
      return Object.freeze({ messageId: message.messageId, deduped: true });
      }
      validateLease(message, leaseId);
      message.state = "completed";
      message.completedAtMs = store.nowMs;
      message.leaseId = null;
      message.leaseExpiresAtMs = null;
      message.processing = false;
      appendTrace(store, {
        type: "queue.completed",
        queueName: message.queueName,
        messageId: message.messageId,
        idempotencyKey: message.idempotencyKey,
      });
      return Object.freeze({ messageId: message.messageId, deduped: false });
    },

    release(messageId, leaseId) {
      const message = findMessageById(store, messageId);
      validateLease(message, leaseId);
      releaseForRetry(message, store);
      return Object.freeze({ messageId: message.messageId });
    },

    simulateRedelivery(messageId) {
      const message = findMessageById(store, messageId);
      message.state = "pending";
      message.availableAtMs = store.nowMs;
      message.leaseId = null;
      message.leaseExpiresAtMs = null;
      appendTrace(store, {
        type: "queue.redelivered",
        queueName: message.queueName,
        messageId: message.messageId,
        idempotencyKey: message.idempotencyKey,
      });
      return Object.freeze({ messageId: message.messageId });
    },

    async signal(actorKey, msg, options = {}) {
      const key = requireNonEmptyString(actorKey, "actorKey");
      const idempotencyKey = requireNonEmptyString(options.idempotencyKey, "options.idempotencyKey");
      const queueName = `actor:${key}`;
      const result = await this.enqueue(queueName, { actorKey: key, msg: clone(msg) }, { idempotencyKey });
      return Object.freeze({ ...result, queueName });
    },
  });
}

function createClockPort(store) {
  return Object.freeze({
    now() {
      return formatInstant(store.nowMs);
    },

    nowMs() {
      return store.nowMs;
    },

    sleep(runId, delayMs, options = {}) {
      const idempotencyKey = requireNonEmptyString(options.idempotencyKey, "options.idempotencyKey");
      const previous = store.timers.find((timer) => timer.idempotencyKey === idempotencyKey);
      if (previous) {
        return publicSleepTimer(previous, true);
      }

      const delay = normalizeNonNegativeInteger(delayMs, "delayMs");
      const timer = {
        timerId: `timer-${store.nextTimerSeq++}`,
        kind: "sleep",
        runId: requireNonEmptyString(runId, "runId"),
        label: optionalString(options.label, "options.label"),
        idempotencyKey,
        scheduledAtMs: store.nowMs,
        fireAtMs: store.nowMs + delay,
        firedAtMs: null,
        firedOrder: null,
      };
      store.timers.push(timer);
      appendTrace(store, {
        type: "timer.scheduled",
        timerId: timer.timerId,
        runId: timer.runId,
        label: timer.label,
        idempotencyKey: timer.idempotencyKey,
        delayMs: delay,
        scheduledAtMs: timer.scheduledAtMs,
        fireAtMs: timer.fireAtMs,
      });

      return publicSleepTimer(timer, false);
    },

    cron(scheduleId, spec = {}) {
      const id = requireNonEmptyString(scheduleId, "scheduleId");
      const previous = store.cronSchedules.find((schedule) => schedule.scheduleId === id);
      if (previous) {
        return publicCronSchedule(previous, true);
      }

      const everyMs = normalizePositiveInteger(spec.everyMs, "spec.everyMs");
      const startAtMs = normalizeNonNegativeInteger(spec.startAtMs ?? store.nowMs + everyMs, "spec.startAtMs");
      const schedule = {
        scheduleId: id,
        everyMs,
        startAtMs,
        nextFireAtMs: startAtMs,
        occurrence: 0,
      };
      store.cronSchedules.push(schedule);
      appendTrace(store, {
        type: "cron.scheduled",
        scheduleId: id,
        everyMs,
        startAtMs,
      });

      return publicCronSchedule(schedule, false);
    },

    advance(deltaMs) {
      const delta = normalizeNonNegativeInteger(deltaMs, "deltaMs");
      const fromMs = store.nowMs;
      store.nowMs += delta;
      appendTrace(store, {
        type: "clock.advanced",
        deltaMs: delta,
        fromMs,
        toMs: store.nowMs,
      });

      const fired = [];
      for (;;) {
        const due = nextDueFire(store);
        if (!due) {
          break;
        }
        fired.push(fireDue(store, due));
      }
      return Object.freeze(fired);
    },

    trace() {
      return clone(store.trace);
    },
  });
}

function nextDueFire(store) {
  const candidates = [];
  for (const timer of store.timers) {
    if (timer.firedAtMs === null && timer.fireAtMs <= store.nowMs) {
      candidates.push({ kind: "sleep", key: timer.timerId, fireAtMs: timer.fireAtMs, timer });
    }
  }
  for (const schedule of store.cronSchedules) {
    if (schedule.nextFireAtMs <= store.nowMs) {
      candidates.push({
        kind: "cron",
        key: schedule.scheduleId,
        fireAtMs: schedule.nextFireAtMs,
        schedule,
      });
    }
  }

  candidates.sort(
    (left, right) =>
      left.fireAtMs - right.fireAtMs ||
      left.kind.localeCompare(right.kind) ||
      left.key.localeCompare(right.key),
  );
  return candidates[0];
}

function fireDue(store, due) {
  const order = store.nextFireSeq++;
  if (due.kind === "sleep") {
    due.timer.firedAtMs = due.fireAtMs;
    due.timer.firedOrder = order;
    const fired = Object.freeze({
      fireId: `timer:${due.timer.timerId}`,
      kind: "sleep",
      timerId: due.timer.timerId,
      runId: due.timer.runId,
      label: due.timer.label,
      at: formatInstant(due.fireAtMs),
      order,
    });
    appendTrace(store, {
      type: "timer.fired",
      fireId: fired.fireId,
      timerId: fired.timerId,
      runId: fired.runId,
      atMs: due.fireAtMs,
      order,
    });
    return fired;
  }

  due.schedule.occurrence += 1;
  const occurrence = due.schedule.occurrence;
  const fireAtMs = due.schedule.nextFireAtMs;
  due.schedule.nextFireAtMs += due.schedule.everyMs;
  const fired = Object.freeze({
    fireId: `cron:${due.schedule.scheduleId}:${occurrence}`,
    kind: "cron",
    scheduleId: due.schedule.scheduleId,
    occurrence,
    at: formatInstant(fireAtMs),
    order,
  });
  appendTrace(store, {
    type: "cron.fired",
    fireId: fired.fireId,
    scheduleId: fired.scheduleId,
    occurrence,
    atMs: fireAtMs,
    order,
  });
  return fired;
}

async function provesQueueIdempotencyKeyDedup(createRuntime) {
  const runtime = createRuntime();
  const first = await runtime.queue.enqueue("jobs", { name: "send" }, { idempotencyKey: "job-1" });
  const retry = await runtime.queue.enqueue("jobs", { name: "send" }, { idempotencyKey: "job-1" });
  return retry.deduped === true && retry.messageId === first.messageId;
}

async function provesAtLeastOnceRetry(createRuntime) {
  const runtime = createRuntime();
  await runtime.queue.enqueue("jobs", { name: "retry" }, { idempotencyKey: "job-1" });
  let attempts = 0;
  try {
    await runtime.queue.handle("jobs", async () => {
      attempts += 1;
      throw new Error("transient");
    });
  } catch {
    // Expected retry path.
  }
  await runtime.queue.handle("jobs", async () => {
    attempts += 1;
  });
  return attempts === 2;
}

async function provesRedeliveryDedup(createRuntime) {
  const runtime = createRuntime();
  const enqueued = await runtime.queue.enqueue("jobs", { name: "once" }, { idempotencyKey: "job-1" });
  const effects = [];
  await runtime.queue.handle("jobs", async (message) => effects.push(message.idempotencyKey));
  runtime.queue.simulateRedelivery(enqueued.messageId);
  await runtime.queue.handle("jobs", async (message) => effects.push(message.idempotencyKey));
  return effects.length === 1;
}

function provesDurableTimerRestart(createRuntime) {
  const runtime = createRuntime({ seed: "timer-restart", startInstant: "2026-06-26T00:00:00.000Z" });
  const timer = runtime.clock.sleep("run-1", 1_000, { idempotencyKey: "sleep-1" });
  const restarted = createRuntime({ snapshot: runtime.snapshot() });
  const fired = restarted.clock.advance(1_000);
  const restartedAgain = createRuntime({ snapshot: restarted.snapshot() });
  return (
    fired.length === 1 &&
    fired[0].timerId === timer.timerId &&
    restarted.clock.advance(0).length === 0 &&
    restartedAgain.clock.advance(1_000).length === 0
  );
}

function provesDurableCronRestart(createRuntime) {
  const runtime = createRuntime({ seed: "cron-restart", startInstant: "2026-06-26T00:00:00.000Z" });
  runtime.clock.cron("heartbeat", { everyMs: 1_000 });
  const restarted = createRuntime({ snapshot: runtime.snapshot() });
  const fired = restarted.clock.advance(1_000);
  const restartedAgain = createRuntime({ snapshot: restarted.snapshot() });
  return (
    fired.length === 1 &&
    fired[0].fireId === "cron:heartbeat:1" &&
    restartedAgain.clock.advance(0).length === 0
  );
}

function provesSeededClockReplay(createRuntime) {
  const runtime = createRuntime({ seed: "seeded", startInstant: "2026-06-26T00:00:00.000Z" });
  runtime.clock.sleep("slow", 30, { idempotencyKey: "slow" });
  runtime.clock.sleep("fast", 10, { idempotencyKey: "fast" });
  runtime.clock.advance(10);
  runtime.clock.advance(20);
  const replay = replayClockTrace(runtime.clock.trace(), { seed: "seeded" });
  return replay.fireOrder.join(",") === "timer:timer-2,timer:timer-1";
}

function normalizeStore(options) {
  if (options.snapshot) {
    const snapshot = clone(options.snapshot);
    if (options.seed !== undefined && options.seed !== snapshot.seed) {
      throw new NondeterministicClockError(
        `snapshot seed mismatch: expected ${snapshot.seed}, got ${options.seed}`,
      );
    }
    return {
      version: QUEUE_CLOCK_RUNTIME_PORT_CONTRACT_VERSION,
      seed: requireNonEmptyString(snapshot.seed, "snapshot.seed"),
      nowMs: normalizeNonNegativeInteger(snapshot.nowMs, "snapshot.nowMs"),
      nextMessageSeq: normalizePositiveInteger(snapshot.nextMessageSeq, "snapshot.nextMessageSeq"),
      nextLeaseSeq: normalizePositiveInteger(snapshot.nextLeaseSeq, "snapshot.nextLeaseSeq"),
      nextTimerSeq: normalizePositiveInteger(snapshot.nextTimerSeq, "snapshot.nextTimerSeq"),
      nextFireSeq: normalizePositiveInteger(snapshot.nextFireSeq, "snapshot.nextFireSeq"),
      queues: snapshot.queues ?? {},
      timers: snapshot.timers ?? [],
      cronSchedules: snapshot.cronSchedules ?? [],
      trace: snapshot.trace ?? [],
    };
  }

  const seed = requireNonEmptyString(options.seed ?? "runtime-local-seed", "options.seed");
  const nowMs = parseInstantMs(options.startInstant ?? "2026-06-26T00:00:00.000Z", "options.startInstant");
  const store = {
    version: QUEUE_CLOCK_RUNTIME_PORT_CONTRACT_VERSION,
    seed,
    nowMs,
    nextMessageSeq: 1,
    nextLeaseSeq: 1,
    nextTimerSeq: 1,
    nextFireSeq: 1,
    queues: {},
    timers: [],
    cronSchedules: [],
    trace: [],
  };
  appendTrace(store, {
    type: "clock.started",
    seed,
    atMs: nowMs,
    at: formatInstant(nowMs),
  });
  return store;
}

function getQueue(store, queueName) {
  const name = requireNonEmptyString(queueName, "queueName");
  store.queues[name] ??= { name, messages: [] };
  return store.queues[name];
}

function isAvailableForLease(message, nowMs) {
  if (message.processing) {
    return false;
  }
  if (message.completedAtMs !== null && message.state === "completed") {
    return false;
  }
  if (message.availableAtMs > nowMs) {
    return false;
  }
  return message.state === "pending" || (message.state === "leased" && message.leaseExpiresAtMs <= nowMs);
}

function publicMessage(message) {
  return Object.freeze({
    messageId: message.messageId,
    queueName: message.queueName,
    idempotencyKey: message.idempotencyKey,
    body: clone(message.body),
    leaseId: message.leaseId,
    leaseExpiresAt: formatInstant(message.leaseExpiresAtMs),
    deliveryAttempt: message.deliveryAttempt,
  });
}

function queueEnqueueResult(message, deduped) {
  return Object.freeze({
    messageId: message.messageId,
    idempotencyKey: message.idempotencyKey,
    deduped,
  });
}

function publicSleepTimer(timer, deduped) {
  return Object.freeze({
    timerId: timer.timerId,
    runId: timer.runId,
    idempotencyKey: timer.idempotencyKey,
    fireAt: formatInstant(timer.fireAtMs),
    deduped,
  });
}

function publicCronSchedule(schedule, deduped) {
  return Object.freeze({
    scheduleId: schedule.scheduleId,
    everyMs: schedule.everyMs,
    nextFireAt: formatInstant(schedule.nextFireAtMs),
    deduped,
  });
}

function findMessageById(store, messageId) {
  const id = requireNonEmptyString(messageId, "messageId");
  for (const queue of Object.values(store.queues)) {
    const message = queue.messages.find((candidate) => candidate.messageId === id);
    if (message) {
      return message;
    }
  }
  throw new QueueLeaseLostError(`unknown message ${id}`);
}

function validateLease(message, leaseId) {
  const lease = requireNonEmptyString(leaseId, "leaseId");
  if (message.leaseId !== lease) {
    throw new QueueLeaseLostError(`lease lost for ${message.messageId}`);
  }
}

function releaseForRetry(message, store, leaseId = message.leaseId) {
  if (message.leaseId !== leaseId) {
    return false;
  }
  message.state = "pending";
  message.availableAtMs = store.nowMs;
  message.leaseId = null;
  message.leaseExpiresAtMs = null;
  message.processing = false;
  appendTrace(store, {
    type: "queue.released",
    queueName: message.queueName,
    messageId: message.messageId,
    idempotencyKey: message.idempotencyKey,
  });
  return true;
}

function appendTrace(store, event) {
  store.trace.push(Object.freeze({ ...event }));
}

function normalizeFiredTraceEntry(entry) {
  if (entry.type === "timer.fired" || entry.kind === "sleep") {
    const atMs = entry.atMs ?? parseInstantMs(entry.at, "fire.at");
    return Object.freeze({
      type: "timer.fired",
      fireId: entry.fireId,
      timerId: entry.timerId,
      runId: entry.runId,
      atMs,
      order: entry.order,
    });
  }
  if (entry.type === "cron.fired" || entry.kind === "cron") {
    const atMs = entry.atMs ?? parseInstantMs(entry.at, "fire.at");
    return Object.freeze({
      type: "cron.fired",
      fireId: entry.fireId,
      scheduleId: entry.scheduleId,
      occurrence: entry.occurrence,
      atMs,
      order: entry.order,
    });
  }
  throw new NondeterministicClockError(`unknown fire trace entry ${entry.type ?? entry.kind}`);
}

function cloneRequiredArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an array`);
  }
  return clone(value);
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

function normalizePositiveInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${fieldName} must be a positive safe integer`);
  }
  return value;
}

function normalizeNonNegativeInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer`);
  }
  return value;
}

function parseInstantMs(value, fieldName) {
  const ms = Date.parse(value);
  if (!isJsonString(value) || Number.isNaN(ms)) {
    throw new TypeError(`${fieldName} must be a valid ISO-8601 string`);
  }
  return ms;
}

function formatInstant(timestampMs) {
  return new Date(timestampMs).toISOString();
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone instanceof Function
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}
