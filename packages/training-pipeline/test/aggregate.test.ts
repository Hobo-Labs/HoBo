import assert from "node:assert/strict";
import { test } from "vitest";

import {
	aggregateEvalResults,
	evaluatePromotionGate,
	PromotionGateParseError,
	PromotionOutcome,
	parseEvalResult,
	parsePromotionThresholds,
} from "../src/index.js";

test("aggregates per-metric means over the graded sample", () => {
	const result = aggregateEvalResults(
		[
			{ scores: { accuracy: 1, latency: 0.5 } },
			{ scores: { accuracy: 0.5, latency: 1 } },
			{ scores: { accuracy: 0.75 } },
		],
		{ rubricRef: "rubric://x@1.0.0", source: "live-eval" },
	);

	assert.equal(result.sampleCount, 3);
	assert.equal(result.scores.accuracy, 0.75);
	assert.equal(result.scores.latency, 0.75);
	assert.deepEqual(result.metricSampleCounts, { accuracy: 3, latency: 2 });
	assert.equal(result.rubricRef, "rubric://x@1.0.0");
	assert.equal(result.source, "live-eval");
	assert.ok(Object.isFrozen(result));
	assert.ok(Object.isFrozen(result.scores));
	assert.ok(Object.isFrozen(result.metricSampleCounts));
});

test("does not count trajectories missing a required metric toward its minimum", () => {
	const evalResult = aggregateEvalResults(
		[
			{ scores: { accuracy: 1 } },
			{ scores: { latency: 1 } },
			{ scores: { latency: 1 } },
		],
		{ rubricRef: "rubric://x@1.0.0", source: "live-eval" },
	);
	const decision = evaluatePromotionGate({
		candidateId: "candidate-1",
		conformance: true,
		policy: true,
		evalResult,
		thresholds: parsePromotionThresholds({
			metricFloors: { accuracy: 0.9 },
			minSamples: 3,
		}),
	});
	assert.equal(decision.outcome, PromotionOutcome.REFUSE);
	assert.ok(decision.failures.some((failure) => failure.includes("accuracy")));
});

test("does not infer metric counts from legacy aggregate totals", () => {
	const evalResult = parseEvalResult({
		rubricRef: "rubric://x@1.0.0",
		scores: { accuracy: 1 },
		sampleCount: 3,
		source: "live-eval",
	});
	const decision = evaluatePromotionGate({
		candidateId: "candidate-1",
		conformance: true,
		policy: true,
		evalResult,
		thresholds: parsePromotionThresholds({
			metricFloors: { accuracy: 0.9 },
			minSamples: 3,
		}),
	});
	assert.equal(decision.outcome, PromotionOutcome.REFUSE);
	assert.ok(decision.failures.some((failure) => failure.includes("accuracy")));
});

test.each([
	{ accuracy: 0 },
	{ accuracy: 4 },
	{ latency: 1 },
])("rejects invalid per-metric sample counts: %o", (metricSampleCounts) => {
	assert.throws(
		() =>
			parseEvalResult({
				rubricRef: "rubric://x@1.0.0",
				scores: { accuracy: 1 },
				sampleCount: 3,
				source: "live-eval",
				metricSampleCounts,
			}),
		PromotionGateParseError,
	);
});

test("rejects an empty sample", () => {
	assert.throws(
		() =>
			aggregateEvalResults([], {
				rubricRef: "rubric://x@1.0.0",
				source: "live-eval",
			}),
		PromotionGateParseError,
	);
});

test("rejects out-of-range metric scores at the boundary", () => {
	assert.throws(
		() =>
			aggregateEvalResults([{ scores: { accuracy: 1.2 } }], {
				rubricRef: "rubric://x@1.0.0",
				source: "live-eval",
			}),
		PromotionGateParseError,
	);
});
