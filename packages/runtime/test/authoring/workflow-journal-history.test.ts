import fc from "fast-check";
import { expect, it } from "vitest";
import type { JsonBag } from "../../src/json.js";
import { validateJournalHistory } from "../../src/replay/journal-history.js";
import { replayRun } from "../../src/replay/replayer.js";
import { createInMemoryEventStore } from "../../src/replay/store.js";
import type { EventEnvelope } from "../../src/replay/types.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

const streamId = "run/history";
function start(version: number | undefined): EventEnvelope {
	const data: JsonBag = { args: null, workflowName: "history", seed: "seed" };
	if (version !== undefined) data.commandTreeVersion = version;
	return {
		id: "start",
		streamId,
		seq: 1,
		type: "run.Started",
		data,
	};
}
function event(seq: number, type: string): EventEnvelope {
	return { id: `${seq}`, streamId, seq, type, data: {} };
}
function terminal(seq: number): EventEnvelope {
	return { ...event(seq, "run.Completed"), data: { result: "recorded" } };
}

it("requires a start at the beginning of the validated prefix", () => {
	expect(() =>
		validateJournalHistory([event(1, "app.Recorded"), terminal(2)]),
	).toThrow(/journal.*begin/i);
});

it("rejects broken journal structure before a terminal result or replay callback", async () => {
	for (const version of [undefined, 1, 2, 3]) {
		for (const events of [
			[start(version), terminal(3)],
			[start(version), { ...start(version), seq: 2 }, terminal(3)],
			[event(1, "run.Other"), { ...start(version), seq: 2 }, terminal(3)],
			[start(version), terminal(2), event(3, "run.Other")],
		]) {
			let calls = 0;
			let writes = 0;
			const store = {
				readStream: async () => events,
				readBySeq: async () => null,
				append: async () => {
					writes++;
				},
			};
			const engine = createWorkflowEngine({ store });
			const workflow = defineWorkflow({
				name: "history",
				run: () => {
					calls++;
					return "unexpected";
				},
			});
			const replay = {
				name: "history",
				initialState: () => {
					calls++;
					return null;
				},
				execute: async () => {
					calls++;
					return null;
				},
			};
			await expect(engine.resume(workflow, "history", null)).rejects.toThrow(
				/journal/i,
			);
			await expect(replayRun(store, "history", replay, null)).rejects.toThrow(
				/journal/i,
			);
			expect(calls).toBe(0);
			expect(writes).toBe(0);
			// Diagnostic reads remain available for reconciliation.
			expect(await engine.journal("history")).toHaveLength(events.length);
		}
	}
});

it("rejects unknown reserved records in current histories while retaining legacy records", async () => {
	for (const version of [undefined, 3]) {
		const events = [start(version), event(2, "run.Future"), terminal(3)];
		const store = {
			readStream: async () => events,
			readBySeq: async () => null,
			append: async () => {},
		};
		const workflow = defineWorkflow({ name: "history", run: () => "new" });
		const engine = createWorkflowEngine({ store });
		const resume = engine.resume(workflow, "history", null);
		const replay = () =>
			replayRun(store, "history", engine.toReplayDefinition(workflow), null);
		if (version === 3) {
			await expect(resume).rejects.toThrow(/journal/i);
			await expect(replay()).rejects.toThrow(/journal/i);
		} else {
			await expect(resume).resolves.toMatchObject({ result: "recorded" });
			await expect(replay()).resolves.toMatchObject({ state: "new" });
		}
	}
});

it("refuses invalid event types before running a workflow", async () => {
	for (const invalid of ["", 4, null, Object("app.Recorded")]) {
		let calls = 0;
		const invalidEvent = event(2, "app.Recorded");
		Object.defineProperty(invalidEvent, "type", {
			value: invalid,
			enumerable: true,
		});
		const events = [start(3), invalidEvent];
		const store = {
			readStream: async () => events,
			readBySeq: async () => null,
			append: async () => {},
		};
		const workflow = defineWorkflow({
			name: "history",
			run: () => {
				calls++;
				return null;
			},
		});
		await expect(
			createWorkflowEngine({ store }).resume(workflow, "history", null),
		).rejects.toThrow(/journal.*type/i);
		expect(calls).toBe(0);
	}
});

it("rejects a damaged initial read after claiming a fresh run", async () => {
	const durable = createInMemoryEventStore();
	let calls = 0;
	const store = {
		...durable,
		readStream: async (id: string) => {
			const events = await durable.readStream(id);
			return [...events, terminal(3)];
		},
	};
	const workflow = defineWorkflow({
		name: "history",
		run: () => {
			calls++;
			return null;
		},
	});
	await expect(
		createWorkflowEngine({ store }).start(workflow, null, { runId: "history" }),
	).rejects.toThrow(/journal.*sequence/i);
	expect(calls).toBe(0);
	expect(await durable.readStream(streamId)).toHaveLength(1);
});

it("rejects missing interior records across generated current and legacy histories", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.integer({ min: 1, max: 8 }),
			fc.constantFrom(undefined, 1, 2, 3),
			async (count, version) => {
				const events = [start(version)];
				for (let index = 0; index < count; index++) {
					events.push({
						...event(index + 2, "app.Recorded"),
						meta: {
							workflowEmit: {
								index,
								parentStepIndex: null,
								nullPayload: false,
							},
						},
					});
				}
				events.push(terminal(count + 2));
				const store = {
					readStream: async () => events,
					readBySeq: async () => null,
					append: async () => {},
				};
				const workflow = defineWorkflow({ name: "history", run: () => "new" });
				await expect(
					createWorkflowEngine({ store }).resume(workflow, "history", null),
				).resolves.toMatchObject({ result: "recorded" });
				for (let removed = 1; removed <= count; removed++) {
					const broken = events.filter((_, index) => index !== removed);
					await expect(
						createWorkflowEngine({
							store: { ...store, readStream: async () => broken },
						}).resume(workflow, "history", null),
					).rejects.toThrow(/journal/i);
				}
			},
		),
		{ seed: 614619, numRuns: 60 },
	);
});
