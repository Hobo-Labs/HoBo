import { describe, expect, it } from "vitest";

import { digest } from "../../src/replay/divergence.js";
import { nextEnvelope, recordEffect } from "../../src/replay/recorder.js";
import {
	replayRun,
	type WorkflowDefinition,
} from "../../src/replay/replayer.js";
import { createInMemoryEventStore } from "../../src/replay/store.js";

describe("replayRun", () => {
	it("replays a recorded workflow to byte-identical canonical state", async () => {
		const store = createInMemoryEventStore();
		const streamId = "run/run-1";
		const workflow: WorkflowDefinition<{ total: number }, { amount: number }> =
			{
				name: "adder",
				initialState: () => ({ total: 0 }),
				async execute(ctx, state, args) {
					const stepValue = await ctx.step("capture", () => args.amount);
					return { total: state.total + stepValue };
				},
			};

		await recordEffect(
			store,
			nextEnvelope(streamId, 1, "run.Started", {
				seed: "seed-1",
				args: { amount: 5 },
			}),
		);
		await recordEffect(
			store,
			nextEnvelope(streamId, 2, "run.StepScheduled", {
				name: "capture",
				index: 0,
			}),
		);
		await recordEffect(
			store,
			nextEnvelope(streamId, 3, "run.StepCompleted", {
				name: "capture",
				index: 0,
				result: 5,
			}),
		);

		const first = await replayRun(
			store,
			"run-1",
			workflow,
			{ amount: 5 },
			{ seed: "seed-1" },
		);
		const second = await replayRun(
			store,
			"run-1",
			workflow,
			{ amount: 5 },
			{ seed: "seed-1" },
		);

		expect(first.state).toEqual({ total: 5 });
		expect(first.report.stateDigest).toBe(second.report.stateDigest);
		expect(first.report.readSetHash).toBe(second.report.readSetHash);
		expect(first.report.readSetHash).toMatch(/^[0-9a-f]{64}$/);
		expect(digest(first.state)).toBe(first.report.stateDigest);
	});
});
