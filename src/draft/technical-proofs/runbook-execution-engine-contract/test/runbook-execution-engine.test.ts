import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  INCIDENT_EVENT_TYPES,
  makeIncidentEvent,
} from "../../incident-aggregate-contract/src/incident-aggregate.js";
import { createProjectionReadStore } from "../../sre-diagnose-projection-contract/src/sre-diagnose-projection.js";
import {
  createStackStormEnginePortStub,
  executeRunbook,
  replayRunbookExecution,
  runHoboRunbookExec,
} from "../src/runbook-execution-engine.js";

describe("runbook execution engine contract", () => {
  it("executes high-5xx-on-api end-to-end through diagnosis, classification, gate dispatch, and replay", async () => {
    const gateway = recordingGateway();
    const result = await executeRunbook({
      runbook: high5xxRunbook(),
      incidentEvents: incidentOpenedAndTriaged(),
      projections: high5xxProjectionStore(),
      signal: {
        kind: "saturation",
        capacityExhausted: true,
        resourceId: "api",
        environment: "staging",
        conformanceState: "green",
      },
      gateway,
      executedAt: "2026-06-27T12:00:00.000Z",
      canaryPercentages: [100],
      healthGate: { id: "api-health", timeoutMs: 300000, passAfterConsecutive: 1, failAfterConsecutive: 1 },
    });

    assert.equal(result.status, "completed");
    assert.equal(result.selectedFix.when, "capacity-exhausted");
    assert.equal(result.classification.failureClass, "capacity-exhausted");
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
    assert.equal(result.replay.runbook.status, "completed");
    assert.equal(result.replay.selectedFix, "capacity-exhausted");
    assert.equal(gateway.commands.length, 1);
    assert.equal(gateway.commands[0].kind, "gateway.shiftTraffic");
    assert.equal(result.events.incident.at(-1).type, "incident.RemediationApplied");
  });

  it("escalates when no fix matches the classified failure", async () => {
    const result = await executeRunbook({
      runbook: high5xxRunbook(),
      incidentEvents: incidentOpenedAndTriaged(),
      projections: high5xxProjectionStore(),
      signal: {
        kind: "unmapped-backend-failure",
        resourceId: "api",
        environment: "staging",
        conformanceState: "green",
      },
      executedAt: "2026-06-27T12:00:00.000Z",
    });

    assert.equal(result.status, "escalated");
    assert.equal(result.classification.failureClass, "unclassifiable");
    assert.equal(result.selectedFix.when, "unknown");
    assert.equal(result.selectedFix.action.kind, "escalate");
    assert.equal(result.remediation.status, "waiting-for-approval");
    assert.equal(result.events.policy[0].type, "policy.ObligationCreated");
    assert.equal(result.replay.selectedFix, "unknown");
  });

  it("makes hobo runbook exec --incident replayable from an incident event store", async () => {
    const command = await runHoboRunbookExec({
      incidentId: "incident-api-burn",
      runbooks: [high5xxRunbook()],
      eventStore: new Map([["incident-api-burn", incidentOpenedAndTriaged()]]),
      projections: high5xxProjectionStore(),
      signal: {
        kind: "saturation",
        resourceId: "api",
        environment: "staging",
        conformanceState: "green",
      },
      gateway: recordingGateway(),
      executedAt: "2026-06-27T12:00:00.000Z",
      canaryPercentages: [100],
      healthGate: { id: "api-health", timeoutMs: 300000, passAfterConsecutive: 1, failAfterConsecutive: 1 },
    });

    assert.equal(command.command, "hobo runbook exec --incident incident-api-burn");
    assert.equal(command.runbookName, "high-5xx-on-api");
    assert.equal(command.result.status, "completed");
    assert.deepEqual(command.replay, replayRunbookExecution(command.result.events.runbook));
  });

  it("resolves a signal matching two classes deterministically and never dispatches both fixes", async () => {
    const gateway = recordingGateway();
    const result = await executeRunbook({
      runbook: high5xxRunbook(),
      incidentEvents: incidentOpenedAndTriaged(),
      projections: high5xxProjectionStore(),
      signal: {
        kind: "provider-region-health",
        providerDegraded: true,
        capacityExhausted: true,
        region: "us-east-1",
        resourceId: "api",
        environment: "staging",
        conformanceState: "green",
      },
      gateway,
      executedAt: "2026-06-27T12:00:00.000Z",
      canaryPercentages: [100],
      healthGate: { id: "api-health", timeoutMs: 300000, passAfterConsecutive: 1, failAfterConsecutive: 1 },
    });

    assert.deepEqual(result.classification.matchedClasses, [
      "provider-degraded-region",
      "capacity-exhausted",
    ]);
    assert.equal(result.selectedFix.when, "provider-degraded");
    assert.equal(result.events.crew.filter((event) => event.type === "crew.ActionProposed").length, 1);
    assert.equal(result.events.crew[1].data.action.kind, "failover");
    assert.equal(gateway.commands.length, 1);
  });

  it("aborts before gate dispatch when the selected fix exceeds the blast-radius budget", async () => {
    const gateway = recordingGateway();
    const result = await executeRunbook({
      runbook: high5xxRunbook(),
      incidentEvents: incidentOpenedAndTriaged(),
      projections: high5xxProjectionStore(),
      signal: {
        kind: "provider-region-health",
        providerDegraded: true,
        region: "us-east-1",
        environment: "staging",
        conformanceState: "green",
      },
      gateway,
      blastRadiusBudget: { maxImpact: "low", maxResources: 1, allowedScopes: ["resource"] },
      executedAt: "2026-06-27T12:00:00.000Z",
    });

    assert.equal(result.status, "aborted");
    assert.equal(result.remediation, null);
    assert.equal(result.replay.runbook.status, "failed");
    assert.equal(result.replay.failureReason, "blast-radius-budget-exceeded");
    assert.deepEqual(gateway.commands, []);
    assert.equal(result.events.crew.length, 0);
  });

  it("publishes StackStorm as a mapping-only engine-port stub behind the native Pipelines engine", () => {
    const stub = createStackStormEnginePortStub();

    assert.equal(stub.provider, "stackstorm");
    assert.equal(stub.mode, "stub");
    assert.match(stub.mapping.fix, /RemediationAction/);
    assert.throws(() => stub.execute(), /mapping-only/);
  });
});

function incidentOpenedAndTriaged() {
  const opened = makeIncidentEvent(INCIDENT_EVENT_TYPES.opened, {
    id: "incident-open-api-burn",
    incidentId: "incident-api-burn",
    correlationId: "corr-api-burn",
    causationId: "slo-burn-api",
    occurredAt: "2026-06-27T11:59:00.000Z",
    payload: {
      severity: "high",
      impact: "checkout api 5xx burst",
      causedBy: [{ id: "slo-burn-api", type: "slo.BudgetBurned", correlationId: "corr-api-burn" }],
    },
  });
  const triaged = makeIncidentEvent(INCIDENT_EVENT_TYPES.triaged, {
    id: "incident-triaged-api-burn",
    incidentId: "incident-api-burn",
    correlationId: "corr-api-burn",
    causationId: opened.id,
    occurredAt: "2026-06-27T11:59:30.000Z",
    payload: { owner: "operator:sre" },
  });

  return [opened, triaged];
}

function high5xxProjectionStore() {
  return createProjectionReadStore({
    "tail_logs api": {
      atSeq: 51,
      stale: false,
      value: { topError: "HTTP 503 from checkout-api", sampleCount: 42 },
    },
    "get_drift api": {
      atSeq: 51,
      stale: false,
      value: { drifted: false },
    },
    "slo_status api.availability": {
      atSeq: 51,
      stale: false,
      value: { burnRate: 18.1, rootCauseHint: "api error budget burn" },
    },
  });
}

function high5xxRunbook() {
  return {
    name: "high-5xx-on-api",
    version: "0.1.0",
    on: { alert: "api.5xx-burst", severity: ">=SEV2" },
    diagnose: ["tail_logs api", "get_drift api", "slo_status api.availability"],
    fix: [
      {
        when: "provider-degraded",
        gate: "canary-with-auto-rollback",
        action: boundedAction({
          kind: "failover",
          target: { kind: "region", id: "us-east-1" },
          environment: "staging",
          impact: "medium",
        }),
      },
      {
        when: "capacity-exhausted",
        gate: "auto",
        action: boundedAction({
          kind: "scale",
          target: { kind: "resource", id: "api" },
          environment: "staging",
          impact: "low",
        }),
      },
      {
        when: "unknown",
        gate: "require-approval",
        action: {
          kind: "escalate",
          target: { kind: "resource", id: "runbook:high-5xx-on-api" },
          blastRadius: {
            scope: "resource",
            reversible: false,
            estimatedImpact: "high",
          },
          environment: "prod",
          idempotencyKey: "runbook/high-5xx/escalate",
          conformanceState: "unknown",
        },
      },
    ],
    signature: {
      signedBy: "yard:ops",
      digest: "sha256:2d7c8f6b6b3ce3ed0f7722e9d14a0ebc1d6f8fbe31dbbb7f647df1c0fcb427e8",
      signature: "sigstore:fixture",
    },
  };
}

function boundedAction({ kind, target, environment, impact }) {
  return {
    kind,
    target,
    blastRadius: {
      scope: target.kind,
      reversible: true,
      compensationPath: `undo-${kind}`,
      estimatedImpact: impact,
    },
    environment,
    idempotencyKey: `incident-api-burn/${kind}/${target.id}`,
    conformanceState: "green",
  };
}

function recordingGateway() {
  const commands = [];

  return {
    commands,
    async apply(command) {
      commands.push(command);
      if (command.kind === "gateway.shiftTraffic") {
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
      }
      if (command.kind === "gateway.rollbackTraffic") {
        return {
          status: "rolled-back",
          state: {
            routeId: command.routeId,
            split: {
              [command.restoredVersion]: command.restoredWeight,
              [command.revertedVersion]: 0,
            },
          },
        };
      }
      return { status: "applied" };
    },
  };
}
