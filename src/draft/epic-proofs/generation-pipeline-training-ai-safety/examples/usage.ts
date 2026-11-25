import { strict as assert } from "node:assert";

import { runGenerationPipelineTrainingSafetySimulation } from "../services/generation-reference-architecture.ts";

const result = await runGenerationPipelineTrainingSafetySimulation();
assert.equal(result.epic.slug, "generation-pipeline-training-ai-safety");

assert.equal(
	result.materials.sanitized.materials[0].trustBoundary,
	"untrusted_user_material",
);
assert.deepEqual(
	result.coldStart.stageResults.map((stage: { stage: string }) => stage.stage),
	["request", "scaffold", "fill", "repair", "certify"],
);
assert.equal(result.coldStart.outcome, "certified");
assert.equal(result.coldStart.finalValidation.traceReplay.status, "passed");
assert.equal(result.coldStart.certification.ok, true);
assert.equal(result.safety.certifiable.effect, "allow");
assert.equal(result.sandbox.egressAttempts, 0);
console.log(
	`cold start stages=${result.coldStart.stageResults.length} outcome=${result.coldStart.outcome} traceReplay=${result.coldStart.finalValidation.traceReplay.status}`,
);
console.log(
	`safety certifiable=${result.safety.certifiable.effect} sandboxEgressAttempts=${result.sandbox.egressAttempts}`,
);

const training = result.training;
assert.equal(training.capture.trajectoryCount, 3);
assert.equal(training.optimizer.outcome, "ready-for-gate");
assert.equal(training.liveEval.outcome, "gate-passed");
assert.equal(training.poisoning.outcome, "trusted-for-promotion");
assert.equal(training.privacy.optimizerPayload.rawPayloadsIncluded, false);
assert.equal(training.promotion.outcome, "promoted");
console.log(
	`training trajectories=${training.capture.trajectoryCount} optimizer=${training.optimizer.outcome} liveEval=${training.liveEval.outcome}`,
);
console.log(
	`training poisoning=${training.poisoning.outcome} rawPayloadsToOptimizer=${training.privacy.optimizerPayload.rawPayloadsIncluded} promotion=${training.promotion.outcome}`,
);

assert.equal(result.liveFix.decision.outcome, "requires-human-approval");
assert.equal(result.negative.nonConverging.outcome, "needs-human");
assert.equal(result.negative.maliciousCandidate.effect, "deny");
assert.equal(result.negative.poisonedTraining.outcome, "quarantined");
assert.equal(result.crossLayer.outcome, "propagated");
console.log(
	`live fix=${result.liveFix.decision.outcome} nonConverging=${result.negative.nonConverging.outcome}`,
);
console.log(
	`malicious=${result.negative.maliciousCandidate.effect} poisonedTraining=${result.negative.poisonedTraining.outcome} crossLayer=${result.crossLayer.outcome}`,
);

console.log(
	"EPIC HELD: generation certifies only through sandboxed gates; training promotes only trusted evidence",
);
