import assert from "node:assert/strict";
import { test } from "vitest";

import {
  auditFidelityCatalog,
  compareLocalAndCamp,
  createForkLane,
  evaluateProdReadyClaim,
  verifyReplayDeterminism,
} from "../src/dev-fidelity-drift.js";

test("mislabeled simulated capability that only has mock behavior fails fidelity audit", () => {
  const report = auditFidelityCatalog([
    {
      capability: "email",
      declaredFidelity: "simulated",
      observedFidelity: "mocked",
      evidence: "shape-only stub",
    },
  ]);

  assert.equal(report.status, "fail");
  assert.deepEqual(report.labels, { email: "simulated" });
  assert.equal(report.failures[0].code, "HOBO_DEV_FIDELITY_MISLABELED");
  assert.match(report.failures[0].message, /declares simulated but only proves mocked/);
});

test("prod-ready claim for mocked-only behavior is refused with defer-to-Camp evidence", () => {
  const claim = evaluateProdReadyClaim({
    capability: "secrets",
    declaredFidelity: "mocked",
    evidence: { local: "mock-pass", camp: "unrun" },
  });

  assert.equal(claim.status, "blocked");
  assert.equal(claim.code, "HOBO_DEV_PROD_READY_DEFER_TO_CAMP");
  assert.match(claim.message, /defer to Camp/);
});

test("fork lanes keep writes out of baseline and out of each other", () => {
  const baseline = {
    "cart:user-1": 1,
    "inventory:sku-1": 3,
  };
  const cartLane = createForkLane({ id: "lane-cart", service: "cart", into: "staging", baseline });
  const inventoryLane = createForkLane({ id: "lane-inventory", service: "inventory", into: "staging", baseline });

  cartLane.write("cart:user-1", 2);
  inventoryLane.write("cart:user-1", 9);
  inventoryLane.write("inventory:sku-1", 0);

  assert.deepEqual(baseline, {
    "cart:user-1": 1,
    "inventory:sku-1": 3,
  });
  assert.equal(cartLane.read("cart:user-1"), 2);
  assert.equal(inventoryLane.read("cart:user-1"), 9);
  assert.equal(cartLane.read("inventory:sku-1"), 3);
  assert.deepEqual(cartLane.diff().writes, {
    "cart:user-1": { baseline: 1, lane: 2 },
  });
  assert.deepEqual(inventoryLane.diff().writes, {
    "cart:user-1": { baseline: 1, lane: 9 },
    "inventory:sku-1": { baseline: 3, lane: 0 },
  });
});

test("local-vs-Camp mismatch for a labeled-real capability fails drift check", () => {
  const drift = compareLocalAndCamp({
    capability: "scheduler",
    declaredFidelity: "real",
    localResult: { nextRunAt: "2026-06-27T12:00:00.000Z" },
    campResult: { nextRunAt: "2026-06-27T12:05:00.000Z" },
  });

  assert.equal(drift.status, "fail");
  assert.equal(drift.code, "HOBO_DEV_LOCAL_CAMP_DRIFT");
  assert.deepEqual(drift.diff, {
    local: { nextRunAt: "2026-06-27T12:00:00.000Z" },
    camp: { nextRunAt: "2026-06-27T12:05:00.000Z" },
  });
});

test("missing fidelity label defaults conservative camp-only, never real", () => {
  const report = auditFidelityCatalog([
    {
      capability: "payments",
      observedFidelity: "real",
      evidence: "adapter ping",
    },
  ]);

  assert.equal(report.status, "fail");
  assert.deepEqual(report.labels, { payments: "camp-only" });
  assert.equal(report.failures[0].code, "HOBO_DEV_FIDELITY_UNDECLARED");
  assert.match(report.failures[0].message, /defaults to camp-only/);
});

test("mock drift from contract is flagged rather than silently divergent", () => {
  const drift = compareLocalAndCamp({
    capability: "queue",
    declaredFidelity: "mocked",
    localResult: { delivered: "at-most-once" },
    campResult: { delivered: "at-least-once" },
    contractResult: { delivered: "at-least-once" },
  });

  assert.equal(drift.status, "fail");
  assert.equal(drift.code, "HOBO_DEV_MOCK_CONTRACT_DRIFT");
  assert.match(drift.message, /mock result drifted from contract/);
});

test("clock-driven simulated behavior replays identically across restarts", () => {
  const replay = verifyReplayDeterminism({
    capability: "cron",
    declaredFidelity: "simulated",
    firstRun: [
      { at: 0, event: "cron.Tick", key: "nightly" },
      { at: 60_000, event: "cron.Tick", key: "nightly" },
    ],
    replayRun: [
      { at: 0, event: "cron.Tick", key: "nightly" },
      { at: 60_000, event: "cron.Tick", key: "nightly" },
    ],
  });

  assert.equal(replay.status, "pass");
});

test("partition or incident evidence surfaces as uncertain, not confident local success", () => {
  const drift = compareLocalAndCamp({
    capability: "objectStore",
    declaredFidelity: "real",
    localResult: { ok: true },
    campResult: { incident: "camp partition", observed: "unavailable" },
  });

  assert.equal(drift.status, "blocked");
  assert.equal(drift.code, "HOBO_DEV_CAMP_UNCERTAIN");
  assert.match(drift.message, /cannot certify prod-ready local result/);
});
