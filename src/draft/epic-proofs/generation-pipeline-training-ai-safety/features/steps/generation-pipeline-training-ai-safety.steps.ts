/**
 * Executable step definitions for generation-pipeline-training-ai-safety.feature.
 *
 * Drives the epic's real reference simulation
 * (services/generation-reference-architecture.ts) and asserts the cold-start,
 * training, live-fix, and adversarial artifacts it actually produces.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import { runGenerationPipelineTrainingSafetySimulation } from "../../services/generation-reference-architecture.js";

type Simulation = Awaited<
	ReturnType<typeof runGenerationPipelineTrainingSafetySimulation>
>;

let simulationPromise: Promise<Simulation> | undefined;
function simulation(): Promise<Simulation> {
	simulationPromise ??= runGenerationPipelineTrainingSafetySimulation();
	return simulationPromise;
}

type GenerationWorld = {
	result?: Simulation;
};

// --- Scenario: Generate and certify a database provider ----------------------------------

Given(
	"a target WIT port, capability manifest, sanitized material, and recorded traces",
	async function (this: GenerationWorld) {
		this.result = await simulation();
		assert.equal(
			this.result.epic.slug,
			"generation-pipeline-training-ai-safety",
		);
		assert.equal(
			this.result.materials.sanitized.materials[0].trustBoundary,
			"untrusted_user_material",
			"user material stays behind the trust boundary",
		);
	},
);

When(
	"the generation loop scaffolds, fills, repairs, and certifies the candidate",
	function (this: GenerationWorld) {
		const coldStart = this.result?.coldStart;
		assert.ok(coldStart);
		assert.deepEqual(
			coldStart.stageResults.map((stage: { stage: string }) => stage.stage),
			["request", "scaffold", "fill", "repair", "certify"],
		);
	},
);

Then(
	"the artifact certifies only after sandbox validation and safety gates pass with zero sandbox egress",
	function (this: GenerationWorld) {
		const result = this.result;
		assert.ok(result);
		assert.equal(result.coldStart.outcome, "certified");
		assert.equal(result.coldStart.finalValidation.traceReplay.status, "passed");
		assert.equal(result.coldStart.certification.ok, true);
		assert.equal(result.safety.certifiable.effect, "allow");
		assert.equal(result.sandbox.egressAttempts, 0, "sandbox never egresses");
	},
);

// --- Scenario: Promote a challenger from trusted training evidence -----------------------

Given(
	"OpenInference trajectories with privacy filtering and poisoning checks",
	async function (this: GenerationWorld) {
		this.result = await simulation();
		assert.equal(
			this.result.training.capture.trajectoryCount,
			3,
			"trajectories are captured",
		);
	},
);

When(
	"the built-in OPTO training engine proposes a region-scoped candidate",
	function (this: GenerationWorld) {
		assert.equal(this.result?.training.optimizer.outcome, "ready-for-gate");
	},
);

Then(
	"the challenger promotes only after live-eval, poisoning, and privacy gates pass",
	function (this: GenerationWorld) {
		const training = this.result?.training;
		assert.ok(training);
		assert.equal(training.liveEval.outcome, "gate-passed");
		assert.equal(training.poisoning.outcome, "trusted-for-promotion");
		assert.equal(
			training.privacy.optimizerPayload.rawPayloadsIncluded,
			false,
			"raw payloads never reach the optimizer",
		);
		assert.equal(training.promotion.outcome, "promoted");
	},
);

// --- Scenario: Retain gates for risky generated changes and adversarial candidates -------

Given(
	"a drifted generated stack with a candidate live fix and adversarial training inputs",
	async function (this: GenerationWorld) {
		this.result = await simulation();
		assert.ok(
			this.result.liveFix && this.result.negative,
			"live-fix and negative paths ran",
		);
	},
);

When(
	"the live-fix flow and negative-path screens evaluate the candidates",
	function (this: GenerationWorld) {
		assert.equal(
			this.result?.negative.nonConverging.outcome,
			"needs-human",
			"non-converging generation escalates to a human",
		);
	},
);

Then(
	"risky live fixes require human approval, malicious candidates are denied, and poisoned training quarantines",
	function (this: GenerationWorld) {
		const result = this.result;
		assert.ok(result);
		assert.equal(result.liveFix.decision.outcome, "requires-human-approval");
		assert.equal(result.negative.maliciousCandidate.effect, "deny");
		assert.equal(result.negative.poisonedTraining.outcome, "quarantined");
		assert.equal(
			result.crossLayer.outcome,
			"propagated",
			"generated regions stay synchronized",
		);
	},
);
