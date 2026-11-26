import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  applyDeploymentAfterGate,
  evaluateErrorBudgetDeployGate,
  handleAutoRevertObligationSignal,
  replayErrorBudgetDeployGate,
} from "../src/error-budget-deploy-gate.js";

const BASE_TIME = "2026-06-27T21:55:00.000Z";

function deployRequest(overrides = {}) {
  return {
    deployId: "deploy-checkout-api-42",
    bindle: "checkout-api",
    camp: "prod-us",
    environment: "prod",
    actor: {
      kind: "user",
      id: "user:deployer",
      roles: ["Deployer"],
    },
    phase: "can-deploy",
    ...overrides,
  };
}

function sloSnapshot(overrides = {}) {
  return {
    seq: 41,
    generatedAt: BASE_TIME,
    sloId: "checkout-availability",
    status: "burning",
    burnRate: 12.5,
    remainingBudgetRatio: 0.02,
    window: "30m",
    ...overrides,
  };
}

describe("error-budget can-deploy gate", () => {
  it("freezes a deploy on burning budget and records replayable policy.Decided evidence", () => {
    const result = evaluateErrorBudgetDeployGate({
      deploy: deployRequest(),
      slo: sloSnapshot(),
      policy: {
        freezeBurnRate: 8,
        minRemainingBudgetRatio: 0.05,
      },
      now: BASE_TIME,
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.decision.effect, "deny");
    assert.equal(result.decision.reason, "error-budget-freeze");
    assert.deepEqual(result.events.map((event) => event.type), ["policy.Decided"]);

    const [decisionEvent] = result.events;
    assert.equal(decisionEvent.data.phase, "can-deploy");
    assert.equal(decisionEvent.data.dimension, "error-budget");
    assert.equal(decisionEvent.data.evidence.sloSeq, 41);
    assert.equal(decisionEvent.data.evidence.burnRate, 12.5);
    assert.equal(decisionEvent.data.evidence.remainingBudgetRatio, 0.02);

    const replayed = replayErrorBudgetDeployGate(result.events);
    assert.equal(replayed.decisions.length, 1);
    assert.equal(replayed.decisions[0].data.effect, "deny");
    assert.equal(replayed.decisions[0].data.evidence.inputHash, decisionEvent.data.evidence.inputHash);
  });

  it("lifts a previous freeze when a fresh healthy budget recovers", () => {
    const result = evaluateErrorBudgetDeployGate({
      deploy: deployRequest(),
      slo: sloSnapshot({
        seq: 42,
        status: "healthy",
        burnRate: 0.4,
        remainingBudgetRatio: 0.91,
      }),
      previousDecision: {
        id: "policy.Decided:deploy-checkout-api-42:41",
        effect: "deny",
        reason: "error-budget-freeze",
        decidedAt: "2026-06-27T21:50:00.000Z",
      },
      policy: {
        freezeBurnRate: 8,
        minRemainingBudgetRatio: 0.05,
      },
      now: "2026-06-27T22:00:00.000Z",
    });

    assert.equal(result.status, "allowed");
    assert.equal(result.decision.effect, "allow");
    assert.equal(result.decision.reason, "error-budget-recovered");
    assert.equal(result.events[0].data.evidence.previousDecisionId, "policy.Decided:deploy-checkout-api-42:41");
  });

  it("rechecks the SLO snapshot at apply and blocks if a burn appears after can-deploy", () => {
    const initial = evaluateErrorBudgetDeployGate({
      deploy: deployRequest(),
      slo: sloSnapshot({
        seq: 42,
        status: "healthy",
        burnRate: 0.4,
        remainingBudgetRatio: 0.91,
      }),
      policy: {
        freezeBurnRate: 8,
        minRemainingBudgetRatio: 0.05,
      },
      now: "2026-06-27T22:00:00.000Z",
    });

    const applied = applyDeploymentAfterGate({
      deploy: deployRequest(),
      gateDecision: initial.events[0],
      latestSlo: sloSnapshot({
        seq: 43,
        status: "burning",
        burnRate: 9.1,
        remainingBudgetRatio: 0.03,
      }),
      policy: {
        freezeBurnRate: 8,
        minRemainingBudgetRatio: 0.05,
      },
      now: "2026-06-27T22:01:00.000Z",
    });

    assert.equal(applied.status, "blocked-at-apply");
    assert.equal(applied.applied, false);
    assert.deepEqual(applied.events.map((event) => event.type), ["policy.Decided"]);
    assert.equal(applied.events[0].data.reason, "error-budget-freeze");
    assert.equal(applied.events[0].data.evidence.recheckedFromDecisionId, initial.events[0].id);
    assert.equal(applied.events[0].data.evidence.sloSeq, 43);
  });

  it("rechecks at apply and lifts a stale freeze when the budget recovered", () => {
    const initial = evaluateErrorBudgetDeployGate({
      deploy: deployRequest(),
      slo: sloSnapshot({
        seq: 43,
        status: "burning",
        burnRate: 9.1,
        remainingBudgetRatio: 0.03,
      }),
      policy: {
        freezeBurnRate: 8,
        minRemainingBudgetRatio: 0.05,
      },
      now: "2026-06-27T22:00:00.000Z",
    });

    const applied = applyDeploymentAfterGate({
      deploy: deployRequest(),
      gateDecision: initial.events[0],
      latestSlo: sloSnapshot({
        seq: 44,
        status: "healthy",
        burnRate: 0.4,
        remainingBudgetRatio: 0.91,
      }),
      policy: {
        freezeBurnRate: 8,
        minRemainingBudgetRatio: 0.05,
      },
      now: "2026-06-27T22:01:00.000Z",
    });

    assert.equal(applied.status, "applied");
    assert.equal(applied.applied, true);
    assert.equal(applied.decision.reason, "error-budget-recovered");
    assert.equal(applied.events[0].data.evidence.recheckedFromDecisionId, initial.events[0].id);
    assert.equal(applied.events[0].data.evidence.sloSeq, 44);
  });

  it("auto-reverts an in-flight rollout through the strategy saga when SLO burn triggers the obligation", () => {
    const result = handleAutoRevertObligationSignal({
      obligationEvent: {
        id: "policy.ObligationCreated:rollout-checkout-api",
        type: "policy.ObligationCreated",
        data: {
          status: "open",
          policyDecisionId: "policy.Decided:deploy-checkout-api-42:42",
          obligation: {
            kind: "error-budget.auto-revert",
            target: {
              kind: "rollout",
              rolloutId: "rollout-checkout-api-42",
              fromVersion: "v1",
              toVersion: "v2",
            },
          },
        },
      },
      sloBurnEvent: {
        id: "slo.BudgetBurned:checkout-availability:43",
        type: "slo.BudgetBurned",
        data: {
          burnRate: 12.5,
          remainingBudgetRatio: 0.02,
        },
      },
      now: "2026-06-27T22:02:00.000Z",
    });

    assert.equal(result.status, "satisfied");
    assert.deepEqual(result.events.map((event) => event.type), [
      "policy.ObligationTriggered",
      "rollout.RolledBack",
      "policy.ObligationSatisfied",
    ]);
    assert.equal(result.events[1].data.rolloutId, "rollout-checkout-api-42");
    assert.equal(result.events[1].data.restoredVersion, "v1");
    assert.equal(result.events[1].data.strategySaga, "deployment-strategy-saga-templates");
    assert.equal(result.events[2].data.resultEventId, result.events[1].id);
  });

  it("escalates and preserves compensation evidence when auto-revert fails", () => {
    const result = handleAutoRevertObligationSignal({
      obligationEvent: {
        id: "policy.ObligationCreated:rollout-checkout-api",
        type: "policy.ObligationCreated",
        data: {
          status: "open",
          policyDecisionId: "policy.Decided:deploy-checkout-api-42:42",
          obligation: {
            kind: "error-budget.auto-revert",
            target: {
              kind: "rollout",
              rolloutId: "rollout-checkout-api-42",
              fromVersion: "v1",
              toVersion: "v2",
            },
          },
        },
      },
      sloBurnEvent: {
        id: "slo.BudgetBurned:checkout-availability:43",
        type: "slo.BudgetBurned",
        data: {
          burnRate: 12.5,
          remainingBudgetRatio: 0.02,
        },
      },
      autoRevertResult: {
        status: "failed",
        reason: "gateway rejected rollback command",
      },
      now: "2026-06-27T22:02:30.000Z",
    });

    assert.equal(result.status, "escalated");
    assert.deepEqual(result.events.map((event) => event.type), [
      "policy.ObligationTriggered",
      "rollout.RollbackFailed",
      "policy.ObligationEscalated",
    ]);
    assert.equal(result.events[1].data.reason, "gateway rejected rollback command");
    assert.equal(result.events[2].data.failedEventId, result.events[1].id);
    assert.equal(result.events[2].data.compensation, "manual-rollback-or-traffic-drain-required");
  });

  it("auto-reverts feature flags through the flag plane using the same obligation surface", () => {
    const result = handleAutoRevertObligationSignal({
      obligationEvent: {
        id: "policy.ObligationCreated:flag-checkout-expedite",
        type: "policy.ObligationCreated",
        data: {
          status: "open",
          policyDecisionId: "policy.Decided:deploy-checkout-api-42:42",
          obligation: {
            kind: "error-budget.auto-revert",
            target: {
              kind: "feature-flag",
              flagKey: "checkout.expedite",
              previousVariation: "off",
            },
          },
        },
      },
      sloBurnEvent: {
        id: "slo.BudgetBurned:checkout-availability:43",
        type: "slo.BudgetBurned",
        data: {
          burnRate: 12.5,
          remainingBudgetRatio: 0.02,
        },
      },
      now: "2026-06-27T22:02:45.000Z",
    });

    assert.equal(result.status, "satisfied");
    assert.deepEqual(result.events.map((event) => event.type), [
      "policy.ObligationTriggered",
      "flag.Changed",
      "policy.ObligationSatisfied",
    ]);
    assert.equal(result.events[1].data.flagKey, "checkout.expedite");
    assert.equal(result.events[1].data.restoredVariation, "off");
    assert.equal(result.events[1].data.flagPlane, "policy-gated-flag-flips");
  });

  it("holds a recovered budget until hysteresis confirms it is not flapping", () => {
    const result = evaluateErrorBudgetDeployGate({
      deploy: deployRequest(),
      slo: sloSnapshot({
        seq: 44,
        status: "healthy",
        burnRate: 0.5,
        remainingBudgetRatio: 0.82,
      }),
      previousDecision: {
        id: "policy.Decided:deploy-checkout-api-42:43",
        effect: "deny",
        reason: "error-budget-freeze",
      },
      policy: {
        freezeBurnRate: 8,
        minRemainingBudgetRatio: 0.05,
        recoveryHysteresis: {
          minHealthySnapshots: 2,
          healthySnapshots: 1,
          window: "5m",
        },
      },
      now: "2026-06-27T22:03:00.000Z",
    });

    assert.equal(result.status, "blocked");
    assert.equal(result.decision.effect, "deny");
    assert.equal(result.decision.reason, "error-budget-hysteresis-hold");
    assert.equal(result.events[0].data.evidence.hysteresis.minHealthySnapshots, 2);
    assert.equal(result.events[0].data.evidence.hysteresis.healthySnapshots, 1);
  });

  it("allows emergency deploys through an audited break-glass override", () => {
    const result = evaluateErrorBudgetDeployGate({
      deploy: deployRequest({ phase: "emergency-can-deploy" }),
      slo: sloSnapshot({
        seq: 45,
        status: "burning",
        burnRate: 13,
        remainingBudgetRatio: 0.01,
      }),
      policy: {
        freezeBurnRate: 8,
        minRemainingBudgetRatio: 0.05,
        breakGlass: {
          id: "breakglass:incident-7",
          approvedBy: "user:incident-commander",
          reason: "restore checkout availability",
          expiresAt: "2026-06-27T22:15:00.000Z",
        },
      },
      now: "2026-06-27T22:04:00.000Z",
    });

    assert.equal(result.status, "allowed");
    assert.equal(result.decision.effect, "allow");
    assert.equal(result.decision.reason, "error-budget-break-glass");
    assert.equal(result.events[0].data.evidence.breakGlass.id, "breakglass:incident-7");
    assert.equal(result.events[0].data.evidence.breakGlass.approvedBy, "user:incident-commander");
  });
});
