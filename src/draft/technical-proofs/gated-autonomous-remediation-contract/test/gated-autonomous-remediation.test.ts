import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { foldCrewStream } from "../../crew-event-contract/src/crew-event-contract.js";
import {
  INCIDENT_EVENT_TYPES,
  foldIncidentStream,
  makeIncidentEvent,
} from "../../incident-aggregate-contract/src/incident-aggregate.js";
import {
  applyGatedRemediation,
  replayGatedRemediation,
} from "../src/gated-autonomous-remediation.js";

describe("gated autonomous remediation contract", () => {
  it("auto-applies a low-risk fix as a canary and rolls back on regression", async () => {
    const result = await applyGatedRemediation({
      incidentEvents: rootCausedIncidentEvents(),
      action: failoverAction({ environment: "staging" }),
      decidedAt: "2026-06-27T18:00:00.000Z",
      gateway: recordingGateway(),
      gateSignal: ({ step }) =>
        step.action.toWeight === 10
          ? { signals: { sloBurn: { verdict: "rollback", sourceSeq: 40 } } }
          : { decision: "pass", reason: "healthy" },
    });

    assert.equal(result.status, "rolled-back");
    assert.deepEqual(result.events.crew.map((event) => event.type), [
      "policy.Decided",
      "crew.ActionProposed",
      "crew.ActionApplied",
      "crew.HandoffRequested",
    ]);
    assert.ok(result.events.rollout.some((event) => event.type === "rollout.RolledBack"));
    assert.equal(result.events.incident.at(-1).type, INCIDENT_EVENT_TYPES.remediationFailed);
    assert.equal(result.loopGuard.reason, "rolled-back-remediation-cooldown");

    assert.equal(foldCrewStream(result.events.crew).actions[0].status, "applied");
    assert.equal(foldIncidentStream(result.events.incident).status, "remediation-failed");
    assert.equal(replayGatedRemediation(result.events).status, "rolled-back");
  });

  it("does not immediately re-propose the same fix after canary rollback", async () => {
    const first = await applyGatedRemediation({
      incidentEvents: rootCausedIncidentEvents(),
      action: failoverAction({ environment: "staging" }),
      decidedAt: "2026-06-27T18:00:00.000Z",
      gateway: recordingGateway(),
      gateSignal: () => ({ signals: { goldenSuite: { status: "failed" } } }),
    });

    const second = await applyGatedRemediation({
      priorEvents: first.events,
      incidentEvents: rootCausedIncidentEvents(),
      action: failoverAction({ environment: "staging" }),
      decidedAt: "2026-06-27T18:02:00.000Z",
      gateway: recordingGateway(),
    });

    assert.equal(second.status, "loop-guarded");
    assert.deepEqual(
      second.events.crew.map((event) => event.type),
      ["crew.HandoffRequested"],
    );
    assert.ok(!second.events.crew.some((event) => event.type === "crew.ActionProposed"));
    assert.ok(!second.events.crew.some((event) => event.type === "crew.ActionApplied"));
    assert.match(second.events.crew[0].data.reason, /self-caused remediation rollback/);
  });

  it("holds a prod fix until approval and applies only after an allow decision", async () => {
    const waiting = await applyGatedRemediation({
      incidentEvents: rootCausedIncidentEvents(),
      action: failoverAction({ environment: "prod" }),
      decidedAt: "2026-06-27T18:10:00.000Z",
      gateway: recordingGateway(),
    });

    assert.equal(waiting.status, "waiting-for-approval");
    assert.deepEqual(
      waiting.events.policy.map((event) => event.type),
      ["policy.ObligationCreated"],
    );
    assert.ok(!waiting.events.crew.some((event) => event.type === "crew.ActionApplied"));

    const applied = await applyGatedRemediation({
      priorEvents: waiting.events,
      incidentEvents: rootCausedIncidentEvents(),
      action: failoverAction({ environment: "prod" }),
      approval: {
        approvedAt: "2026-06-27T18:15:00.000Z",
        approvedBy: "user:on-call",
      },
      decidedAt: "2026-06-27T18:15:30.000Z",
      gateway: recordingGateway(),
    });

    assert.equal(applied.status, "applied");
    assert.equal(applied.events.crew[0].type, "policy.Decided");
    assert.equal(applied.events.crew[0].data.effect, "allow");
    assert.equal(applied.events.crew[2].type, "crew.ActionApplied");
    assert.deepEqual(
      applied.events.policy.map((event) => event.type),
      ["policy.ObligationCreated", "policy.ObligationSatisfied"],
    );
    assert.ok(applied.events.rollout.some((event) => event.type === "rollout.Promoted"));
    assert.equal(foldIncidentStream(applied.events.incident).status, "remediation-applied");
    assert.equal(replayGatedRemediation(applied.events).policyEffect, "allow");
  });

  it("rejects crew.ActionApplied without a matching allow policy.Decided", () => {
    const invalid = {
      crew: [
        {
          id: "policy-prod",
          type: "policy.Decided",
          v: 1,
          streamId: "policy:incident-api-burn",
          seq: 1,
          ts: "2026-06-27T18:20:00.000Z",
          data: { effect: "require-approval" },
        },
        {
          id: "proposal-prod",
          type: "crew.ActionProposed",
          v: 1,
          streamId: "crew:sre",
          seq: 2,
          ts: "2026-06-27T18:20:01.000Z",
          principal: srePrincipal(),
          correlationId: "corr-api-burn",
          action: { kind: "failover", target: "checkout-route" },
          blastRadius: { environment: "prod", maxResources: 1, reversible: true },
          policyDecisionId: "policy-prod",
        },
        {
          id: "applied-prod",
          type: "crew.ActionApplied",
          v: 1,
          streamId: "crew:sre",
          seq: 3,
          ts: "2026-06-27T18:20:02.000Z",
          principal: srePrincipal(),
          correlationId: "corr-api-burn",
          proposalId: "proposal-prod",
          policyDecisionId: "policy-prod",
        },
      ],
      incident: [],
      rollout: [],
      policy: [],
    };

    assert.throws(
      () => replayGatedRemediation(invalid),
      /crew.ActionApplied requires an allow or warn policy.Decided effect/,
    );
  });
});

function rootCausedIncidentEvents() {
  const opened = makeIncidentEvent(INCIDENT_EVENT_TYPES.opened, {
    id: "incident-open-api",
    incidentId: "incident-api-burn",
    correlationId: "corr-api-burn",
    causationId: "slo-burn-api",
    occurredAt: "2026-06-27T17:55:00.000Z",
    payload: {
      severity: "SEV2",
      impact: "checkout api availability burning",
      causedBy: [{ id: "slo-burn-api", type: "slo.BudgetBurned", correlationId: "corr-api-burn" }],
    },
  });
  const triaged = makeIncidentEvent(INCIDENT_EVENT_TYPES.triaged, {
    id: "incident-triaged-api",
    incidentId: "incident-api-burn",
    correlationId: "corr-api-burn",
    causationId: opened.id,
    occurredAt: "2026-06-27T17:56:00.000Z",
    payload: { owner: "operator:sre" },
  });
  const rootCause = makeIncidentEvent(INCIDENT_EVENT_TYPES.rootCauseIdentified, {
    id: "incident-root-cause-api",
    incidentId: "incident-api-burn",
    correlationId: "corr-api-burn",
    causationId: triaged.id,
    occurredAt: "2026-06-27T17:57:00.000Z",
    payload: { rootCause: "provider edge degradation" },
  });

  return [opened, triaged, rootCause];
}

function failoverAction({ environment }) {
  return {
    kind: "failover",
    target: { kind: "region", id: "checkout-route" },
    environment,
    idempotencyKey: `failover-checkout-${environment}`,
    conformanceState: "green",
    blastRadius: {
      scope: "region",
      reversible: true,
      compensationPath: "failover:restore-primary",
      estimatedImpact: environment === "prod" ? "medium" : "low",
    },
  };
}

function recordingGateway() {
  return {
    state: {
      routeId: "checkout-route",
      activeVersion: "checkout@stable",
      split: {
        "checkout@stable": 100,
        "checkout@live-fix": 0,
      },
    },
    async apply(command) {
      if (command.kind === "gateway.shiftTraffic") {
        this.state = {
          routeId: command.routeId,
          activeVersion: command.toWeight === 100 ? command.toVersion : command.fromVersion,
          split: {
            [command.fromVersion]: 100 - command.toWeight,
            [command.toVersion]: command.toWeight,
          },
        };
        return { status: "applied", state: this.state };
      }

      if (command.kind === "gateway.rollbackTraffic") {
        this.state = {
          routeId: command.routeId,
          activeVersion: command.restoredVersion,
          split: {
            [command.restoredVersion]: 100,
            [command.revertedVersion]: 0,
          },
        };
        return { status: "applied", state: this.state };
      }

      throw new Error(`unexpected gateway command ${command.kind}`);
    },
  };
}

function srePrincipal() {
  return {
    name: "SRE",
    svid: "spiffe://yard/acme/agent/sre",
    perAgentPolicy: {
      scopedCapabilities: ["incident:read", "remediation:apply"],
      spendCapUsd: 50,
      requireApprovalGates: ["prod", "destroy", "over-budget"],
    },
    enginePort: "hobo:sre-engine/built-in@0.1.0",
  };
}
