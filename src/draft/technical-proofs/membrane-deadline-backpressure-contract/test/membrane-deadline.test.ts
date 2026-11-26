import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createManualClock,
  createMembraneDeadlineBackpressure,
  DeadlineExceededError,
} from "../src/index.js";
import { type JsonValue } from "../src/json.js";


const KV = "wasi:keyvalue/store@0.2.0";
const WORKFLOW = "hobo:runtime/workflow@0.1.0";

test("slow provider exceeds caller deadline with typed transient classification", async () => {
  const clock = createManualClock(0);
  const membrane = createMembraneDeadlineBackpressure({ clock });
  const cancellations: string[] = [];

  membrane.registerComponent({ id: "api", imports: [KV] });
  membrane.registerProvider({
    id: "slow-kv",
    exports: {
      [KV]: {
        get: async (_payload, context) => {
          context.signal.addEventListener(
            "abort",
            // SAFETY: assertion to `() => cancellations.push((context.signal.reason as { code: string }).code),` is required at this boundary.
            () => cancellations.push((context.signal.reason as { code: string }).code),
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
    idempotencyKey: undefined,
    inFlight: 0,
  });
});

test("nested in-process call inherits and shrinks remaining deadline", async () => {
  const clock = createManualClock(100);
  const membrane = createMembraneDeadlineBackpressure({ clock });
  const innerDeadlines: JsonValue[] = [];

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
});

test("hung provider that ignores cancellation still returns deadline-exceeded", async () => {
  const clock = createManualClock(0);
  const membrane = createMembraneDeadlineBackpressure({ clock });

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

  await assert.rejects(call, (error) => error instanceof DeadlineExceededError);
  assert.equal(membrane.events.at(-1)?.outcome, "deadline-exceeded");
  assert.equal(membrane.events.at(-1)?.cancellation, "signaled");
});
