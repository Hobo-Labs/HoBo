import assert from "node:assert/strict";
import {
	aggregateEvalResults,
	createTrajectoryCapture,
	evaluatePromotionGate,
	PromotionOutcome,
	parsePromotionThresholds,
	promotionEventNames,
	TRAINING_TRAJECTORY_CAPTURED,
} from "@hobo/training-pipeline";
import { test } from "vitest";

import { createAgentVLiveEvalGrader } from "../src/index.js";
import { REGION } from "./helpers.js";

// The closed IMPL-003 loop, end to end and deterministic: spans captured
// around agent actions (OTel/OpenInference span emission) assemble into the
// stored Trajectory record, the agentV live-eval grader scores it without
// re-running the agent, the scores aggregate into the gate's EvalResult, and
// the three-lens promotion gate decides — capture → grade → aggregate →
// promotion, all riding the training.*/eval.*/impl.* event families.

const RUBRIC_REF = "rubric://support/classifier@1.0.0";

function captureTrajectory(index: number, subject: string, category: string) {
	let tick = -1;
	const capture = createTrajectoryCapture({
		now: () => {
			tick += 1;
			return new Date(Date.UTC(2026, 6, 25, 12, index, tick)).toISOString();
		},
	});

	const root = capture.startSpan("support.classifyTicket", {
		kind: "AGENT",
		input: { subject },
	});
	const tool = capture.startSpan("tool.searchStatusPage", {
		kind: "TOOL",
		parent: root,
		input: { query: subject },
	});
	tool.end({ output: { incidents: 1 } });
	const llm = capture.startSpan("llm.classify", {
		kind: "LLM",
		parent: root,
		input: { prompt: subject },
	});
	llm.end({ output: { category } });
	root.end({ output: { category } });

	return capture.toTrajectory({
		id: `trajectory-run-${index}-1`,
		run: {
			id: `run-${index}`,
			tenantId: "tenant-a",
			bindle: "bindle/support",
			agent: {
				id: "agent:support-classifier",
				principalRef:
					"spiffe://tenant-a/bindle/support/agent/support-classifier",
			},
		},
		subject: {
			method: "classifyTicket",
			contractRef: "contract://support/classification@1.0.0",
			generatedRegion: REGION,
		},
		reward: { source: "capture", rubricRef: RUBRIC_REF },
	});
}

const grader = createAgentVLiveEvalGrader({
	rubricRef: RUBRIC_REF,
	now: () => "2026-07-25T13:00:00.000Z",
	metrics: {
		categoryCorrect: { kind: "icontains", value: '"category":"outage"' },
		wellFormed: { kind: "is-json" },
	},
});

test("a captured trajectory is graded by the agentv live-eval path", async () => {
	const captured = captureTrajectory(1, "site is down", "outage");
	// The grader re-parses the stored record: feed it the proto-JSON wire
	// form the capture emitted, exactly as it would come off the event log.
	const { grade, reward } = await grader.grade(captured.trajectoryJson);

	assert.equal(grade.caseId, "trajectory-run-1-1");
	assert.equal(grade.pass, true);
	assert.deepEqual(grade.namedScores, { categoryCorrect: 1, wellFormed: 1 });
	assert.equal(reward.source, "live-eval");
	assert.equal(reward.rubricRef, RUBRIC_REF);
	assert.equal(reward.score, 1);
});

test("capture → grade → aggregate → promotion gate closes the loop", async () => {
	const graded = await Promise.all(
		[
			captureTrajectory(1, "site is down", "outage"),
			captureTrajectory(2, "cannot reach api", "outage"),
			captureTrajectory(3, "status page timeout", "outage"),
		].map(async (captured) => {
			const { grade } = await grader.grade(captured.trajectoryJson);
			return { scores: grade.namedScores };
		}),
	);

	const evalResult = aggregateEvalResults(graded, {
		rubricRef: RUBRIC_REF,
		source: "live-eval",
	});
	assert.equal(evalResult.sampleCount, 3);

	const decision = evaluatePromotionGate({
		candidateId: "candidate-1",
		conformance: true,
		policy: true,
		evalResult,
		thresholds: parsePromotionThresholds({
			metricFloors: { categoryCorrect: 0.6, wellFormed: 1 },
			minSamples: 3,
		}),
	});
	assert.equal(decision.outcome, PromotionOutcome.PROMOTE);

	// One event-sourced loop: the capture fact and the promotion facts ride
	// the same training.*/eval.*/impl.* families.
	const eventNames = [
		TRAINING_TRAJECTORY_CAPTURED,
		...promotionEventNames(decision),
	];
	assert.deepEqual(eventNames, [
		"training.TrajectoryCaptured",
		"training.Promoted",
		"impl.Promoted",
	]);
});

test("a regressed capture refuses promotion through the same gate", async () => {
	const captured = captureTrajectory(4, "billing question", "billing");
	const { grade } = await grader.grade(captured.trajectoryJson);
	assert.equal(grade.pass, false);

	const decision = evaluatePromotionGate({
		candidateId: "candidate-2",
		conformance: true,
		policy: true,
		evalResult: aggregateEvalResults([{ scores: grade.namedScores }], {
			rubricRef: RUBRIC_REF,
			source: "live-eval",
		}),
		thresholds: parsePromotionThresholds({
			metricFloors: { categoryCorrect: 0.6, wellFormed: 1 },
			minSamples: 1,
		}),
	});
	assert.equal(decision.outcome, PromotionOutcome.REFUSE);
	assert.deepEqual(promotionEventNames(decision), ["eval.GateFailed"]);
});
