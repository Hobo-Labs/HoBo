import assert from "node:assert/strict";
import { test } from "vitest";

import {
  NondeterministicClockError,
  QUEUE_CLOCK_RUNTIME_PORT_CONTRACT_VERSION,
  createRuntimeLocalQueueClock,
  replayClockTrace,
  runQueueClockConformance,
} from "../src/queue-clock-runtime-port.js";

test("Queue dedups duplicate enqueues by idempotency key before handling", async () => {
  const runtime = createRuntimeLocalQueueClock();

  const first = await runtime.queue.enqueue("email", { to: "a@example.test" }, { idempotencyKey: "send-a" });
  const retry = await runtime.queue.enqueue("email", { to: "a@example.test" }, { idempotencyKey: "send-a" });
  const handled = [];

  await runtime.queue.handle("email", async (message) => {
    handled.push(message);
  });

  assert.equal(retry.deduped, true);
  assert.equal(retry.messageId, first.messageId);
  assert.deepEqual(handled.map((message) => message.idempotencyKey), ["send-a"]);
});

test("Queue retries failed handlers at least once until completion", async () => {
  const runtime = createRuntimeLocalQueueClock();
  await runtime.queue.enqueue("jobs", { task: "retry" }, { idempotencyKey: "job-retry" });
  let attempts = 0;

  await assert.rejects(
    () =>
      runtime.queue.handle("jobs", async () => {
        attempts += 1;
        throw new Error("transient failure");
      }),
    /transient failure/,
  );
  const retry = await runtime.queue.handle("jobs", async () => {
    attempts += 1;
  });

  assert.equal(attempts, 2);
  assert.deepEqual(retry.handled, ["msg-1"]);
});

test("Queue suppresses duplicate effects when a completed message is redelivered", async () => {
  const runtime = createRuntimeLocalQueueClock();
  const enqueued = await runtime.queue.enqueue("payments", { cents: 500 }, { idempotencyKey: "charge-1" });
  const effects = [];

  await runtime.queue.handle("payments", async (message) => {
    effects.push(`charged:${message.idempotencyKey}`);
  });
  runtime.queue.simulateRedelivery(enqueued.messageId);
  const redelivery = await runtime.queue.handle("payments", async (message) => {
    effects.push(`charged:${message.idempotencyKey}`);
  });

  assert.deepEqual(effects, ["charged:charge-1"]);
  assert.deepEqual(redelivery, { handled: [], deduped: [enqueued.messageId] });
});

test("Queue does not redeliver an expired lease while the handler is still active", async () => {
  const runtime = createRuntimeLocalQueueClock();
  await runtime.queue.enqueue("payments", { cents: 500 }, { idempotencyKey: "charge-active" });
  const effects = [];
  let finishHandler;

  const inFlight = runtime.queue.handle(
    "payments",
    async (message) => {
      effects.push(`charged:${message.idempotencyKey}`);
      await new Promise((resolve) => {
        finishHandler = resolve;
      });
    },
    { visibilityTimeoutMs: 1 },
  );

  runtime.clock.advance(2);
  assert.deepEqual(runtime.queue.dequeue("payments", { visibilityTimeoutMs: 100 }), []);

  finishHandler();
  await inFlight;
  runtime.queue.simulateRedelivery("msg-1");
  await runtime.queue.handle("payments", async (message) => {
    effects.push(`charged:${message.idempotencyKey}`);
  });

  assert.deepEqual(effects, ["charged:charge-active"]);
});

test("Queue signal enqueues actor messages with idempotent delivery", async () => {
  const runtime = createRuntimeLocalQueueClock();

  const first = await runtime.queue.signal("actor:counter:1", { type: "increment", by: 1 }, { idempotencyKey: "signal-1" });
  const retry = await runtime.queue.signal("actor:counter:1", { type: "increment", by: 1 }, { idempotencyKey: "signal-1" });
  const delivered = [];

  await runtime.queue.handle(first.queueName, async (message) => {
    delivered.push(message.body);
  });

  assert.equal(retry.deduped, true);
  assert.deepEqual(delivered, [
    {
      actorKey: "actor:counter:1",
      msg: { type: "increment", by: 1 },
    },
  ]);
});

test("Clock durable sleep survives simulated restart and fires once", () => {
  const runtime = createRuntimeLocalQueueClock({
    seed: "timer-restart",
    startInstant: "2026-06-26T00:00:00.000Z",
  });
  const timer = runtime.clock.sleep("run:checkout", 1_000, { idempotencyKey: "sleep-checkout" });
  const restarted = createRuntimeLocalQueueClock({ snapshot: runtime.snapshot() });

  const fired = restarted.clock.advance(1_000);
  const afterFireRestart = createRuntimeLocalQueueClock({ snapshot: restarted.snapshot() });

  assert.deepEqual(fired.map((event) => [event.kind, event.timerId, event.runId]), [
    ["sleep", timer.timerId, "run:checkout"],
  ]);
  assert.deepEqual(restarted.clock.advance(0), []);
  assert.deepEqual(afterFireRestart.clock.advance(10_000), []);
});

test("Clock deterministic cron interval persists occurrence ordering across restart", () => {
  const runtime = createRuntimeLocalQueueClock({
    seed: "cron-seed",
    startInstant: "2026-06-26T00:00:00.000Z",
  });
  runtime.clock.cron("heartbeat", { everyMs: 1_000 });

  const firstWindow = runtime.clock.advance(3_000);
  const restarted = createRuntimeLocalQueueClock({ snapshot: runtime.snapshot() });
  const secondWindow = restarted.clock.advance(1_000);

  assert.deepEqual(firstWindow.map((event) => event.fireId), [
    "cron:heartbeat:1",
    "cron:heartbeat:2",
    "cron:heartbeat:3",
  ]);
  assert.deepEqual(secondWindow.map((event) => event.fireId), ["cron:heartbeat:4"]);
});

test("Clock pending cron schedule survives simulated restart and fires the first occurrence once", () => {
  const runtime = createRuntimeLocalQueueClock({
    seed: "cron-pending-seed",
    startInstant: "2026-06-26T00:00:00.000Z",
  });
  runtime.clock.cron("heartbeat", { everyMs: 1_000 });
  const restarted = createRuntimeLocalQueueClock({ snapshot: runtime.snapshot() });

  const fired = restarted.clock.advance(1_000);
  const afterFireRestart = createRuntimeLocalQueueClock({ snapshot: restarted.snapshot() });

  assert.deepEqual(fired.map((event) => event.fireId), ["cron:heartbeat:1"]);
  assert.deepEqual(afterFireRestart.clock.advance(0), []);
});

test("Clock advance wakes sleeping runs and seeded replay reproduces fire ordering", () => {
  const runtime = createRuntimeLocalQueueClock({
    seed: "checkout-seed",
    startInstant: "2026-06-26T00:00:00.000Z",
  });
  runtime.clock.sleep("run:slow", 30, { idempotencyKey: "sleep-slow", label: "slow" });
  runtime.clock.sleep("run:fast", 10, { idempotencyKey: "sleep-fast", label: "fast" });

  const firstAdvance = runtime.clock.advance(10);
  const secondAdvance = runtime.clock.advance(20);
  const replay = replayClockTrace(runtime.clock.trace(), { seed: "checkout-seed" });

  assert.deepEqual([...firstAdvance, ...secondAdvance].map((event) => event.runId), ["run:fast", "run:slow"]);
  assert.deepEqual(replay.fireOrder, ["timer:timer-2", "timer:timer-1"]);
});

test("Clock replay rejects seed mismatch before accepting a nondeterministic trace", () => {
  const runtime = createRuntimeLocalQueueClock({ seed: "expected-seed" });
  runtime.clock.sleep("run:one", 1, { idempotencyKey: "sleep-one" });
  runtime.clock.advance(1);

  assert.throws(
    () => replayClockTrace(runtime.clock.trace(), { seed: "ambient-seed" }),
    NondeterministicClockError,
  );
});

test("Clock replay rejects same-seed traces with divergent fire ordering", () => {
  const runtime = createRuntimeLocalQueueClock({ seed: "expected-seed" });
  runtime.clock.sleep("run:slow", 30, { idempotencyKey: "sleep-slow" });
  runtime.clock.sleep("run:fast", 10, { idempotencyKey: "sleep-fast" });
  runtime.clock.advance(30);
  const tamperedTrace = runtime.clock.trace().map((entry) =>
    entry.type === "timer.fired" && entry.fireId === "timer:timer-1"
      ? { ...entry, fireId: "timer:timer-999" }
      : entry,
  );

  assert.throws(
    () => replayClockTrace(tamperedTrace, { seed: "expected-seed" }),
    NondeterministicClockError,
  );
});

test("Clock replay rejects same-seed traces with mutated fire timestamps", () => {
  const runtime = createRuntimeLocalQueueClock({ seed: "expected-seed" });
  runtime.clock.sleep("run:one", 10, { idempotencyKey: "sleep-one" });
  runtime.clock.advance(10);
  const tamperedTrace = runtime.clock.trace().map((entry) =>
    entry.type === "timer.fired" ? { ...entry, atMs: entry.atMs + 1 } : entry,
  );

  assert.throws(
    () => replayClockTrace(tamperedTrace, { seed: "expected-seed" }),
    NondeterministicClockError,
  );
});

test("runtime-local passes the Queue + Clock conformance subset", async () => {
  const report = await runQueueClockConformance();

  assert.deepEqual(report, {
    contract: QUEUE_CLOCK_RUNTIME_PORT_CONTRACT_VERSION,
    backend: "runtime-local",
    assertions: {
      queueIdempotencyKeyDedup: "pass",
      atLeastOnceRetry: "pass",
      redeliveryDedup: "pass",
      durableTimerRestart: "pass",
      durableCronRestart: "pass",
      seededClockReplay: "pass",
    },
  });
});
