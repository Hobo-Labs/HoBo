import assert from "node:assert/strict";
import { test } from "vitest";

import {
  DeadlineExceededError,
  createDeadlinePropagationMembrane,
  createManualClock,
} from "../src/wrpc-deadline-propagation.js";

const KV = "wasi:keyvalue/store@0.2.0";
const WORKFLOW = "hobo:runtime/workflow@0.1.0";

test("slow provider exceeds caller deadline with typed Plan-5 timeout classification", async () => {
  const clock = createManualClock(0);
  const membrane = createDeadlinePropagationMembrane({ clock });
  const cancellations = [];

  membrane.registerComponent({ id: "api", imports: [KV] });
  membrane.registerProvider({
    id: "slow-kv",
    exports: {
      [KV]: {
        get: async (_payload, context) => {
          context.signal.addEventListener(
            "abort",
            () => cancellations.push(context.signal.reason.code),
            { once: true },
          );
          await context.sleep(50);
          return { value: "too-late" };
        },
      },
    },
  });
  membrane.link({
    componentId: "api",
    importInterface: KV,
    providerId: "slow-kv",
    exportInterface: KV,
  });

  const call = membrane.callImport("api", KV, "get", { key: "session" }, { timeoutMs: 10 });
  await Promise.resolve();
  clock.advance(11);

  await assert.rejects(
    call,
    (error) =>
      error instanceof DeadlineExceededError &&
      error.code === "deadline-exceeded" &&
      error.failure.class === "transient" &&
      error.failure.strategy.kind === "backoff-budget",
  );
  assert.deepEqual(cancellations, ["deadline-exceeded"]);
  assert.deepEqual(membrane.events.at(-1), {
    type: "link.Called",
    componentId: "api",
    importInterface: KV,
    providerId: "slow-kv",
    exportInterface: KV,
    operation: "get",
    transport: "in-process",
    boundaryMode: "live",
    deadline: {
      source: "caller",
      startedAtMs: 0,
      expiresAtMs: 10,
      remainingAtDispatchMs: 10,
    },
    outcome: "deadline-exceeded",
    failureClass: "transient",
    cancellation: "signaled",
    codec: "json-wit",
  });
});

test("nested in-process call inherits and shrinks remaining deadline", async () => {
  const clock = createManualClock(100);
  const membrane = createDeadlinePropagationMembrane({ clock });
  const innerDeadlines = [];

  membrane.registerComponent({ id: "api", imports: [WORKFLOW, KV] });
  membrane.registerProvider({
    id: "workflow-runtime",
    exports: {
      [WORKFLOW]: {
        run: async (_payload, context) => {
          await context.sleep(30);
          return context.callLinked(KV, "get", { key: "nested" });
        },
      },
    },
  });
  membrane.registerProvider({
    id: "local-kv",
    exports: {
      [KV]: {
        get: (_payload, context) => {
          innerDeadlines.push(context.deadline);
          return { value: "nested-ok" };
        },
      },
    },
  });
  membrane.link({
    componentId: "api",
    importInterface: WORKFLOW,
    providerId: "workflow-runtime",
    exportInterface: WORKFLOW,
  });
  membrane.link({
    componentId: "api",
    importInterface: KV,
    providerId: "local-kv",
    exportInterface: KV,
  });

  const call = membrane.callImport("api", WORKFLOW, "run", {}, { timeoutMs: 80 });
  await Promise.resolve();
  clock.advance(30);
  const result = await call;

  assert.deepEqual(result, { value: "nested-ok" });
  assert.deepEqual(innerDeadlines, [
    {
      source: "inherited",
      startedAtMs: 130,
      expiresAtMs: 180,
      remainingAtDispatchMs: 50,
    },
  ]);
  assert.deepEqual(
    membrane.events.filter((event) => event.type === "link.Called").map((event) => ({
      importInterface: event.importInterface,
      outcome: event.outcome,
      deadline: event.deadline,
    })),
    [
      {
        importInterface: KV,
        outcome: "ok",
        deadline: {
          source: "inherited",
          startedAtMs: 130,
          expiresAtMs: 180,
          remainingAtDispatchMs: 50,
        },
      },
      {
        importInterface: WORKFLOW,
        outcome: "ok",
        deadline: {
          source: "caller",
          startedAtMs: 100,
          expiresAtMs: 180,
          remainingAtDispatchMs: 80,
        },
      },
    ],
  );
});

test("hung provider that ignores cancellation still returns deadline-exceeded to the caller", async () => {
  const clock = createManualClock(0);
  const membrane = createDeadlinePropagationMembrane({ clock });

  membrane.registerComponent({ id: "api", imports: [KV] });
  membrane.registerProvider({
    id: "hung-kv",
    exports: {
      [KV]: {
        get: () => new Promise(() => {}),
      },
    },
  });
  membrane.link({
    componentId: "api",
    importInterface: KV,
    providerId: "hung-kv",
    exportInterface: KV,
  });

  const call = membrane.callImport("api", KV, "get", { key: "never" }, { timeoutMs: 5 });
  await Promise.resolve();
  clock.advance(6);

  await assert.rejects(call, (error) => error.code === "deadline-exceeded");
  assert.equal(membrane.events.at(-1).outcome, "deadline-exceeded");
  assert.equal(membrane.events.at(-1).cancellation, "signaled");
});

test("report records HOBO-24 scope and keeps cross-host, backpressure, and retry reconciliation out", () => {
  const membrane = createDeadlinePropagationMembrane({ clock: createManualClock(0) });

  assert.deepEqual(membrane.report(), {
    schema: "hobo.wrpc.deadline-propagation/v1",
    issue: "HOBO-24",
    supportedTransports: ["in-process"],
    events: ["link.Established", "link.Called"],
    scopeIn: [
      "caller deadline carried on link.Called",
      "deadline-exceeded result classified as Plan-5 transient timeout",
      "AbortSignal cancellation for cancellable provider operations",
      "nested in-process calls inherit and shrink remaining deadline",
      "hung in-process providers cannot hold the caller past deadline",
    ],
    scopeOut: [
      "NATS/JetStream lattice transport",
      "cross-host hung-call timing divergence",
      "backpressure handling",
      "retry or provider idempotency reconciliation",
      "full failure-classifier implementation",
      "wire-version negotiation",
    ],
  });
});
