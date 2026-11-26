import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  RPO_ASYNC_TARGET_MS,
  RTO_TARGET_MS,
  assessCrossRegionReplication,
  parseMultiRegionTopology,
  replayEventLog,
  runRegionLossDrill,
  verifyProjectionIntegrity,
  yardUpRestore,
} from "../src/multi-region-dr-replay.ts";

describe("multi-region DR replay contract", () => {
  describe("Given a multi-region Yard topology", () => {
    it("When authoritative log is active-passive and stateless tier is active-active, Then topology parses", () => {
      const topology = parseMultiRegionTopology({
        regions: ["us-east-1", "us-west-2"],
        authoritativeLog: {
          mode: "active-passive-log",
          primaryRegion: "us-east-1",
          replication: "cross-region-quorum",
        },
        statelessTier: {
          mode: "active-active",
          roles: ["gateway", "planner", "executor"],
        },
      });

      assert.equal(topology.authoritativeLog.mode, "active-passive-log");
      assert.deepEqual(topology.authoritativeLog.passiveRegions, ["us-west-2"]);
      assert.equal(topology.statelessTier.mode, "active-active");
      assert.equal(topology.statelessTier.horizontallyScaled, true);
    });
  });

  describe("Given a replicated event log", () => {
    it("When hobo yard up --restore replays the log, Then actors and projections rehydrate", () => {
      const log = productionReplicatedLog();
      const restore = yardUpRestore({
        logPath: "/replicated/us-west-2/yard-event-log",
        log,
        topology: defaultTopology(),
        preLossSnapshots: log.preLossSnapshots,
        startedAt: "2026-07-02T10:00:00.000Z",
        completedAt: "2026-07-02T10:08:00.000Z",
      });

      assert.deepEqual(restore.command.argv, [
        "hobo",
        "yard",
        "up",
        "--restore",
        "/replicated/us-west-2/yard-event-log",
      ]);
      assert.equal(restore.status, "restored");
      assert.equal(restore.actorsRehydrated, 2);
      assert.equal(restore.projectionsRehydrated, 3);
      assert.equal(restore.replay.replayedEvents, 5);
      assert.equal(restore.rto.withinTarget, true);
      assert.equal(restore.replication.rpo.withinTarget, true);
      assert.equal(restore.integrity.byteIdentical, true);
    });

    it("When cross-region replication is assessed, Then RPO honesty is reported", () => {
      const sync = assessCrossRegionReplication(productionReplicatedLog());
      assert.equal(sync.rpo.ms, 0);
      assert.equal(sync.rpo.claimsZeroDataLoss, true);

      const lagged = assessCrossRegionReplication(laggedReplicatedLog());
      assert.equal(lagged.rpo.ms, 4500);
      assert.equal(lagged.rpo.withinTarget, true);
      assert.equal(lagged.rpo.claimsZeroDataLoss, false);
      assert.deepEqual(lagged.rpo.unreplicatedSeqRange, [705, 709]);
    });
  });

  describe("Feature: region-loss DR drill", () => {
    it("Scenario: rebuild functional Yard within RTO with byte-identical projections", () => {
      const log = productionReplicatedLog();
      const drill = runRegionLossDrill({
        lostRegion: "us-east-1",
        targetRegion: "us-west-2",
        topology: defaultTopology(),
        log,
        preLossSnapshots: log.preLossSnapshots,
        detectedAt: "2026-07-02T10:00:00.000Z",
        restoredAt: "2026-07-02T10:12:00.000Z",
      });

      assert.equal(drill.status, "passed");
      assert.equal(drill.functional, true);
      assert.equal(drill.rto.ms, 12 * 60 * 1000);
      assert.equal(drill.rto.withinTarget, true);
      assert.equal(drill.rpo.withinTarget, true);
      assert.equal(drill.integrity.byteIdentical, true);
    });
  });

  describe("Adversarial: DR integrity guards", () => {
    it("rejects async replica lag beyond 5s RPO budget in restore outcome", () => {
      const restore = yardUpRestore({
        logPath: "/replicated/us-west-2/yard-event-log",
        log: excessiveLagLog(),
        topology: defaultTopology(),
        preLossSnapshots: excessiveLagLog().preLossSnapshots,
        startedAt: "2026-07-02T10:00:00.000Z",
        completedAt: "2026-07-02T10:08:00.000Z",
      });

      assert.equal(restore.replication.rpo.withinTarget, false);
      assert.equal(restore.status, "failed");
    });

    it("fails region-loss drill when RTO exceeds 15 minute target", () => {
      const log = productionReplicatedLog();
      const drill = runRegionLossDrill({
        lostRegion: "us-east-1",
        targetRegion: "us-west-2",
        topology: defaultTopology(),
        log,
        preLossSnapshots: log.preLossSnapshots,
        detectedAt: "2026-07-02T10:00:00.000Z",
        restoredAt: "2026-07-02T10:16:01.000Z",
      });

      assert.equal(drill.rto.withinTarget, false);
      assert.equal(drill.status, "failed");
    });

    it("fails integrity check when rebuilt projection hashes diverge", () => {
      const log = productionReplicatedLog();
      const replay = replayEventLog(log);
      const integrity = verifyProjectionIntegrity({
        before: log.preLossSnapshots,
        after: {
          ...replay.projectionSnapshots,
          "projection:deployment-view": "fnv1a-deadbeef",
        },
      });

      assert.equal(integrity.byteIdentical, false);
      assert.equal(integrity.mismatches.length, 1);
      assert.equal(integrity.mismatches[0].reason, "hash-mismatch");
    });

    it("rejects empty or corrupt replicated logs at the parse boundary", () => {
      assert.throws(() => replayEventLog({ streams: {} }), /streams must not be empty/);
      assert.throws(
        () => replayEventLog({
          streams: { "projection:view": [{ seq: -1, type: "projection.Rebuilt" }] },
          lastCommittedSeq: 1,
          replicatedSeq: 1,
        }),
        /invalid seq/,
      );
    });
  });
});

function defaultTopology() {
  return {
    regions: ["us-east-1", "us-west-2"],
    authoritativeLog: {
      mode: "active-passive-log",
      primaryRegion: "us-east-1",
    },
    statelessTier: {
      mode: "active-active",
      roles: ["gateway", "planner", "executor"],
    },
  };
}

function productionReplicatedLog() {
  const replay = {
    topology: "cross-region-quorum",
    primaryRegion: "us-east-1",
    replicaRegion: "us-west-2",
    lastCommittedSeq: 704,
    replicatedSeq: 704,
    replicationLagMs: 0,
    snapshotSeq: 700,
    streams: {
      "actor:cart": [{ seq: 703, type: "actor.StateAppended", payload: { state: "open" } }],
      "actor:checkout": [{ seq: 704, type: "actor.StateAppended", payload: { state: "ready" } }],
      "projection:deployment-view": [{ seq: 704, type: "projection.Rebuilt", payload: { deployments: 12 } }],
      "projection:incident-view": [{ seq: 704, type: "projection.Rebuilt", payload: { incidents: 0 } }],
      "projection:runbook-view": [{ seq: 704, type: "projection.Rebuilt", payload: { runbooks: 4 } }],
    },
  };

  const projectionSnapshots = replayEventLog(replay).projectionSnapshots;
  return {
    ...replay,
    preLossSnapshots: projectionSnapshots,
  };
}

function laggedReplicatedLog() {
  return {
    ...productionReplicatedLog(),
    lastCommittedSeq: 709,
    replicatedSeq: 704,
    replicationLagMs: 4500,
  };
}

function excessiveLagLog() {
  const log = laggedReplicatedLog();
  return {
    ...log,
    replicationLagMs: RPO_ASYNC_TARGET_MS + 1,
    preLossSnapshots: productionReplicatedLog().preLossSnapshots,
  };
}

describe("contract constants", () => {
  it("pins Plan-05 RTO and async-tier RPO targets", () => {
    assert.equal(RTO_TARGET_MS, 900_000);
    assert.equal(RPO_ASYNC_TARGET_MS, 5_000);
  });
});
