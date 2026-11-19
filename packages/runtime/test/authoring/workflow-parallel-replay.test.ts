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

it("resumes an earlier in-flight step after a later parallel step completed", async () => {
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
	).rejects.toThrow(/step name differs from journal/);
	expect(await recoveredStore.readStream("run/parallel-replay")).toEqual(saved);
	expect(unexpectedEffects).toBe(0);

	const resumed = await createWorkflowEngine({ store: recoveredStore }).resume(
		wf,
		"parallel-replay",
		null,
	);
	expect(resumed.result).toEqual(["earlier", "later"]);
	expect(earlierCalls).toBe(2);
	expect(laterCalls).toBe(1);
	const resumedJournal = await recoveredStore.readStream("run/parallel-replay");
	expect(
		resumedJournal.filter((event) => event.type === "run.StepScheduled"),
	).toHaveLength(2);
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

it.each([
	{
		label: "scheduled-only gap",
		events: [{ type: "run.StepScheduled", name: "step-2", index: 2 }],
		error: /gapped step journal/,
	},
	{
		label: "schedule above the outcome tip",
		events: [
			{ type: "run.StepScheduled", name: "step-0", index: 0 },
			{ type: "run.StepCompleted", name: "step-0", index: 0, result: 0 },
			{ type: "run.StepScheduled", name: "step-2", index: 2 },
		],
		error: /gapped step journal/,
	},
	{
		label: "outcome above an unscheduled gap",
		events: [
			{ type: "run.StepCompleted", name: "step-0", index: 0, result: 0 },
			{ type: "run.StepCompleted", name: "step-2", index: 2, result: 2 },
		],
		error: /gapped step journal/,
	},
	{
		label: "scheduled index above the cap",
		events: [
			{ type: "run.StepScheduled", name: "step-huge", index: 1_000_001 },
		],
		error: /invalid step journal/,
	},
])("rejects $label before running", async ({ events, error }) => {
	const store = createInMemoryEventStore();
	const stream = "run/gapped-schedules";
	let seq = 0;
	await store.append(
		nextEnvelope(stream, ++seq, "run.Started", {
			args: null,
			seed: "seed",
			workflowName: "gapped-schedules",
		}),
		seq - 1,
	);
	for (const event of events) {
		const { type, ...data } = event;
		await store.append(nextEnvelope(stream, ++seq, type, data), seq - 1);
	}
	let effects = 0;
	const wf = defineWorkflow({
		name: "gapped-schedules",
		run(ctx) {
			return ctx.step("step-0", () => {
				effects += 1;
			});
		},
	});
	await expect(
		createWorkflowEngine({ store }).resume(wf, "gapped-schedules", null),
	).rejects.toThrow(error);
	expect(effects).toBe(0);
	expect(await store.readStream(stream)).toHaveLength(events.length + 1);
});

it("resumes an interior scheduled gap and reuses the later outcome", async () => {
	const store = createInMemoryEventStore();
	const stream = "run/interior-scheduled-gap";
	let seq = 0;
	await store.append(
		nextEnvelope(stream, ++seq, "run.Started", {
			args: null,
			seed: "seed",
			workflowName: "interior-scheduled-gap",
		}),
		seq - 1,
	);
	for (const index of [0, 1, 2]) {
		await store.append(
			nextEnvelope(stream, ++seq, "run.StepScheduled", {
				name: `step-${index}`,
				index,
			}),
			seq - 1,
		);
	}
	for (const index of [0, 2]) {
		await store.append(
			nextEnvelope(stream, ++seq, "run.StepCompleted", {
				name: `step-${index}`,
				index,
				result: index,
			}),
			seq - 1,
		);
	}
	const calls = [0, 0, 0];
	const wf = defineWorkflow({
		name: "interior-scheduled-gap",
		async run(ctx) {
			const values: number[] = [];
			for (const index of [0, 1, 2]) {
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
	const resumed = await createWorkflowEngine({ store }).resume(
		wf,
		"interior-scheduled-gap",
		null,
	);
	expect(resumed.result).toEqual([0, 1, 2]);
	expect(calls).toEqual([0, 1, 0]);
	const journal = await store.readStream(stream);
	expect(
		journal.filter((event) => event.type === "run.StepScheduled"),
	).toHaveLength(3);
});

it("replays a later step failure after resuming an earlier scheduled gap", async () => {
	const store = createInMemoryEventStore();
	const stream = "run/scheduled-gap-failure";
	let seq = 0;
	await store.append(
		nextEnvelope(stream, ++seq, "run.Started", {
			args: null,
			seed: "seed",
			workflowName: "scheduled-gap-failure",
		}),
		seq - 1,
	);
	for (const index of [0, 1]) {
		await store.append(
			nextEnvelope(stream, ++seq, "run.StepScheduled", {
				name: `step-${index}`,
				index,
			}),
			seq - 1,
		);
	}
	await store.append(
		nextEnvelope(stream, ++seq, "run.StepFailed", {
			name: "step-1",
			index: 1,
			message: "boom",
		}),
		seq - 1,
	);
	const calls = [0, 0, 0];
	const wf = defineWorkflow({
		name: "scheduled-gap-failure",
		async run(ctx) {
			const first = await ctx.step("step-0", () => {
				calls[0] = (calls[0] ?? 0) + 1;
				return "first";
			});
			try {
				await ctx.step("step-1", () => {
					calls[1] = (calls[1] ?? 0) + 1;
					return "unused";
				});
				return "unexpected";
			} catch {
				return ctx.step("compensate", () => {
					calls[2] = (calls[2] ?? 0) + 1;
					return `${first}-compensated`;
				});
			}
		},
	});
	const resumed = await createWorkflowEngine({ store }).resume(
		wf,
		"scheduled-gap-failure",
		null,
	);
	expect(resumed.status).toBe("completed");
	expect(resumed.result).toBe("first-compensated");
	expect(calls).toEqual([1, 0, 1]);
});

it("resumes a single trailing scheduled step at the tip", async () => {
	const store = createInMemoryEventStore();
	const stream = "run/trailing-schedule";
	let seq = 0;
	await store.append(
		nextEnvelope(stream, ++seq, "run.Started", {
			args: null,
			seed: "seed",
			workflowName: "trailing-schedule",
		}),
		seq - 1,
	);
	await store.append(
		nextEnvelope(stream, ++seq, "run.StepScheduled", {
			name: "step-0",
			index: 0,
		}),
		seq - 1,
	);
	await store.append(
		nextEnvelope(stream, ++seq, "run.StepCompleted", {
			name: "step-0",
			index: 0,
			result: 0,
		}),
		seq - 1,
	);
	await store.append(
		nextEnvelope(stream, ++seq, "run.StepScheduled", {
			name: "step-1",
			index: 1,
		}),
		seq - 1,
	);
	const calls = [0, 0];
	const wf = defineWorkflow({
		name: "trailing-schedule",
		async run(ctx) {
			const first = await ctx.step("step-0", () => {
				calls[0] = (calls[0] ?? 0) + 1;
				return 0;
			});
			const second = await ctx.step("step-1", () => {
				calls[1] = (calls[1] ?? 0) + 1;
				return 1;
			});
			return [first, second];
		},
	});
	const resumed = await createWorkflowEngine({ store }).resume(
		wf,
		"trailing-schedule",
		null,
	);
	expect(resumed.result).toEqual([0, 1]);
	expect(calls).toEqual([0, 1]);
	const journal = await store.readStream(stream);
	expect(
		journal.filter((event) => event.type === "run.StepScheduled"),
	).toHaveLength(2);
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
