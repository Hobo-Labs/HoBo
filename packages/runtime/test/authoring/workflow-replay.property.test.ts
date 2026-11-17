import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WorkflowFailure } from "../../src/errors.js";
import { replayRun } from "../../src/replay/replayer.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

describe("durable workflow histories", () => {
	it("replays each recorded sleep exactly once in order", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.integer({ min: 0, max: 100_000 }), { maxLength: 6 }),
				async (delays) => {
					const engine = createWorkflowEngine();
					const wf = defineWorkflow({
						name: "timer-history",
						async run(ctx, input: number[]) {
							for (const delay of input) await ctx.sleep(delay);
							return input;
						},
					});
					const handle = await engine.start(wf, delays);
					const replay = await replayRun(
						engine.store,
						handle.runId,
						engine.toReplayDefinition(wf),
						delays,
					);
					expect(replay.state).toEqual(handle.result);
				},
			),
			{ seed: 614456, numRuns: 150 },
		);
	});

	it("rejects a missing, changed, or unconsumed later sleep", async () => {
		await fc.assert(
			fc.asyncProperty(fc.integer({ min: 0, max: 100_000 }), async (delay) => {
				const engine = createWorkflowEngine();
				const wf = defineWorkflow({
					name: "two-timers",
					async run(ctx) {
						await ctx.sleep(delay);
						await ctx.sleep(delay);
						return "done";
					},
				});
				const handle = await engine.start(wf, null);
				const streamId = `run/${handle.runId}`;
				const events = await engine.store.readStream(streamId);
				let seen = 0;
				const missing = events.filter(
					(event) => event.type !== "run.SleepScheduled" || ++seen !== 2,
				);
				const incompleteStore = {
					...engine.store,
					readStream: async () => missing,
				};
				await expect(
					replayRun(
						incompleteStore,
						handle.runId,
						engine.toReplayDefinition(wf),
						null,
					),
				).rejects.toThrow(/SleepScheduled/);
					let changedIndex = 0;
					const changed = events.map((event) =>
						event.type === "run.SleepScheduled" && changedIndex++ === 1
							? { ...event, data: { index: 1, delayMs: delay + 1 } }
						: event,
				);
				await expect(
					replayRun(
						{ ...engine.store, readStream: async () => changed },
						handle.runId,
						engine.toReplayDefinition(wf),
						null,
					),
				).rejects.toThrow(/sleep schedule diverged/);
				const shortened = defineWorkflow({
					name: wf.name,
					async run(ctx) {
						await ctx.sleep(delay);
						return "done";
					},
				});
				await expect(
					replayRun(
						engine.store,
						handle.runId,
						engine.toReplayDefinition(shortened),
						null,
					),
				).rejects.toThrow(/SleepScheduled/);
			}),
			{ seed: 614457, numRuns: 100 },
		);
	});

	it("accepts ordered legacy sleeps but rejects an inconsistent recorded index", async () => {
		const engine = createWorkflowEngine();
		const wf = defineWorkflow({
			name: "legacy-timers",
			async run(ctx) {
				await ctx.sleep(3);
				await ctx.sleep(7);
				return "done";
			},
		});
		const handle = await engine.start(wf, null);
		const events = await engine.store.readStream(`run/${handle.runId}`);
		let index = 0;
		const legacy = events.map((event) =>
			event.type === "run.SleepScheduled"
				? { ...event, data: { delayMs: index++ === 0 ? 3 : 7 } }
				: event,
		);
		const definition = engine.toReplayDefinition(wf);
		await expect(
			replayRun(
				{ ...engine.store, readStream: async () => legacy },
				handle.runId,
				definition,
				null,
			),
		).resolves.toMatchObject({ state: "done" });
		index = 0;
		const wrongIndex = events.map((event) =>
			event.type === "run.SleepScheduled" && index++ === 1
				? { ...event, data: { delayMs: 7, index: 0 } }
				: event,
		);
		await expect(
			replayRun(
				{ ...engine.store, readStream: async () => wrongIndex },
				handle.runId,
				definition,
				null,
			),
		).rejects.toThrow(/sleep schedule diverged/);
	});
	it("keeps terminal success and failure stable across repeated resume", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.string({ maxLength: 12 }),
				fc.integer({ min: 0, max: 1000 }),
				fc.boolean(),
				async (id, revision, fail) => {
					const engine = createWorkflowEngine({ seed: "original-seed" });
					let runs = 0;
					let effects = 0;
					const wf = defineWorkflow({
						name: "terminal-history",
						async run(ctx, input: { id: string; revision: number }) {
							runs++;
							const result = await ctx.step("record", () => {
								effects++;
								return input;
							});
							if (fail)
								throw new WorkflowFailure("declined", { step: "record" });
							return result;
						},
					});
					const input = { id, revision };
					const first = await engine.start(wf, input, { runId: "terminal" });
					const saved = await engine.journal(first.runId);
					const restarted = createWorkflowEngine({
						store: engine.store,
						seed: "new-seed",
					});
					await expect(
						restarted.resume(wf, first.runId, { id, revision: revision + 1 }),
					).rejects.toThrow(/input/);
					for (let i = 0; i < 3; i++) {
						expect(
							await restarted.resume(wf, first.runId, { ...input }),
						).toEqual(first);
						expect(await restarted.journal(first.runId)).toEqual(saved);
					}
					expect(runs).toBe(1);
					expect(effects).toBe(1);
				},
			),
			{ seed: 614448, numRuns: 150 },
		);
	});

	it("allows only one fresh start to claim a shared run ID", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.string({ maxLength: 12 }), { minLength: 2, maxLength: 8 }),
				async (inputs) => {
					const engine = createWorkflowEngine();
					let effects = 0;
					const wf = defineWorkflow({
						name: "claim-history",
						async run(ctx, input: string) {
							return ctx.step("effect", () => {
								effects++;
								return input;
							});
						},
					});
					const results = await Promise.allSettled(
						inputs.map((input) =>
							createWorkflowEngine({ store: engine.store }).start(wf, input, {
								runId: "same",
							}),
						),
					);
					expect(
						results.filter((result) => result.status === "fulfilled"),
					).toHaveLength(1);
					expect(
						results.filter((result) => result.status === "rejected"),
					).toHaveLength(inputs.length - 1);
					expect(effects).toBe(1);
				},
			),
			{ seed: 614449, numRuns: 150 },
		);
	});
});
