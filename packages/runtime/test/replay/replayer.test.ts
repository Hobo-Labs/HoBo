import { describe, expect, it } from "vitest";

import { digest } from "../../src/replay/divergence.js";
import { nextEnvelope, recordEffect } from "../../src/replay/recorder.js";
import {
	canonicalStateBytes,
	replayRun,
	type WorkflowDefinition,
} from "../../src/replay/replayer.js";
import { createInMemoryEventStore } from "../../src/replay/store.js";

interface ReplayCycle {
	self?: ReplayCycle;
}

describe("replayRun", () => {
	it("keeps collection values in workflow replay reports", async () => {
		const store = createInMemoryEventStore();
		await recordEffect(
			store,
			nextEnvelope("run/collections", 1, "run.Started", { seed: "seed" }),
		);
		const workflow: WorkflowDefinition<Map<string, number>, number> = {
			name: "collection",
			initialState: () => new Map(),
			execute: (_ctx, state, value) => new Map([...state, ["value", value]]),
		};
		const first = await replayRun(store, "collections", workflow, 1);
		const second = await replayRun(store, "collections", workflow, 2);
		expect(first.report.stateDigest).toBe(digest(first.state));
		expect(first.report.stateDigest).not.toBe(second.report.stateDigest);
		expect(canonicalStateBytes(first.state)).not.toBe(
			canonicalStateBytes(second.state),
		);
	});

	it("canonicalizes nested collections without changing JSON values", () => {
		const first = new Map([
			[{ name: "same" }, 2],
			[{ name: "same" }, 1],
		]);
		const second = new Map([
			[{ name: "same" }, 1],
			[{ name: "same" }, 2],
		]);
		expect(canonicalStateBytes(first)).toBe(canonicalStateBytes(second));
		expect(
			canonicalStateBytes({
				date: new Date("2026-01-01T00:00:00Z"),
				missing: undefined,
				invalid: Number.NaN,
				values: [undefined, -0],
			}),
		).toBe(
			'{"date":"2026-01-01T00:00:00.000Z","invalid":null,"values":[null,0]}',
		);
		const cyclic: ReplayCycle = {};
		cyclic.self = cyclic;
		expect(() => canonicalStateBytes(cyclic)).toThrow(TypeError);
	});

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
