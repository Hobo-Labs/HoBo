import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { WorkflowFailure } from "../../src/errors.js";
import { isJsonObject } from "../../src/json.js";
import { createInMemoryEventStore } from "../../src/replay/store.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function resultBeforeRelease(run: Promise<unknown>) {
	return Promise.race([
		run.then(
			() => "completed",
			(error) => error,
		),
		new Promise<"blocked">((resolve) =>
			setTimeout(() => resolve("blocked"), 50),
		),
	]);
}

describe("workflow command lifetimes", () => {
	it("rejects an unawaited root step before its scheduling response arrives", async () => {
		const store = createInMemoryEventStore();
		const entered = deferred();
		const release = deferred();
		const slow = {
			...store,
			async append(
				event: Parameters<typeof store.append>[0],
				expected?: number,
			) {
				if (event.type === "run.StepScheduled") {
					entered.resolve();
					await release.promise;
				}
				return store.append(event, expected);
			},
		};
		let effects = 0;
		let orphan: Promise<unknown> = Promise.resolve();
		const wf = defineWorkflow({
			name: "unawaited-root",
			run(ctx) {
				orphan = ctx.step("late", () => ++effects).catch((error) => error);
				return "done";
			},
		});
		const engine = createWorkflowEngine({ store: slow });
		const run = engine.start(wf, null, { runId: "unawaited-root" });
		await Promise.race([entered.promise, run.catch(() => undefined)]);
		const outcome = await resultBeforeRelease(run);
		release.resolve();
		await orphan;
		await run.catch(() => undefined);
		expect(outcome).toBeInstanceOf(Error);
		expect(String(outcome)).toMatch(/outstanding|unfinished|unawaited/i);
		expect(effects).toBe(0);
		const events = await engine.journal("unawaited-root");
		expect(
			events.some(
				(event) =>
					event.type === "run.Completed" || event.type === "run.Failed",
			),
		).toBe(false);
	});

	it("rejects an unawaited nested child without retrying its parent", async () => {
		const store = createInMemoryEventStore();
		const entered = deferred();
		const release = deferred();
		const slow = {
			...store,
			async append(
				event: Parameters<typeof store.append>[0],
				expected?: number,
			) {
				if (
					event.type === "run.StepScheduled" &&
					isJsonObject(event.data) &&
					event.data.name === "child"
				) {
					entered.resolve();
					await release.promise;
				}
				return store.append(event, expected);
			},
		};
		let parentCalls = 0;
		let effects = 0;
		let orphan: Promise<unknown> = Promise.resolve();
		const wf = defineWorkflow({
			name: "unawaited-child",
			run(ctx) {
				return ctx.step("parent", () => {
					parentCalls++;
					orphan = ctx.step("child", () => ++effects).catch((error) => error);
					return "done";
				});
			},
		});
		const engine = createWorkflowEngine({ store: slow });
		const run = engine.start(wf, null, { runId: "unawaited-child" });
		await Promise.race([entered.promise, run.catch(() => undefined)]);
		const outcome = await resultBeforeRelease(run);
		release.resolve();
		await orphan;
		await run.catch(() => undefined);
		expect(outcome).toBeInstanceOf(Error);
		expect(String(outcome)).toMatch(/outstanding|unfinished|unawaited/i);
		expect(parentCalls).toBe(1);
		expect(effects).toBe(0);
		const events = await engine.journal("unawaited-child");
		expect(
			events.some(
				(event) =>
					event.type === "run.Completed" ||
					event.type === "run.Failed" ||
					event.type === "run.StepCompleted",
			),
		).toBe(false);
	});

	it("rejects an unawaited sleep and does not record a terminal outcome", async () => {
		const release = deferred();
		let orphan: Promise<unknown> = Promise.resolve();
		let now = 100;
		const engine = createWorkflowEngine({
			clock: { now: () => new Date(now).toISOString(), nowMs: () => now },
			wait: async () => {
				await release.promise;
				now = 110;
			},
		});
		const wf = defineWorkflow({
			name: "unawaited-sleep",
			run(ctx) {
				orphan = ctx.sleep(10).catch((error) => error);
				return "done";
			},
		});
		const run = engine.start(wf, null, { runId: "unawaited-sleep" });
		const outcome = await resultBeforeRelease(run);
		release.resolve();
		await orphan;
		await run.catch(() => undefined);
		expect(outcome).toBeInstanceOf(Error);
		expect(String(outcome)).toMatch(/outstanding|unfinished|unawaited/i);
		const events = await engine.journal("unawaited-sleep");
		expect(
			events.some(
				(event) =>
					event.type === "run.Completed" ||
					event.type === "run.Failed" ||
					event.type === "run.SleepCompleted",
			),
		).toBe(false);
	});

	it("rejects an unawaited event append before recording a terminal outcome", async () => {
		const store = createInMemoryEventStore();
		const release = deferred();
		const slow = {
			...store,
			async append(
				event: Parameters<typeof store.append>[0],
				expected?: number,
			) {
				if (event.type === "audit") await release.promise;
				return store.append(event, expected);
			},
		};
		let orphan: Promise<unknown> = Promise.resolve();
		const wf = defineWorkflow({
			name: "unawaited-emit",
			run(ctx) {
				orphan = ctx.emit("audit").catch((error) => error);
				return "done";
			},
		});
		const engine = createWorkflowEngine({ store: slow });
		const run = engine.start(wf, null, { runId: "unawaited-emit" });
		const outcome = await resultBeforeRelease(run);
		release.resolve();
		await orphan;
		await run.catch(() => undefined);
		expect(outcome).toBeInstanceOf(Error);
		expect(String(outcome)).toMatch(/outstanding|unfinished|unawaited/i);
		const events = await engine.journal("unawaited-emit");
		expect(
			events.some(
				(event) =>
					event.type === "run.Completed" || event.type === "run.Failed",
			),
		).toBe(false);
	});

	it("does not claim to cancel an effect that started before its parent returned", async () => {
		const entered = deferred();
		const release = deferred();
		let effects = 0;
		let orphan: Promise<unknown> = Promise.resolve();
		const wf = defineWorkflow({
			name: "already-started-effect",
			async run(ctx) {
				orphan = ctx
					.step("effect", async () => {
						effects++;
						entered.resolve();
						await release.promise;
						effects++;
					})
					.catch((error) => error);
				await entered.promise;
				return "done";
			},
		});
		const engine = createWorkflowEngine();
		const run = engine.start(wf, null, { runId: "already-started-effect" });
		await entered.promise;
		const outcome = await resultBeforeRelease(run);
		release.resolve();
		await orphan;
		await run.catch(() => undefined);
		expect(String(outcome)).toMatch(/outstanding|unfinished|unawaited/i);
		expect(effects).toBe(2);
		const events = await engine.journal("already-started-effect");
		expect(
			events.some(
				(event) =>
					event.type === "run.Completed" ||
					event.type === "run.Failed" ||
					event.type === "run.StepCompleted",
			),
		).toBe(false);
	});

	it("does not record a failed terminal result while a command is pending", async () => {
		const release = deferred();
		let orphan: Promise<unknown> = Promise.resolve();
		const wf = defineWorkflow({
			name: "failure-with-pending-command",
			run(ctx) {
				orphan = ctx.sleep(1).catch((error) => error);
				throw new WorkflowFailure("application failure");
			},
		});
		const engine = createWorkflowEngine({ wait: () => release.promise });
		const run = engine.start(wf, null, {
			runId: "failure-with-pending-command",
		});
		const outcome = await resultBeforeRelease(run);
		release.resolve();
		await orphan;
		await run.catch(() => undefined);
		expect(String(outcome)).toMatch(/outstanding|unfinished|unawaited/i);
		const events = await engine.journal("failure-with-pending-command");
		expect(
			events.some(
				(event) =>
					event.type === "run.Completed" || event.type === "run.Failed",
			),
		).toBe(false);
	});

	it("does not retry a parent after a nested journal append fails", async () => {
		const store = createInMemoryEventStore();
		const broken = {
			...store,
			async append(
				event: Parameters<typeof store.append>[0],
				expected?: number,
			) {
				if (
					event.type === "run.StepScheduled" &&
					isJsonObject(event.data) &&
					event.data.name === "child"
				) {
					throw new Error("child scheduling failed");
				}
				return store.append(event, expected);
			},
		};
		let parentCalls = 0;
		const wf = defineWorkflow({
			name: "failed-child-append",
			run(ctx) {
				return ctx.step("parent", async () => {
					parentCalls++;
					return ctx.step("child", () => "never");
				});
			},
		});
		const engine = createWorkflowEngine({ store: broken });
		await expect(
			engine.start(wf, null, { runId: "failed-child-append" }),
		).rejects.toThrow("child scheduling failed");
		expect(parentCalls).toBe(1);
		const events = await engine.journal("failed-child-append");
		expect(
			events.some(
				(event) =>
					event.type === "run.Completed" || event.type === "run.Failed",
			),
		).toBe(false);
	});

	it("rejects a callback that schedules work after its parent returns", async () => {
		const release = deferred();
		let late: Promise<unknown> = Promise.resolve();
		let effects = 0;
		const wf = defineWorkflow({
			name: "late-callback",
			async run(ctx) {
				await ctx.step("parent", () => {
					late = release.promise.then(() => ctx.step("late", () => ++effects));
				});
				return "done";
			},
		});
		const engine = createWorkflowEngine();
		const result = await engine.start(wf, null);
		release.resolve();
		await expect(late).rejects.toThrow(/closed|finished|inactive/i);
		expect(effects).toBe(0);
		const events = await engine.journal(result.runId);
		expect(
			events.filter((event) => event.type === "run.StepScheduled"),
		).toHaveLength(1);
	});

	it("accepts awaited sibling commands under varied interleavings", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 0, max: 4 }),
				fc.integer({ min: 0, max: 4 }),
				async (left, right) => {
					const wf = defineWorkflow({
						name: "awaited-siblings",
						async run(ctx) {
							const work = (name: string, count: number) =>
								ctx.step(name, async () => {
									for (let i = 0; i < count; i++) await Promise.resolve();
									return ctx.step(`${name}-child`, () => name);
								});
							return Promise.all([work("left", left), work("right", right)]);
						},
					});
					const engine = createWorkflowEngine();
					const result = await engine.start(wf, null);
					expect(result.result).toEqual(["left", "right"]);
				},
			),
			{ seed: 614463, numRuns: 100 },
		);
	});
});
