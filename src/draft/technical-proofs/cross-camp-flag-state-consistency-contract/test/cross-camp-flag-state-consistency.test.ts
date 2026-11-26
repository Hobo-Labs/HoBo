import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createCrossCampFlagStateRuntime,
  declareCrossCampFlagStateTopology,
  resolveActiveActiveFlagChanges
} from "../src/cross-camp-flag-state-consistency.js";
import {
  createFlagChanged,
  createFlagContract
} from "../../flag-event-contract/src/flag-event-contract.js";

const actor = Object.freeze({
  kind: "user",
  id: "operator_1",
  tenant: "tenant_a"
});

test("single-writer topology declares bounded follower semantics and scope boundaries", () => {
  const contract = declareCheckoutTopology();

  assert.equal(contract.flagKey, "checkout.kill-switch");
  assert.deepEqual(contract.replicationTopology, {
    kind: "single-writer-camp",
    ownerCampId: "camp-central",
    followerCampIds: ["camp-east", "camp-west"],
    readStream: "owner-replicated-flag-stream",
    writePolicy: "route-to-owner"
  });
  assert.equal(contract.consistency, "bounded-staleness");
  assert.equal(contract.scopeBoundary.replicationTransport, "out-of-scope");
  assert.equal(contract.scopeBoundary.flipGovernance, "out-of-scope");
});

test("writer flip propagates to followers within bound and becomes fresh only after catch-up", () => {
  const contract = declareCheckoutTopology({ maxStalenessMs: 100 });
  const runtime = createCrossCampFlagStateRuntime({ contract });
  const events = checkoutFlagEntries();

  runtime.appendWriterEntry(events.defined);
  runtime.appendWriterEntry(events.enabled);

  const beforeCatchUp = runtime.read("camp-east", { nowMs: 20 });
  assert.equal(beforeCatchUp.staleness.status, "stale");
  assert.equal(beforeCatchUp.staleness.fresh, false);

  const replication = runtime.replicateTo("camp-east", {
    entries: runtime.ownerReadStream(),
    ownerWatermarkMs: 10,
    receivedAtMs: 55
  });
  const afterCatchUp = runtime.read("camp-east", { nowMs: 55 });
  const latency = runtime.measureKillSwitchPropagation({
    followerCampId: "camp-east",
    seq: events.enabled.seq
  });

  assert.equal(replication.accepted, true);
  assert.equal(afterCatchUp.value, true);
  assert.equal(afterCatchUp.rulesetSeq, 2);
  assert.deepEqual(afterCatchUp.staleness, {
    guarantee: "bounded-staleness",
    status: "fresh",
    fresh: true,
    stale: false,
    blocked: false,
    label: "bounded-staleness:fresh",
    reason: "caught-up",
    boundMs: 100,
    observedLagMs: 45,
    ownerSeq: 2,
    followerSeq: 2,
    ownerCampId: "camp-central",
    servedByCampId: "camp-east",
    topology: "single-writer-camp"
  });
  assert.deepEqual(latency, {
    followerCampId: "camp-east",
    flagKey: "checkout.kill-switch",
    seq: 2,
    propagationMs: 45,
    boundMs: 100,
    withinBound: true
  });
});

test("follower behind the writer never reports stale flag state as fresh", () => {
  const contract = declareCheckoutTopology();
  const runtime = createCrossCampFlagStateRuntime({ contract });
  const events = checkoutFlagEntries();

  runtime.appendWriterEntry(events.defined);
  runtime.replicateTo("camp-west", {
    entries: [events.defined],
    ownerWatermarkMs: 0,
    receivedAtMs: 10
  });
  runtime.appendWriterEntry(events.enabled);

  const read = runtime.read("camp-west", { nowMs: 30 });

  assert.equal(read.value, false);
  assert.equal(read.rulesetSeq, 1);
  assert.equal(read.staleness.status, "stale");
  assert.equal(read.staleness.fresh, false);
  assert.equal(read.staleness.reason, "replication-lag");
  assert.equal(read.staleness.ownerSeq, 2);
  assert.equal(read.staleness.followerSeq, 1);
});

test("partitioned follower serves last-known value with unbounded stale label without blocking", () => {
  const contract = declareCheckoutTopology({ maxStalenessMs: 50, heartbeatTtlMs: 50 });
  const runtime = createCrossCampFlagStateRuntime({ contract });
  const events = checkoutFlagEntries();

  runtime.appendWriterEntry(events.defined);
  runtime.replicateTo("camp-east", {
    entries: [events.defined],
    ownerWatermarkMs: 0,
    receivedAtMs: 5
  });
  runtime.appendWriterEntry(events.enabled);

  const read = runtime.read("camp-east", { nowMs: 100 });

  assert.equal(read.value, false);
  assert.equal(read.rulesetSeq, 1);
  assert.equal(read.staleness.status, "partition-suspected");
  assert.equal(read.staleness.label, "unbounded-stale:partition-suspected");
  assert.equal(read.staleness.blocked, false);
});

test("active-active concurrent flips converge deterministically without losing either update", () => {
  const events = checkoutFlagEntries();

  const result = resolveActiveActiveFlagChanges({
    flagKey: "checkout.kill-switch",
    changes: [
      {
        campId: "camp-east",
        logicalTimeMs: 10,
        seq: 2,
        event: events.disabled.event
      },
      {
        campId: "camp-west",
        logicalTimeMs: 10,
        seq: 2,
        event: events.enabled.event
      }
    ]
  });

  assert.equal(result.topology, "active-active-eventual");
  assert.equal(result.converged, true);
  assert.equal(result.value, true);
  assert.deepEqual(result.winner, {
    campId: "camp-west",
    logicalTimeMs: 10,
    seq: 2,
    value: true
  });
  assert.deepEqual(result.conflictResolution, {
    strategy: "last-writer-wins-camp-id-tiebreak",
    retainedChanges: 2,
    lostUpdates: 0
  });
  assert.deepEqual(
    result.lineage.map((entry) => [entry.campId, entry.value]),
    [
      ["camp-east", false],
      ["camp-west", true]
    ]
  );
});

test("follower rejects out-of-order writer entries and keeps its monotonic state", () => {
  const contract = declareCheckoutTopology();
  const runtime = createCrossCampFlagStateRuntime({ contract });
  const events = checkoutFlagEntries();

  runtime.appendWriterEntry(events.defined);
  runtime.appendWriterEntry(events.enabled);
  runtime.appendWriterEntry(events.disabled);
  runtime.replicateTo("camp-west", {
    entries: [events.defined],
    ownerWatermarkMs: 0,
    receivedAtMs: 10
  });

  const rejected = runtime.replicateTo("camp-west", {
    entries: [events.disabled],
    ownerWatermarkMs: 25,
    receivedAtMs: 35
  });
  const read = runtime.read("camp-west", { nowMs: 35 });

  assert.deepEqual(rejected, {
    accepted: false,
    campId: "camp-west",
    reason: "out-of-order-replication",
    expectedSeq: 2,
    receivedSeq: 3,
    appliedSeq: 1
  });
  assert.equal(read.value, false);
  assert.equal(read.rulesetSeq, 1);
  assert.equal(read.staleness.status, "stale");
});

function declareCheckoutTopology(overrides = {}) {
  return declareCrossCampFlagStateTopology({
    flagKey: "checkout.kill-switch",
    writerCampId: "camp-central",
    followerCampIds: ["camp-west", "camp-east"],
    maxStalenessMs: overrides.maxStalenessMs ?? 250,
    heartbeatTtlMs: overrides.heartbeatTtlMs ?? 500
  });
}

function checkoutFlagEntries() {
  const contract = createFlagContract({
    knownTargetingAttributes: ["user.segment"]
  });
  const defined = contract.flag.boolean("checkout.kill-switch", {
    default: false,
    targeting: [{ attribute: "user.segment", op: "equals", value: "beta" }]
  });
  const enabled = createFlagChanged(defined.ref, {
    from: false,
    to: true,
    actor,
    reason: "incident-kill-switch"
  });
  const disabled = createFlagChanged(defined.ref, {
    from: true,
    to: false,
    actor,
    reason: "operator-clear"
  });

  return {
    defined: { seq: 1, event: defined.event, emittedAtMs: 0 },
    enabled: { seq: 2, event: enabled, emittedAtMs: 10 },
    disabled: { seq: 3, event: disabled, emittedAtMs: 25 }
  };
}
