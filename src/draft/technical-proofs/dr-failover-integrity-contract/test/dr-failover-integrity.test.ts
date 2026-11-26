import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  INCIDENT_EVENT_TYPES,
  makeIncidentEvent,
} from "../../incident-aggregate-contract/src/incident-aggregate.js";
import {
  certifyFailoverIntegrity,
  replayFailoverIntegrity,
  resumeInterruptedFailover,
} from "../src/dr-failover-integrity.js";

describe("DR failover integrity contract", () => {
  it("rejects stale owner writes with the restored Yard's higher fence token", async () => {
    const proof = await certifyFailoverIntegrity({
      ...baseFailoverInput(),
      stalePrimaryAppend: {
        ownerNode: "yard-node-a",
        fenceToken: 41,
        seq: 701,
        eventType: "resource.Provisioned",
      },
    });

    assert.equal(proof.status, "integrity-certified");
    assert.equal(proof.state.ownerNode, "yard-node-b");
    assert.equal(proof.state.fenceToken, 42);
    assert.equal(proof.integrity.staleOwner.accepted, false);
    assert.equal(proof.integrity.staleOwner.reason, "stale-fence-rejected");
    assert.equal(proof.integrity.staleOwner.seqCommitted, false);
  });

  it("reports async restore RPO honestly and refuses zero-loss wording", async () => {
    const proof = await certifyFailoverIntegrity({
      ...baseFailoverInput(),
      sourceLog: laggedAsyncReplicatedLog(),
      rpoTargetMs: 5000,
      restoredAt: "2026-06-27T18:06:30.000Z",
    });

    assert.equal(proof.integrity.rpo.label, "bounded-staleness");
    assert.equal(proof.integrity.rpo.claimsZeroDataLoss, false);
    assert.deepEqual(proof.integrity.rpo.unreplicatedSeqRange, [705, 709]);
    assert.match(proof.integrity.rpo.honestStatement, /bounded-staleness RPO: 4500ms/);
    assert.doesNotMatch(proof.integrity.rpo.honestStatement, /zero data loss/i);
  });

  it("replays from zero into one consistent owner and state head", async () => {
    const proof = await certifyFailoverIntegrity({
      ...baseFailoverInput(),
      doubleFailoverCandidates: [
        { ownerNode: "yard-node-b", fenceToken: 42, quorumVotes: 3, sourceSeq: 704 },
        { ownerNode: "yard-node-c", fenceToken: 41, quorumVotes: 2, sourceSeq: 704 },
      ],
    });

    const replay = replayFailoverIntegrity(proof.events.integrity);

    assert.equal(replay.status, "consistent");
    assert.deepEqual(replay.owners, ["yard-node-b"]);
    assert.equal(replay.stateHead.seq, 704);
    assert.deepEqual(replay.rejectedOwners, ["yard-node-c"]);
  });

  it("resumes an interrupted failover without double-applying completed steps", async () => {
    const resumed = await resumeInterruptedFailover({
      ...baseFailoverInput(),
      checkpoint: {
        id: "checkpoint-after-fence",
        completedSteps: ["fence-original-owner"],
        actorKey: "yard:prod/control-plane",
        fenceToken: 42,
        idempotencyKey: "incident-dr-us-east-1/failover/us-west-2",
      },
    });

    assert.equal(resumed.status, "restored");
    assert.deepEqual(resumed.recovery.replayedCompletedSteps, ["fence-original-owner"]);
    assert.deepEqual(resumed.recovery.remainingSteps, ["restore-from-log", "verify-rpo-rto", "complete-runbook"]);
    assert.equal(resumed.recovery.doubleAppliedSteps.length, 0);
    assert.equal(resumed.state.ownerNode, "yard-node-b");
  });
});

function baseFailoverInput() {
  return {
    incidentEvents: providerLossIncident(),
    sourceLog: synchronousReplicatedLog(),
    lease: stalePrimaryLease(),
    targetYard: { id: "yard-us-west", region: "us-west-2", camp: "prod" },
    gateway: recordingGateway(),
    detectedAt: "2026-06-27T18:00:00.000Z",
    restoredAt: "2026-06-27T18:08:00.000Z",
    rtoTargetMs: 15 * 60 * 1000,
    rpoTargetMs: 0,
  };
}

function providerLossIncident() {
  const opened = makeIncidentEvent(INCIDENT_EVENT_TYPES.opened, {
    id: "incident-open-provider-loss",
    incidentId: "incident-dr-us-east-1",
    correlationId: "corr-dr-us-east-1",
    causationId: "alert-provider-loss",
    occurredAt: "2026-06-27T17:59:55.000Z",
    payload: {
      severity: "high",
      impact: "provider region us-east-1 unavailable",
      causedBy: [
        { id: "alert-provider-loss", type: "alert.Fired", correlationId: "corr-dr-us-east-1" },
      ],
    },
  });
  const triaged = makeIncidentEvent(INCIDENT_EVENT_TYPES.triaged, {
    id: "incident-triaged-provider-loss",
    incidentId: "incident-dr-us-east-1",
    correlationId: "corr-dr-us-east-1",
    causationId: opened.id,
    occurredAt: "2026-06-27T18:00:00.000Z",
    payload: { owner: "operator:sre" },
  });

  return [opened, triaged];
}

function synchronousReplicatedLog() {
  return {
    topology: "sync-quorum",
    lastCommittedSeq: 704,
    replicatedSeq: 704,
    replicationLagMs: 0,
    snapshotSeq: 700,
    streams: {
      "actor:cart": [{ seq: 703, type: "actor.StateAppended" }],
      "actor:checkout": [{ seq: 704, type: "actor.StateAppended" }],
      "projection:deployment-view": [{ seq: 704, type: "projection.Rebuilt" }],
      "projection:incident-view": [{ seq: 704, type: "projection.Rebuilt" }],
      "projection:runbook-view": [{ seq: 704, type: "projection.Rebuilt" }],
    },
  };
}

function laggedAsyncReplicatedLog() {
  return {
    ...synchronousReplicatedLog(),
    topology: "async-replica",
    lastCommittedSeq: 709,
    replicatedSeq: 704,
    replicationLagMs: 4500,
  };
}

function stalePrimaryLease() {
  return {
    actorKey: "yard:prod/control-plane",
    previousOwnerNode: "yard-node-a",
    previousFenceToken: 41,
    newOwnerNode: "yard-node-b",
    expiredAt: "2026-06-27T18:00:05.000Z",
  };
}

function recordingGateway() {
  const commands = [];

  return {
    commands,
    async apply(command) {
      commands.push(command);
      return {
        status: "applied",
        state: {
          routeId: command.routeId,
          split: {
            [command.fromVersion]: 100 - command.toWeight,
            [command.toVersion]: command.toWeight,
          },
        },
      };
    },
  };
}
