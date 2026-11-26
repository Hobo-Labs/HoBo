import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  INCIDENT_EVENT_TYPES,
  makeIncidentEvent,
} from "../../incident-aggregate-contract/src/incident-aggregate.js";
import {
  DISASTER_RECOVERY_RUNBOOK_NAME,
  buildDisasterRecoveryPostmortem,
  orchestrateDisasterRecovery,
  replayDisasterRecovery,
} from "../src/disaster-recovery-failover.js";

describe("disaster recovery failover orchestration contract", () => {
  it("runs a gated failover and replay-restore drill with measured RPO/RTO", async () => {
    const result = await orchestrateDisasterRecovery({
      incidentEvents: providerLossIncident(),
      sourceLog: synchronousReplicatedLog(),
      lease: stalePrimaryLease(),
      targetYard: { id: "yard-us-west", region: "us-west-2", camp: "prod" },
      gateway: recordingGateway(),
      detectedAt: "2026-06-27T18:00:00.000Z",
      restoredAt: "2026-06-27T18:08:00.000Z",
      rtoTargetMs: 15 * 60 * 1000,
      rpoTargetMs: 0,
    });

    assert.equal(result.status, "restored");
    assert.equal(result.runbook.name, DISASTER_RECOVERY_RUNBOOK_NAME);
    assert.equal(result.failover.action.kind, "failover");
    assert.equal(result.remediation.status, "applied");
    assert.deepEqual(
      result.events.runbook.map((event) => event.type),
      [
        "runbook.Defined",
        "runbook.Triggered",
        "runbook.StepCompleted",
        "runbook.StepCompleted",
        "runbook.StepCompleted",
        "runbook.StepCompleted",
        "runbook.StepCompleted",
        "runbook.Completed",
      ],
    );
    assert.deepEqual(
      result.events.crew.map((event) => event.type),
      ["policy.Decided", "crew.ActionProposed", "crew.ActionApplied"],
    );
    assert.equal(result.restore.projectionsRehydrated, 3);
    assert.equal(result.restore.actorsRehydrated, 2);
    assert.equal(result.restore.rpo.ms, 0);
    assert.equal(result.restore.rpo.claimsZeroDataLoss, true);
    assert.equal(result.restore.rto.ms, 8 * 60 * 1000);
    assert.equal(result.restore.rto.withinTarget, true);
    assert.equal(result.fencing.stalePrimaryAppend.reason, "no-contending-append");
    assert.equal(
      result.events.runbook.find((event) => event.payload.kind === "fence-original-owner")?.payload.reason,
      "no contending append observed",
    );
    assert.equal(result.events.incident.at(-2).type, INCIDENT_EVENT_TYPES.resolved);
    assert.equal(result.events.incident.at(-1).type, INCIDENT_EVENT_TYPES.postmortemFiled);

    const replay = replayDisasterRecovery(result.events);
    assert.equal(replay.status, "restored");
    assert.equal(replay.restore.rpo.ms, 0);
    assert.equal(replay.restore.rto.ms, 8 * 60 * 1000);
  });

  it("rejects stale primary writes after failover with a higher fence token", async () => {
    const result = await orchestrateDisasterRecovery({
      incidentEvents: providerLossIncident(),
      sourceLog: synchronousReplicatedLog(),
      lease: stalePrimaryLease(),
      targetYard: { id: "yard-us-west", region: "us-west-2", camp: "prod" },
      gateway: recordingGateway(),
      stalePrimaryAppend: {
        ownerNode: "yard-node-a",
        fenceToken: 41,
        seq: 701,
        eventType: "resource.Provisioned",
      },
    });

    assert.equal(result.fencing.newFenceToken, 42);
    assert.equal(result.fencing.stalePrimaryAppend.accepted, false);
    assert.equal(result.fencing.stalePrimaryAppend.reason, "stale-fence-rejected");
    assert.match(
      result.events.runbook.find((event) => event.payload.kind === "fence-original-owner")?.payload.reason,
      /lower fenceToken/,
    );
  });

  it("surfaces bounded staleness for lagged async restore and refuses zero-loss wording", async () => {
    const result = await orchestrateDisasterRecovery({
      incidentEvents: providerLossIncident(),
      sourceLog: laggedAsyncReplicatedLog(),
      lease: stalePrimaryLease(),
      targetYard: { id: "yard-us-west", region: "us-west-2", camp: "prod" },
      gateway: recordingGateway(),
      detectedAt: "2026-06-27T18:00:00.000Z",
      restoredAt: "2026-06-27T18:06:30.000Z",
      rpoTargetMs: 5000,
      rtoTargetMs: 15 * 60 * 1000,
    });

    assert.equal(result.restore.rpo.label, "bounded-staleness");
    assert.equal(result.restore.rpo.ms, 4500);
    assert.equal(result.restore.rpo.claimsZeroDataLoss, false);
    assert.deepEqual(result.restore.rpo.unreplicatedSeqRange, [705, 709]);
    assert.match(buildDisasterRecoveryPostmortem(result.events), /bounded-staleness RPO: 4500ms/);
  });
});

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
