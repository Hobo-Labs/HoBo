import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createGateDecision,
  evaluatePromotionGate,
  resolvePromotionPolicy,
  SLO_PROMOTION_GATE_CONTRACT_VERSION
} from "../src/slo-promotion-gate-contract.js";

function healthySnapshot() {
  return {
    seq: 42,
    generatedAt: "2026-06-25T04:00:00.000Z",
    slos: [
      {
        id: "checkout.latency",
        burnRate: 0.7,
        remainingBudgetRatio: 0.72,
        status: "available"
      }
    ]
  };
}

function policy(overrides = {}) {
  return {
    id: "checkout-canary-policy",
    gates: [
      {
        sloId: "checkout.latency",
        analysisWindow: "5m",
        thresholds: {
          holdBurnRate: 1.0,
          rollbackBurnRate: 2.0,
          minRemainingBudgetRatio: 0.1
        }
      }
    ],
    ...overrides
  };
}

test("contract exports a versioned promotion-gate surface", () => {
  assert.equal(SLO_PROMOTION_GATE_CONTRACT_VERSION, "hobo.slo-promotion-gate/v1");
});

test("promotion-policy references resolve to a burn-rate snapshot at a pinned seq", () => {
  const resolved = resolvePromotionPolicy(policy(), healthySnapshot());

  assert.equal(resolved.version, SLO_PROMOTION_GATE_CONTRACT_VERSION);
  assert.equal(resolved.seq, 42);
  assert.equal(resolved.policyId, "checkout-canary-policy");
  assert.deepEqual(resolved.gates, [
    {
      sloId: "checkout.latency",
      analysisWindow: "5m",
      thresholds: {
        holdBurnRate: 1.0,
        rollbackBurnRate: 2.0,
        minRemainingBudgetRatio: 0.1
      },
      snapshot: {
        burnRate: 0.7,
        remainingBudgetRatio: 0.72,
        status: "available"
      }
    }
  ]);
});

test("fixed snapshot and thresholds produce a pure replayable promote verdict", () => {
  const source = healthySnapshot();
  const resolved = resolvePromotionPolicy(policy(), source);

  source.seq = 99;
  source.slos[0].burnRate = 9;

  assert.equal(evaluatePromotionGate(resolved).verdict, "promote");
  assert.equal(resolved.seq, 42);
  assert.equal(resolved.gates[0].snapshot.burnRate, 0.7);
});

test("golden-suite failure maps to rollback verdict", () => {
  const resolved = resolvePromotionPolicy(
    policy({
      goldenSuite: {
        signal: "continuous",
        failures: [{ suiteId: "golden.default", runId: "run-17" }]
      }
    }),
    healthySnapshot()
  );

  const result = evaluatePromotionGate(resolved);

  assert.equal(result.verdict, "rollback");
  assert.equal(result.reason, "golden-suite-failure");
});

test("unknown SLO id is a definition-time error", () => {
  assert.throws(
    () =>
      resolvePromotionPolicy(
        policy({ gates: [{ ...policy().gates[0], sloId: "missing.slo" }] }),
        healthySnapshot()
      ),
    /unknown SLO id missing\.slo/
  );
});

test("stale or unavailable burn-rate reads fail safe to hold", () => {
  for (const status of ["stale", "unavailable"]) {
    const snapshot = healthySnapshot();
    snapshot.slos[0].status = status;

    const result = evaluatePromotionGate(resolvePromotionPolicy(policy(), snapshot));

    assert.equal(result.verdict, "hold", status);
    assert.equal(result.reason, `slo-snapshot-${status}`);
  }
});

test("gate decision pins the snapshot seq and deterministic input hash", () => {
  const resolved = resolvePromotionPolicy(policy(), healthySnapshot());
  const decision = createGateDecision(resolved, {
    decisionId: "policy-decision-1",
    rolloutId: "rollout-api-1"
  });

  assert.equal(decision.type, "delivery.PromotionGateDecided");
  assert.equal(decision.payload.verdict, "promote");
  assert.equal(decision.payload.input.seq, 42);
  assert.match(decision.payload.inputHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(decision.payload.input, resolved);
});
