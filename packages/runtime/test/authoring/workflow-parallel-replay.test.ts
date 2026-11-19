import fc from "fast-check";
import { expect, it } from "vitest";
import { isJsonObject } from "../../src/json.js";
import { nextEnvelope } from "../../src/replay/recorder.js";
import { createInMemoryEventStore } from "../../src/replay/store.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

it("rejects a scheduled hole below a later completed parallel step", async () => {
	const base = createInMemoryEventStore();
	const laterRecorded = deferred();
	const releaseEarlier = deferred();
	const store = {
		...base,
		async append(event: Parameters<typeof base.append>[0], expected?: number) {
			await base.append(event, expected);
			if (
				event.type === "run.StepCompleted" &&
				isJsonObject(event.data) &&
				event.data.index === 1
			) {
				laterRecorded.resolve();
			}
		},
	};
	let earlierCalls = 0;
	let laterCalls = 0;
	const wf = defineWorkflow({
		name: "parallel-replay",
		async run(ctx) {
			return Promise.all([
				ctx.step("earlier", async () => {
					earlierCalls += 1;
					if (earlierCalls === 1) await releaseEarlier.promise;
					return "earlier";
				}),
				ctx.step("later", () => {
					laterCalls += 1;
					return "later";
				}),
			]);
		},
	});
	const running = createWorkflowEngine({ store }).start(wf, null, {
		runId: "parallel-replay",
	});
	await laterRecorded.promise;
	const saved = await base.readStream("run/parallel-replay");
	const recoveredStore = createInMemoryEventStore();
	for (const event of saved) {
		await recoveredStore.append(event, event.seq - 1);
	}
	releaseEarlier.resolve();
	await running;
	let unexpectedEffects = 0;
	const changed = defineWorkflow({
		name: "parallel-replay",
		async run(ctx) {
			try {
				await ctx.step("renamed", () => {
					unexpectedEffects += 1;
				});
			} catch {}
			try {
				await ctx.step("later", () => {
					unexpectedEffects += 1;
				});
			} catch {}
			try {
				await ctx.emit("app.Unexpected");
			} catch {}
			return "unexpected";
		},
	});
	await expect(
		createWorkflowEngine({ store: recoveredStore }).resume(
			changed,
			"parallel-replay",
			null,
		),
	).rejects.toThrow(/gapped step journal|invalid step journal/);
	expect(await recoveredStore.readStream("run/parallel-replay")).toEqual(saved);
	expect(unexpectedEffects).toBe(0);

	await expect(
		createWorkflowEngine({ store: recoveredStore }).resume(
			wf,
			"parallel-replay",
			null,
		),
	).rejects.toThrow(/gapped step journal|invalid step journal/);
	expect(await recoveredStore.readStream("run/parallel-replay")).toEqual(saved);
	expect(earlierCalls).toBe(1);
	expect(laterCalls).toBe(1);
});

it("replays generated scheduled gaps without repeating recorded effects", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(fc.boolean(), { minLength: 1, maxLength: 6 }),
			async (recorded) => {
				const store = createInMemoryEventStore();
				const stream = "run/generated-gaps";
				let seq = 0;
				const started = nextEnvelope(stream, ++seq, "run.Started", {
					args: null,
					seed: "seed",
					workflowName: "generated-gaps",
				});
				await store.append(started, seq - 1);
				for (const [index] of recorded.entries()) {
					const scheduled = nextEnvelope(stream, ++seq, "run.StepScheduled", {
						name: `step-${index}`,
						index,
					});
					await store.append(scheduled, seq - 1);
				}
				for (const [index, completed] of recorded.entries()) {
					if (!completed) continue;
					const event = nextEnvelope(stream, ++seq, "run.StepCompleted", {
						name: `step-${index}`,
						index,
						result: index,
					});
					await store.append(event, seq - 1);
				}
				const calls = recorded.map(() => 0);
				const wf = defineWorkflow({
					name: "generated-gaps",
					async run(ctx) {
						const values: number[] = [];
						for (const [index] of recorded.entries()) {
							values.push(
								await ctx.step(`step-${index}`, () => {
									calls[index] = (calls[index] ?? 0) + 1;
									return index;
								}),
							);
						}
						return values;
					},
				});
				const openAt = recorded.findIndex((completed) => !completed);
				const contiguous = openAt === -1 || openAt === recorded.length - 1;
				if (!contiguous) {
					await expect(
						createWorkflowEngine({ store }).resume(wf, "generated-gaps", null),
					).rejects.toThrow(/gapped step journal|invalid step journal/);
					expect(calls).toEqual(recorded.map(() => 0));
					return;
				}
				const result = await createWorkflowEngine({ store }).resume(
					wf,
					"generated-gaps",
					null,
				);
				expect(result.result).toEqual(recorded.map((_, index) => index));
				expect(calls).toEqual(recorded.map((completed) => (completed ? 0 : 1)));
			},
		),
		{ seed: 614451, numRuns: 100 },
	);
});

it("rejects inconsistent scheduled step names before running", async () => {
	const store = createInMemoryEventStore();
	const stream = "run/bad-schedules";
	await store.append(
		nextEnvelope(stream, 1, "run.Started", {
			args: null,
			seed: "seed",
			workflowName: "bad-schedules",
		}),
		0,
	);
	await store.append(
		nextEnvelope(stream, 2, "run.StepScheduled", {
			name: "first",
			index: 0,
		}),
		1,
	);
	await store.append(
		nextEnvelope(stream, 3, "run.StepScheduled", {
			name: "different",
			index: 0,
		}),
		2,
	);
	let effects = 0;
	const wf = defineWorkflow({
		name: "bad-schedules",
		run(ctx) {
			return ctx.step("first", () => {
				effects += 1;
			});
		},
	});
	await expect(
		createWorkflowEngine({ store }).resume(wf, "bad-schedules", null),
	).rejects.toThrow(/step name differs from journal/);
	expect(effects).toBe(0);
});

it.each([
	{ name: "first", index: "0" },
	{ name: "first", index: -1 },
	{ name: "first", index: 0.5 },
	{ name: 1, index: 0 },
	{ name: "first", index: 0, extra: true },
])("rejects malformed scheduled facts before running: %j", async (data) => {
	const store = createInMemoryEventStore();
	const stream = "run/bad-schedule";
	await store.append(
		nextEnvelope(stream, 1, "run.Started", {
			args: null,
			seed: "seed",
			workflowName: "bad-schedule",
		}),
		0,
	);
	await store.append(nextEnvelope(stream, 2, "run.StepScheduled", data), 1);
	let effects = 0;
	const wf = defineWorkflow({
		name: "bad-schedule",
		run(ctx) {
			return ctx.step("first", () => {
				effects += 1;
			});
		},
	});
	await expect(
		createWorkflowEngine({ store }).resume(wf, "bad-schedule", null),
	).rejects.toThrow(/invalid run.StepScheduled/);
	expect(effects).toBe(0);
});

it("rejects an outcome that disagrees with its scheduled name", async () => {
	const store = createInMemoryEventStore();
	const stream = "run/bad-outcome-name";
	await store.append(
		nextEnvelope(stream, 1, "run.Started", {
			args: null,
			seed: "seed",
			workflowName: "bad-outcome-name",
		}),
		0,
	);
	await store.append(
		nextEnvelope(stream, 2, "run.StepScheduled", {
			name: "first",
			index: 0,
		}),
		1,
	);
	await store.append(
		nextEnvelope(stream, 3, "run.StepCompleted", {
			name: "different",
			index: 0,
			result: "wrong",
		}),
		2,
	);
	const wf = defineWorkflow({
		name: "bad-outcome-name",
		run(ctx) {
			return ctx.step("first", () => "live");
		},
	});
	await expect(
		createWorkflowEngine({ store }).resume(wf, "bad-outcome-name", null),
	).rejects.toThrow(/step name differs from journal/);
});

it("cannot hide a sleep divergence by catching it", async () => {
	const store = createInMemoryEventStore();
	const stream = "run/divergent-sleep";
	await store.append(
		nextEnvelope(stream, 1, "run.Started", {
			args: null,
			seed: "seed",
			workflowName: "divergent-sleep",
		}),
		0,
	);
	await store.append(
		nextEnvelope(stream, 2, "run.SleepScheduled", {
			delayMs: 10,
			index: 0,
		}),
		1,
	);
	let effects = 0;
	const wf = defineWorkflow({
		name: "divergent-sleep",
		async run(ctx) {
			try {
				await ctx.sleep(20);
			} catch {}
			try {
				await ctx.step("after", () => {
					effects += 1;
				});
			} catch {}
			return "unexpected";
		},
	});
	await expect(
		createWorkflowEngine({ store }).resume(wf, "divergent-sleep", null),
	).rejects.toThrow(/sleep schedule diverged/);
	expect(effects).toBe(0);
	expect(await store.readStream(stream)).toHaveLength(2);
});
