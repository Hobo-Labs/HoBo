import assert from "node:assert/strict";
import { test } from "vitest";

import { runGenerationPipelineTrainingSafetySimulation } from "../services/generation-reference-architecture.js";

test("cold-start provider generation certifies only after sandbox validation, repair, and safety gates", async () => {
  const result = await runGenerationPipelineTrainingSafetySimulation();

  assert.equal(result.epic.slug, "generation-pipeline-training-ai-safety");
  assert.equal(result.coldStart.outcome, "certified");
  assert.equal(result.coldStart.finalValidation.traceReplay.status, "passed");
  assert.equal(result.coldStart.repair.outcome, "validated");
  assert.equal(result.coldStart.certification.ok, true);
  assert.deepEqual(result.coldStart.stageResults.map((stage) => stage.stage), [
    "request",
    "scaffold",
    "fill",
    "repair",
    "certify",
  ]);
  assert.equal(result.safety.certifiable.effect, "allow");
  assert.equal(result.materials.sanitized.materials[0].trustBoundary, "untrusted_user_material");
  assert.equal(result.sandbox.egressAttempts, 0);
});

test("training loop captures trajectories, screens OPTO candidates, and promotes through live evals", async () => {
  const result = await runGenerationPipelineTrainingSafetySimulation();

  assert.equal(result.training.capture.trajectoryCount, 3);
  assert.equal(result.training.optimizer.outcome, "ready-for-gate");
  assert.equal(result.training.liveEval.outcome, "gate-passed");
  assert.equal(result.training.poisoning.outcome, "trusted-for-promotion");
  assert.equal(result.training.privacy.optimizerPayload.rawPayloadsIncluded, false);
  assert.equal(result.training.promotion.outcome, "promoted");
});

test("negative cases require human review instead of silent certification or promotion", async () => {
  const result = await runGenerationPipelineTrainingSafetySimulation();

  assert.equal(result.negative.nonConverging.outcome, "needs-human");
  assert.equal(result.negative.maliciousCandidate.effect, "deny");
  assert.equal(result.negative.poisonedTraining.outcome, "quarantined");
  assert.equal(result.liveFix.decision.outcome, "requires-human-approval");
});

test("cross-layer propagation keeps generated regions synchronized across the stack", async () => {
  const result = await runGenerationPipelineTrainingSafetySimulation();

  assert.equal(result.crossLayer.outcome, "propagated");
  assert.deepEqual(result.crossLayer.layers, ["data", "business", "message", "intelligence", "ui"]);
  assert.equal(result.crossLayer.driftDetected, false);
});
