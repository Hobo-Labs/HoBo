import assert from "node:assert/strict";
import {
	applyTrainingArtifact,
	getTrainable,
	resetTrainables,
	training,
} from "@hobo/runtime";
import { afterEach, test } from "vitest";
import { createAxTrainingEngine } from "../src/index.js";
import { mockModel, optimizeRequest, trajectory } from "./helpers.js";

afterEach(() => {
	resetTrainables();
});

// The empty-implementation loop end to end (ADR-0125, no live LLM):
// declare a signature-only trainable method -> it runs immediately on the
// contract-derived stub -> recorded executions become trajectories -> the
// ax engine optimizes them into a training artifact -> apply-at-load makes
// the callable serve the tuned behavior. This is the "declare a function
// with no body and let the system grow the implementation" promise.
test("empty implementation -> train -> apply artifact", async () => {
	const classify = training.define<{ subject: string }, { category: string }>({
		intent: "Classify a support ticket into a known category.",
		contract: {
			ref: "contract://support/classification@1.0.0",
			examples: [
				{
					input: { subject: "cannot reset password" },
					output: { category: "access" },
				},
			],
		},
		rubric: { categoryCorrect: 0.9 },
		methodRef: "classifyTicket",
	});

	// 1. The app runs before anything is implemented (stub baseline).
	const cold = await classify({ subject: "site is down" });
	assert.equal(cold.category, "access"); // canned response — wrong, but servable
	assert.equal(getTrainable("classifyTicket")?.calls.length, 1);

	// 2. Real recorded executions (with live-eval rewards) are the training
	//    data; here they arrive as trajectories on the event log.
	const trajectories = [
		trajectory("t1", "cannot reset password", "access", 0.95),
		trajectory("t2", "site is down", "outage", 0.97),
	];

	// 3. The engine behind the port optimizes and emits an artifact candidate.
	const engine = createAxTrainingEngine({
		ai: mockModel("outage"),
		maxMetricCalls: 8,
	});
	const candidate = await engine.optimize(
		// SAFETY: test fixture is a wire-shaped OptimizeRequest; the engine re-parses.
		optimizeRequest(trajectories) as never,
	);
	assert.equal(candidate.body.case, "artifact");
	if (candidate.body.case !== "artifact") return;

	// 4. Apply-at-load (post-gate promotion): the callable now serves the
	//    tuned behavior for the recorded high-reward executions.
	applyTrainingArtifact(classify, candidate.body.value);
	const tuned = await classify({ subject: "site is down" });
	assert.equal(tuned.category, "outage");

	// Still reversible — dropping the artifact restores the baseline.
	applyTrainingArtifact(classify, null);
	const reverted = await classify({ subject: "site is down" });
	assert.equal(reverted.category, "access");
});
