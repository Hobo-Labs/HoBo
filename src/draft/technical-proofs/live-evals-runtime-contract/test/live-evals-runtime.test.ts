import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { createClassifyTicketPromotionGate } from "../../eval-promotion-gate-contract/src/eval-promotion-gate.js";
import { createLiveEvalRuntime } from "../src/live-evals-runtime.js";

const GATE = createClassifyTicketPromotionGate({
  minSamples: 3,
  shadowTraffic: "10%",
});

function makeBatch({
  arm = "champion",
  candidateId = "champion-current",
  count = 3,
  scores = { categoryCorrect: 0.95, urgencyCalibrated: 0.94, piiSafe: 1 },
  shadowTraffic = arm === "challenger" ? "15%" : "0%",
  integrity = { verdict: "trusted", attestation: "signed-human-sample" },
  labels,
} = {}) {
  const labelEntries =
    labels ??
    Array.from({ length: count }, (_, index) => ({
      trajectoryId: `trajectory-${candidateId}-${index}`,
      scores,
      reward: scores.categoryCorrect,
      metrics: {
        quality: scores.categoryCorrect,
        costUsd: 0.002 + index / 100000,
        latencyMs: 80 + index,
        calibration: scores.urgencyCalibrated,
      },
    }));

  return {
    semanticFunction: "classifyTicket",
    arm,
    candidateId,
    championId: "champion-current",
    conformance: { passed: true },
    policy: { effect: "allow" },
    traffic: {
      liveSamples: arm === "champion" ? labelEntries.length : 100,
      shadowSamples: arm === "challenger" ? labelEntries.length : 0,
      shadowTraffic,
    },
    labelBatch: {
      id: `labels-${candidateId}`,
      integrity,
      labels: labelEntries,
    },
  };
}

describe("live evals runtime contract", () => {
  it("writes eval.Ran and rewards for live champion traffic", () => {
    const runtime = createLiveEvalRuntime({ gate: GATE });
    const result = runtime.evaluateBatch(makeBatch());

    assert.equal(result.outcome, "champion-healthy");
    assert.equal(result.rewardWrites.length, 3);
    assert.equal(result.events.some((event) => event.type === "eval.Ran"), true);
    assert.deepEqual(runtime.rewardForTrajectory("trajectory-champion-current-0"), {
      reward: 0.95,
      rubricRef: "promotionGate:classifyTicket",
      evalEventId: "eval-0",
    });
    assert.deepEqual(result.telemetry, {
      calibration: 0.94,
      costUsd: 0.00603,
      latencyMs: 81,
      quality: 0.95,
    });
  });

  it("keeps a regressing challenger in shadow and emits eval.GateFailed", () => {
    const runtime = createLiveEvalRuntime({ gate: GATE });
    const result = runtime.evaluateBatch(
      makeBatch({
        arm: "challenger",
        candidateId: "candidate-regressed",
        scores: { categoryCorrect: 0.84, urgencyCalibrated: 0.95, piiSafe: 1 },
      }),
    );

    assert.equal(result.outcome, "stay-shadow");
    assert.equal(result.candidateState.stage, "shadow");
    assert.equal(result.events.some((event) => event.type === "eval.GateFailed"), true);
    assert.equal(result.events.some((event) => event.type === "eval.GatePassed"), false);
    assert.match(result.failures.join("\n"), /categoryCorrect below 0\.92/);
  });

  it("raises a drift alert for a regressing champion without applying live-fix", () => {
    const runtime = createLiveEvalRuntime({ gate: GATE });
    const result = runtime.evaluateBatch(
      makeBatch({
        arm: "champion",
        candidateId: "champion-current",
        scores: { categoryCorrect: 0.86, urgencyCalibrated: 0.9, piiSafe: 1 },
      }),
    );

    const drift = result.events.find((event) => event.type === "eval.DriftDetected");
    assert.equal(result.outcome, "champion-drift");
    assert.equal(drift.data.candidateId, "champion-current");
    assert.equal(drift.data.liveFix.mode, "propose");
    assert.equal(drift.data.liveFix.applied, false);
    assert.equal(result.events.some((event) => event.type === "impl.Promoted"), false);
  });

  it("holds gate movement below min-samples and shadow-traffic floors", () => {
    const runtime = createLiveEvalRuntime({ gate: GATE });
    const underSampled = runtime.evaluateBatch(
      makeBatch({
        arm: "challenger",
        candidateId: "candidate-noisy",
        count: 2,
        scores: { categoryCorrect: 0.99, urgencyCalibrated: 0.98, piiSafe: 1 },
      }),
    );
    const underShadowed = runtime.evaluateBatch(
      makeBatch({
        arm: "challenger",
        candidateId: "candidate-low-shadow",
        shadowTraffic: "5%",
        scores: { categoryCorrect: 0.99, urgencyCalibrated: 0.98, piiSafe: 1 },
      }),
    );

    for (const result of [underSampled, underShadowed]) {
      assert.equal(result.outcome, "gate-held");
      assert.equal(result.gateMoved, false);
      assert.equal(result.events.some((event) => event.type === "eval.GateHeld"), true);
      assert.equal(result.events.some((event) => event.type === "eval.GatePassed"), false);
      assert.equal(result.events.some((event) => event.type === "eval.GateFailed"), false);
    }
  });

  it("quarantines poisoned label batches instead of silently flipping rewards", () => {
    const runtime = createLiveEvalRuntime({ gate: GATE });
    const untrusted = runtime.evaluateBatch(
      makeBatch({
        candidateId: "champion-current",
        integrity: { verdict: "untrusted", attestation: "missing-signature" },
      }),
    );
    const conflicting = runtime.evaluateBatch(
      makeBatch({
        candidateId: "champion-current",
        labels: [
          {
            trajectoryId: "trajectory-poisoned",
            scores: { categoryCorrect: 0.1, urgencyCalibrated: 0.1, piiSafe: 1 },
            reward: 0.1,
            metrics: { quality: 0.1, costUsd: 0.001, latencyMs: 50, calibration: 0.1 },
          },
          {
            trajectoryId: "trajectory-poisoned",
            scores: { categoryCorrect: 1, urgencyCalibrated: 1, piiSafe: 1 },
            reward: 1,
            metrics: { quality: 1, costUsd: 0.001, latencyMs: 50, calibration: 1 },
          },
        ],
      }),
    );

    for (const result of [untrusted, conflicting]) {
      assert.equal(result.outcome, "label-batch-quarantined");
      assert.equal(result.rewardWrites.length, 0);
      assert.equal(result.events.some((event) => event.type === "eval.LabelBatchQuarantined"), true);
      assert.equal(result.events.some((event) => event.type === "eval.GatePassed"), false);
      assert.equal(result.events.some((event) => event.type === "eval.GateFailed"), false);
    }
    assert.equal(runtime.rewardForTrajectory("trajectory-poisoned"), null);
  });
});
