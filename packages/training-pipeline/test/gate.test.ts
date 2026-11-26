import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
	evaluatePromotionGate,
	PromotionGateParseError,
	PromotionOutcome,
	parseEvalResult,
	parsePromotionThresholds,
	promotionEventNames,
} from "../src/index.js";

const thresholds = parsePromotionThresholds({
	metricFloors: { accuracy: 0.85 },
	minSamples: 100,
});

function evalResult(accuracy: number, sampleCount = 128) {
	return parseEvalResult({
		rubricRef: "rubric://support/classification@1.0.0",
		scores: { accuracy },
		sampleCount,
		source: "live-eval",
	});
}

test("promotes a challenger that clears every lens", () => {
	const decision = evaluatePromotionGate({
		candidateId: "candidate-1",
		conformance: true,
		policy: true,
		championId: "champion-1",
		evalResult: evalResult(0.92),
		thresholds,
	});

	assert.equal(decision.outcome, PromotionOutcome.PROMOTE);
	assert.equal(decision.passed?.conformance, true);
	assert.equal(decision.passed?.eval, true);
	assert.equal(decision.passed?.policy, true);
	assert.deepEqual(decision.failures, []);
	assert.equal(decision.championChallenger?.championId, "champion-1");
	assert.equal(decision.championChallenger?.challengerId, "candidate-1");
	assert.deepEqual(promotionEventNames(decision), [
		"training.Promoted",
		"impl.Promoted",
	]);
});

test("refuses a challenger below the metric floor", () => {
	const decision = evaluatePromotionGate({
		candidateId: "candidate-2",
		conformance: true,
		policy: true,
		evalResult: evalResult(0.71),
		thresholds,
	});

	assert.equal(decision.outcome, PromotionOutcome.REFUSE);
	assert.equal(decision.passed?.eval, false);
	assert.ok(decision.failures.some((f) => f.includes("accuracy")));
	assert.deepEqual(promotionEventNames(decision), ["eval.GateFailed"]);
});

test("refuses when the sample count is below the minimum floor", () => {
	const decision = evaluatePromotionGate({
		candidateId: "candidate-3",
		conformance: true,
		policy: true,
		evalResult: evalResult(0.99, 10),
		thresholds,
	});

	assert.equal(decision.outcome, PromotionOutcome.REFUSE);
	assert.equal(decision.passed?.eval, false);
	assert.ok(decision.failures.some((f) => f.includes("samples")));
});

test("refuses when conformance or policy blocks even with passing eval", () => {
	const conformanceBlocked = evaluatePromotionGate({
		candidateId: "candidate-4",
		conformance: false,
		policy: true,
		evalResult: evalResult(0.92),
		thresholds,
	});
	assert.equal(conformanceBlocked.outcome, PromotionOutcome.REFUSE);
	assert.equal(conformanceBlocked.passed?.eval, true);
	assert.equal(conformanceBlocked.passed?.conformance, false);

	const policyBlocked = evaluatePromotionGate({
		candidateId: "candidate-5",
		conformance: true,
		policy: false,
		evalResult: evalResult(0.92),
		thresholds,
	});
	assert.equal(policyBlocked.outcome, PromotionOutcome.REFUSE);
	assert.equal(policyBlocked.passed?.policy, false);
});

test("reports a metric named in the floors but missing from the eval result", () => {
	const decision = evaluatePromotionGate({
		candidateId: "candidate-6",
		conformance: true,
		policy: true,
		evalResult: parseEvalResult({
			rubricRef: "rubric://support/classification@1.0.0",
			scores: { latency: 0.9 },
			sampleCount: 128,
			source: "live-eval",
		}),
		thresholds,
	});
	assert.equal(decision.outcome, PromotionOutcome.REFUSE);
	assert.ok(decision.failures.some((f) => f.includes("missing")));
});

test("rejects an eval score outside the unit interval at the parse boundary", () => {
	assert.throws(
		() =>
			parseEvalResult({
				rubricRef: "rubric://x@1.0.0",
				scores: { accuracy: 1.4 },
				sampleCount: 10,
				source: "live-eval",
			}),
		PromotionGateParseError,
	);
});

test("the promote pact fixture round-trips through the gate", () => {
	const pact = JSON.parse(
		readFileSync(
			new URL("../contracts/pacts/promotion_gate.pact.json", import.meta.url),
			"utf8",
		),
	);
	const promote = pact.interactions[0];
	const decision = evaluatePromotionGate({
		candidateId: promote.request.body.candidateId,
		conformance: promote.request.body.conformance,
		policy: promote.request.body.policy,
		championId: promote.request.body.championId,
		evalResult: parseEvalResult(promote.request.body.evalResult),
		thresholds: parsePromotionThresholds(promote.request.body.thresholds),
	});
	assert.equal(decision.outcome, PromotionOutcome.PROMOTE);
	assert.equal(decision.candidateId, promote.response.body.candidateId);
});
