import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventInput } from "@hobo/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRuntimeLocalEventStore } from "../../../runtimes/runtime-local/dist/eventstore/eventstore.js";
import { isJsonNumber, isJsonObject, type JsonBag } from "../../src/json.js";
import { nextEnvelope } from "../../src/replay/recorder.js";
import {
	createEventStoreReader,
	createInMemoryEventStore,
	type EventStoreWriter,
} from "../../src/replay/store.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

describe("workflow journal append ordering", () => {
	it("captures emitted data when the append is requested", async () => {
		const engine = createWorkflowEngine();
		const wf = defineWorkflow({
			name: "snapshot",
			async run(ctx) {
				const data = { value: 1, nested: { value: 1 } };
				const emitted = ctx.emit("app.Event", data);
				data.value = 2;
				data.nested.value = 2;
				await emitted;
			},
		});
		const result = await engine.start(wf, null);
		const event = (await engine.journal(result.runId)).find(
			(row) => row.type === "app.Event",
		);
		expect(event?.data).toEqual({ value: 1, nested: { value: 1 } });
	});

	it("blocks later effects if an event cannot be serialized", async () => {
		const engine = createWorkflowEngine();
		let effects = 0;
		const wf = defineWorkflow({
			name: "bad-payload",
			async run(ctx) {
				const cyclic: JsonBag = {};
				cyclic.self = cyclic;
				await Promise.allSettled([
					ctx.emit("app.Event", cyclic),
					ctx.step("after", () => {
						effects++;
					}),
				]);
			},
		});
		await expect(
			engine.start(wf, null, { runId: "bad-payload" }),
		).rejects.toThrow(/circular/i);
		expect(effects).toBe(0);
		expect(
			(await engine.journal("bad-payload")).map((event) => event.type),
		).toEqual(["run.Started"]);
	});
	it.each([
		Number.MAX_SAFE_INTEGER,
		Number.MAX_SAFE_INTEGER + 1,
		-1,
	])("refuses to append past an exhausted or invalid sequence %s", async (head) => {
		const stream = "run/sequence-limit";
		const start = nextEnvelope(stream, head, "run.Started", {
			args: null,
			workflowName: "sequence-limit",
		});
		const base = createInMemoryEventStore();
		let appendCalls = 0;
		const store = {
			...base,
			async readStream() {
				return [start];
			},
			async append() {
				appendCalls++;
			},
		};
		let effects = 0;
		const wf = defineWorkflow({
			name: "sequence-limit",
			async run(ctx) {
				await ctx.step("effect", () => {
					effects++;
				});
			},
		});
		await expect(
			createWorkflowEngine({ store }).resume(wf, "sequence-limit", null),
		).rejects.toThrow(/sequence/);
		expect(appendCalls).toBe(0);
		expect(effects).toBe(0);
	});
	it("serializes parallel step scheduling before invoking either effect", async () => {
		const store = createInMemoryEventStore();
		let releaseFirst: (() => void) | undefined;
		let enteredFirst: (() => void) | undefined;
		const firstEntered = new Promise<void>((resolve) => {
			enteredFirst = resolve;
		});
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstReleased = false;
		let secondEnteredEarly = false;
		const delayed = {
			...store,
			async append(
				event: Parameters<typeof store.append>[0],
				expectedSeq?: number,
			) {
				if (event.type === "run.StepScheduled" && isJsonObject(event.data)) {
					if (event.data.index === 0) {
						enteredFirst?.();
						await firstGate;
					} else if (event.data.index === 1 && !firstReleased) {
						secondEnteredEarly = true;
					}
				}
				return store.append(event, expectedSeq);
			},
		};
		const effects: string[] = [];
		const wf = defineWorkflow({
			name: "parallel",
			async run(ctx) {
				return Promise.all([
					ctx.step("first", () => {
						effects.push("first");
						return 1;
					}),
					ctx.step("second", () => {
						effects.push("second");
						return 2;
					}),
				]);
			},
		});
		const engine = createWorkflowEngine({ store: delayed });
		const run = engine.start(wf, null, { runId: "parallel" });
		void run.catch(() => undefined);
		await firstEntered;
		await new Promise<void>((resolve) => setImmediate(resolve));
		firstReleased = true;
		releaseFirst?.();
		await expect(run).resolves.toMatchObject({
			status: "completed",
			result: [1, 2],
		});
		expect(secondEnteredEarly).toBe(false);
		expect(effects.sort()).toEqual(["first", "second"]);
		const events = await store.readStream("run/parallel");
		expect(events.map((event) => event.seq)).toEqual(
			events.map((_, index) => index + 1),
		);
	});

	it.each([
		false,
		true,
	])("stops new effects after a failed append (committed: %s)", async (committed) => {
		const store = createInMemoryEventStore();
		let failed = false;
		const unreliable = {
			...store,
			async append(
				event: Parameters<typeof store.append>[0],
				expectedSeq?: number,
			) {
				if (event.type === "run.StepScheduled" && !failed) {
					failed = true;
					if (committed) await store.append(event, expectedSeq);
					throw new Error("append result is uncertain");
				}
				return store.append(event, expectedSeq);
			},
		};
		let effects = 0;
		const wf = defineWorkflow({
			name: "uncertain-append",
			async run(ctx) {
				await Promise.allSettled([
					ctx.step("first", () => {
						effects++;
					}),
					ctx.step("second", () => {
						effects++;
					}),
				]);
				return "done";
			},
		});
		const engine = createWorkflowEngine({ store: unreliable });
		await expect(
			engine.start(wf, null, { runId: "uncertain" }),
		).rejects.toThrow("append result is uncertain");
		expect(effects).toBe(0);
		const events = await store.readStream("run/uncertain");
		expect(events.map((event) => event.type)).toEqual(
			committed ? ["run.Started", "run.StepScheduled"] : ["run.Started"],
		);
		const resumed = await createWorkflowEngine({ store }).resume(
			wf,
			"uncertain",
			null,
		);
		expect(resumed.status).toBe("completed");
		expect(effects).toBe(2);
	});

	it("preserves contiguous journals under generated asynchronous append delays", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.integer({ min: 0, max: 5 }), {
					minLength: 2,
					maxLength: 7,
				}),
				async (delays) => {
					const store = createInMemoryEventStore();
					const asynchronous = {
						...store,
						async append(
							event: Parameters<typeof store.append>[0],
							expectedSeq?: number,
						) {
							if (
								event.type === "run.StepScheduled" &&
								isJsonObject(event.data) &&
								isJsonNumber(event.data.index)
							) {
								for (let i = 0; i < (delays[event.data.index] ?? 0); i++)
									await Promise.resolve();
							}
							return store.append(event, expectedSeq);
						},
					};
					const wf = defineWorkflow({
						name: "generated-parallel",
						async run(ctx) {
							return Promise.all(
								delays.map((_, index) =>
									ctx.step(`step-${index}`, () => index),
								),
							);
						},
					});
					const result = await createWorkflowEngine({
						store: asynchronous,
					}).start(wf, null, { runId: "generated" });
					expect(result.result).toEqual(delays.map((_, index) => index));
					const events = await store.readStream("run/generated");
					expect(events.map((event) => event.seq)).toEqual(
						events.map((_, index) => index + 1),
					);
				},
			),
			{ seed: 614460, numRuns: 100 },
		);
	});

	it("persists concurrent steps in order in a reopened SQLite journal", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-workflow-append-"));
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
						actor: { kind: "system", id: "append-test" },
						tenant: "append-test",
					});
				},
			};
			const wf = defineWorkflow({
				name: "sqlite-parallel",
				async run(ctx) {
					return Promise.all([ctx.step("a", () => 1), ctx.step("b", () => 2)]);
				},
			});
			const result = await createWorkflowEngine({ store: writer }).start(
				wf,
				null,
				{ runId: "sqlite" },
			);
			expect(result.result).toEqual([1, 2]);
			durable.close();
			durable = createRuntimeLocalEventStore({ dataDir: directory });
			const events =
				await createEventStoreReader(durable).readStream("run/sqlite");
			expect(events.map((event) => event.seq)).toEqual(
				events.map((_, index) => index + 1),
			);
			expect(events.at(-1)?.type).toBe("run.Completed");
		} finally {
			durable.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
