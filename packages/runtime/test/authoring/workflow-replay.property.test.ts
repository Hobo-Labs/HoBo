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
