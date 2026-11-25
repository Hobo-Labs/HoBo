import { describe, expect, it } from "vitest";
import { WorkflowFailure } from "../../src/errors.js";
import { isJsonNumber, isJsonObject } from "../../src/json.js";

import { replayRun } from "../../src/replay/replayer.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";
import { readJournaledWorkflowResult } from "../../src/workflow-value.js";

interface OrderState {
	reserved: boolean;
	charged: boolean;
	confirmedAt: string;
}

describe("durable workflow: journal, restart, replay", () => {
	it("returns a completed run without invoking its workflow or appending again", async () => {
		const engine = createWorkflowEngine();
		let runs = 0;
		const wf = defineWorkflow({
			name: "terminal-success",
			async run(ctx, value: string) {
				runs++;
				return ctx.step("result", () => value);
			},
		});
		const first = await engine.start(wf, "result", { runId: "completed-run" });
		const before = await engine.journal(first.runId);
		const resumed = await engine.resume(wf, first.runId, "result");
		expect(resumed).toEqual(first);
		expect(runs).toBe(1);
		expect(await engine.journal(first.runId)).toEqual(before);
	});

	it("returns a failed run without executing it again", async () => {
		const engine = createWorkflowEngine();
		let runs = 0;
		const wf = defineWorkflow({
			name: "terminal-failure",
			run() {
				runs++;
				throw new WorkflowFailure("declined", { step: "payment" });
			},
		});
		const first = await engine.start(wf, {}, { runId: "failed-run" });
		const before = await engine.journal(first.runId);
		const resumed = await engine.resume(wf, first.runId, {});
		expect(first.status).toBe("failed");
		expect(resumed).toEqual(first);
		expect(runs).toBe(1);
		expect(await engine.journal(first.runId)).toEqual(before);
	});

	it("returns a legacy failure without inventing a missing step", async () => {
		const engine = createWorkflowEngine();
		await engine.store.append(
			{
				id: "legacy-start",
				streamId: "run/legacy-failure",
				seq: 1,
				type: "run.Started",
				data: { args: {} },
			},
			0,
		);
		await engine.store.append(
			{
				id: "legacy-failure",
				streamId: "run/legacy-failure",
				seq: 2,
				type: "run.Failed",
				data: { message: "declined" },
			},
			1,
		);
		let runs = 0;
		const wf = defineWorkflow({
			name: "legacy",
			run() {
				runs++;
				return "unexpected";
			},
		});
		const result = await engine.resume(wf, "legacy-failure", {});
		expect(result).toEqual({
			runId: "legacy-failure",
			status: "failed",
			result: undefined,
			error: { code: "workflow.failed", message: "declined" },
		});
		expect(runs).toBe(0);
	});

	it("rejects malformed terminal facts without executing the workflow", async () => {
		const engine = createWorkflowEngine();
		await engine.store.append(
			{
				id: "start",
				streamId: "run/malformed",
				seq: 1,
				type: "run.Started",
				data: { args: {} },
			},
			0,
		);
		await engine.store.append(
			{
				id: "failed",
				streamId: "run/malformed",
				seq: 2,
				type: "run.Failed",
				data: {},
			},
			1,
		);
		let runs = 0;
		const wf = defineWorkflow({
			name: "malformed",
			run() {
				runs++;
			},
		});
		await expect(engine.resume(wf, "malformed", {})).rejects.toThrow(
			/invalid run.Failed/,
		);
		expect(runs).toBe(0);
	});

	it("survives a host restart and resumes from the journal without re-running completed steps", async () => {
		const engine = createWorkflowEngine();
		const invocations = { reserve: 0, charge: 0, confirm: 0 };
		let crashed = false;

		const checkout = defineWorkflow<{ id: string }, OrderState>({
			name: "checkout",
			async run(ctx, args) {
				const reserved = await ctx.step("reserve", () => {
					invocations.reserve += 1;
					return { id: args.id, reserved: true };
				});
				// Host dies after the first step is durably journaled.
				if (!crashed) {
					crashed = true;
					throw new Error("SIMULATED_HOST_CRASH");
				}
				await ctx.step("charge", () => {
					invocations.charge += 1;
					return { charged: true };
				});
				const confirmedAt = await ctx.step("confirm", () => {
					invocations.confirm += 1;
					return ctx.now();
				});
				return { reserved: reserved.reserved, charged: true, confirmedAt };
			},
		});

		await expect(
			engine.start(checkout, { id: "order-1" }, { runId: "run-1" }),
		).rejects.toThrow("SIMULATED_HOST_CRASH");
		expect(invocations.reserve).toBe(1);

		// A brand-new engine over the SAME durable store resumes the run.
		const restarted = createWorkflowEngine({ store: engine.store });
		const handle = await restarted.resume(checkout, "run-1", { id: "order-1" });

		expect(handle.status).toBe("completed");
		// reserve was journaled on attempt 1 — replayed from the log, not re-run.
		expect(invocations.reserve).toBe(1);
		expect(invocations.charge).toBe(1);
		expect(invocations.confirm).toBe(1);

		const journal = await restarted.journal("run-1");
		expect(journal.at(-1)?.type).toBe("run.Completed");
		expect(handle.result?.charged).toBe(true);
	});

	it("gives fresh starts distinct journals across concurrent and restarted engines", async () => {
		const first = createWorkflowEngine();
		const second = createWorkflowEngine({ store: first.store });
		const seen: string[] = [];
		const wf = defineWorkflow({
			name: "unique",
			async run(ctx, input: string) {
				return ctx.step("value", () => {
					seen.push(input);
					return input;
				});
			},
		});
		const runs = await Promise.all(
			Array.from({ length: 12 }, (_, index) =>
				(index % 2 ? first : second).start(wf, `input-${index}`),
			),
		);
		expect(new Set(runs.map((run) => run.runId)).size).toBe(runs.length);
		expect(runs.map((run) => run.result)).toEqual(
			Array.from({ length: 12 }, (_, index) => `input-${index}`),
		);
		expect(seen).toHaveLength(12);
		const restarted = createWorkflowEngine({ store: first.store });
		const afterRestart = await restarted.start(wf, "after-restart");
		expect(runs.some((run) => run.runId === afterRestart.runId)).toBe(false);
		expect(afterRestart.result).toBe("after-restart");
	});

	it("claims a caller-supplied run ID before effects and rejects duplicate fresh starts", async () => {
		const engine = createWorkflowEngine();
		let effects = 0;
		const wf = defineWorkflow({
			name: "claim",
			async run(ctx) {
				return ctx.step("effect", () => {
					effects++;
					return effects;
				});
			},
		});
		const first = await engine.start(wf, {}, { runId: "known-run" });
		expect(first.runId).toBe("known-run");
		await expect(
			createWorkflowEngine({ store: engine.store }).start(
				wf,
				{},
				{ runId: "known-run" },
			),
		).rejects.toThrow();
		expect(effects).toBe(1);
	});

	it("refuses an unknown run or a resume with different workflow input", async () => {
		const engine = createWorkflowEngine({ seed: "original-seed" });
		let effects = 0;
		let crash = true;
		const wf = defineWorkflow({
			name: "resume-check",
			async run(ctx, input: { id: string }) {
				await ctx.step("once", () => {
					effects++;
					return input.id;
				});
				if (crash) {
					crash = false;
					throw new Error("host crash");
				}
				return ctx.seed;
			},
		});
		await expect(engine.resume(wf, "missing", { id: "one" })).rejects.toThrow(
			/run.Started|not found/,
		);
		expect(effects).toBe(0);
		await expect(
			engine.start(wf, { id: "one" }, { runId: "resume-check" }),
		).rejects.toThrow("host crash");
		const restarted = createWorkflowEngine({
			store: engine.store,
			seed: "changed-seed",
		});
		await expect(
			restarted.resume(wf, "resume-check", { id: "different" }),
		).rejects.toThrow(/input|args/i);
		const wrong = defineWorkflow({ name: "different-workflow", run: wf.run });
		await expect(
			restarted.resume(wrong, "resume-check", { id: "one" }),
		).rejects.toThrow(/workflow/i);
		const resumed = await restarted.resume(wf, "resume-check", { id: "one" });
		expect(resumed.result).toBe("original-seed");
		expect(effects).toBe(1);
	});

	it("resumes a legacy journal without a recorded workflow name", async () => {
		const engine = createWorkflowEngine({ seed: "new-engine-seed" });
		await engine.store.append(
			{
				id: "legacy-start",
				streamId: "run/legacy",
				seq: 1,
				type: "run.Started",
				data: { seed: "legacy-seed", args: { id: "one" } },
			},
			0,
		);
		const wf = defineWorkflow({
			name: "legacy-workflow",
			run: (ctx) => ctx.seed,
		});
		const result = await engine.resume(wf, "legacy", { id: "one" });
		expect(result.result).toBe("legacy-seed");
	});

	it("produces a journal that is replay-equivalent under the existing replay engine", async () => {
		const engine = createWorkflowEngine();
		const wf = defineWorkflow<{ id: string }, OrderState>({
			name: "checkout",
			async run(ctx, args) {
				await ctx.step("reserve", () => ({ id: args.id, reserved: true }));
				await ctx.step("charge", () => ({ charged: true }));
				const confirmedAt = await ctx.step("confirm", () => ctx.now());
				return { reserved: true, charged: true, confirmedAt };
			},
		});

		const handle = await engine.start(wf, { id: "order-2" });
		expect(handle.status).toBe("completed");

		// Feed the journal our engine wrote to the pre-existing replay engine.
		const replay = await replayRun(
			engine.store,
			handle.runId,
			engine.toReplayDefinition(wf),
			{ id: "order-2" },
		);

		expect(replay.state).toEqual(handle.result);
		expect(replay.report.mode).toBe("replay");
	});

	it("makes ctx.sleep deterministic under replay", async () => {
		let now = 1_000;
		const engine = createWorkflowEngine({
			clock: { now: () => new Date(now).toISOString(), nowMs: () => now },
			wait: async (delay) => {
				now += delay;
			},
		});
		const wf = defineWorkflow<{ id: string }, { at: string; slept: boolean }>({
			name: "delayed",
			async run(ctx) {
				await ctx.step("before", () => "before");
				await ctx.sleep(10_000, { label: "cooldown" });
				const at = ctx.now();
				return { at, slept: true };
			},
		});

		const handle = await engine.start(wf, { id: "order-3" });
		expect(now).toBe(11_000);

		const journal = await engine.journal(handle.runId);
		const sleepEvent = journal.find(
			(event) => event.type === "run.SleepScheduled",
		);
		if (!sleepEvent) {
			throw new Error("expected run.SleepScheduled");
		}
		const data = sleepEvent.data;
		if (!isJsonObject(data) || !isJsonNumber(data.delayMs)) {
			throw new Error("expected delayMs number");
		}
		expect(data.delayMs).toBe(10_000);

		// Two independent replays reproduce identical state + digest.
		const first = await replayRun(
			engine.store,
			handle.runId,
			engine.toReplayDefinition(wf),
			{ id: "order-3" },
		);
		const second = await replayRun(
			engine.store,
			handle.runId,
			engine.toReplayDefinition(wf),
			{ id: "order-3" },
		);

		expect(first.state).toEqual(handle.result);
		expect(first.report.stateDigest).toBe(second.report.stateDigest);
	});

	it("replays a void step completion after a host restart", async () => {
		const engine = createWorkflowEngine();
		let attempts = 0;
		let crashed = false;
		const wf = defineWorkflow({
			name: "void-step",
			async run(ctx) {
				await ctx.step("noop", () => {
					attempts += 1;
				});
				if (!crashed) {
					crashed = true;
					throw new Error("SIMULATED_HOST_CRASH");
				}
				return "done";
			},
		});
		await expect(engine.start(wf, {}, { runId: "void-step" })).rejects.toThrow(
			"SIMULATED_HOST_CRASH",
		);
		expect(attempts).toBe(1);
		const restarted = createWorkflowEngine({ store: engine.store });
		const handle = await restarted.resume(wf, "void-step", {});
		expect(handle.result).toBe("done");
		expect(attempts).toBe(1);
	});

	it("replays a journaled step failure without re-running the step effect", async () => {
		const engine = createWorkflowEngine();
		let attempts = 0;
		let crash = true;
		const wf = defineWorkflow({
			name: "step-failed-replay",
			async run(ctx) {
				try {
					await ctx.step(
						"pay",
						() => {
							attempts += 1;
							throw new WorkflowFailure("card declined", { step: "pay" });
						},
						{ retries: 0 },
					);
				} catch (error) {
					if (crash) {
						crash = false;
						throw error instanceof WorkflowFailure
							? new Error("SIMULATED_HOST_CRASH")
							: error;
					}
				}
				return "recovered";
			},
		});
		await expect(
			engine.start(wf, {}, { runId: "step-failed-replay" }),
		).rejects.toThrow("SIMULATED_HOST_CRASH");
		expect(attempts).toBe(1);
		const restarted = createWorkflowEngine({ store: engine.store });
		const handle = await restarted.resume(wf, "step-failed-replay", {});
		expect(handle.result).toBe("recovered");
		expect((await restarted.resume(wf, "step-failed-replay", {})).result).toBe(
			"recovered",
		);
		expect(attempts).toBe(1);
	});

	it("rejects duplicate run.Started facts", async () => {
		const engine = createWorkflowEngine();
		await engine.store.append(
			{
				id: "start-1",
				streamId: "run/dup-started",
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "dup-started-seed",
					workflowName: "dup-started",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "start-2",
				streamId: "run/dup-started",
				seq: 2,
				type: "run.Started",
				data: {
					args: {},
					seed: "dup-started-seed",
					workflowName: "dup-started",
				},
			},
			1,
		);
		let runs = 0;
		const wf = defineWorkflow({
			name: "dup-started",
			run() {
				runs += 1;
				return "live";
			},
		});
		await expect(engine.resume(wf, "dup-started", {})).rejects.toThrow(
			/duplicate run.Started/,
		);
		expect(runs).toBe(0);
	});

	it("rejects run.Started with wrong-typed fields", async () => {
		const engine = createWorkflowEngine();
		await engine.store.append(
			{
				id: "bad-start",
				streamId: "run/bad-started",
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "bad-started-seed",
					workflowName: 42,
				},
			},
			0,
		);
		const wf = defineWorkflow({ name: "bad-started", run: () => "x" });
		await expect(engine.resume(wf, "bad-started", {})).rejects.toThrow(
			/invalid run.Started/,
		);
	});

	it("resumes legacy run.Started without args as null input", async () => {
		const engine = createWorkflowEngine();
		await engine.store.append(
			{
				id: "legacy-start",
				streamId: "run/legacy-no-args",
				seq: 1,
				type: "run.Started",
				data: { seed: "legacy-no-args" },
			},
			0,
		);
		await engine.store.append(
			{
				id: "legacy-complete",
				streamId: "run/legacy-no-args",
				seq: 2,
				type: "run.Completed",
				data: { result: "from-journal" },
			},
			1,
		);
		const wf = defineWorkflow({
			name: "legacy-no-args",
			run() {
				return "live";
			},
		});
		const handle = await engine.resume(wf, "legacy-no-args", null);
		expect(handle.status).toBe("completed");
		expect(handle.result).toBe("from-journal");
	});

	it("rejects a step name that diverges from the journal at the same index", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/name-diverge";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "name-diverge",
					workflowName: "name-diverge",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "done-b",
				streamId,
				seq: 2,
				type: "run.StepCompleted",
				data: { name: "b", index: 0, result: 2 },
			},
			1,
		);
		const wf = defineWorkflow({
			name: "name-diverge",
			async run(ctx) {
				await ctx.step("a", () => 1);
				return "done";
			},
		});
		await expect(engine.resume(wf, "name-diverge", {})).rejects.toThrow(
			/step name differs from journal/,
		);
	});

	it("rejects duplicate step outcomes at the same positional index", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/dup-index";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "dup-index",
					workflowName: "dup-index",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "done-a",
				streamId,
				seq: 2,
				type: "run.StepCompleted",
				data: { name: "a", index: 0, result: 1 },
			},
			1,
		);
		await engine.store.append(
			{
				id: "done-b",
				streamId,
				seq: 3,
				type: "run.StepCompleted",
				data: { name: "b", index: 0, result: 2 },
			},
			2,
		);
		const wf = defineWorkflow({
			name: "dup-index",
			async run(ctx) {
				await ctx.step("a", () => 1);
				return "done";
			},
		});
		await expect(engine.resume(wf, "dup-index", {})).rejects.toThrow(
			/duplicate run.StepCompleted/,
		);
	});

	it("rejects duplicate run.StepCompleted facts for the same step", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/dup-step-complete";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "dup-step-seed",
					workflowName: "dup-step-complete",
				},
			},
			0,
		);
		const completed = { name: "work", index: 0, result: { ok: true } };
		await engine.store.append(
			{
				id: "done-1",
				streamId,
				seq: 2,
				type: "run.StepCompleted",
				data: completed,
			},
			1,
		);
		await engine.store.append(
			{
				id: "done-2",
				streamId,
				seq: 3,
				type: "run.StepCompleted",
				data: completed,
			},
			2,
		);
		let runs = 0;
		const wf = defineWorkflow({
			name: "dup-step-complete",
			async run(ctx) {
				await ctx.step("work", () => {
					runs += 1;
					return { ok: true };
				});
				return "done";
			},
		});
		await expect(engine.resume(wf, "dup-step-complete", {})).rejects.toThrow(
			/duplicate run.StepCompleted/,
		);
		expect(runs).toBe(0);
	});

	it("rejects conflicting run.StepCompleted and run.StepFailed for the same step", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/conflict-step";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "conflict-seed",
					workflowName: "conflict-step",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "done",
				streamId,
				seq: 2,
				type: "run.StepCompleted",
				data: { name: "work", index: 0, result: { ok: true } },
			},
			1,
		);
		await engine.store.append(
			{
				id: "failed",
				streamId,
				seq: 3,
				type: "run.StepFailed",
				data: { name: "work", index: 0, message: "nope" },
			},
			2,
		);
		const wf = defineWorkflow({
			name: "conflict-step",
			async run(ctx) {
				await ctx.step("work", () => ({ ok: true }));
				return "done";
			},
		});
		await expect(engine.resume(wf, "conflict-step", {})).rejects.toThrow(
			/conflicting step outcomes/,
		);
	});

	it("rejects run.StepFailed with non-record data before running", async () => {
		const engine = createWorkflowEngine();
		await engine.store.append(
			{
				id: "start",
				streamId: "run/bad-step-failed-shape",
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "bad-step-failed-shape",
					workflowName: "bad-step-failed-shape",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "failed",
				streamId: "run/bad-step-failed-shape",
				seq: 2,
				type: "run.StepFailed",
				data: "not-a-record",
			},
			1,
		);
		const wf = defineWorkflow({
			name: "bad-step-failed-shape",
			async run(ctx) {
				await ctx.step("work", () => ({}));
				return "done";
			},
		});
		await expect(
			engine.resume(wf, "bad-step-failed-shape", {}),
		).rejects.toThrow(/invalid run.StepFailed/);
	});

	it("rejects corrupt step journals even when a terminal fact exists", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/terminal-with-bad-step";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "terminal-with-bad-step",
					workflowName: "terminal-with-bad-step",
				},
			},
			0,
		);
		const completed = { name: "work", index: 0, result: { ok: true } };
		await engine.store.append(
			{
				id: "step-1",
				streamId,
				seq: 2,
				type: "run.StepCompleted",
				data: completed,
			},
			1,
		);
		await engine.store.append(
			{
				id: "step-2",
				streamId,
				seq: 3,
				type: "run.StepCompleted",
				data: completed,
			},
			2,
		);
		await engine.store.append(
			{
				id: "terminal",
				streamId,
				seq: 4,
				type: "run.Completed",
				data: { result: { ok: true } },
			},
			3,
		);
		const wf = defineWorkflow({
			name: "terminal-with-bad-step",
			run() {
				return { ok: true };
			},
		});
		await expect(
			engine.resume(wf, "terminal-with-bad-step", {}),
		).rejects.toThrow(/duplicate run.StepCompleted/);
	});

	it("rejects run.StepCompleted with wrong-typed index", async () => {
		const engine = createWorkflowEngine();
		await engine.store.append(
			{
				id: "start",
				streamId: "run/bad-step-index",
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "bad-step-index",
					workflowName: "bad-step-index",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "done",
				streamId: "run/bad-step-index",
				seq: 2,
				type: "run.StepCompleted",
				data: { name: "work", index: "0", result: {} },
			},
			1,
		);
		const wf = defineWorkflow({
			name: "bad-step-index",
			async run(ctx) {
				await ctx.step("work", () => ({}));
				return "done";
			},
		});
		await expect(engine.resume(wf, "bad-step-index", {})).rejects.toThrow(
			/invalid run.StepCompleted/,
		);
	});

	it("rejects run.Failed with wrong-typed step", async () => {
		const engine = createWorkflowEngine();
		await engine.store.append(
			{
				id: "start",
				streamId: "run/bad-failed-step",
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "bad-failed-step-seed",
					workflowName: "bad-failed-step",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "failed",
				streamId: "run/bad-failed-step",
				seq: 2,
				type: "run.Failed",
				data: { message: "nope", step: 7 },
			},
			1,
		);
		const wf = defineWorkflow({
			name: "bad-failed-step",
			run() {
				return "unexpected";
			},
		});
		await expect(engine.resume(wf, "bad-failed-step", {})).rejects.toThrow(
			/invalid run.Failed/,
		);
	});

	it("executes with args stored on run.Started", async () => {
		const engine = createWorkflowEngine();
		await engine.store.append(
			{
				id: "journal-start",
				streamId: "run/journal-args",
				seq: 1,
				type: "run.Started",
				data: {
					args: { from: "journal" },
					seed: "journal-args-seed",
					workflowName: "journal-args",
				},
			},
			0,
		);
		const wf = defineWorkflow({
			name: "journal-args",
			run(_ctx, args: { from: string }) {
				return args.from;
			},
		});
		const result = await engine.resume(wf, "journal-args", { from: "journal" });
		expect(result.result).toBe("journal");
	});

	it.each([
		["run.Completed", "run.Completed"],
		["run.Completed", "run.Failed"],
		["run.Failed", "run.Completed"],
		["run.Failed", "run.Failed"],
	] as const)("rejects duplicate terminal facts %s then %s", async (first, second) => {
		const engine = createWorkflowEngine();
		await engine.store.append(
			{
				id: "start",
				streamId: "run/dup-terminal",
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "dup-terminal-seed",
					workflowName: "dup",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "completed",
				streamId: "run/dup-terminal",
				seq: 2,
				type: first,
				data: { result: "first" },
			},
			1,
		);
		await engine.store.append(
			{
				id: "completed-again",
				streamId: "run/dup-terminal",
				seq: 3,
				type: second,
				data: { result: "second" },
			},
			2,
		);
		let runs = 0;
		const wf = defineWorkflow({
			name: "dup",
			run() {
				runs++;
				return "live";
			},
		});
		await expect(engine.resume(wf, "dup-terminal", {})).rejects.toThrow(
			/duplicate terminal/,
		);
		expect(runs).toBe(0);
	});

	it("rejects a gapped step journal before running the workflow", async () => {
		const engine = createWorkflowEngine();
		await engine.store.append(
			{
				id: "start",
				streamId: "run/gapped",
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "gapped-seed",
					workflowName: "gapped",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "failed",
				streamId: "run/gapped",
				seq: 2,
				type: "run.StepFailed",
				data: { name: "only", index: 2, message: "boom" },
			},
			1,
		);
		const wf = defineWorkflow({
			name: "gapped",
			run(ctx) {
				return ctx.step("only", () => "nope");
			},
		});
		await expect(engine.resume(wf, "gapped", {})).rejects.toThrow(
			/gapped step journal/,
		);
	});

	it("rejects a schedule above maxOutcome with a gapped prefix", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/scheduled-far-gap";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "scheduled-far-gap",
					workflowName: "scheduled-far-gap",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "done",
				streamId,
				seq: 2,
				type: "run.StepCompleted",
				data: { name: "early", index: 0, result: "ok" },
			},
			1,
		);
		await engine.store.append(
			{
				id: "scheduled",
				streamId,
				seq: 3,
				type: "run.StepScheduled",
				data: { name: "late", index: 5 },
			},
			2,
		);
		let runs = 0;
		const wf = defineWorkflow({
			name: "scheduled-far-gap",
			async run(ctx) {
				runs += 1;
				await ctx.step("early", () => "ok");
				await ctx.step("late", () => "nope");
				return "nope";
			},
		});
		await expect(engine.resume(wf, "scheduled-far-gap", {})).rejects.toThrow(
			/gapped step journal/,
		);
		expect(runs).toBe(0);
	});

	it("resumes a scheduled-only hole below a later step outcome", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/scheduled-hole";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "scheduled-hole",
					workflowName: "scheduled-hole",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "scheduled",
				streamId,
				seq: 2,
				type: "run.StepScheduled",
				data: { name: "hole", index: 0 },
			},
			1,
		);
		await engine.store.append(
			{
				id: "later",
				streamId,
				seq: 3,
				type: "run.StepCompleted",
				data: { name: "later", index: 1, result: "done" },
			},
			2,
		);
		let runs = 0;
		let holeEffects = 0;
		let laterEffects = 0;
		const wf = defineWorkflow({
			name: "scheduled-hole",
			async run(ctx) {
				runs += 1;
				await ctx.step("hole", () => {
					holeEffects += 1;
					return "first";
				});
				return ctx.step("later", () => {
					laterEffects += 1;
					return "done";
				});
			},
		});
		const handle = await engine.resume(wf, "scheduled-hole", {});
		expect(handle.status).toBe("completed");
		expect(handle.result).toBe("done");
		expect(runs).toBe(1);
		expect(holeEffects).toBe(1);
		expect(laterEffects).toBe(0);
		const journal = await engine.journal("scheduled-hole");
		expect(
			journal.some(
				(event) =>
					event.type === "run.StepCompleted" &&
					isJsonObject(event.data) &&
					event.data.index === 0,
			),
		).toBe(true);
	});

	it("resumes a schedule above the open journal tip", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/orphan-schedule";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "orphan-schedule",
					workflowName: "orphan-schedule",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "done-0",
				streamId,
				seq: 2,
				type: "run.StepCompleted",
				data: { name: "first", index: 0, result: "ok" },
			},
			1,
		);
		await engine.store.append(
			{
				id: "open",
				streamId,
				seq: 3,
				type: "run.StepScheduled",
				data: { name: "second", index: 1 },
			},
			2,
		);
		await engine.store.append(
			{
				id: "scheduled-2",
				streamId,
				seq: 4,
				type: "run.StepScheduled",
				data: { name: "third", index: 2 },
			},
			3,
		);
		await engine.store.append(
			{
				id: "done-2",
				streamId,
				seq: 5,
				type: "run.StepCompleted",
				data: { name: "third", index: 2, result: "later" },
			},
			4,
		);
		let runs = 0;
		let firstEffects = 0;
		let secondEffects = 0;
		let thirdEffects = 0;
		const wf = defineWorkflow({
			name: "orphan-schedule",
			async run(ctx) {
				runs += 1;
				await ctx.step("first", () => {
					firstEffects += 1;
					return "ok";
				});
				await ctx.step("second", () => {
					secondEffects += 1;
					return "open";
				});
				return ctx.step("third", () => {
					thirdEffects += 1;
					return "later";
				});
			},
		});
		const handle = await engine.resume(wf, "orphan-schedule", {});
		expect(handle.status).toBe("completed");
		expect(handle.result).toBe("later");
		expect(runs).toBe(1);
		expect(firstEffects).toBe(0);
		expect(secondEffects).toBe(1);
		expect(thirdEffects).toBe(0);
	});

	it("resumes a single open scheduled tip without scheduling it again", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/open-tip";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "open-tip",
					workflowName: "open-tip",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "scheduled",
				streamId,
				seq: 2,
				type: "run.StepScheduled",
				data: { name: "work", index: 0 },
			},
			1,
		);
		let runs = 0;
		const wf = defineWorkflow({
			name: "open-tip",
			run: (ctx) =>
				ctx.step("work", () => {
					runs += 1;
					return "done";
				}),
		});
		const first = await engine.resume(wf, "open-tip", {});
		expect(first.result).toBe("done");
		expect(runs).toBe(1);
		const schedules = (await engine.journal("open-tip")).filter(
			(event) => event.type === "run.StepScheduled",
		);
		expect(schedules).toHaveLength(1);
		expect((await engine.resume(wf, "open-tip", {})).result).toBe("done");
		expect(runs).toBe(1);
		expect(
			(await engine.journal("open-tip")).filter(
				(event) => event.type === "run.StepScheduled",
			),
		).toHaveLength(1);
	});

	it("accepts identical duplicate schedules at the same index", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/dup-schedule";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "dup-schedule",
					workflowName: "dup-schedule",
				},
			},
			0,
		);
		const scheduled = { name: "work", index: 0 };
		await engine.store.append(
			{
				id: "scheduled-1",
				streamId,
				seq: 2,
				type: "run.StepScheduled",
				data: scheduled,
			},
			1,
		);
		await engine.store.append(
			{
				id: "scheduled-2",
				streamId,
				seq: 3,
				type: "run.StepScheduled",
				data: scheduled,
			},
			2,
		);
		let runs = 0;
		let workEffects = 0;
		const wf = defineWorkflow({
			name: "dup-schedule",
			run(ctx) {
				runs += 1;
				return ctx.step("work", () => {
					workEffects += 1;
					return "done";
				});
			},
		});
		const handle = await engine.resume(wf, "dup-schedule", {});
		expect(handle.status).toBe("completed");
		expect(handle.result).toBe("done");
		expect(runs).toBe(1);
		expect(workEffects).toBe(1);
		const journal = await engine.journal("dup-schedule");
		expect(
			journal.filter((event) => event.type === "run.StepScheduled"),
		).toHaveLength(2);
		expect(
			journal.filter((event) => event.type === "run.StepCompleted"),
		).toHaveLength(1);
	});

	it("rejects a scheduled step index above 1000000", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/scheduled-bound";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "scheduled-bound",
					workflowName: "scheduled-bound",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "scheduled",
				streamId,
				seq: 2,
				type: "run.StepScheduled",
				data: { name: "too-high", index: 1_000_001 },
			},
			1,
		);
		let runs = 0;
		const wf = defineWorkflow({
			name: "scheduled-bound",
			run(ctx) {
				runs += 1;
				return ctx.step("too-high", () => "nope");
			},
		});
		await expect(engine.resume(wf, "scheduled-bound", {})).rejects.toThrow(
			/invalid run\.StepScheduled|invalid step journal/,
		);
		expect(runs).toBe(0);
	});

	it.each([
		["negative zero", -0],
		["sparse array", Array(2)],
		["nested negative zero", { n: -0 }],
		["nested sparse array", { items: Array(2) }],
	])("rejects %s in journaled run.Started", async (_label, args) => {
		const engine = createWorkflowEngine();
		await engine.store.append(
			{
				id: "start",
				streamId: "run/bad-started-value",
				seq: 1,
				type: "run.Started",
				data: {
					args,
					seed: "bad-started-value",
					workflowName: "bad-started-value",
				},
			},
			0,
		);
		const wf = defineWorkflow({
			name: "bad-started-value",
			run: () => "live",
		});
		await expect(engine.resume(wf, "bad-started-value", null)).rejects.toThrow(
			/invalid run\.Started/,
		);
	});

	it.each([
		["negative zero", -0],
		["sparse array", Array(2)],
		["nested negative zero", { n: -0 }],
		["nested sparse array", { items: Array(2) }],
	])("rejects %s in a journaled step result", async (_label, result) => {
		const engine = createWorkflowEngine();
		const streamId = "run/bad-step-result";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "bad-step-result",
					workflowName: "bad-step-result",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "done",
				streamId,
				seq: 2,
				type: "run.StepCompleted",
				data: { name: "read", index: 0, result },
			},
			1,
		);
		let runs = 0;
		let readEffects = 0;
		const wf = defineWorkflow({
			name: "bad-step-result",
			run: (ctx) => {
				runs += 1;
				return ctx.step("read", () => {
					readEffects += 1;
					return "live";
				});
			},
		});
		const journalBefore = await engine.journal("bad-step-result");
		let rejection: TypeError | undefined;
		try {
			await engine.resume(wf, "bad-step-result", {});
		} catch (reason: unknown) {
			if (reason instanceof TypeError) rejection = reason;
		}
		expect(rejection).toBeInstanceOf(TypeError);
		expect(rejection?.message).toMatch(
			/invalid run\.StepCompleted|JSON-normalized/,
		);
		expect(runs).toBe(0);
		expect(readEffects).toBe(0);
		expect(await engine.journal("bad-step-result")).toEqual(journalBefore);
	});

	it.each([
		[
			"non-enumerable fact key",
			() => {
				const data = { name: "read", index: 0, result: "ok" };
				Object.defineProperty(data, "extra", {
					value: true,
					enumerable: false,
				});
				return data;
			},
		],
		[
			"non-enumerable result key",
			() => {
				const result = { a: 1 };
				Object.defineProperty(result, "hidden", {
					value: 2,
					enumerable: false,
				});
				return { name: "read", index: 0, result };
			},
		],
		[
			"symbol result key",
			() => {
				const result = { a: 1 };
				Object.defineProperty(result, Symbol("hidden"), {
					value: 2,
					enumerable: false,
				});
				return { name: "read", index: 0, result };
			},
		],
		[
			"symbol array result key",
			() => {
				const result = [1];
				Object.defineProperty(result, Symbol("hidden"), {
					value: 2,
					enumerable: true,
				});
				return { name: "read", index: 0, result };
			},
		],
		[
			"extra array result key",
			() => {
				const result = [1];
				Object.defineProperty(result, "extra", {
					value: 2,
					enumerable: true,
				});
				return { name: "read", index: 0, result };
			},
		],
		[
			"__proto__-only fact",
			() => {
				const data: Record<
					string,
					{ name: string; index: number; result: string }
				> = {};
				Object.defineProperty(data, "__proto__", {
					value: { name: "read", index: 0, result: "ok" },
					enumerable: true,
				});
				return data;
			},
		],
	])("rejects %s preserved by the journal snapshot", async (_label, buildData) => {
		const engine = createWorkflowEngine();
		const streamId = "run/bad-snapshot-shape";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "bad-snapshot-shape",
					workflowName: "bad-snapshot-shape",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "done",
				streamId,
				seq: 2,
				type: "run.StepCompleted",
				data: buildData(),
			},
			1,
		);
		let runs = 0;
		let readEffects = 0;
		const wf = defineWorkflow({
			name: "bad-snapshot-shape",
			run: (ctx) => {
				runs += 1;
				return ctx.step("read", () => {
					readEffects += 1;
					return "live";
				});
			},
		});
		const journalBefore = await engine.journal("bad-snapshot-shape");
		await expect(
			engine.resume(wf, "bad-snapshot-shape", {}),
		).rejects.toMatchObject({
			name: "TypeError",
			message: "invalid run.StepCompleted",
		});
		expect(runs).toBe(0);
		expect(readEffects).toBe(0);
		expect(await engine.journal("bad-snapshot-shape")).toEqual(journalBefore);
	});

	it("replays a journaled result with an own __proto__ key", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/proto-result";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "proto-result",
					workflowName: "proto-result",
				},
			},
			0,
		);
		const result = { ok: 2 };
		Object.defineProperty(result, "__proto__", {
			value: { polluted: 1 },
			enumerable: true,
			writable: true,
			configurable: true,
		});
		await engine.store.append(
			{
				id: "done",
				streamId,
				seq: 2,
				type: "run.StepCompleted",
				data: { name: "read", index: 0, result },
			},
			1,
		);
		let readEffects = 0;
		const wf = defineWorkflow({
			name: "proto-result",
			run: (ctx) =>
				ctx.step("read", () => {
					readEffects += 1;
					return { ok: 2 };
				}),
		});
		const handle = await engine.resume(wf, "proto-result", {});
		expect(handle.status).toBe("completed");
		expect(readEffects).toBe(0);
		if (!isJsonObject(handle.result)) {
			throw new Error("expected object result");
		}
		expect(Object.hasOwn(handle.result, "__proto__")).toBe(true);
		expect(
			Object.getOwnPropertyDescriptor(handle.result, "__proto__")?.value,
		).toEqual({ polluted: 1 });
		expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
	});

	it("rejects sparse arrays and negative zero when reading a journaled value", () => {
		for (const value of [Array(2), -0, { n: -0 }, { items: Array(2) }]) {
			let caught: unknown;
			try {
				readJournaledWorkflowResult(value);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(TypeError);
			if (!(caught instanceof TypeError)) {
				throw new Error("expected TypeError");
			}
			expect(caught.message.length).toBeGreaterThan(0);
		}
	});

	it("rethrows a replay failure from now and random", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/replay-clock";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "replay-clock",
					workflowName: "replay-clock",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "sleep",
				streamId,
				seq: 2,
				type: "run.SleepScheduled",
				data: { delayMs: 10, index: 0 },
			},
			1,
		);
		let caught: unknown;
		let nowError: unknown;
		let randomError: unknown;
		let probe: number | undefined;
		const wf = defineWorkflow({
			name: "replay-clock",
			async run(ctx) {
				probe = ctx.random("probe");
				try {
					await ctx.sleep(20);
				} catch (error) {
					caught = error;
				}
				try {
					ctx.now();
				} catch (error) {
					nowError = error;
				}
				try {
					ctx.random("after");
				} catch (error) {
					randomError = error;
				}
				if (caught instanceof Error) throw caught;
				return "unexpected";
			},
		});
		await expect(engine.resume(wf, "replay-clock", {})).rejects.toThrow(
			/sleep schedule diverged/,
		);
		expect(probe).toEqual(expect.any(Number));
		expect(caught).toBeInstanceOf(Error);
		expect(nowError).toBe(caught);
		expect(randomError).toBe(caught);
		expect(await engine.journal("replay-clock")).toHaveLength(2);
	});

	it.each([
		null,
		"nope",
		{ delayMs: "10", index: 0 },
		{ delayMs: 10 },
		{ delayMs: 10, index: 0, extra: true },
		{ delayMs: 10, index: 1_000_001 },
		{ delayMs: Number.NaN, index: 0 },
		{ delayMs: Number.POSITIVE_INFINITY, index: 0 },
		{ delayMs: -1, index: 0 },
		{ delayMs: 10, index: -1 },
		{ delayMs: 10, index: 0.5 },
		{ delayMs: 10, index: Number.NaN },
		{ delayMs: -0, index: 0 },
		{ delayMs: -0.5, index: 0 },
		{ delayMs: 1e20, index: 0 },
		{ delayMs: Number.MAX_SAFE_INTEGER + 1, index: 0 },
	])("rejects invalid run.SleepScheduled %j", async (data) => {
		const engine = createWorkflowEngine();
		const streamId = "run/bad-sleep";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "bad-sleep",
					workflowName: "bad-sleep",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "sleep",
				streamId,
				seq: 2,
				type: "run.SleepScheduled",
				data,
			},
			1,
		);
		let runs = 0;
		const wf = defineWorkflow({
			name: "bad-sleep",
			async run(ctx) {
				runs += 1;
				await ctx.sleep(10);
				return "unexpected";
			},
		});
		await expect(engine.resume(wf, "bad-sleep", {})).rejects.toThrow(
			/invalid run\.SleepScheduled/,
		);
		expect(runs).toBe(0);
		expect(await engine.journal("bad-sleep")).toHaveLength(2);
	});

	it("normalizes negative zero sleep duration on write", async () => {
		const engine = createWorkflowEngine();
		const wf = defineWorkflow({
			name: "negative-zero-sleep",
			async run(ctx) {
				await ctx.sleep(-0);
				return "done";
			},
		});
		const handle = await engine.start(wf, {}, { runId: "negative-zero-sleep" });
		expect(handle.result).toBe("done");
		const journal = await engine.journal("negative-zero-sleep");
		const sleepEvent = journal.find(
			(event) => event.type === "run.SleepScheduled",
		);
		if (!sleepEvent || !isJsonObject(sleepEvent.data)) {
			throw new Error("expected run.SleepScheduled");
		}
		expect(sleepEvent.data.delayMs).toBe(0);
		expect(Object.is(sleepEvent.data.delayMs, -0)).toBe(false);
		const resumed = await engine.resume(wf, "negative-zero-sleep", {});
		expect(resumed.result).toBe("done");
	});

	it.each([
		["NaN", Number.NaN],
		["positive Infinity", Number.POSITIVE_INFINITY],
		["negative Infinity", Number.NEGATIVE_INFINITY],
		["negative", -1],
		["non-integer", 10.5],
		["non-safe-integer", Number.MAX_SAFE_INTEGER + 1],
	])("rejects invalid ctx.sleep delayMs on write: %s", async (_label, delayMs) => {
		const engine = createWorkflowEngine();
		const wf = defineWorkflow({
			name: "invalid-write-sleep",
			async run(ctx) {
				await ctx.sleep(delayMs);
				return "done";
			},
		});
		await expect(
			engine.start(wf, {}, { runId: "invalid-write-sleep" }),
		).rejects.toThrow(/invalid run\.SleepScheduled/);
		const journal = await engine.journal("invalid-write-sleep");
		expect(journal.map((event) => event.type)).toEqual(["run.Started"]);
	});

	it("cannot hide an invalid ctx.sleep delayMs by catching it", async () => {
		const engine = createWorkflowEngine();
		let effects = 0;
		const wf = defineWorkflow({
			name: "hidden-invalid-sleep",
			async run(ctx) {
				try {
					await ctx.sleep(Number.NaN);
				} catch {}
				try {
					await ctx.step("after", () => {
						effects += 1;
						return "after";
					});
				} catch {}
				return "done";
			},
		});
		await expect(
			engine.start(wf, {}, { runId: "hidden-invalid-sleep" }),
		).rejects.toThrow(/invalid run\.SleepScheduled/);
		expect(effects).toBe(0);
		expect(
			(await engine.journal("hidden-invalid-sleep")).map((event) => event.type),
		).toEqual(["run.Started"]);
	});

	it("rejects an unconsumed run.SleepScheduled at index 1000000 without appending run.Completed", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/max-sleep";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "max-sleep",
					workflowName: "max-sleep",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "sleep",
				streamId,
				seq: 2,
				type: "run.SleepScheduled",
				data: { delayMs: 10, index: 1_000_000 },
			},
			1,
		);
		let runs = 0;
		const wf = defineWorkflow({
			name: "max-sleep",
			async run() {
				runs += 1;
				return "done";
			},
		});
		await expect(engine.resume(wf, "max-sleep", {})).rejects.toThrow(
			/unconsumed scheduled sleep \(orphan SleepScheduled\)/,
		);
		expect(runs).toBe(1);
		const journal = await engine.journal("max-sleep");
		expect(journal).toHaveLength(2);
		expect(journal.some((event) => event.type === "run.Completed")).toBe(false);
	});

	it.each([
		{ delayMs: 20, index: 0 },
		{ delayMs: 10, index: 0, label: "other" },
	])("rejects conflicting duplicate run.SleepScheduled %j", async (duplicate) => {
		const engine = createWorkflowEngine();
		const streamId = "run/dup-sleep";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "dup-sleep",
					workflowName: "dup-sleep",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "sleep-1",
				streamId,
				seq: 2,
				type: "run.SleepScheduled",
				data: { delayMs: 10, index: 0 },
			},
			1,
		);
		await engine.store.append(
			{
				id: "sleep-2",
				streamId,
				seq: 3,
				type: "run.SleepScheduled",
				data: duplicate,
			},
			2,
		);
		let runs = 0;
		const wf = defineWorkflow({
			name: "dup-sleep",
			async run(ctx) {
				runs += 1;
				await ctx.sleep(10);
				return "unexpected";
			},
		});
		await expect(engine.resume(wf, "dup-sleep", {})).rejects.toThrow(
			/invalid run\.SleepScheduled/,
		);
		expect(runs).toBe(0);
		expect(await engine.journal("dup-sleep")).toHaveLength(3);
	});

	it("rejects an orphan SleepScheduled without appending run.Completed", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/orphan-sleep";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "orphan-sleep",
					workflowName: "orphan-sleep",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "sleep",
				streamId,
				seq: 2,
				type: "run.SleepScheduled",
				data: { delayMs: 10, index: 0 },
			},
			1,
		);
		let runs = 0;
		const wf = defineWorkflow({
			name: "orphan-sleep",
			async run() {
				runs += 1;
				return "done";
			},
		});
		await expect(engine.resume(wf, "orphan-sleep", {})).rejects.toThrow(
			/unconsumed scheduled sleep \(orphan SleepScheduled\)/,
		);
		expect(runs).toBe(1);
		const journal = await engine.journal("orphan-sleep");
		expect(journal).toHaveLength(2);
		expect(journal.some((event) => event.type === "run.Completed")).toBe(false);
	});

	it("rejects a sleep appended past an unconsumed journaled sleep", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/sleep-gap";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "sleep-gap",
					workflowName: "sleep-gap",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "sleep-0",
				streamId,
				seq: 2,
				type: "run.SleepScheduled",
				data: { delayMs: 10, index: 0 },
			},
			1,
		);
		await engine.store.append(
			{
				id: "sleep-2",
				streamId,
				seq: 3,
				type: "run.SleepScheduled",
				data: { delayMs: 10, index: 2 },
			},
			2,
		);
		const wf = defineWorkflow({
			name: "sleep-gap",
			async run(ctx) {
				await ctx.sleep(10);
				await ctx.sleep(10);
				return "unexpected";
			},
		});
		await expect(engine.resume(wf, "sleep-gap", {})).rejects.toThrow(
			/sleep schedule diverged on replay/,
		);
		const journal = await engine.journal("sleep-gap");
		expect(journal).toHaveLength(3);
		expect(journal.some((event) => event.type === "run.Completed")).toBe(false);
	});

	it("rejects a journaled fractional delayMs on resume", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/legacy-fractional-sleep";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "legacy-fractional-sleep",
					workflowName: "legacy-fractional-sleep",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "sleep",
				streamId,
				seq: 2,
				type: "run.SleepScheduled",
				data: { delayMs: 1.5, index: 0 },
			},
			1,
		);
		const wf = defineWorkflow({
			name: "legacy-fractional-sleep",
			async run(ctx) {
				await ctx.sleep(1);
				return "done";
			},
		});
		await expect(
			engine.resume(wf, "legacy-fractional-sleep", {}),
		).rejects.toThrow(/invalid run\.SleepScheduled/);
	});

	it("rejects a replay whose sleep does not match a legacy fractional delayMs", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/legacy-fractional-diverged";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "legacy-fractional-diverged",
					workflowName: "legacy-fractional-diverged",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "sleep",
				streamId,
				seq: 2,
				type: "run.SleepScheduled",
				data: { delayMs: 1.5, index: 0 },
			},
			1,
		);
		const wf = defineWorkflow({
			name: "legacy-fractional-diverged",
			async run(ctx) {
				await ctx.sleep(1);
				return "unexpected";
			},
		});
		await expect(
			engine.resume(wf, "legacy-fractional-diverged", {}),
		).rejects.toThrow(/invalid run\.SleepScheduled/);
		const journal = await engine.journal("legacy-fractional-diverged");
		expect(journal).toHaveLength(2);
	});

	it("resumes a journaled sleep before the first step without a step-index gap", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/sleep-then-step";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "sleep-then-step",
					workflowName: "sleep-then-step",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "sleep",
				streamId,
				seq: 2,
				type: "run.SleepScheduled",
				data: { delayMs: 10, index: 0 },
			},
			1,
		);
		await engine.store.append(
			{
				id: "done",
				streamId,
				seq: 3,
				type: "run.StepCompleted",
				data: { name: "work", index: 0, result: "ok" },
			},
			2,
		);
		let runs = 0;
		let workEffects = 0;
		const wf = defineWorkflow({
			name: "sleep-then-step",
			async run(ctx) {
				runs += 1;
				await ctx.sleep(10);
				return ctx.step("work", () => {
					workEffects += 1;
					return "ok";
				});
			},
		});
		const handle = await engine.resume(wf, "sleep-then-step", {});
		expect(handle.status).toBe("completed");
		expect(handle.result).toBe("ok");
		expect(runs).toBe(1);
		expect(workEffects).toBe(0);
	});

	it("consumes a journaled sleep across a host restart", async () => {
		const engine = createWorkflowEngine();
		let crashed = false;
		const wf = defineWorkflow({
			name: "sleep-restart",
			async run(ctx) {
				await ctx.sleep(10, { label: "cooldown" });
				if (!crashed) {
					crashed = true;
					throw new Error("SIMULATED_HOST_CRASH");
				}
				return "done";
			},
		});
		await expect(
			engine.start(wf, {}, { runId: "sleep-restart" }),
		).rejects.toThrow("SIMULATED_HOST_CRASH");
		const resumed = createWorkflowEngine({ store: engine.store });
		const handle = await resumed.resume(wf, "sleep-restart", {});
		expect(handle.status).toBe("completed");
		expect(handle.result).toBe("done");
		const journal = await resumed.journal("sleep-restart");
		expect(
			journal.filter((event) => event.type === "run.SleepScheduled"),
		).toHaveLength(1);
	});

	it("rejects a non-string ctx.sleep label on write", async () => {
		const engine = createWorkflowEngine();
		const wf = defineWorkflow({
			name: "invalid-sleep-label",
			async run(ctx) {
				// oxlint-disable-next-line anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion -- SAFETY: deliberately injects a non-string label to assert the live-path write rejection.
				await ctx.sleep(10, { label: 5 as unknown as string });
				return "done";
			},
		});
		await expect(
			engine.start(wf, {}, { runId: "invalid-sleep-label" }),
		).rejects.toThrow(/invalid run\.SleepScheduled/);
		expect(
			(await engine.journal("invalid-sleep-label")).map((event) => event.type),
		).toEqual(["run.Started"]);
	});

	it("rejects events recorded after a terminal fact", async () => {
		const engine = createWorkflowEngine();
		await engine.store.append(
			{
				id: "start",
				streamId: "run/after-terminal",
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "after-terminal-seed",
					workflowName: "after-terminal",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "done",
				streamId: "run/after-terminal",
				seq: 2,
				type: "run.Completed",
				data: { result: "ok" },
			},
			1,
		);
		await engine.store.append(
			{
				id: "late",
				streamId: "run/after-terminal",
				seq: 3,
				type: "run.StepCompleted",
				data: { name: "late", index: 0, result: "nope" },
			},
			2,
		);
		const wf = defineWorkflow({
			name: "after-terminal",
			run() {
				return "live";
			},
		});
		await expect(engine.resume(wf, "after-terminal", {})).rejects.toThrow(
			/events after terminal/,
		);
	});

	it("returns a completed terminal after a recorded step failure", async () => {
		const engine = createWorkflowEngine();
		await engine.store.append(
			{
				id: "start",
				streamId: "run/conflict-terminal",
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "conflict-terminal-seed",
					workflowName: "conflict-terminal",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "failed",
				streamId: "run/conflict-terminal",
				seq: 2,
				type: "run.StepFailed",
				data: { name: "s", index: 0, message: "boom" },
			},
			1,
		);
		await engine.store.append(
			{
				id: "done",
				streamId: "run/conflict-terminal",
				seq: 3,
				type: "run.Completed",
				data: { result: "nope" },
			},
			2,
		);
		const wf = defineWorkflow({
			name: "conflict-terminal",
			run() {
				return "live";
			},
		});
		const handle = await engine.resume(wf, "conflict-terminal", {});
		expect(handle.status).toBe("completed");
		expect(handle.result).toBe("nope");
	});

	it("refuses run.Completed when a journaled step outcome was not consumed", async () => {
		const engine = createWorkflowEngine();
		await engine.store.append(
			{
				id: "start",
				streamId: "run/unconsumed",
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "unconsumed-seed",
					workflowName: "unconsumed",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "failed",
				streamId: "run/unconsumed",
				seq: 2,
				type: "run.StepFailed",
				data: { name: "later", index: 1, message: "later" },
			},
			1,
		);
		await engine.store.append(
			{
				id: "done",
				streamId: "run/unconsumed",
				seq: 3,
				type: "run.StepCompleted",
				data: { name: "early", index: 0, result: "ok" },
			},
			2,
		);
		const wf = defineWorkflow({
			name: "unconsumed",
			run(ctx) {
				return ctx.step("early", () => "ok");
			},
		});
		await expect(engine.resume(wf, "unconsumed", {})).rejects.toThrow(
			/unconsumed step outcome/,
		);
	});

	it("refuses run.Failed when a journaled step outcome was not consumed", async () => {
		const engine = createWorkflowEngine();
		await engine.store.append(
			{
				id: "start",
				streamId: "run/unconsumed-failure",
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "unconsumed-failure-seed",
					workflowName: "unconsumed-failure",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "done",
				streamId: "run/unconsumed-failure",
				seq: 2,
				type: "run.StepCompleted",
				data: { name: "later", index: 0, result: "ok" },
			},
			1,
		);
		const wf = defineWorkflow({
			name: "unconsumed-failure",
			run() {
				throw new WorkflowFailure("early failure");
			},
		});
		await expect(engine.resume(wf, "unconsumed-failure", {})).rejects.toThrow(
			/unconsumed step outcome/,
		);
		expect(await engine.journal("unconsumed-failure")).toHaveLength(2);
	});

	it("rejects an orphan StepScheduled above consumed outcomes without appending run.Completed", async () => {
		const engine = createWorkflowEngine();
		const streamId = "run/orphan-scheduled";
		await engine.store.append(
			{
				id: "start",
				streamId,
				seq: 1,
				type: "run.Started",
				data: {
					args: {},
					seed: "orphan-scheduled",
					workflowName: "orphan-scheduled",
				},
			},
			0,
		);
		await engine.store.append(
			{
				id: "done-0",
				streamId,
				seq: 2,
				type: "run.StepCompleted",
				data: { name: "only", index: 0, result: "ok" },
			},
			1,
		);
		await engine.store.append(
			{
				id: "scheduled-5",
				streamId,
				seq: 3,
				type: "run.StepScheduled",
				data: { name: "orphan", index: 5 },
			},
			2,
		);
		let effects = 0;
		const wf = defineWorkflow({
			name: "orphan-scheduled",
			run(ctx) {
				return ctx.step("only", () => {
					effects += 1;
					return "ok";
				});
			},
		});
		await expect(engine.resume(wf, "orphan-scheduled", {})).rejects.toThrow(
			/gapped step journal|unconsumed scheduled step \(orphan StepScheduled\)/,
		);
		expect(effects).toBe(0);
		const journal = await engine.journal("orphan-scheduled");
		expect(journal).toHaveLength(3);
		expect(journal.some((event) => event.type === "run.Completed")).toBe(false);
	});

	it.each([
		false,
		true,
	])("replays compensation after a caught step failure (crash: %s)", async (crash) => {
		const engine = createWorkflowEngine();
		let attempts = 0;
		let compensations = 0;
		let crashed = false;
		const wf = defineWorkflow({
			name: "compensation",
			async run(ctx) {
				try {
					await ctx.step(
						"charge",
						() => {
							attempts += 1;
							throw new Error("declined");
						},
						{ retries: 0 },
					);
				} catch (error) {
					if (!(error instanceof WorkflowFailure)) throw error;
					await ctx.step("compensate", () => {
						compensations += 1;
						return "recovered";
					});
				}
				if (crash && !crashed) {
					crashed = true;
					throw new Error("SIMULATED_HOST_CRASH");
				}
				return "recovered";
			},
		});
		if (crash) {
			await expect(
				engine.start(wf, {}, { runId: "compensation" }),
			).rejects.toThrow("SIMULATED_HOST_CRASH");
		} else {
			expect(
				(await engine.start(wf, {}, { runId: "compensation" })).result,
			).toBe("recovered");
		}
		const resumed = createWorkflowEngine({ store: engine.store });
		const result = await resumed.resume(wf, "compensation", {});
		expect(result.status).toBe("completed");
		expect(result.result).toBe("recovered");
		const journal = await resumed.journal("compensation");
		expect(journal.map((event) => event.type)).toEqual([
			"run.Started",
			"run.StepScheduled",
			"run.StepFailed",
			"run.StepScheduled",
			"run.StepCompleted",
			"run.Completed",
		]);
		expect((await resumed.resume(wf, "compensation", {})).result).toBe(
			"recovered",
		);
		expect(await resumed.journal("compensation")).toEqual(journal);
		expect(attempts).toBe(1);
		expect(compensations).toBe(1);
	});

	it("refuses run.* appends after its parent returns with a step outstanding", async () => {
		const engine = createWorkflowEngine();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let lateStep: Promise<unknown> = Promise.resolve();
		const wf = defineWorkflow({
			name: "late-step",
			async run(ctx) {
				lateStep = ctx
					.step("slow", async () => {
						await gate;
						return "slow";
					})
					.catch((error) => error);
				return "fast";
			},
		});
		await expect(engine.start(wf, {}, { runId: "late-step" })).rejects.toThrow(
			/outstanding/,
		);
		const journalAtReturn = await engine.journal("late-step");
		release();
		expect(await lateStep).toBeInstanceOf(Error);
		const journal = await engine.journal("late-step");
		expect(journal).toEqual(journalAtReturn);
		expect(
			journal.some(
				(event) =>
					event.type === "run.Completed" || event.type === "run.Failed",
			),
		).toBe(false);
	});
});
