import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  canaryStrategy,
  createDeploymentStrategySaga,
  replayGatewayState,
} from "../../deployment-strategy-saga-templates-contract/src/deployment-strategy-saga-templates.js";
import { resolvePromotionPolicy } from "../../slo-promotion-gate-contract/src/slo-promotion-gate-contract.js";
import {
  SLO_GATED_ROLLBACK_ANALYSIS_VERSION,
  completeRollbackObligation,
  evaluateRolloutMetricGate,
  replayMetricGateEvents,
  stableDigest,
} from "../src/slo-gated-rollback-analysis.js";

describe("SLO-gated rollback metric-analysis contract", () => {
  it("promotes a healthy rollout step with pinned replayable evidence", () => {
    const result = evaluateRolloutMetricGate({
      rollout: rolloutContext(),
      policy: policy(),
      sloSnapshot: sloSample({ seq: 12, burnRate: 0.4, remainingBudgetRatio: 0.82 }),
      windowSamples: [
        sloSample({ seq: 11, burnRate: 0.5, remainingBudgetRatio: 0.81 }),
        sloSample({ seq: 12, burnRate: 0.4, remainingBudgetRatio: 0.82 }),
      ],
      goldenSuite: { suiteId: "checkout-golden", status: "passed", failures: [] },
      now: "2026-06-28T18:55:00.000Z",
    });

    assert.equal(result.schemaVersion, SLO_GATED_ROLLBACK_ANALYSIS_VERSION);
    assert.equal(result.verdict, "promote");
    assert.equal(result.gateSignal.decision, "pass");
    assert.deepEqual(result.events.map((event) => event.type), ["delivery.MetricAnalysisDecided"]);
    assert.equal(result.events[0].data.verdict, "promote");
    assert.equal(result.events[0].data.evidence.sloSnapshot.seq, 12);
    assert.equal(
      result.events[0].data.inputHash,
      stableDigest(result.events[0].data.evidence),
    );

    const replayed = replayMetricGateEvents(result.events);
    assert.equal(replayed.status, "promote");
    assert.equal(replayed.latestVerdict, "promote");
  });

  it("consumes the HOBO-314 resolved SLO gate at its pinned seq", () => {
    const sloPromotionGate = resolvePromotionPolicy(promotionPolicy(), reliabilitySnapshot({
      seq: 88,
      burnRate: 0.3,
      remainingBudgetRatio: 0.84,
    }));

    const result = evaluateRolloutMetricGate({
      rollout: rolloutContext(),
      sloPromotionGate,
      windowSamples: [
        sloSample({ seq: 87, burnRate: 0.4, remainingBudgetRatio: 0.82 }),
        sloSample({ seq: 88, burnRate: 0.3, remainingBudgetRatio: 0.84 }),
      ],
      goldenSuite: { suiteId: "checkout-golden", status: "passed", failures: [] },
      now: "2026-06-28T18:57:00.000Z",
    });

    assert.equal(result.verdict, "promote");
    assert.equal(result.events[0].data.evidence.sloSnapshot.seq, 88);
    assert.equal(result.events[0].data.evidence.sloPromotionGate.seq, 88);
    assert.equal(result.events[0].data.evidence.upstreamGate.verdict, "promote");
  });

  it("rolls back through the delivery saga when sustained SLO burn crosses threshold", async () => {
    const gate = evaluateRolloutMetricGate({
      rollout: rolloutContext(),
      policy: policy({ sustainedBreachCount: 2 }),
      sloSnapshot: sloSample({ seq: 22, burnRate: 14.8, remainingBudgetRatio: 0.04 }),
      windowSamples: [
        sloSample({ seq: 21, burnRate: 13.5, remainingBudgetRatio: 0.06 }),
        sloSample({ seq: 22, burnRate: 14.8, remainingBudgetRatio: 0.04 }),
      ],
      goldenSuite: { suiteId: "checkout-golden", status: "passed" },
      now: fixedClock("2026-06-28T19:00:00.000Z"),
    });
    const obligation = gate.events.find((event) => event.type === "policy.ObligationCreated");

    assert.equal(gate.verdict, "rollback");
    assert.equal(gate.reason, "slo-burn-rate-rollback-threshold");
    assert.equal(obligation.data.status, "open");
    assert.equal(obligation.data.blocksPromotionUntil, "policy.ObligationSatisfied");

    const saga = createDeploymentStrategySaga({ now: fixedClock("2026-06-28T19:05:00.000Z") });
    const gateway = recordingGateway();
    const rollout = await saga.run({
      rollout: rolloutForSaga(),
      gateway,
      gateSignal: ({ step }) => step.action.toWeight === 50 ? gate.gateSignal : healthyGateSignal(20),
    });

    assert.equal(rollout.status.state, "rolled-back");
    assert.equal(rollout.status.rollbackReason, "slo-burn-rate-rollback-threshold");
    assert.deepEqual(gateway.commands.map((command) => command.kind), [
      "gateway.shiftTraffic",
      "gateway.shiftTraffic",
      "gateway.rollbackTraffic",
    ]);
    assert.deepEqual(replayGatewayState(rollout.events), {
      routeId: "route-checkout",
      activeVersion: "checkout@blue",
      split: {
        "checkout@blue": 100,
        "checkout@green": 0,
      },
    });

    const rollbackEvent = rollout.events.find((event) => event.type === "rollout.RolledBack");
    const satisfied = completeRollbackObligation({
      obligationEvent: obligation,
      rollbackEvent,
      now: "2026-06-28T19:08:00.000Z",
    });
    const replayed = replayMetricGateEvents([...gate.events, satisfied]);

    assert.equal(satisfied.type, "policy.ObligationSatisfied");
    assert.equal(replayed.status, "rollback");
    assert.deepEqual(replayed.openObligations, []);
  });

  it("rolls back on continuous Golden-suite failure even when SLO burn is healthy", () => {
    const result = evaluateRolloutMetricGate({
      rollout: rolloutContext(),
      policy: policy(),
      sloSnapshot: sloSample({ seq: 30, burnRate: 0.2, remainingBudgetRatio: 0.94 }),
      windowSamples: [
        sloSample({ seq: 29, burnRate: 0.2, remainingBudgetRatio: 0.95 }),
        sloSample({ seq: 30, burnRate: 0.2, remainingBudgetRatio: 0.94 }),
      ],
      goldenSuite: {
        suiteId: "checkout-golden",
        status: "failed",
        failures: [{ checkId: "checkout-contract-replay", runId: "golden-run-17" }],
      },
    });

    assert.equal(result.verdict, "rollback");
    assert.equal(result.reason, "golden-suite-failure");
    assert.equal(result.gateSignal.decision, "fail");
    assert.equal(result.events[1].type, "policy.ObligationCreated");
    assert.equal(result.events[0].data.evidence.goldenSuite.failures[0].checkId, "checkout-contract-replay");
  });

  it("holds instead of oscillating on flapping burn-rate samples near threshold", () => {
    const result = evaluateRolloutMetricGate({
      rollout: rolloutContext(),
      policy: policy({ sustainedBreachCount: 3, sustainedHealthyCount: 2 }),
      sloSnapshot: sloSample({ seq: 43, burnRate: 12.3, remainingBudgetRatio: 0.18 }),
      windowSamples: [
        sloSample({ seq: 40, burnRate: 12.8, remainingBudgetRatio: 0.12 }),
        sloSample({ seq: 41, burnRate: 0.8, remainingBudgetRatio: 0.31 }),
        sloSample({ seq: 42, burnRate: 12.6, remainingBudgetRatio: 0.13 }),
        sloSample({ seq: 43, burnRate: 12.3, remainingBudgetRatio: 0.18 }),
      ],
    });

    assert.equal(result.verdict, "hold");
    assert.equal(result.reason, "slo-burn-rate-hold-threshold");
    assert.equal(result.gateSignal.decision, "hold");
    assert.deepEqual(result.events.map((event) => event.type), ["delivery.MetricAnalysisDecided"]);
  });

  it("holds on missing or stale SLO reads and never reports optimistic promote", () => {
    for (const status of ["stale", "unavailable", "no-data"]) {
      const result = evaluateRolloutMetricGate({
        rollout: rolloutContext(),
        policy: policy(),
        sloSnapshot: sloSample({ seq: 50, status, burnRate: 0, remainingBudgetRatio: 0 }),
        windowSamples: [
          sloSample({ seq: 50, status, burnRate: 0, remainingBudgetRatio: 0 }),
        ],
      });

      assert.equal(result.verdict, "hold", status);
      assert.equal(result.gateSignal.decision, "hold", status);
      assert.equal(result.reason, `slo-snapshot-${status}`);
      assert.equal(result.events.length, 1);
    }
  });

  it("keeps rollback obligations blocking until they are satisfied or escalated", () => {
    const result = evaluateRolloutMetricGate({
      rollout: rolloutContext(),
      policy: policy({ sustainedBreachCount: 2 }),
      sloSnapshot: sloSample({ seq: 62, burnRate: 20, remainingBudgetRatio: 0.01 }),
      windowSamples: [
        sloSample({ seq: 61, burnRate: 19, remainingBudgetRatio: 0.02 }),
        sloSample({ seq: 62, burnRate: 20, remainingBudgetRatio: 0.01 }),
      ],
    });
    const obligation = result.events.find((event) => event.type === "policy.ObligationCreated");
    const open = replayMetricGateEvents(result.events);

    assert.equal(open.status, "rollback-obligation-open");
    assert.deepEqual(open.openObligations.map((event) => event.id), [obligation.id]);

    const escalated = completeRollbackObligation({
      obligationEvent: obligation,
      status: "escalated",
      reason: "rollback-command-deadline-exhausted",
      now: "2026-06-28T19:20:00.000Z",
    });
    const replayed = replayMetricGateEvents([...result.events, escalated]);

    assert.equal(escalated.type, "policy.ObligationEscalated");
    assert.equal(replayed.status, "rollback");
    assert.deepEqual(replayed.escalatedObligationIds, [obligation.id]);
    assert.deepEqual(replayed.openObligations, []);
  });
});

function policy(overrides = {}) {
  return {
    analysisWindow: "5m",
    holdBurnRate: 1,
    rollbackBurnRate: 12,
    minRemainingBudgetRatio: 0.08,
    holdRemainingBudgetRatio: 0.2,
    sustainedBreachCount: 2,
    sustainedHealthyCount: 2,
    ...overrides,
  };
}

function rolloutContext(overrides = {}) {
  return {
    rolloutId: "rollout-checkout-42",
    stepId: "canary-50",
    routeId: "route-checkout",
    fromVersion: "checkout@blue",
    toVersion: "checkout@green",
    tenant: "tenant-a",
    ...overrides,
  };
}

function promotionPolicy() {
  return {
    id: "checkout-canary-policy",
    gates: [
      {
        sloId: "checkout-availability",
        analysisWindow: "5m",
        thresholds: {
          holdBurnRate: 1,
          rollbackBurnRate: 12,
          minRemainingBudgetRatio: 0.08,
        },
      },
    ],
  };
}

function reliabilitySnapshot(overrides = {}) {
  return {
    seq: overrides.seq ?? 1,
    generatedAt: "2026-06-28T18:57:00.000Z",
    slos: [
      {
        id: "checkout-availability",
        burnRate: overrides.burnRate ?? 0.2,
        remainingBudgetRatio: overrides.remainingBudgetRatio ?? 0.9,
        status: overrides.status ?? "available",
      },
    ],
  };
}

function sloSample(overrides = {}) {
  return {
    sloId: "checkout-availability",
    seq: 1,
    status: "available",
    burnRate: 0.2,
    remainingBudgetRatio: 0.9,
    observedAt: "2026-06-28T19:00:00.000Z",
    ...overrides,
  };
}

function rolloutForSaga() {
  return {
    rolloutId: "rollout-checkout-42",
    runId: "run-checkout-42",
    tenant: "tenant-a",
    actor: { kind: "service-account", id: "delivery-harness", tenant: "tenant-a" },
    target: {
      service: "checkout-api",
      routeId: "route-checkout",
      fromVersion: "checkout@blue",
      toVersion: "checkout@green",
    },
    strategy: canaryStrategy({
      routeId: "route-checkout",
      percentages: [10, 50, 100],
      healthGate: {
        id: "slo:checkout-availability",
        timeoutMs: 300000,
      },
      autoRollbackSignals: ["slo:checkout-availability", "golden-suite"],
    }),
  };
}

function healthyGateSignal(seq) {
  return {
    decision: "pass",
    reason: "within-slo-budget",
    signals: {
      sloBurn: {
        verdict: "promote",
        reason: "within-slo-budget",
        sourceSeq: seq,
        sloId: "checkout-availability",
      },
    },
  };
}

function recordingGateway() {
  return {
    state: {
      routeId: "route-checkout",
      activeVersion: "checkout@blue",
      split: {
        "checkout@blue": 100,
        "checkout@green": 0,
      },
    },
    commands: [],
    async apply(command) {
      this.commands.push(command);
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
            [command.restoredVersion]: command.restoredWeight,
            [command.revertedVersion]: 0,
          },
        };
        return { status: "applied", state: this.state };
      }
      throw new Error(`unexpected gateway command ${command.kind}`);
    },
  };
}

function fixedClock(startIso) {
  const start = Date.parse(startIso);
  let tick = 0;
  return () => new Date(start + tick++ * 60_000).toISOString();
}
