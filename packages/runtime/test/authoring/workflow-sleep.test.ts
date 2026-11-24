import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventInput } from "@hobo/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRuntimeLocalEventStore } from "../../../runtimes/runtime-local/dist/eventstore/eventstore.js";
import { isJsonNumber, isJsonObject } from "../../src/json.js";
import { nextEnvelope } from "../../src/replay/recorder.js";
import {
	createEventStoreReader,
	createInMemoryEventStore,
	type EventStoreWriter,
} from "../../src/replay/store.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

describe("workflow sleep deadlines", () => {
	it("waits for a real default-clock deadline", async () => {
		let effectAt = 0;
		const before = Date.now();
		const wf = defineWorkflow({
			name: "real-timer",
			async run(ctx) {
				await ctx.sleep(20);
				effectAt = Date.now();
			},
		});
		await createWorkflowEngine().start(wf, null);
		expect(effectAt - before).toBeGreaterThanOrEqual(20);
	});

	it("does not continue on an early wake-up", async () => {
		let now = 1_000;
		let effects = 0;
		const pending: Array<{ delay: number; resolve: () => void }> = [];
		const engine = createWorkflowEngine({
			clock: { now: () => new Date(now).toISOString(), nowMs: () => now },
			wait: (delay) =>
				new Promise<void>((resolve) => pending.push({ delay, resolve })),
		});
		const wf = defineWorkflow({
			name: "wait-for-deadline",
			async run(ctx) {
				await ctx.sleep(10);
				effects++;
			},
		});
		const run = engine.start(wf, null);
		async function nextWait() {
			for (let i = 0; i < 100 && pending.length === 0; i++)
				await Promise.resolve();
			const next = pending.shift();
			if (!next) throw new Error("sleep did not wait for its deadline");
			return next;
		}
		const first = await nextWait();
		expect(first.delay).toBe(10);
		expect(effects).toBe(0);
		now += 9;
		first.resolve();
		const early = await nextWait();
		expect(early.delay).toBe(1);
		expect(effects).toBe(0);
		now += 1;
		early.resolve();
		expect((await run).status).toBe("completed");
		expect(effects).toBe(1);
	});

	it("retains the original deadline across a crash and explicit resume", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 10_000 }),
				fc.integer({ min: 0, max: 20_000 }),
				async (delay, elapsed) => {
					let now = 1_000;
					let effectAt = -1;
					const clock = {
						now: () => new Date(now).toISOString(),
						nowMs: () => now,
					};
					const wf = defineWorkflow({
						name: "restart-timer",
						async run(ctx) {
							await ctx.sleep(delay);
							effectAt = now;
						},
					});
					const first = createWorkflowEngine({
						clock,
						wait: async () => {
							throw new Error("host stopped");
						},
					});
					await expect(
						first.start(wf, null, { runId: "timer" }),
					).rejects.toThrow("host stopped");
					now += elapsed;
					const waits: number[] = [];
					const resumed = createWorkflowEngine({
						store: first.store,
						clock,
						wait: async (remaining) => {
							waits.push(remaining);
							now += remaining;
						},
					});
					expect((await resumed.resume(wf, "timer", null)).status).toBe(
						"completed",
					);
					expect(effectAt).toBeGreaterThanOrEqual(1_000 + delay);
					expect(waits.reduce((sum, value) => sum + value, 0)).toBe(
						Math.max(0, delay - elapsed),
					);
					const journal = await resumed.journal("timer");
					expect(
						journal.filter((event) => event.type === "run.SleepScheduled"),
					).toHaveLength(1);
					const completions = journal.filter(
						(event) => event.type === "run.SleepCompleted",
					);
					expect(completions).toHaveLength(1);
					const completion = completions[0];
					if (
						!completion ||
						!isJsonObject(completion.data) ||
						!isJsonNumber(completion.data.completedAtMs)
					) {
						throw new Error("missing sleep completion timestamp");
					}
					expect(completion.data.completedAtMs).toBeGreaterThanOrEqual(
						1_000 + delay,
					);
				},
			),
			{ seed: 614458, numRuns: 150 },
		);
	});

	it("rebases an old unbounded sleep once and keeps that deadline on restart", async () => {
		let now = 1_000;
		const store = createInMemoryEventStore();
		const stream = "run/legacy-timer";
		await store.append(
			nextEnvelope(stream, 1, "run.Started", {
				args: null,
				seed: "s",
				workflowName: "legacy",
			}),
			0,
		);
		await store.append(
			nextEnvelope(stream, 2, "run.SleepScheduled", { index: 0, delayMs: 10 }),
			1,
		);
		const clock = { now: () => new Date(now).toISOString(), nowMs: () => now };
		const wf = defineWorkflow({
			name: "legacy",
			async run(ctx) {
				await ctx.sleep(10);
				return now;
			},
		});
		const first = createWorkflowEngine({
			store,
			clock,
			wait: async () => {
				throw new Error("host stopped");
			},
		});
		await expect(first.resume(wf, "legacy-timer", null)).rejects.toThrow(
			"host stopped",
		);
		now += 4;
		const waits: number[] = [];
		const resumed = createWorkflowEngine({
			store,
			clock,
			wait: async (delay) => {
				waits.push(delay);
				now += delay;
			},
		});
		expect((await resumed.resume(wf, "legacy-timer", null)).result).toBe(1_010);
		expect(waits).toEqual([6]);
		const journal = await resumed.journal("legacy-timer");
		expect(
			journal.filter((event) => event.type === "run.SleepDeadlineSet"),
		).toHaveLength(1);
	});

	it("uses the persisted deadline after reopening a SQLite journal", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-workflow-sleep-"));
		let now = 1_000;
		const clock = { now: () => new Date(now).toISOString(), nowMs: () => now };
		const wf = defineWorkflow({
			name: "sqlite-timer",
			async run(ctx) {
				await ctx.sleep(10);
				return now;
			},
		});
		function open() {
			const durable = createRuntimeLocalEventStore({ dataDir: directory });
			const writer: EventStoreWriter = {
				...createEventStoreReader(durable),
				async append(event, expectedSeq) {
					if (expectedSeq === undefined)
						throw new Error("expected sequence required");
					const input: EventInput = {
						type: event.type,
						v: event.v,
						data: event.data,
					};
					if (event.meta !== undefined) input.meta = event.meta;
					await durable.append(event.streamId, [input], {
						expectedSeq,
						actor: { kind: "system", id: "timer-test" },
						tenant: "timer-test",
					});
				},
			};
			return { durable, writer };
		}
		let opened = open();
		try {
			const first = createWorkflowEngine({
				store: opened.writer,
				clock,
				wait: async () => {
					throw new Error("host stopped");
				},
			});
			await expect(first.start(wf, null, { runId: "sqlite" })).rejects.toThrow(
				"host stopped",
			);
			opened.durable.close();
			now += 4;
			opened = open();
			const waits: number[] = [];
			const restarted = createWorkflowEngine({
				store: opened.writer,
				clock,
				wait: async (delay) => {
					waits.push(delay);
					now += delay;
				},
			});
			expect((await restarted.resume(wf, "sqlite", null)).result).toBe(1_010);
			expect(waits).toEqual([6]);
		} finally {
			opened.durable.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("rejects a corrupted recorded deadline rather than waking early", async () => {
		const store = createInMemoryEventStore();
		const stream = "run/bad-deadline";
		await store.append(
			nextEnvelope(stream, 1, "run.Started", {
				args: null,
				seed: "s",
				workflowName: "bad",
			}),
			0,
		);
		await store.append(
			nextEnvelope(stream, 2, "run.SleepScheduled", {
				index: 0,
				delayMs: 10,
				scheduledAtMs: 1_000,
				deadlineMs: 1_001,
			}),
			1,
		);
		let effects = 0;
		const wf = defineWorkflow({
			name: "bad",
			async run(ctx) {
				await ctx.sleep(10);
				effects++;
			},
		});
		const engine = createWorkflowEngine({
			store,
			clock: { now: () => new Date(1_001).toISOString(), nowMs: () => 1_001 },
		});
		await expect(engine.resume(wf, "bad-deadline", null)).rejects.toThrow(
			/invalid recorded workflow sleep deadline/,
		);
		expect(effects).toBe(0);
	});

	it("splits waits longer than the Node timer limit", async () => {
		let now = 0;
		const waits: number[] = [];
		const engine = createWorkflowEngine({
			clock: { now: () => new Date(now).toISOString(), nowMs: () => now },
			wait: async (delay) => {
				waits.push(delay);
				now += delay;
			},
		});
		const wf = defineWorkflow({
			name: "long-timer",
			async run(ctx) {
				await ctx.sleep(2_147_483_648);
			},
		});
		await engine.start(wf, null);
		expect(waits).toEqual([2_147_483_647, 1]);
	});

	it.each([
		-1,
		0.5,
		Number.POSITIVE_INFINITY,
		Number.NaN,
		Number.MAX_SAFE_INTEGER,
	])("rejects invalid or overflowing delay %s before recording a sleep", async (delay) => {
		const engine = createWorkflowEngine();
		const wf = defineWorkflow({
			name: "invalid-sleep",
			async run(ctx) {
				await ctx.sleep(delay);
			},
		});
		await expect(engine.start(wf, null, { runId: "invalid" })).rejects.toThrow(
			/sleep|deadline/i,
		);
		expect(
			(await engine.journal("invalid")).some(
				(event) => event.type === "run.SleepScheduled",
			),
		).toBe(false);
	});
});
