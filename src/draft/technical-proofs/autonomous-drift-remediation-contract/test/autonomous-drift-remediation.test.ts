import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { foldCrewStream } from "../../crew-event-contract/src/crew-event-contract.js";
import { foldIncidentStream } from "../../incident-aggregate-contract/src/incident-aggregate.js";
import {
  handleResourceDrift,
  replayDriftRemediation,
} from "../src/autonomous-drift-remediation.js";

describe("autonomous drift remediation contract", () => {
  it("auto-resyncs a heal resource through the gated canary path", async () => {
    const result = await handleResourceDrift({
      drift: driftSignal({ resourceId: "api", id: "drift-api-1" }),
      policies: { api: { mode: "heal", environment: "staging", estimatedImpact: "medium" } },
      decidedAt: "2026-06-27T19:20:00.000Z",
      gateway: recordingGateway("api"),
      gateSignal: () => ({ decision: "pass", reason: "healthy" }),
    });

    assert.equal(result.status, "applied");
    assert.equal(result.classification.failureClass, "drift");
    assert.equal(result.action.kind, "resync");
    assert.equal(result.events.drift[0].type, "drift.RemediationRouted");
    assert.ok(result.events.rollout.some((event) => event.type === "rollout.Promoted"));
    assert.equal(foldCrewStream(result.events.crew).actions[0].status, "applied");
    assert.equal(foldIncidentStream(result.events.incident).status, "remediation-applied");
    assert.equal(replayDriftRemediation(result.events).status, "applied");
  });

  it("opens a gated diff for a propose resource without applying the resync", async () => {
    const result = await handleResourceDrift({
      drift: driftSignal({ resourceId: "billing-db", id: "drift-billing-1", environment: "prod" }),
      policies: { "billing-db": { mode: "propose", environment: "prod" } },
      decidedAt: "2026-06-27T19:21:00.000Z",
    });

    assert.equal(result.status, "proposed");
    assert.equal(result.events.drift[0].type, "drift.DiffProposed");
    assert.deepEqual(
      result.events.crew.map((event) => event.type),
      ["policy.Decided", "crew.ActionProposed"],
    );
    assert.equal(result.events.crew[0].data.effect, "require-approval");
    assert.ok(!result.events.crew.some((event) => event.type === "crew.ActionApplied"));
    assert.deepEqual(result.events.rollout, []);
    assert.equal(result.events.incident.at(-1).payload.diff.desiredSetRef, "set:desired@sha256-good");
    assert.equal(replayDriftRemediation(result.events).status, "proposed");
  });

  it("records ignored drift and emits no write action", async () => {
    const result = await handleResourceDrift({
      drift: driftSignal({ resourceId: "legacy-cache", id: "drift-cache-1" }),
      policies: { "legacy-cache": { mode: "ignore", reason: "adopted detect-only resource" } },
      decidedAt: "2026-06-27T19:22:00.000Z",
    });

    assert.equal(result.status, "ignored");
    assert.equal(result.events.drift[0].type, "drift.Ignored");
    assert.deepEqual(result.events.crew, []);
    assert.deepEqual(result.events.policy, []);
    assert.deepEqual(result.events.rollout, []);
    assert.equal(replayDriftRemediation(result.events).status, "ignored");
  });

  it("does not oscillate on repeated drift for the same desired and observed refs", async () => {
    const first = await handleResourceDrift({
      drift: driftSignal({ resourceId: "api", id: "drift-api-loop-1" }),
      policies: { api: { mode: "heal", environment: "staging", estimatedImpact: "medium" } },
      decidedAt: "2026-06-27T19:23:00.000Z",
      gateway: recordingGateway("api"),
      gateSignal: () => ({ decision: "pass", reason: "healthy" }),
    });

    const second = await handleResourceDrift({
      drift: driftSignal({ resourceId: "api", id: "drift-api-loop-2" }),
      policies: { api: { mode: "heal", environment: "staging", estimatedImpact: "medium" } },
      priorEvents: first.events,
      decidedAt: "2026-06-27T19:24:00.000Z",
      gateway: recordingGateway("api"),
    });

    assert.equal(second.status, "escalated");
    assert.equal(second.guard.reason, "repeated-drift-same-desired-and-observed");
    assert.deepEqual(
      second.events.crew.map((event) => event.type),
      ["crew.HandoffRequested"],
    );
    assert.ok(!second.events.crew.some((event) => event.type === "crew.ActionApplied"));
    assert.equal(second.events.drift[0].type, "drift.Escalated");
  });

  it("escalates when a drift resync would exceed the blast-radius budget", async () => {
    const result = await handleResourceDrift({
      drift: driftSignal({ resourceId: "payments", id: "drift-payments-1" }),
      policies: { payments: { mode: "heal", environment: "staging", estimatedImpact: "high" } },
      blastRadiusBudget: { maxResources: 1 },
      decidedAt: "2026-06-27T19:25:00.000Z",
    });

    assert.equal(result.status, "escalated");
    assert.equal(result.budgetDecision.reason, "blast-radius-budget-exceeded");
    assert.equal(result.events.crew[0].type, "crew.HandoffRequested");
    assert.match(result.events.crew[0].data.reason, /blast radius budget/);
    assert.deepEqual(result.events.rollout, []);
  });
});

function driftSignal({ resourceId, id, environment = "staging" }) {
  return {
    id,
    type: "resource.DriftDetected",
    resourceId,
    environment,
    occurredAt: "2026-06-27T19:19:00.000Z",
    correlationId: `corr-${resourceId}`,
    desiredSetRef: "set:desired@sha256-good",
    observedRef: "provider:observed@sha256-drifted",
  };
}

function recordingGateway(routeId) {
  return {
    state: {
      routeId,
      activeVersion: "desired-set@previous",
      split: {
        "desired-set@previous": 100,
        "desired-set@resync": 0,
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
