import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WorkflowFailure } from "../../src/errors.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

describe("durable workflow histories", () => {
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

	it("replays caught failures and later steps after a crash", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
				fc.integer({ min: -1, max: 4 }),
				async (failures, crashChoice) => {
					const engine = createWorkflowEngine();
					const calls = failures.map(() => 0);
					const crashAt = crashChoice < 0 ? -1 : crashChoice % failures.length;
					let crashed = false;
					const wf = defineWorkflow({
						name: "compensation-history",
						async run(ctx) {
							const results: number[] = [];
							for (const [index, shouldFail] of failures.entries()) {
								try {
									const value = await ctx.step(
										`step-${index}`,
										() => {
											calls[index] = (calls[index] ?? 0) + 1;
											if (shouldFail) throw new Error("declined");
											return index;
										},
										{ retries: 0 },
									);
									results.push(value);
								} catch (error) {
									if (!(error instanceof WorkflowFailure)) throw error;
									results.push(-1);
								}
								if (!crashed && index === crashAt) {
									crashed = true;
									throw new Error("SIMULATED_HOST_CRASH");
								}
							}
							return results;
						},
					});
					const start = engine.start(wf, {}, { runId: "compensation" });
					if (crashAt >= 0) {
						await expect(start).rejects.toThrow("SIMULATED_HOST_CRASH");
					} else {
						await expect(start).resolves.toMatchObject({ status: "completed" });
					}
					const restarted = createWorkflowEngine({ store: engine.store });
					const completed = await restarted.resume(wf, "compensation", {});
					expect(completed.status).toBe("completed");
					expect(completed.result).toEqual(
						failures.map((shouldFail, index) => (shouldFail ? -1 : index)),
					);
					const saved = await restarted.journal("compensation");
					expect(await restarted.resume(wf, "compensation", {})).toEqual(
						completed,
					);
					expect(await restarted.journal("compensation")).toEqual(saved);
					expect(calls).toEqual(failures.map(() => 1));
				},
			),
			{ seed: 614450, numRuns: 150 },
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
