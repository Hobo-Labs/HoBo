import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventInput } from "@hobo/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRuntimeLocalEventStore } from "../../../runtimes/runtime-local/dist/eventstore/eventstore.js";
import { FatalError } from "../../src/errors.js";
import { isJsonObject } from "../../src/json.js";
import { replayRun } from "../../src/replay/replayer.js";
import {
	createEventStoreReader,
	type EventStoreWriter,
} from "../../src/replay/store.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

describe("nested workflow replay", () => {
	it("replays nested steps after reopening a SQLite journal", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-tree-replay-"));
		let durable = createRuntimeLocalEventStore({ dataDir: directory });
		try {
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
						actor: { kind: "system", id: "tree-test" },
						tenant: "tree-test",
					});
				},
			};
			let effects = 0;
			const wf = defineWorkflow({
				name: "sqlite-tree",
				async run(ctx) {
					const nested = await ctx.step("parent", () =>
						ctx.step("child", () => {
							effects++;
							return 1;
						}),
					);
					return (
						nested +
						(await ctx.step("after", () => {
							effects++;
							return 2;
						}))
					);
				},
			});
			const engine = createWorkflowEngine({ store: writer });
			const live = await engine.start(wf, null, { runId: "sqlite-tree" });
			durable.close();
			durable = createRuntimeLocalEventStore({ dataDir: directory });
			const replay = await replayRun(
				createEventStoreReader(durable),
				live.runId,
				engine.toReplayDefinition(wf),
				null,
			);
			expect(replay.state).toBe(3);
			expect(effects).toBe(2);
		} finally {
			durable.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reuses completed nested steps without confusing later root steps", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 0, max: 4 }),
				fc.integer({ min: 0, max: 4 }),
				async (leftDelay, rightDelay) => {
					const engine = createWorkflowEngine();
					let effects = 0;
					const wf = defineWorkflow({
						name: "nested-replay",
						async run(ctx) {
							const parent = (name: string, delay: number) =>
								ctx.step(name, async () => {
									for (let i = 0; i < delay; i++) await Promise.resolve();
									return ctx.step(`${name}-child`, () => {
										effects++;
										return name;
									});
								});
							const values = await Promise.all([
								parent("left", leftDelay),
								parent("right", rightDelay),
							]);
							const last = await ctx.step("after", () => {
								effects++;
								return "after";
							});
							return [...values, last];
						},
					});
					const live = await engine.start(wf, null);
					expect(effects).toBe(3);
					const replay = await replayRun(
						engine.store,
						live.runId,
						engine.toReplayDefinition(wf),
						null,
					);
					expect(replay.state).toEqual(live.result);
					expect(effects).toBe(3);
				},
			),
			{ seed: 614462, numRuns: 100 },
		);
	});

	it("refuses a parent completion whose child lacks a terminal fact", async () => {
		const engine = createWorkflowEngine();
		const wf = defineWorkflow({
			name: "missing-child",
			async run(ctx) {
				return ctx.step("parent", () => ctx.step("child", () => 1));
			},
		});
		const live = await engine.start(wf, null);
		const events = await engine.store.readStream(`run/${live.runId}`);
		const incomplete = events.filter(
			(event) =>
				event.type !== "run.StepCompleted" ||
				!isJsonObject(event.data) ||
				event.data.name !== "child",
		);
		await expect(
			replayRun(
				{ ...engine.store, readStream: async () => incomplete },
				live.runId,
				engine.toReplayDefinition(wf),
				null,
			),
		).rejects.toThrow(/nested.*(unfinished|terminal|complete)/i);
	});

	it("replays a parent that handled a terminal child failure", async () => {
		const engine = createWorkflowEngine();
		const wf = defineWorkflow({
			name: "handled-child",
			async run(ctx) {
				return ctx.step("parent", async () => {
					try {
						await ctx.step("child", () => {
							throw new FatalError("declined");
						});
					} catch {
						return "handled";
					}
					return "unexpected";
				});
			},
		});
		const live = await engine.start(wf, null);
		const replay = await replayRun(
			engine.store,
			live.runId,
			engine.toReplayDefinition(wf),
			null,
		);
		expect(replay.state).toBe("handled");
	});

	it("refuses a child associated with an unknown parent", async () => {
		const engine = createWorkflowEngine();
		const wf = defineWorkflow({
			name: "bad-parent",
			async run(ctx) {
				return ctx.step("parent", () => ctx.step("child", () => 1));
			},
		});
		const live = await engine.start(wf, null);
		const events = await engine.store.readStream(`run/${live.runId}`);
		const corrupted = events.map((event) => {
			if (
				event.type !== "run.StepScheduled" ||
				!isJsonObject(event.data) ||
				event.data.name !== "child"
			)
				return event;
			return { ...event, data: { ...event.data, parentStepIndex: 999 } };
		});
		await expect(
			replayRun(
				{ ...engine.store, readStream: async () => corrupted },
				live.runId,
				engine.toReplayDefinition(wf),
				null,
			),
		).rejects.toThrow(/parent.*not active/);
	});

	it("refuses a child scheduled after its parent completed", async () => {
		const engine = createWorkflowEngine();
		const wf = defineWorkflow({
			name: "late-child",
			async run(ctx) {
				return ctx.step("parent", () => ctx.step("child", () => 1));
			},
		});
		const live = await engine.start(wf, null);
		const events = await engine.store.readStream(`run/${live.runId}`);
		const parentDone = events.find(
			(event) =>
				event.type === "run.StepCompleted" &&
				isJsonObject(event.data) &&
				event.data.name === "parent",
		);
		if (!parentDone) throw new Error("missing parent completion");
		const reordered = events.filter((event) => event !== parentDone);
		reordered.splice(2, 0, parentDone);
		const corrupted = reordered.map((event, index) => ({
			...event,
			seq: index + 1,
		}));
		await expect(
			replayRun(
				{ ...engine.store, readStream: async () => corrupted },
				live.runId,
				engine.toReplayDefinition(wf),
				null,
			),
		).rejects.toThrow(/parent.*not active/);
	});

	it("refuses nested sleeps whose completion was never journaled", async () => {
		const engine = createWorkflowEngine();
		const wf = defineWorkflow({
			name: "nested-sleep",
			async run(ctx) {
				return ctx.step("parent", async () => {
					await ctx.sleep(0);
					return "done";
				});
			},
		});
		const live = await engine.start(wf, null);
		const events = await engine.store.readStream(`run/${live.runId}`);
		const legacy = events
			.filter((event) => event.type !== "run.SleepCompleted")
			.map((event) => {
				if (event.type !== "run.Started" || !isJsonObject(event.data))
					return event;
				return { ...event, data: { ...event.data, commandTreeVersion: 1 } };
			});
		await expect(
			replayRun(
				{ ...engine.store, readStream: async () => legacy },
				live.runId,
				engine.toReplayDefinition(wf),
				null,
			),
		).rejects.toThrow(/nested sleep.*completion/i);
	});
});
