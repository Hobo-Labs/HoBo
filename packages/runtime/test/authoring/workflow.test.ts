import { describe, expect, it } from "vitest";
import { WorkflowFailure } from "../../src/errors.js";
import { isJsonNumber, isJsonObject } from "../../src/json.js";

import { replayRun } from "../../src/replay/replayer.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

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
		const engine = createWorkflowEngine();
		const wf = defineWorkflow<{ id: string }, { at: string; slept: boolean }>({
			name: "delayed",
			async run(ctx) {
				await ctx.step("before", () => "before");
				await ctx.sleep(10_000, { label: "cooldown" });
				const at = ctx.now();
				return { at, slept: true };
			},
		});

		const start = Date.now();
		const handle = await engine.start(wf, { id: "order-3" });
		// The durable timer is journaled, not a wall-clock wait.
		expect(Date.now() - start).toBeLessThan(1000);

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
				data: { args: {}, workflowName: "dup" },
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
});
