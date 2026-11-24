import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WorkflowFailure } from "../../src/errors.js";
import { replayRun } from "../../src/replay/replayer.js";
import { createInMemoryEventStore } from "../../src/replay/store.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

function storeWithInterruptedCompletion() {
	const store = createInMemoryEventStore();
	let interrupt = true;
	return {
		...store,
		async append(
			event: Parameters<typeof store.append>[0],
			expectedSeq?: number,
		) {
			if (event.type === "run.StepCompleted" && interrupt) {
				interrupt = false;
				throw new Error("host stopped");
			}
			return store.append(event, expectedSeq);
		},
	};
}

describe("workflow command history", () => {
	it("refuses replay that leaves completed steps unused", async () => {
		await fc.assert(
			fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (count) => {
				const engine = createWorkflowEngine();
				const original = defineWorkflow({
					name: "steps",
					async run(ctx) {
						for (let i = 0; i < count; i++)
							await ctx.step(`step-${i}`, () => i);
						return "done";
					},
				});
				const shorter = defineWorkflow({
					name: "steps",
					async run(ctx) {
						for (let i = 0; i < count - 1; i++)
							await ctx.step(`step-${i}`, () => i);
						return "done";
					},
				});
				const run = await engine.start(original, null);
				await expect(
					replayRun(
						engine.store,
						run.runId,
						engine.toReplayDefinition(shorter),
						null,
					),
				).rejects.toThrow(/unconsumed.*StepCompleted/);
			}),
			{ seed: 614459, numRuns: 100 },
		);
	});

	it("refuses to finish a resumed workflow with recorded steps left over", async () => {
		const engine = createWorkflowEngine();
		const original = defineWorkflow({
			name: "resume-steps",
			async run(ctx) {
				await ctx.step("first", () => 1);
				await ctx.step("second", () => 2);
				throw new Error("host stopped");
			},
		});
		await expect(
			engine.start(original, null, { runId: "resume" }),
		).rejects.toThrow("host stopped");
		const shorter = defineWorkflow({
			name: "resume-steps",
			async run(ctx) {
				await ctx.step("first", () => 1);
				return "done";
			},
		});
		await expect(engine.resume(shorter, "resume", null)).rejects.toThrow(
			/unconsumed.*command/,
		);
		expect(
			(await engine.journal("resume")).some(
				(event) => event.type === "run.Completed",
			),
		).toBe(false);
		const failsEarly = defineWorkflow({
			name: "resume-steps",
			async run() {
				throw new WorkflowFailure("changed workflow failed");
			},
		});
		await expect(engine.resume(failsEarly, "resume", null)).rejects.toThrow(
			/unconsumed.*command/,
		);
		expect(
			(await engine.journal("resume")).some(
				(event) => event.type === "run.Failed",
			),
		).toBe(false);
	});

	it("rejects a changed pending step before running its replacement", async () => {
		const engine = createWorkflowEngine({
			store: storeWithInterruptedCompletion(),
		});
		const original = defineWorkflow({
			name: "pending",
			async run(ctx) {
				await ctx.step("original", () => 1);
			},
		});
		await expect(
			engine.start(original, null, { runId: "pending" }),
		).rejects.toThrow("host stopped");
		let effects = 0;
		const changed = defineWorkflow({
			name: "pending",
			async run(ctx) {
				await ctx.step("replacement", () => {
					effects++;
				});
			},
		});
		const resumed = engine.resume(changed, "pending", null);
		await resumed.catch(() => undefined);
		expect(effects).toBe(0);
		await expect(resumed).rejects.toThrow(/command.*diverged/);
	});

	it("rejects a replacement step before an outstanding sleep", async () => {
		const clock = {
			now: () => new Date(1_000).toISOString(),
			nowMs: () => 1_000,
		};
		const engine = createWorkflowEngine({
			clock,
			wait: async () => {
				throw new Error("host stopped");
			},
		});
		const original = defineWorkflow({
			name: "pending-sleep",
			async run(ctx) {
				await ctx.sleep(10);
			},
		});
		await expect(
			engine.start(original, null, { runId: "sleep" }),
		).rejects.toThrow("host stopped");
		let effects = 0;
		const changed = defineWorkflow({
			name: "pending-sleep",
			async run(ctx) {
				await ctx.step("replacement", () => {
					effects++;
				});
			},
		});
		const resumed = engine.resume(changed, "sleep", null);
		await resumed.catch(() => undefined);
		expect(effects).toBe(0);
		await expect(resumed).rejects.toThrow(/command.*diverged/);
	});

	it("allows a failed in-flight step to be retried under the same command", async () => {
		const engine = createWorkflowEngine({
			store: storeWithInterruptedCompletion(),
		});
		let calls = 0;
		const wf = defineWorkflow({
			name: "retry",
			async run(ctx) {
				return ctx.step("same", () => {
					calls++;
					return 1;
				});
			},
		});
		await expect(engine.start(wf, null, { runId: "retry" })).rejects.toThrow(
			"host stopped",
		);
		expect((await engine.resume(wf, "retry", null)).result).toBe(1);
		expect(calls).toBe(2);
	});
});
