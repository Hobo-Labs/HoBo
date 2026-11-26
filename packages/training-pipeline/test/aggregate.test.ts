import assert from "node:assert/strict";
import { test } from "vitest";

import { aggregateEvalResults, PromotionGateParseError } from "../src/index.js";

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
	assert.equal(result.rubricRef, "rubric://x@1.0.0");
	assert.equal(result.source, "live-eval");
	assert.ok(Object.isFrozen(result));
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
