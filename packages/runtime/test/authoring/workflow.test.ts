import { describe, expect, it } from "vitest";
import { isJsonNumber, isJsonObject } from "../../src/json.js";

import { replayRun } from "../../src/replay/replayer.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

interface OrderState {
	reserved: boolean;
	charged: boolean;
	confirmedAt: string;
}

describe("durable workflow: journal, restart, replay", () => {
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

		await expect(engine.start(checkout, { id: "order-1" })).rejects.toThrow(
			"SIMULATED_HOST_CRASH",
		);
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
});
