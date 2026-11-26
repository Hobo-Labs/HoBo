import assert from "node:assert/strict";
import { test } from "vitest";

import { createBrokenFenceRuntimeBackend } from "../src/fixtures/broken-fence-backend.js";
import { createRuntimeLocalDurabilityBackend } from "../src/fixtures/reference-backend.js";
import {
  RUNTIME_PORT_CONFORMANCE_VERSION,
  proveCheckoutDurability,
  runRuntimePortDurabilitySuite,
} from "../src/runtime-port/index.js";

test("runtime-local passes the runtime-port durability conformance suite", async () => {
  const report = await runRuntimePortDurabilitySuite(createRuntimeLocalDurabilityBackend);

  assert.equal(report.contract, RUNTIME_PORT_CONFORMANCE_VERSION);
  assert.equal(report.backend, "runtime-local");
  assert.equal(report.status, "pass");
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.coverage.local, {
    status: "pass",
    passed: 5,
    failed: 0,
    total: 5,
  });
  assert.deepEqual(
    report.checks.map((check) => [check.checkId, check.status]),
    [
      ["eventStore.local.seq-conditional-append", "pass"],
      ["eventStore.local.idempotency-key-dedup", "pass"],
      ["queue.local.idempotency-key-dedup", "pass"],
      ["actorHost.local.stale-fence-rejected", "pass"],
      ["runtime.local.checkout-replay-equals-live", "pass"],
    ],
  );
});

test("checkout durability proof replays the same final state from the event log", async () => {
  const proof = await proveCheckoutDurability(createRuntimeLocalDurabilityBackend());

  assert.deepEqual(proof.liveState, proof.replayState);
  assert.deepEqual(proof.replayState, {
    runId: "checkout:run-1",
    status: "paid",
    reservedItems: ["sku-hobo-mug"],
    chargedCents: 4200,
    duplicateCharges: 0,
    timedOut: false,
  });
  assert.deepEqual(proof.queueEffects, ["charge:checkout:run-1"]);
  assert.deepEqual(proof.clockTrace.map((entry) => entry.type), [
    "clock.started",
    "timer.scheduled",
    "clock.advanced",
    "timer.fired",
  ]);
});

test("a backend that claims runtime-local but drops stale-fence checks fails conformance", async () => {
  const report = await runRuntimePortDurabilitySuite(createBrokenFenceRuntimeBackend);

  assert.equal(report.backend, "runtime-local");
  assert.equal(report.status, "fail");
  assert.deepEqual(report.failures, [
    {
      checkId: "actorHost.local.stale-fence-rejected",
      message: "stale lease append was accepted",
    },
  ]);
});
