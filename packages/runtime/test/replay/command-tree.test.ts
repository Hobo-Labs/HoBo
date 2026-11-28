import { describe, expect, it } from "vitest";
import { readReplayCommandTree } from "../../src/replay/command-tree.js";
import { nextEnvelope } from "../../src/replay/recorder.js";

const runId = "steps";
const streamId = `run/${runId}`;

function started() {
	return nextEnvelope(streamId, 1, "run.Started", {
		args: null,
		seed: "seed",
		workflowName: runId,
	});
}

describe("readReplayCommandTree step outcomes", () => {
	it("refuses a completed outcome for a step that was never scheduled", () => {
		expect(() =>
			readReplayCommandTree(
				[
					started(),
					nextEnvelope(streamId, 2, "run.StepCompleted", {
						name: "work",
						index: 0,
						result: "ok",
					}),
				],
				runId,
			),
		).toThrow(/unscheduled step outcome/);
	});

	it("refuses a failed outcome for a step that was never scheduled", () => {
		expect(() =>
			readReplayCommandTree(
				[
					started(),
					nextEnvelope(streamId, 2, "run.StepFailed", {
						name: "work",
						index: 0,
						message: "boom",
					}),
				],
				runId,
			),
		).toThrow(/unscheduled step outcome/);
	});

	it("refuses an outcome that would have extended the step list", () => {
		expect(() =>
			readReplayCommandTree(
				[
					started(),
					nextEnvelope(streamId, 2, "run.StepScheduled", {
						name: "hole",
						index: 0,
					}),
					nextEnvelope(streamId, 3, "run.StepCompleted", {
						name: "later",
						index: 1,
						result: "done",
					}),
				],
				runId,
			),
		).toThrow(/unscheduled step outcome/);
	});

	it("applies an outcome only to an already scheduled step", () => {
		const tree = readReplayCommandTree(
			[
				started(),
				nextEnvelope(streamId, 2, "run.StepScheduled", {
					name: "work",
					index: 0,
				}),
				nextEnvelope(streamId, 3, "run.StepCompleted", {
					name: "work",
					index: 0,
					result: "ok",
				}),
			],
			runId,
		);
		expect(tree.steps.size).toBe(1);
		expect(tree.steps.get(0)).toMatchObject({
			name: "work",
			active: false,
			terminal: { kind: "completed", result: "ok" },
		});
	});
});
