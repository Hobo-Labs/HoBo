import assert from "node:assert/strict";
import { TrainingEngineParseError } from "@hobo/core";
import { test } from "vitest";

import { createAgentVLiveEvalGrader } from "../src/index.js";
import { trajectory } from "./helpers.js";

const RUBRIC_REF = "rubric://support/classifier@1.0.0";
const NOW = "2026-07-10T00:00:00.000Z";

function grader(threshold?: number) {
	return createAgentVLiveEvalGrader({
		rubricRef: RUBRIC_REF,
		threshold,
		now: () => NOW,
		metrics: {
			categoryCorrect: { kind: "icontains", value: '"category":"outage"' },
			wellFormed: { kind: "is-json" },
			noPii: {
				kind: "custom",
				run: (output) => ({
					score: /\d{3}-\d{2}-\d{4}/.test(output) ? 0 : 1,
					assertions: [{ text: "output carries no SSN", passed: true }],
				}),
			},
		},
	});
}

test("grades a stored trajectory into per-metric scores and a live-eval reward", async () => {
	const { grade, reward } = await grader().grade(
		trajectory("t1", "site is down", "outage", 0.97),
	);

	assert.equal(grade.caseId, "t1");
	assert.equal(grade.namedScores.categoryCorrect, 1);
	assert.equal(grade.namedScores.wellFormed, 1);
	assert.equal(grade.namedScores.noPii, 1);
	assert.equal(grade.score, 1);
	assert.equal(grade.pass, true);

	assert.equal(reward.source, "live-eval");
	assert.equal(reward.rubricRef, RUBRIC_REF);
	assert.equal(reward.eventId, "t1");
	assert.equal(reward.score, 1);
	assert.equal(reward.observedAt, NOW);
	assert.ok(Object.isFrozen(reward));
});

test("a wrong category fails its metric and drops the overall score", async () => {
	const { grade } = await grader().grade(
		trajectory("t2", "site is down", "access", 0.2),
	);

	assert.equal(grade.namedScores.categoryCorrect, 0);
	assert.equal(grade.namedScores.wellFormed, 1);
	assert.ok(grade.score < 0.8);
	assert.equal(grade.pass, false);
	assert.match(grade.reason, /categoryCorrect/);
});

test("the pass threshold is configurable", async () => {
	// 2/3 metrics pass → overall ≈ 0.67: fails the 0.8 default, passes at 0.5.
	const strict = await grader().grade(
		trajectory("t3", "site is down", "access", 0.2),
	);
	assert.equal(strict.grade.pass, false);

	const lenient = await grader(0.5).grade(
		trajectory("t3", "site is down", "access", 0.2),
	);
	assert.equal(lenient.grade.pass, true);
	assert.ok(lenient.grade.score > 0.5 && lenient.grade.score < 0.8);
});

test("re-parses the trajectory, rejecting out-of-contract input", async () => {
	await assert.rejects(
		() => grader().grade({ id: "", spans: [] }),
		TrainingEngineParseError,
	);
});

test("requires at least one metric", () => {
	assert.throws(() =>
		createAgentVLiveEvalGrader({ rubricRef: RUBRIC_REF, metrics: {} }),
	);
});
