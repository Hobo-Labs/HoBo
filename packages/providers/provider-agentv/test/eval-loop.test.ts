import assert from "node:assert/strict";
import {
	aggregateEvalResults,
	evaluatePromotionGate,
	PromotionOutcome,
	parsePromotionThresholds,
	promotionEventNames,
} from "@hobo/training-pipeline";
import { test } from "vitest";

import { createAgentVLiveEvalGrader } from "../src/index.js";
import { trajectory } from "./helpers.js";

// The IMPL-003 live-eval loop, offline and deterministic: stored trajectories
// are graded by agentV assertions (no agent re-run, no LLM), the per-metric
// scores aggregate into the gate's EvalResult, and the three-lens promotion
// gate decides — exactly the Microsoft-Trace-style feedback path the design
// names (capture → live-eval reward → optimize → gated promotion).

const RUBRIC_REF = "rubric://support/classifier@1.0.0";

const grader = createAgentVLiveEvalGrader({
	rubricRef: RUBRIC_REF,
	now: () => "2026-07-10T00:00:00.000Z",
	metrics: {
		categoryCorrect: { kind: "icontains", value: '"category":"outage"' },
		wellFormed: { kind: "is-json" },
	},
});

const thresholds = parsePromotionThresholds({
	metricFloors: { categoryCorrect: 0.6, wellFormed: 1 },
	minSamples: 3,
});

test("graded trajectories aggregate into an EvalResult that promotes", async () => {
	const graded = await Promise.all(
		[
			trajectory("t1", "site is down", "outage", 0.9),
			trajectory("t2", "cannot reach api", "outage", 0.95),
			trajectory("t3", "everything is broken", "outage", 0.97),
		].map((t) => grader.grade(t)),
	);

	const evalResult = aggregateEvalResults(
		graded.map(({ grade }) => ({ scores: grade.namedScores })),
		{ rubricRef: RUBRIC_REF, source: "live-eval" },
	);
	assert.equal(evalResult.sampleCount, 3);
	assert.equal(evalResult.scores.categoryCorrect, 1);
	assert.equal(evalResult.scores.wellFormed, 1);

	const decision = evaluatePromotionGate({
		candidateId: "candidate-1",
		conformance: true,
		policy: true,
		championId: "champion-1",
		evalResult,
		thresholds,
	});
	assert.equal(decision.outcome, PromotionOutcome.PROMOTE);
	assert.deepEqual(promotionEventNames(decision), [
		"training.Promoted",
		"impl.Promoted",
	]);
});

test("a regressing challenger is refused through the same loop", async () => {
	const graded = await Promise.all(
		[
			trajectory("t1", "site is down", "outage", 0.9),
			trajectory("t2", "cannot reach api", "access", 0.3),
			trajectory("t3", "everything is broken", "other", 0.2),
		].map((t) => grader.grade(t)),
	);

	const evalResult = aggregateEvalResults(
		graded.map(({ grade }) => ({ scores: grade.namedScores })),
		{ rubricRef: RUBRIC_REF, source: "live-eval" },
	);
	assert.ok((evalResult.scores.categoryCorrect ?? 0) < 0.6);

	const decision = evaluatePromotionGate({
		candidateId: "candidate-2",
		conformance: true,
		policy: true,
		evalResult,
		thresholds,
	});
	assert.equal(decision.outcome, PromotionOutcome.REFUSE);
	assert.deepEqual(promotionEventNames(decision), ["eval.GateFailed"]);
	assert.ok(decision.failures.some((f) => f.includes("categoryCorrect")));
});
