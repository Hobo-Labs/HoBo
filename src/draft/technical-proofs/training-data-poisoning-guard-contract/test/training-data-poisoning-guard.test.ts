import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createPoisoningGuard,
  reconstructCandidateInfluence,
  TRAINING_DATA_POISONING_GUARD_CONTRACT,
} from "../src/training-data-poisoning-guard.js";

function trajectory({
  id,
  source,
  reward = 0.8,
  contractPassed = true,
  output = { category: "support", urgency: "normal" },
}) {
  return {
    id,
    hash: `sha256:${id.padEnd(64, "0").slice(0, 64)}`,
    sourceFingerprint: source,
    reward,
    contractPassed,
    output,
  };
}

function label({ trajectoryId, labeler, reward, scores = { quality: reward, piiSafe: 1 } }) {
  return {
    trajectoryId,
    labelerId: labeler,
    reward,
    scores,
  };
}

describe("training data poisoning guard contract", () => {
  it("rejects a rubric-gaming candidate even when poisoned rewards are high", () => {
    const guard = createPoisoningGuard({ minIndependentSources: 3, promotionRewardFloor: 0.75 });
    const result = guard.evaluateCandidate({
      candidateId: "candidate-contract-breaker",
      contract: { passed: false, failures: ["forbidden output: PII in rationale"] },
      trajectories: [
        trajectory({ id: "t1", source: "user:a", reward: 0.92, contractPassed: false }),
        trajectory({ id: "t2", source: "user:b", reward: 0.93, contractPassed: false }),
        trajectory({ id: "t3", source: "user:c", reward: 0.91, contractPassed: false }),
      ],
      labels: [
        label({ trajectoryId: "t1", labeler: "judge:poisoned", reward: 1 }),
        label({ trajectoryId: "t2", labeler: "judge:poisoned", reward: 1 }),
        label({ trajectoryId: "t3", labeler: "judge:poisoned", reward: 1 }),
      ],
    });

    assert.equal(TRAINING_DATA_POISONING_GUARD_CONTRACT, "hobo.training-data-poisoning-guard/v1");
    assert.equal(result.decision, "reject");
    assert.match(result.reason, /contract backstop/);
    assert.equal(result.events.some((event) => event.type === "training.CandidatePromoted"), false);
    assert.equal(result.events.some((event) => event.type === "training.CandidateRejected"), true);
  });

  it("quarantines label-flip and reward-inflation samples before scoring", () => {
    const guard = createPoisoningGuard({ minIndependentSources: 2 });
    const result = guard.evaluateCandidate({
      candidateId: "candidate-poisoned-labels",
      contract: { passed: true },
      trajectories: [
        trajectory({ id: "t4", source: "user:d", reward: 0.4 }),
        trajectory({ id: "t5", source: "user:e", reward: 0.3 }),
        trajectory({ id: "t6", source: "user:f", reward: 0.8 }),
      ],
      labels: [
        label({ trajectoryId: "t4", labeler: "judge:1", reward: 0.1 }),
        label({ trajectoryId: "t4", labeler: "judge:2", reward: 0.95 }),
        label({ trajectoryId: "t5", labeler: "judge:1", reward: 0.99 }),
        label({ trajectoryId: "t6", labeler: "judge:1", reward: 0.83 }),
      ],
    });

    assert.equal(result.quarantines.length, 2);
    assert.deepEqual(
      result.quarantines.map((entry) => entry.reason).sort(),
      ["label-flip", "reward-inflation"],
    );
    assert.equal(result.trustedTrajectoryIds.includes("t4"), false);
    assert.equal(result.trustedTrajectoryIds.includes("t5"), false);
    assert.equal(result.events.filter((event) => event.type === "training.TrajectoryQuarantined").length, 2);
  });

  it("flags gradual reward drift instead of letting a slow poison promote", () => {
    const guard = createPoisoningGuard({ minIndependentSources: 2, maxCumulativeDrift: 0.25 });
    const result = guard.evaluateCandidate({
      candidateId: "candidate-gradual-drift",
      contract: { passed: true },
      trajectories: [
        trajectory({ id: "t7", source: "judge-cluster:slow", reward: 0.55 }),
        trajectory({ id: "t8", source: "judge-cluster:slow", reward: 0.61 }),
        trajectory({ id: "t9", source: "judge-cluster:slow", reward: 0.68 }),
        trajectory({ id: "t10", source: "judge-cluster:slow", reward: 0.9 }),
        trajectory({ id: "t11", source: "user:g", reward: 0.77 }),
      ],
      labels: [
        label({ trajectoryId: "t7", labeler: "judge:slow", reward: 0.55 }),
        label({ trajectoryId: "t8", labeler: "judge:slow", reward: 0.61 }),
        label({ trajectoryId: "t9", labeler: "judge:slow", reward: 0.68 }),
        label({ trajectoryId: "t10", labeler: "judge:slow", reward: 0.9 }),
        label({ trajectoryId: "t11", labeler: "judge:trusted", reward: 0.77 }),
      ],
    });

    assert.equal(result.quarantines.some((entry) => entry.reason === "gradual-drift"), true);
    assert.equal(result.trustedTrajectoryIds.includes("t10"), false);
    assert.equal(result.decision, "hold");
    assert.match(result.reason, /independent sample floor/);
  });

  it("does not count a Sybil burst as independent signal", () => {
    const guard = createPoisoningGuard({ minIndependentSources: 3, promotionRewardFloor: 0.7 });
    const result = guard.evaluateCandidate({
      candidateId: "candidate-sybil-burst",
      contract: { passed: true },
      trajectories: Array.from({ length: 6 }, (_, index) =>
        trajectory({ id: `s${index}`, source: "sybil:fingerprint", reward: 0.97 }),
      ),
      labels: Array.from({ length: 6 }, (_, index) =>
        label({ trajectoryId: `s${index}`, labeler: `sybil:${index}`, reward: 0.97 }),
      ),
    });

    assert.equal(result.independentSourceCount, 1);
    assert.equal(result.decision, "hold");
    assert.match(result.reason, /independent sample floor/);
    assert.equal(result.events.some((event) => event.type === "training.CandidatePromoted"), false);
  });

  it("holds promotion until the shadow evidence floor is met", () => {
    const guard = createPoisoningGuard({
      minIndependentSources: 3,
      minShadowSamples: 2,
      promotionRewardFloor: 0.7,
    });
    const result = guard.evaluateCandidate({
      candidateId: "candidate-under-shadowed",
      contract: { passed: true },
      shadow: { sampleCount: 1 },
      trajectories: [
        trajectory({ id: "sh1", source: "user:1", reward: 0.82 }),
        trajectory({ id: "sh2", source: "user:2", reward: 0.78 }),
        trajectory({ id: "sh3", source: "user:3", reward: 0.81 }),
      ],
      labels: [
        label({ trajectoryId: "sh1", labeler: "judge:trusted", reward: 0.82 }),
        label({ trajectoryId: "sh2", labeler: "judge:trusted", reward: 0.78 }),
        label({ trajectoryId: "sh3", labeler: "judge:trusted", reward: 0.81 }),
      ],
    });

    assert.equal(result.decision, "hold");
    assert.match(result.reason, /shadow evidence floor/);
    assert.equal(result.events.some((event) => event.type === "training.CandidatePromoted"), false);
  });

  it("records auditable influence provenance that replays without quarantined samples", () => {
    const guard = createPoisoningGuard({ minIndependentSources: 3, promotionRewardFloor: 0.7 });
    const fixtures = [
      trajectory({ id: "p1", source: "user:1", reward: 0.82 }),
      trajectory({ id: "p2", source: "user:2", reward: 0.78 }),
      trajectory({ id: "p3", source: "user:3", reward: 0.8 }),
      trajectory({ id: "p4", source: "user:4", reward: 0.2 }),
    ];
    const result = guard.evaluateCandidate({
      candidateId: "candidate-trusted",
      contract: { passed: true },
      trajectories: fixtures,
      labels: [
        label({ trajectoryId: "p1", labeler: "judge:trusted", reward: 0.82 }),
        label({ trajectoryId: "p2", labeler: "judge:trusted", reward: 0.78 }),
        label({ trajectoryId: "p3", labeler: "judge:trusted", reward: 0.8 }),
        label({ trajectoryId: "p4", labeler: "judge:inflated", reward: 0.99 }),
      ],
    });

    assert.equal(result.decision, "promote");
    const influence = reconstructCandidateInfluence(result.events, "candidate-trusted");
    assert.deepEqual(influence.trustedTrajectoryIds, ["p1", "p2", "p3"]);
    assert.deepEqual(influence.quarantinedTrajectoryIds, ["p4"]);
    assert.deepEqual(influence.trajectoryHashes, fixtures.slice(0, 3).map((trajectory) => trajectory.hash));
  });
});
