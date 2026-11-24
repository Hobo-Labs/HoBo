import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventInput } from "@hobo/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createRuntimeLocalEventStore } from "../../../runtimes/runtime-local/dist/eventstore/eventstore.js";
import { FatalError } from "../../src/errors.js";
import { isJsonObject } from "../../src/json.js";
import {
	createEventStoreReader,
	createInMemoryEventStore,
	type EventStoreWriter,
} from "../../src/replay/store.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

function failOneSchedule(
	store: ReturnType<typeof createInMemoryEventStore>,
	name: string,
) {
	let fail = true;
	return {
		...store,
		async append(event: Parameters<typeof store.append>[0], expected?: number) {
			if (
				fail &&
				event.type === "run.StepScheduled" &&
				isJsonObject(event.data) &&
				event.data.name === name
			) {
				fail = false;
				throw new Error(`stopped before ${name}`);
			}
			return store.append(event, expected);
		},
	};
}

describe("nested workflow resume", () => {
	it("recovers a completed nested parent after closing and reopening SQLite", async () => {
		const directory = mkdtempSync(join(tmpdir(), "hobo-nested-resume-"));
		let durable = createRuntimeLocalEventStore({ dataDir: directory });
		let fail = true;
		const writer: EventStoreWriter = {
			readStream: (streamId) =>
				createEventStoreReader(durable).readStream(streamId),
			readBySeq: (streamId, seq) =>
				createEventStoreReader(durable).readBySeq(streamId, seq),
			async append(event, expectedSeq) {
				if (
					event.type === "run.StepScheduled" &&
					isJsonObject(event.data) &&
					event.data.name === "later" &&
					fail
				) {
					fail = false;
					throw new Error("stopped before later");
				}
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
					actor: { kind: "system", id: "resume-test" },
					tenant: "resume-test",
				});
			},
		};
		let effects = 0;
		const wf = defineWorkflow({
			name: "sqlite-nested-resume",
			async run(ctx) {
				const first = await ctx.step("parent", () =>
					ctx.step("child", () => {
						effects++;
						return 3;
					}),
				);
				return first + (await ctx.step("later", () => 4));
			},
		});
		try {
			await expect(
				createWorkflowEngine({ store: writer }).start(wf, null, {
					runId: "sqlite-nested",
				}),
			).rejects.toThrow("stopped before later");
			durable.close();
			durable = createRuntimeLocalEventStore({ dataDir: directory });
			expect(
				(
					await createWorkflowEngine({ store: writer }).resume(
						wf,
						"sqlite-nested",
						null,
					)
				).result,
			).toBe(7);
			expect(effects).toBe(1);
		} finally {
			durable.close();
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("reuses a completed nested parent before later root work", async () => {
		const store = createInMemoryEventStore();
		let parentCalls = 0;
		let childCalls = 0;
		let laterCalls = 0;
		const wf = defineWorkflow({
			name: "completed-parent-resume",
			async run(ctx) {
				const first = await ctx.step("parent", async () => {
					parentCalls++;
					return ctx.step("child", () => {
						childCalls++;
						return 3;
					});
				});
				return (
					first +
					(await ctx.step("later", () => {
						laterCalls++;
						return 4;
					}))
				);
			},
		});
		await expect(
			createWorkflowEngine({ store: failOneSchedule(store, "later") }).start(
				wf,
				null,
				{ runId: "completed-parent" },
			),
		).rejects.toThrow("stopped before later");
		const result = await createWorkflowEngine({ store }).resume(
			wf,
			"completed-parent",
			null,
		);
		expect(result.result).toBe(7);
		expect([parentCalls, childCalls, laterCalls]).toEqual([1, 1, 1]);
	});

	it("reuses completed children when a parent was interrupted", async () => {
		const store = createInMemoryEventStore();
		let parentCalls = 0;
		let firstCalls = 0;
		let secondCalls = 0;
		const wf = defineWorkflow({
			name: "partial-parent-resume",
			run(ctx) {
				return ctx.step("parent", async () => {
					parentCalls++;
					const first = await ctx.step("first", () => {
						firstCalls++;
						return 3;
					});
					const second = await ctx.step("second", () => {
						secondCalls++;
						return 4;
					});
					return first + second;
				});
			},
		});
		await expect(
			createWorkflowEngine({ store: failOneSchedule(store, "second") }).start(
				wf,
				null,
				{ runId: "partial-parent" },
			),
		).rejects.toThrow("stopped before second");
		const result = await createWorkflowEngine({ store }).resume(
			wf,
			"partial-parent",
			null,
		);
		expect(result.result).toBe(7);
		expect([parentCalls, firstCalls, secondCalls]).toEqual([2, 1, 1]);
	});

	it("recovers separate sibling scopes with equally named children", async () => {
		const store = createInMemoryEventStore();
		const effects = { left: 0, right: 0 };
		const wf = defineWorkflow({
			name: "separate-sibling-scopes",
			async run(ctx) {
				return Promise.all([
					ctx.step("left", () =>
						ctx.step("same", () => {
							effects.left++;
							return "left";
						}),
					),
					ctx.step("right", async () => {
						const first = await ctx.step("same", () => {
							effects.right++;
							return "right";
						});
						await ctx.step("second", () => undefined);
						return first;
					}),
				]);
			},
		});
		await expect(
			createWorkflowEngine({ store: failOneSchedule(store, "second") }).start(
				wf,
				null,
				{ runId: "separate-siblings" },
			),
		).rejects.toThrow("stopped before second");
		expect(
			(
				await createWorkflowEngine({ store }).resume(
					wf,
					"separate-siblings",
					null,
				)
			).result,
		).toEqual(["left", "right"]);
		expect(effects).toEqual({ left: 1, right: 1 });
	});

	it("reuses an already completed nested sleep after interruption", async () => {
		const store = createInMemoryEventStore();
		const wf = defineWorkflow({
			name: "nested-sleep-resume",
			run(ctx) {
				return ctx.step("parent", async () => {
					await ctx.sleep(0);
					return ctx.step("later", () => "done");
				});
			},
		});
		await expect(
			createWorkflowEngine({ store: failOneSchedule(store, "later") }).start(
				wf,
				null,
				{ runId: "nested-sleep" },
			),
		).rejects.toThrow("stopped before later");
		const engine = createWorkflowEngine({ store });
		expect((await engine.resume(wf, "nested-sleep", null)).result).toBe("done");
		const events = await engine.journal("nested-sleep");
		expect(
			events.filter((event) => event.type === "run.SleepScheduled"),
		).toHaveLength(1);
		expect(
			events.filter((event) => event.type === "run.SleepCompleted"),
		).toHaveLength(1);
	});

	it("replays a recorded step failure without rerunning its effect", async () => {
		const store = createInMemoryEventStore();
		let failures = 0;
		const wf = defineWorkflow({
			name: "memoized-step-failure",
			async run(ctx) {
				try {
					await ctx.step("declined", () => {
						failures++;
						throw new FatalError("declined");
					});
				} catch {
					return ctx.step("later", () => "handled");
				}
				return "unexpected";
			},
		});
		await expect(
			createWorkflowEngine({ store: failOneSchedule(store, "later") }).start(
				wf,
				null,
				{ runId: "failed-step" },
			),
		).rejects.toThrow("stopped before later");
		expect(
			(await createWorkflowEngine({ store }).resume(wf, "failed-step", null))
				.result,
		).toBe("handled");
		expect(failures).toBe(1);
	});

	it("rejects a shortened interrupted parent history", async () => {
		const store = createInMemoryEventStore();
		const original = defineWorkflow({
			name: "shortened-nested",
			run(ctx) {
				return ctx.step("parent", async () => {
					await ctx.step("first", () => 1);
					return ctx.step("later", () => 2);
				});
			},
		});
		await expect(
			createWorkflowEngine({ store: failOneSchedule(store, "later") }).start(
				original,
				null,
				{ runId: "shortened-nested" },
			),
		).rejects.toThrow("stopped before later");
		const changed = defineWorkflow({
			name: original.name,
			run(ctx) {
				return ctx.step("parent", () => 2);
			},
		});
		await expect(
			createWorkflowEngine({ store }).resume(changed, "shortened-nested", null),
		).rejects.toThrow(/unconsumed|diverged/i);
	});

	it("does not allow a caught history divergence to become a terminal result", async () => {
		const store = createInMemoryEventStore();
		const original = defineWorkflow({
			name: "caught-nested-divergence",
			run(ctx) {
				return ctx.step("parent", async () => {
					await ctx.step("first", () => 1);
					return ctx.step("later", () => 2);
				});
			},
		});
		await expect(
			createWorkflowEngine({ store: failOneSchedule(store, "later") }).start(
				original,
				null,
				{ runId: "caught-divergence" },
			),
		).rejects.toThrow("stopped before later");
		let effects = 0;
		const changed = defineWorkflow({
			name: original.name,
			async run(ctx) {
				try {
					await ctx.step("parent", () => ctx.step("changed", () => ++effects));
				} catch {
					return "swallowed";
				}
				return "unexpected";
			},
		});
		const engine = createWorkflowEngine({ store });
		await expect(
			engine.resume(changed, "caught-divergence", null),
		).rejects.toThrow(/diverged/i);
		expect(effects).toBe(0);
		const events = await engine.journal("caught-divergence");
		expect(
			events.some(
				(event) =>
					event.type === "run.Completed" || event.type === "run.Failed",
			),
		).toBe(false);
	});

	it("reuses a completed child across retries of its parent", async () => {
		let attempts = 0;
		let effects = 0;
		const wf = defineWorkflow({
			name: "parent-retry-child",
			run(ctx) {
				return ctx.step("parent", async () => {
					const result = await ctx.step("child", () => {
						effects++;
						return 3;
					});
					if (++attempts === 1) throw new Error("retry parent");
					return result;
				});
			},
		});
		expect((await createWorkflowEngine().start(wf, null)).result).toBe(3);
		expect([attempts, effects]).toEqual([2, 1]);
	});

	it("recovers interleaved completed sibling trees before later root work", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 0, max: 4 }),
				fc.integer({ min: 0, max: 4 }),
				async (leftDelay, rightDelay) => {
					const store = createInMemoryEventStore();
					let childEffects = 0;
					const wf = defineWorkflow({
						name: "sibling-resume",
						async run(ctx) {
							const sibling = (name: string, delay: number) =>
								ctx.step(name, async () => {
									for (let i = 0; i < delay; i++) await Promise.resolve();
									return ctx.step(`${name}-child`, () => {
										childEffects++;
										return name;
									});
								});
							const values = await Promise.all([
								sibling("left", leftDelay),
								sibling("right", rightDelay),
							]);
							await ctx.step("later", () => "done");
							return values;
						},
					});
					await expect(
						createWorkflowEngine({
							store: failOneSchedule(store, "later"),
						}).start(wf, null, { runId: "siblings" }),
					).rejects.toThrow("stopped before later");
					expect(
						(await createWorkflowEngine({ store }).resume(wf, "siblings", null))
							.result,
					).toEqual(["left", "right"]);
					expect(childEffects).toBe(2);
				},
			),
			{ seed: 614465, numRuns: 100 },
		);
	});
});
