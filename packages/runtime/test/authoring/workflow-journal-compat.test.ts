import { describe, expect, it } from "vitest";
import { isJsonObject, type JsonValue } from "../../src/json.js";
import { nextEnvelope } from "../../src/replay/recorder.js";
import { replayRun } from "../../src/replay/replayer.js";
import {
	createInMemoryEventStore,
	type EventStoreWriter,
} from "../../src/replay/store.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

async function appendFact(
	store: EventStoreWriter,
	streamId: string,
	seq: number,
	type: string,
	data: JsonValue,
): Promise<void> {
	await store.append(nextEnvelope(streamId, seq, type, data), seq - 1);
}

function started(
	workflowName: string,
	args: JsonValue = null,
	commandTreeVersion?: JsonValue,
	extra?: true,
) {
	const fact = { args, seed: "main-seed", workflowName };
	if (commandTreeVersion === undefined) return fact;
	if (extra === undefined) return { ...fact, commandTreeVersion };
	return { ...fact, commandTreeVersion, extra };
}

describe("journals written with the previous command tree", () => {
	it("resumes and replays a run.Started fact that records commandTreeVersion 3", async () => {
		const store = createInMemoryEventStore();
		const streamId = "run/main-open";
		await appendFact(
			store,
			streamId,
			1,
			"run.Started",
			started("main-open", null, 3),
		);
		let calls = 0;
		const workflow = defineWorkflow({
			name: "main-open",
			run: () => {
				calls += 1;
				return "live";
			},
		});
		const engine = createWorkflowEngine({ store });
		await expect(
			engine.resume(workflow, "main-open", null),
		).resolves.toMatchObject({ status: "completed", result: "live" });
		expect(calls).toBe(1);
		const journal = await engine.journal("main-open");
		expect(journal[0]?.data).toMatchObject({ commandTreeVersion: 3 });
		calls = 0;
		await expect(
			replayRun(store, "main-open", engine.toReplayDefinition(workflow), null),
		).resolves.toMatchObject({ state: "live" });
		expect(calls).toBe(1);
	});

	it("returns a completed main journal without calling the workflow", async () => {
		const store = createInMemoryEventStore();
		const streamId = "run/main-done";
		await appendFact(
			store,
			streamId,
			1,
			"run.Started",
			started("main-done", null, 3),
		);
		await appendFact(store, streamId, 2, "run.Completed", {
			result: "recorded",
		});
		let calls = 0;
		const workflow = defineWorkflow({
			name: "main-done",
			run: () => {
				calls += 1;
				return "live";
			},
		});
		await expect(
			createWorkflowEngine({ store }).resume(workflow, "main-done", null),
		).resolves.toMatchObject({ status: "completed", result: "recorded" });
		expect(calls).toBe(0);
	});

	it("reuses a memoized step from a version-3 journal", async () => {
		const store = createInMemoryEventStore();
		const streamId = "run/main-step";
		await appendFact(
			store,
			streamId,
			1,
			"run.Started",
			started("main-step", { n: 1 }, 3),
		);
		await appendFact(store, streamId, 2, "run.StepScheduled", {
			name: "read",
			index: 0,
			parentStepIndex: null,
		});
		await appendFact(store, streamId, 3, "run.StepCompleted", {
			name: "read",
			index: 0,
			result: 7,
		});
		let effects = 0;
		const workflow = defineWorkflow({
			name: "main-step",
			run: (ctx, args: { n: number }) =>
				ctx.step("read", () => {
					effects += 1;
					return args.n;
				}),
		});
		const engine = createWorkflowEngine({ store });
		await expect(
			engine.resume(workflow, "main-step", { n: 1 }),
		).resolves.toMatchObject({ result: 7 });
		expect(effects).toBe(0);
		await expect(
			replayRun(
				store,
				"main-step",
				engine.toReplayDefinition(workflow),
				{ n: 1 },
				{ seed: "main-seed" },
			),
		).resolves.toMatchObject({ state: 7 });
		expect(effects).toBe(0);
	});

	it.each([
		1,
		2,
		4,
		"3",
		null,
	])("refuses commandTreeVersion %j before the workflow runs", async (commandTreeVersion) => {
		const store = createInMemoryEventStore();
		const streamId = "run/bad-version";
		await appendFact(
			store,
			streamId,
			1,
			"run.Started",
			started("bad-version", null, commandTreeVersion),
		);
		await appendFact(store, streamId, 2, "run.Completed", {
			result: "recorded",
		});
		let calls = 0;
		const workflow = defineWorkflow({
			name: "bad-version",
			run: () => {
				calls += 1;
				return "live";
			},
		});
		await expect(
			createWorkflowEngine({ store }).resume(workflow, "bad-version", null),
		).rejects.toThrow(/invalid run\.Started/);
		expect(calls).toBe(0);
	});

	it("refuses an unknown key beside commandTreeVersion 3", async () => {
		const store = createInMemoryEventStore();
		await appendFact(
			store,
			"run/extra-started",
			1,
			"run.Started",
			started("extra-started", null, 3, true),
		);
		let calls = 0;
		const workflow = defineWorkflow({
			name: "extra-started",
			run: () => {
				calls += 1;
				return "live";
			},
		});
		await expect(
			createWorkflowEngine({ store }).resume(workflow, "extra-started", null),
		).rejects.toThrow(/invalid run\.Started/);
		expect(calls).toBe(0);
	});

	it("keeps a recorded SleepDeadlineSet instead of inventing a deadline", async () => {
		const store = createInMemoryEventStore();
		const streamId = "run/rebased-timer";
		await appendFact(
			store,
			streamId,
			1,
			"run.Started",
			started("rebased-timer", null, 3),
		);
		await appendFact(store, streamId, 2, "run.SleepScheduled", {
			delayMs: 10,
			index: 0,
			parentStepIndex: null,
		});
		await appendFact(store, streamId, 3, "run.SleepDeadlineSet", {
			index: 0,
			scheduledAtMs: 1_000,
			deadlineMs: 1_010,
		});
		let now = 1_004;
		const waits: number[] = [];
		let effects = 0;
		const workflow = defineWorkflow({
			name: "rebased-timer",
			async run(ctx) {
				await ctx.sleep(10);
				effects += 1;
				return now;
			},
		});
		const engine = createWorkflowEngine({
			store,
			clock: { now: () => new Date(now).toISOString(), nowMs: () => now },
			wait: async (delay) => {
				waits.push(delay);
				now += delay;
			},
		});
		await expect(
			engine.resume(workflow, "rebased-timer", null),
		).resolves.toMatchObject({ result: 1_010 });
		expect(effects).toBe(1);
		expect(waits).toEqual([6]);
		const journal = await engine.journal("rebased-timer");
		expect(
			journal.filter((event) => event.type === "run.SleepDeadlineSet"),
		).toHaveLength(1);
		const completion = journal.find(
			(event) => event.type === "run.SleepCompleted",
		);
		expect(completion && isJsonObject(completion.data)).toBe(true);
		if (!completion || !isJsonObject(completion.data)) {
			throw new Error("missing sleep completion");
		}
		expect(completion.data.completedAtMs).toBe(1_010);
	});

	it("uses an inline main deadline recorded next to commandTreeVersion 3", async () => {
		const store = createInMemoryEventStore();
		const streamId = "run/inline-timer";
		await appendFact(
			store,
			streamId,
			1,
			"run.Started",
			started("inline-timer", null, 3),
		);
		await appendFact(store, streamId, 2, "run.SleepScheduled", {
			delayMs: 10,
			index: 0,
			parentStepIndex: null,
			scheduledAtMs: 1_000,
			deadlineMs: 1_010,
		});
		let now = 1_004;
		const waits: number[] = [];
		const workflow = defineWorkflow({
			name: "inline-timer",
			async run(ctx) {
				await ctx.sleep(10);
				return now;
			},
		});
		await expect(
			createWorkflowEngine({
				store,
				clock: { now: () => new Date(now).toISOString(), nowMs: () => now },
				wait: async (delay) => {
					waits.push(delay);
					now += delay;
				},
			}).resume(workflow, "inline-timer", null),
		).resolves.toMatchObject({ result: 1_010 });
		expect(waits).toEqual([6]);
	});

	it("replays a sleep whose deadline lives on run.SleepDeadlineSet", async () => {
		const store = createInMemoryEventStore();
		const streamId = "run/rebased-replay";
		await appendFact(
			store,
			streamId,
			1,
			"run.Started",
			started("rebased-replay", null, 3),
		);
		await appendFact(store, streamId, 2, "run.SleepScheduled", {
			delayMs: 10,
			index: 0,
		});
		await appendFact(store, streamId, 3, "run.SleepDeadlineSet", {
			index: 0,
			scheduledAtMs: 1_000,
			deadlineMs: 1_010,
		});
		await appendFact(store, streamId, 4, "run.SleepCompleted", {
			index: 0,
			completedAtMs: 1_010,
		});
		let calls = 0;
		await expect(
			replayRun(
				store,
				"rebased-replay",
				{
					name: "rebased-replay",
					initialState: () => {
						calls += 1;
						return null;
					},
					async execute(ctx) {
						calls += 1;
						await ctx.sleep(10);
						return "replayed";
					},
				},
				null,
				{ seed: "main-seed" },
			),
		).resolves.toMatchObject({ state: "replayed" });
		expect(calls).toBe(2);
	});

	it.each([
		{
			label: "duplicate deadline",
			events: [
				{ delayMs: 10, index: 0 },
				{ index: 0, scheduledAtMs: 1_000, deadlineMs: 1_010 },
				{ index: 0, scheduledAtMs: 1_000, deadlineMs: 1_010 },
			],
			message: /duplicate workflow sleep deadline/,
		},
		{
			label: "deadline that does not match the delay",
			events: [
				{ delayMs: 10, index: 0 },
				{ index: 0, scheduledAtMs: 1_000, deadlineMs: 1_005 },
			],
			message: /invalid recorded workflow sleep deadline/,
		},
		{
			label: "deadline before its sleep",
			events: [{ index: 0, scheduledAtMs: 1_000, deadlineMs: 1_010 }],
			message: /invalid workflow sleep deadline record/,
		},
		{
			label: "deadline beside an inline deadline",
			events: [
				{
					delayMs: 10,
					index: 0,
					scheduledAtMs: 1_000,
					deadlineMs: 1_010,
				},
				{ index: 0, scheduledAtMs: 1_000, deadlineMs: 1_010 },
			],
			message: /duplicate workflow sleep deadline/,
		},
	])("rejects a $label before the workflow runs", async ({
		events,
		message,
	}) => {
		const store = createInMemoryEventStore();
		const streamId = "run/bad-deadline-set";
		await appendFact(
			store,
			streamId,
			1,
			"run.Started",
			started("bad-deadline-set", null, 3),
		);
		for (const [offset, data] of events.entries()) {
			const type =
				"delayMs" in data ? "run.SleepScheduled" : "run.SleepDeadlineSet";
			await appendFact(store, streamId, offset + 2, type, data);
		}
		let calls = 0;
		const workflow = defineWorkflow({
			name: "bad-deadline-set",
			async run(ctx) {
				calls += 1;
				await ctx.sleep(10);
			},
		});
		await expect(
			createWorkflowEngine({ store }).resume(
				workflow,
				"bad-deadline-set",
				null,
			),
		).rejects.toThrow(message);
		expect(calls).toBe(0);
	});
});

describe("run.HookResumed replay", () => {
	it("returns the journaled hook payload from replayRun", async () => {
		const store = createInMemoryEventStore();
		const streamId = "run/hook";
		await appendFact(
			store,
			streamId,
			1,
			"run.Started",
			started("hook", null, 3),
		);
		await appendFact(store, streamId, 2, "run.HookResumed", {
			payload: { ok: true },
		});
		await appendFact(store, streamId, 3, "run.StepScheduled", {
			name: "after-hook",
			index: 0,
		});
		await appendFact(store, streamId, 4, "run.StepCompleted", {
			name: "after-hook",
			index: 0,
			result: "kept",
		});
		let stage = "unread";
		let effects = 0;
		const replayed = await replayRun(
			store,
			"hook",
			{
				name: "hook",
				initialState: () => {
					stage = "initial";
					return null;
				},
				async execute(ctx) {
					stage = "execute";
					const payload = ctx.resumeHook({ ok: false });
					const step = await ctx.step("after-hook", () => {
						effects += 1;
						return "fresh";
					});
					return { payload, step };
				},
			},
			null,
			{ seed: "main-seed" },
		);
		expect(stage).toBe("execute");
		expect(effects).toBe(0);
		expect(replayed.state).toEqual({ payload: { ok: true }, step: "kept" });

		let resumed = 0;
		const workflow = defineWorkflow({
			name: "hook",
			async run(ctx) {
				resumed += 1;
				return ctx.step("after-hook", () => "fresh");
			},
		});
		await expect(
			createWorkflowEngine({ store }).resume(workflow, "hook", null),
		).resolves.toMatchObject({ result: "kept" });
		expect(resumed).toBe(1);
		expect(effects).toBe(0);
	});

	it("reports a missing hook from execute rather than from history validation", async () => {
		const store = createInMemoryEventStore();
		await appendFact(
			store,
			"run/missing-hook",
			1,
			"run.Started",
			started("missing-hook"),
		);
		let stage = "unread";
		await expect(
			replayRun(
				store,
				"missing-hook",
				{
					name: "missing-hook",
					initialState: () => {
						stage = "initial";
						return null;
					},
					execute(ctx) {
						stage = "execute";
						return ctx.resumeHook(null);
					},
				},
				null,
				{ seed: "main-seed" },
			),
		).rejects.toThrow(/missing run\.HookResumed/);
		expect(stage).toBe("execute");
	});

	it.each([
		{},
		{ payload: { ok: true }, extra: true },
		{ payload: -0 },
	])("rejects malformed run.HookResumed %j before execute", async (data) => {
		const store = createInMemoryEventStore();
		await appendFact(
			store,
			"run/bad-hook",
			1,
			"run.Started",
			started("bad-hook"),
		);
		await appendFact(store, "run/bad-hook", 2, "run.HookResumed", data);
		let calls = 0;
		await expect(
			replayRun(
				store,
				"bad-hook",
				{
					name: "bad-hook",
					initialState: () => {
						calls += 1;
						return null;
					},
					execute: () => {
						calls += 1;
						return null;
					},
				},
				null,
				{ seed: "main-seed" },
			),
		).rejects.toThrow(/invalid run\.HookResumed/);
		expect(calls).toBe(0);
	});
});
