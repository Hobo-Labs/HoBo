import { describe, expect, it } from "vitest";
import { isJsonObject } from "../../src/json.js";
import { replayRun } from "../../src/replay/replayer.js";
import { createInMemoryEventStore } from "../../src/replay/store.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

describe("workflow sleep completion facts", () => {
	it("replays a nested sleep only after recording its completion", async () => {
		const engine = createWorkflowEngine();
		const wf = defineWorkflow({
			name: "nested-sleep-complete",
			async run(ctx) {
				return ctx.step("parent", async () => {
					await ctx.sleep(0);
					return "done";
				});
			},
		});
		const live = await engine.start(wf, null);
		const journal = await engine.journal(live.runId);
		expect(
			journal.filter((event) => event.type === "run.SleepCompleted"),
		).toHaveLength(1);
		expect(
			journal.find((event) => event.type === "run.Started")?.data,
		).toMatchObject({ commandTreeVersion: 3 });
		expect(
			(
				await replayRun(
					engine.store,
					live.runId,
					engine.toReplayDefinition(wf),
					null,
				)
			).state,
		).toBe("done");
	});

	it("refuses a version-two root sleep without completion evidence", async () => {
		const engine = createWorkflowEngine();
		const wf = defineWorkflow({
			name: "missing-sleep-completion",
			async run(ctx) {
				await ctx.sleep(0);
				return "done";
			},
		});
		const live = await engine.start(wf, null);
		const events = await engine.store.readStream(`run/${live.runId}`);
		const missing = events
			.filter((event) => event.type !== "run.SleepCompleted")
			.map((event) => {
				if (event.type !== "run.Started" || !isJsonObject(event.data))
					return event;
				return { ...event, data: { ...event.data, commandTreeVersion: 2 } };
			});
		await expect(
			replayRun(
				{ ...engine.store, readStream: async () => missing },
				live.runId,
				engine.toReplayDefinition(wf),
				null,
			),
		).rejects.toThrow(/sleep.*completion/i);
	});

	it("refuses a completion timestamp before the recorded deadline", async () => {
		let now = 1_000;
		const clock = { now: () => new Date(now).toISOString(), nowMs: () => now };
		const wait = async (delay: number) => {
			now += delay;
		};
		const engine = createWorkflowEngine({ clock, wait });
		const wf = defineWorkflow({
			name: "early-completion",
			async run(ctx) {
				await ctx.sleep(5);
				return "done";
			},
		});
		const live = await engine.start(wf, null);
		const events = await engine.store.readStream(`run/${live.runId}`);
		const early = events.map((event) =>
			event.type === "run.SleepCompleted"
				? { ...event, data: { index: 0, completedAtMs: 1_004 } }
				: event,
		);
		await expect(
			replayRun(
				{ ...engine.store, readStream: async () => early },
				live.runId,
				engine.toReplayDefinition(wf),
				null,
			),
		).rejects.toThrow(/sleep completion/i);
		const interrupted = early.filter((event) => event.type !== "run.Completed");
		await expect(
			createWorkflowEngine({
				store: { ...engine.store, readStream: async () => interrupted },
				clock,
				wait,
			}).resume(wf, live.runId, null),
		).rejects.toThrow(/sleep completion time/i);
	});

	it("refuses duplicate completion facts on replay and resume", async () => {
		const engine = createWorkflowEngine();
		const wf = defineWorkflow({
			name: "duplicate-completion",
			async run(ctx) {
				await ctx.sleep(0);
				return "done";
			},
		});
		const live = await engine.start(wf, null);
		const events = await engine.store.readStream(`run/${live.runId}`);
		const completed = events.find(
			(event) => event.type === "run.SleepCompleted",
		);
		if (!completed) throw new Error("missing completion fact");
		const duplicate = [
			...events.filter((event) => event.type !== "run.Completed"),
			{ ...completed, id: "duplicate" },
		].map((event, index) => ({ ...event, seq: index + 1 }));
		const reader = { ...engine.store, readStream: async () => duplicate };
		await expect(
			replayRun(reader, live.runId, engine.toReplayDefinition(wf), null),
		).rejects.toThrow(/sleep completion/i);
		await expect(
			createWorkflowEngine({ store: reader }).resume(wf, live.runId, null),
		).rejects.toThrow(/duplicate workflow sleep completion/i);
	});

	it.each([
		false,
		true,
	])("recovers a lost completion response without duplicating the fact (committed: %s)", async (committed) => {
		const store = createInMemoryEventStore();
		let fail = true;
		const unreliable = {
			...store,
			async append(
				event: Parameters<typeof store.append>[0],
				expectedSeq?: number,
			) {
				if (event.type === "run.SleepCompleted" && fail) {
					fail = false;
					if (committed) await store.append(event, expectedSeq);
					throw new Error("completion response lost");
				}
				return store.append(event, expectedSeq);
			},
		};
		let now = 1_000;
		let effects = 0;
		const clock = { now: () => new Date(now).toISOString(), nowMs: () => now };
		const wait = async (delay: number) => {
			now += delay;
		};
		const wf = defineWorkflow({
			name: "lost-completion",
			async run(ctx) {
				await ctx.sleep(5);
				return ctx.step("after", () => {
					effects++;
					return "done";
				});
			},
		});
		const first = createWorkflowEngine({ store: unreliable, clock, wait });
		await expect(first.start(wf, null, { runId: "sleep" })).rejects.toThrow(
			"completion response lost",
		);
		expect(effects).toBe(0);
		const resumed = createWorkflowEngine({ store, clock, wait });
		expect((await resumed.resume(wf, "sleep", null)).result).toBe("done");
		expect(effects).toBe(1);
		const events = await resumed.journal("sleep");
		expect(
			events.filter((event) => event.type === "run.SleepScheduled"),
		).toHaveLength(1);
		expect(
			events.filter((event) => event.type === "run.SleepCompleted"),
		).toHaveLength(1);
	});
});
