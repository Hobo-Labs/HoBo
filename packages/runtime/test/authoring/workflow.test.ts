import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventInput } from "@hobo/core";
import { describe, expect, it } from "vitest";
import { createRuntimeLocalEventStore } from "../../../runtimes/runtime-local/dist/index.js";
import { isJsonNumber, isJsonObject } from "../../src/json.js";
import { replayRun } from "../../src/replay/replayer.js";
import {
	createEventStoreReader,
	type EventStoreWriter,
} from "../../src/replay/store.js";
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

		const restarted = createWorkflowEngine({ store: engine.store });
		const handle = await restarted.resume(checkout, "run-1", { id: "order-1" });

		expect(handle.status).toBe("completed");
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

describe("workflow run identity", () => {
	it("does not reuse a journal after an engine restart", async () => {
		const workflow = defineWorkflow<string, string>({
			name: "echo",
			run: (ctx, value) => ctx.step("echo", () => value),
		});
		const firstEngine = createWorkflowEngine();
		const first = await firstEngine.start(workflow, "first");
		const restarted = createWorkflowEngine({ store: firstEngine.store });
		const second = await restarted.start(workflow, "second");
		expect(first.runId).not.toBe(second.runId);
		expect(first.result).toBe("first");
		expect(second.result).toBe("second");
		expect(
			(await restarted.journal(first.runId)).filter(
				(event) => event.type === "run.Started",
			),
		).toHaveLength(1);
		expect(
			(await restarted.journal(second.runId)).filter(
				(event) => event.type === "run.Started",
			),
		).toHaveLength(1);
	});

	it("atomically reserves an explicit run id across engines", async () => {
		let calls = 0;
		const workflow = defineWorkflow<string, string>({
			name: "echo",
			run: (ctx, value) =>
				ctx.step("echo", () => {
					calls += 1;
					return value;
				}),
		});
		const first = createWorkflowEngine();
		const second = createWorkflowEngine({ store: first.store });
		const results = await Promise.allSettled([
			first.start(workflow, "first", { runId: "shared" }),
			second.start(workflow, "second", { runId: "shared" }),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		expect(
			results.filter((result) => result.status === "rejected"),
		).toHaveLength(1);
		expect(calls).toBe(1);
		expect(
			(await first.journal("shared")).filter(
				(event) => event.type === "run.Started",
			),
		).toHaveLength(1);
	});

	it("reserves an explicit id against a durable store with idempotency", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "hobo-workflow-"));
		const storage = createRuntimeLocalEventStore({ dataDir });
		try {
			const store: EventStoreWriter = {
				...createEventStoreReader(storage),
				async append(event, expectedSeq) {
					if (expectedSeq === undefined)
						throw new Error("expected sequence required");
					const input: EventInput = {
						type: event.type,
						v: event.v ?? 1,
						data: event.data,
					};
					if (event.meta !== undefined) input.meta = event.meta;
					await storage.append(event.streamId, [input], {
						expectedSeq,
						tenant: "test",
						actor: { kind: "system", id: "test" },
					});
				},
			};
			let calls = 0;
			const workflow = defineWorkflow<string, string>({
				name: "echo",
				run: (ctx, input) =>
					ctx.step("echo", () => {
						calls += 1;
						return input;
					}),
			});
			const first = createWorkflowEngine({ store });
			const second = createWorkflowEngine({ store });
			const results = await Promise.allSettled([
				first.start(workflow, "same", { runId: "same" }),
				second.start(workflow, "same", { runId: "same" }),
			]);
			expect(
				results.filter((result) => result.status === "fulfilled"),
			).toHaveLength(1);
			expect(
				results.filter((result) => result.status === "rejected"),
			).toHaveLength(1);
			expect(calls).toBe(1);
		} finally {
			storage.close();
			rmSync(dataDir, { recursive: true, force: true });
		}
	});

	it("keeps the original seed and binds a resumed run to its definition and input", async () => {
		const observedSeeds: string[] = [];
		let crashed = false;
		const workflow = defineWorkflow<{ first: number; second: number }, string>({
			name: "seeded",
			async run(ctx) {
				observedSeeds.push(ctx.seed);
				if (!crashed) {
					crashed = true;
					throw new Error("host stopped");
				}
				return ctx.seed;
			},
		});
		const initial = createWorkflowEngine({ seed: "original" });
		await expect(
			initial.start(
				workflow,
				{ first: 1, second: 2 },
				{ runId: "recoverable" },
			),
		).rejects.toThrow("host stopped");
		const restarted = createWorkflowEngine({
			store: initial.store,
			seed: "different",
		});
		await expect(
			restarted.resume(workflow, "recoverable", { first: 2, second: 2 }),
		).rejects.toThrow("different input");
		await expect(
			restarted.resume({ ...workflow, name: "other" }, "recoverable", {
				first: 1,
				second: 2,
			}),
		).rejects.toThrow("another definition");
		const result = await restarted.resume(workflow, "recoverable", {
			second: 2,
			first: 1,
		});
		expect(result.result).toBe("original");
		expect(observedSeeds).toEqual(["original", "original"]);
	});

	it("accepts legacy journals and workflows without input", async () => {
		const engine = createWorkflowEngine();
		const workflow = defineWorkflow<undefined, string>({
			name: "legacy",
			run: (ctx) => ctx.seed,
		});
		const { nextEnvelope } = await import("../../src/replay/recorder.js");
		await engine.store.append(
			nextEnvelope("run/legacy", 1, "run.Started", { seed: "old-seed" }),
			0,
		);
		const resumed = await engine.resume(workflow, "legacy", undefined);
		const started = await engine.start(workflow, undefined);
		expect(resumed.result).toBe("old-seed");
		expect(started.status).toBe("completed");
	});

	it("initializes a preassigned id through resume for existing callers", async () => {
		const engine = createWorkflowEngine();
		const workflow = defineWorkflow<string, string>({
			name: "preassigned",
			run: (_ctx, input) => input,
		});
		const first = await engine.resume(workflow, "preassigned-id", "value");
		const second = await engine.resume(workflow, "preassigned-id", "value");
		expect(first).toEqual(second);
		expect(first.result).toBe("value");
		expect(
			(await engine.journal("preassigned-id")).map((event) => event.type),
		).toEqual(["run.Started", "run.Completed"]);
	});

	it("returns a completed result without executing or appending again", async () => {
		let invocations = 0;
		const engine = createWorkflowEngine();
		const workflow = defineWorkflow<string, string>({
			name: "once",
			run: (_ctx, input) => {
				invocations += 1;
				return input;
			},
		});
		const first = await engine.start(workflow, "value", { runId: "completed" });
		const journal = await engine.journal("completed");
		const repeated = await engine.resume(workflow, "completed", "value");
		expect(repeated).toEqual(first);
		expect(invocations).toBe(1);
		expect(await engine.journal("completed")).toEqual(journal);
	});

	it("rejects invalid run ids before creating a journal", async () => {
		const engine = createWorkflowEngine();
		const workflow = defineWorkflow<undefined, string>({
			name: "echo",
			run: () => "ok",
		});
		for (const runId of ["", " ", " run"]) {
			await expect(
				engine.start(workflow, undefined, { runId }),
			).rejects.toThrow("runId");
			await expect(engine.resume(workflow, runId, undefined)).rejects.toThrow(
				"runId",
			);
		}
	});
});
