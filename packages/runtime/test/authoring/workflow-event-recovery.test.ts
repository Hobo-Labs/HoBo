import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventInput } from "@hobo/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRuntimeLocalEventStore } from "../../../runtimes/runtime-local/dist/eventstore/eventstore.js";
import { nextEnvelope } from "../../src/replay/recorder.js";
import { replayRun } from "../../src/replay/replayer.js";
import {
	createEventStoreReader,
	createInMemoryEventStore,
	type EventStoreWriter,
} from "../../src/replay/store.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

describe("workflow event recovery", () => {
	it.each([
		false,
		true,
	])("recovers a lost event response without duplicating it (committed: %s)", async (committed) => {
		const store = createInMemoryEventStore();
		let fail = true;
		const unreliable = {
			...store,
			async append(
				event: Parameters<typeof store.append>[0],
				expected?: number,
			) {
				if (event.type === "app.Recorded" && fail) {
					fail = false;
					if (committed) await store.append(event, expected);
					throw new Error("event response lost");
				}
				return store.append(event, expected);
			},
		};
		let effects = 0;
		const wf = defineWorkflow({
			name: "lost-event-response",
			async run(ctx) {
				const seq = await ctx.emit("app.Recorded", { value: 7 });
				return ctx.step("after", () => {
					effects++;
					return seq;
				});
			},
		});
		await expect(
			createWorkflowEngine({ store: unreliable }).start(wf, null, {
				runId: "lost-event",
			}),
		).rejects.toThrow("event response lost");
		expect(effects).toBe(0);
		const engine = createWorkflowEngine({ store });
		expect((await engine.resume(wf, "lost-event", null)).result).toBe(2);
		expect(effects).toBe(1);
		const events = await store.readStream("run/lost-event");
		expect(
			events.filter((event) => event.type === "app.Recorded"),
		).toHaveLength(1);
	});

	it("reuses an event emitted by a parent across its retry", async () => {
		let attempts = 0;
		const wf = defineWorkflow({
			name: "retry-event",
			run(ctx) {
				return ctx.step("parent", async () => {
					const seq = await ctx.emit("app.Recorded", { value: 7 });
					if (++attempts === 1) throw new Error("retry parent");
					return seq;
				});
			},
		});
		const engine = createWorkflowEngine();
		const live = await engine.start(wf, null);
		expect(live.result).toBe(3);
		expect(attempts).toBe(2);
		expect(
			(await engine.journal(live.runId)).filter(
				(event) => event.type === "app.Recorded",
			),
		).toHaveLength(1);
	});

	it("replays recorded root events with their original sequence and payload", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.option(fc.integer(), { nil: null }),
				async (value) => {
					const engine = createWorkflowEngine();
					const wf = defineWorkflow({
						name: "replay-event",
						async run(ctx) {
							return ctx.emit(
								"app.Recorded",
								value === null ? null : { value },
							);
						},
					});
					const live = await engine.start(wf, null);
					const replay = await replayRun(
						engine.store,
						live.runId,
						engine.toReplayDefinition(wf),
						null,
					);
					expect(replay.state).toBe(live.result);
				},
			),
			{ seed: 614466, numRuns: 100 },
		);
	});

	it("replays interleaved root events and a completed parent containing an event", async () => {
		const engine = createWorkflowEngine();
		let effects = 0;
		const wf = defineWorkflow({
			name: "nested-event-replay",
			async run(ctx) {
				const first = await ctx.emit("app.First", { n: 1 });
				const parent = await ctx.step("parent", async () => {
					effects++;
					return ctx.emit("app.Nested", { n: 2 });
				});
				const last = await ctx.emit("app.Last", { n: 3 });
				return [first, parent, last];
			},
		});
		const live = await engine.start(wf, null);
		const replay = await replayRun(
			engine.store,
			live.runId,
			engine.toReplayDefinition(wf),
			null,
		);
		expect(replay.state).toEqual(live.result);
		expect(effects).toBe(1);
		const changed = defineWorkflow({
			name: wf.name,
			async run(ctx) {
				return ctx.emit("app.First", { n: 999 });
			},
		});
		await expect(
			replayRun(
				engine.store,
				live.runId,
				engine.toReplayDefinition(changed),
				null,
			),
		).rejects.toThrow(/diverged/i);
	});

	it("rejects changed event data even if the workflow catches divergence", async () => {
		const store = createInMemoryEventStore();
		let value = 1;
		let fail = true;
		const unreliable = {
			...store,
			async append(
				event: Parameters<typeof store.append>[0],
				expected?: number,
			) {
				if (event.type === "run.StepScheduled" && fail) {
					fail = false;
					throw new Error("stopped before step");
				}
				return store.append(event, expected);
			},
		};
		const wf = defineWorkflow({
			name: "changed-event",
			async run(ctx) {
				try {
					await ctx.emit("app.Recorded", { value });
				} catch {
					return "swallowed";
				}
				return ctx.step("after", () => "done");
			},
		});
		await expect(
			createWorkflowEngine({ store: unreliable }).start(wf, null, {
				runId: "changed-event",
			}),
		).rejects.toThrow("stopped before step");
		value = 2;
		const engine = createWorkflowEngine({ store });
		await expect(engine.resume(wf, "changed-event", null)).rejects.toThrow(
			/diverged/i,
		);
		const events = await store.readStream("run/changed-event");
		expect(
			events.filter((event) => event.type === "app.Recorded"),
		).toHaveLength(1);
		expect(
			events.some(
				(event) =>
					event.type === "run.Completed" || event.type === "run.Failed",
			),
		).toBe(false);
	});

	it("refuses a new-format event with missing command metadata", async () => {
		const engine = createWorkflowEngine();
		const wf = defineWorkflow({
			name: "missing-event-metadata",
			async run(ctx) {
				return ctx.emit("app.Recorded", { value: 1 });
			},
		});
		const live = await engine.start(wf, null);
		const events = await engine.store.readStream(`run/${live.runId}`);
		const damaged = events.map((event) =>
			event.type === "app.Recorded" ? { ...event, meta: undefined } : event,
		);
		await expect(
			createWorkflowEngine({
				store: { ...engine.store, readStream: async () => damaged },
			}).resume(wf, live.runId, null),
		).rejects.toThrow(/event.*metadata/i);
	});

	it("refuses an event assigned to an unknown parent", async () => {
		const engine = createWorkflowEngine();
		const wf = defineWorkflow({
			name: "bad-event-parent",
			async run(ctx) {
				return ctx.emit("app.Recorded", { value: 1 });
			},
		});
		const live = await engine.start(wf, null);
		const events = await engine.store.readStream(`run/${live.runId}`);
		const damaged = events.map((event) =>
			event.type === "app.Recorded"
				? {
						...event,
						meta: {
							...event.meta,
							workflowEmit: {
								index: 0,
								parentStepIndex: 999,
								nullPayload: false,
							},
						},
					}
				: event,
		);
		await expect(
			createWorkflowEngine({
				store: { ...engine.store, readStream: async () => damaged },
			}).resume(wf, live.runId, null),
		).rejects.toThrow(/parent.*active/i);
	});

	it("retains legacy version-two event behavior", async () => {
		const store = createInMemoryEventStore();
		await store.append(
			nextEnvelope("run/legacy-event", 1, "run.Started", {
				args: null,
				workflowName: "legacy-event",
				commandTreeVersion: 2,
			}),
			0,
		);
		await store.append(
			nextEnvelope("run/legacy-event", 2, "app.Recorded", { value: 1 }),
			1,
		);
		const wf = defineWorkflow({
			name: "legacy-event",
			async run(ctx) {
				return ctx.emit("app.Recorded", { value: 1 });
			},
		});
		const engine = createWorkflowEngine({ store });
		expect((await engine.resume(wf, "legacy-event", null)).result).toBe(3);
		expect(
			(await engine.journal("legacy-event")).filter(
				(event) => event.type === "app.Recorded",
			),
		).toHaveLength(2);
	});

	it.each([
		null,
		{ value: 1 },
	])("reuses event metadata after closing and reopening SQLite (payload: %s)", async (payload) => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-event-resume-"));
		let durable = createRuntimeLocalEventStore({ dataDir: directory });
		let fail = true;
		const writer: EventStoreWriter = {
			readStream: (streamId) =>
				createEventStoreReader(durable).readStream(streamId),
			readBySeq: (streamId, seq) =>
				createEventStoreReader(durable).readBySeq(streamId, seq),
			async append(event, expectedSeq) {
				const lostResponse = event.type === "app.Recorded" && fail;
				if (lostResponse) fail = false;
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
					actor: { kind: "system", id: "event-resume" },
					tenant: "event-resume",
				});
				if (lostResponse) throw new Error("event response lost");
			},
		};
		const wf = defineWorkflow({
			name: "sqlite-event-resume",
			async run(ctx) {
				const seq = await ctx.emit("app.Recorded", payload);
				return ctx.step("later", () => seq);
			},
		});
		try {
			await expect(
				createWorkflowEngine({ store: writer }).start(wf, null, {
					runId: "sqlite-event",
				}),
			).rejects.toThrow("event response lost");
			durable.close();
			durable = createRuntimeLocalEventStore({ dataDir: directory });
			const engine = createWorkflowEngine({ store: writer });
			expect((await engine.resume(wf, "sqlite-event", null)).result).toBe(2);
			expect(
				(await engine.journal("sqlite-event")).filter(
					(event) => event.type === "app.Recorded",
				),
			).toHaveLength(1);
		} finally {
			durable.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
