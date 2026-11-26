import assert from "node:assert/strict";
import { test } from "vitest";

import { createPartitionedFlagConsistencyProbe } from "../src/flag-partition-consistency.js";

test("partitioned evaluator serves last-known ruleset with stale label while healthy peer advances", async () => {
  const probe = createPartitionedFlagConsistencyProbe();

  const result = await probe.partitionOneEvaluator();

  assert.equal(result.partitioned.value, true);
  assert.equal(result.partitioned.rulesetSeq, 2);
  assert.deepEqual(result.partitioned.freshness, {
    status: "stale",
    seq: 2,
    reason: "stream-partition"
  });
  assert.equal(result.healthy.value, false);
  assert.equal(result.healthy.rulesetSeq, 3);
  assert.deepEqual(result.healthy.freshness, {
    status: "fresh",
    seq: 3,
    reason: "up-to-date"
  });
});

test("replicas at the same ruleset seq never diverge", async () => {
  const probe = createPartitionedFlagConsistencyProbe();

  const result = await probe.compareEqualSeqReplicas();

  assert.equal(result.left.rulesetSeq, 2);
  assert.equal(result.right.rulesetSeq, 2);
  assert.equal(result.left.value, true);
  assert.deepEqual(result.right, result.left);
});

test("post-partition resync equals full replay and does not lose the flip", async () => {
  const probe = createPartitionedFlagConsistencyProbe();

  const result = await probe.resyncAfterPartition();

  assert.deepEqual(result.resync, {
    evaluatorId: "edge-partitioned",
    snapshotSeq: 2,
    tailSeq: 3,
    seq: 3,
    freshness: "fresh"
  });
  assert.equal(result.afterResync.value, false);
  assert.equal(result.afterResync.rulesetSeq, 3);
  assert.deepEqual(result.resyncedRuleset, result.fullReplayRuleset);
});

test("kill-switch propagation latency stays within the declared bound", () => {
  const probe = createPartitionedFlagConsistencyProbe({ maxDeliveryMs: 50 });

  const result = probe.measureKillSwitchPropagation();

  assert.deepEqual(result.delivered.map((delivery) => delivery.deliveryMs), [30, 30]);
  assert.equal(result.withinBound, true);
});

test("clock-skewed replica cannot report a higher seq than it holds", () => {
  const probe = createPartitionedFlagConsistencyProbe();

  const result = probe.rejectClockSkewedSeqClaim();

  assert.equal(result.accepted, false);
  assert.equal(result.actualSeq, 2);
  assert.equal(result.reportedSeq, 5);
  assert.match(result.reason, /higher than held seq/);
});

test("slow replica degrades to stale-labeled reads without blocking healthy evaluators", async () => {
  const probe = createPartitionedFlagConsistencyProbe();

  const result = await probe.slowReplicaDegrades();

  assert.equal(result.delivery.backpressured.includes("edge-slow"), true);
  assert.equal(result.healthy.value, true);
  assert.deepEqual(result.slow.freshness, {
    status: "stale",
    seq: 0,
    reason: "backpressure"
  });
});
