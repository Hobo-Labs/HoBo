import fc from "fast-check";
import { expect, it } from "vitest";
import type { JsonBag, JsonValue } from "../../src/json.js";
import { replayRun } from "../../src/replay/replayer.js";
import { createInMemoryEventStore } from "../../src/replay/store.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

function journal(data: JsonBag, terminal = false) {
	const events = [
		{ id: "start", streamId: "run/context", seq: 1, type: "run.Started", data },
	];
	if (terminal)
		events.push({
			id: "done",
			streamId: "run/context",
			seq: 2,
			type: "run.Completed",
			data: { result: "old" },
		});
	let writes = 0;
	return {
		store: {
			readStream: async () => events,
			readBySeq: async () => null,
			append: async () => {
				writes++;
			},
		},
		writes: () => writes,
	};
}
const started = () => ({
	args: null,
	workflowName: "context",
	seed: "recorded",
});

it("requires recorded context before executing or reusing a terminal result", async () => {
	for (const field of ["args", "workflowName", "seed"] as const) {
		for (const terminal of [false, true]) {
			let calls = 0;
			const data: JsonBag = started();
			delete data[field];
			const { store, writes } = journal(data, terminal);
			const definition = defineWorkflow({
				name: "context",
				run: () => {
					calls++;
					return "new";
				},
			});
			await expect(
				createWorkflowEngine({ store }).resume(definition, "context", null),
			).rejects.toThrow(/run.Started/i);
			expect(calls).toBe(0);
			expect(writes()).toBe(0);
		}
	}
});

it("refuses malformed present names and seeds rather than silently falling back", async () => {
	for (const field of ["workflowName", "seed"] as const) {
		for (const value of [null, "", 42]) {
			let calls = 0;
			const data: JsonBag = { ...started(), [field]: value };
			const { store, writes } = journal(data);
			const definition = defineWorkflow({
				name: "context",
				run: () => {
					calls++;
					return "new";
				},
			});
			await expect(
				createWorkflowEngine({ store }).resume(definition, "context", null),
			).rejects.toThrow(/run.Started/i);
			expect(calls).toBe(0);
			expect(writes()).toBe(0);
		}
	}
});

it("rejects invalid new workflow names and engine seeds before recording work", () => {
	for (const value of ["", 1, null, Object("wrapped")]) {
		expect(() => defineWorkflow({ name: value, run: () => null })).toThrow(
			/name/i,
		);
		expect(() => createWorkflowEngine({ seed: value })).toThrow(/seed/i);
	}
});

it("rejects an invalid supplied definition before appending a start record", async () => {
	const underlying = createInMemoryEventStore();
	const valid = defineWorkflow({ name: "context", run: () => "ok" });
	const invalid = { ...valid, name: "" };
	await expect(
		createWorkflowEngine({ store: underlying }).start(invalid, null, {
			runId: "invalid",
		}),
	).rejects.toThrow(/name/i);
	expect(await underlying.readStream("run/invalid")).toEqual([]);
	const invalidCallback = { ...valid, run: JSON.parse("0") };
	await expect(
		createWorkflowEngine({ store: underlying }).start(invalidCallback, null, {
			runId: "invalid-callback",
		}),
	).rejects.toThrow(/callable/i);
	expect(await underlying.readStream("run/invalid-callback")).toEqual([]);
});

it("refuses empty supplied and recorded replay seeds before workflow callbacks", async () => {
	let calls = 0;
	const workflow = {
		name: "context",
		initialState: () => {
			calls++;
			return 0;
		},
		execute: () => {
			calls++;
			return 0;
		},
	};
	const emptyRecorded = journal({ ...started(), seed: "" });
	await expect(
		replayRun(emptyRecorded.store, "context", workflow, null),
	).rejects.toThrow(/seed/i);
	const valid = journal(started());
	await expect(
		replayRun(valid.store, "context", workflow, null, { seed: "" }),
	).rejects.toThrow(/seed/i);
	let reads = 0;
	const older = journal(started());
	const reader = {
		...older.store,
		async readStream() {
			reads++;
			return older.store.readStream();
		},
	};
	await expect(
		replayRun(reader, "context", workflow, null, { seed: "" }),
	).rejects.toBeInstanceOf(TypeError);
	expect(reads).toBe(0);
	expect(calls).toBe(0);
});

it("refuses generated invalid recorded contexts without effects", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.constantFrom("args", "workflowName", "seed"),
			fc.boolean(),
			async (field, terminal) => {
				let calls = 0;
				const data: JsonBag = started();
				delete data[field];
				const { store, writes } = journal(data, terminal);
				const definition = defineWorkflow({
					name: "context",
					run: (_ctx, _args: JsonValue) => {
						calls++;
						return "new";
					},
				});
				await expect(
					createWorkflowEngine({ store }).resume(definition, "context", null),
				).rejects.toThrow(/run.Started/i);
				expect(calls).toBe(0);
				expect(writes()).toBe(0);
			},
		),
		{ seed: 614617, numRuns: 50 },
	);
});

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

it("captures the definition and its tool authority before the initial append", async () => {
	const entered = deferred();
	const release = deferred();
	const underlying = createInMemoryEventStore();
	const store = {
		...underlying,
		async append(event, expectedSeq) {
			if (event.type === "run.Started") {
				entered.resolve();
				await release.promise;
			}
			return underlying.append(event, expectedSeq);
		},
	};
	const base = defineWorkflow({
		name: "context",
		capabilities: ["tool:lookup"],
		tools: { lookup: () => "original" },
		run: (ctx) => ctx.tool("lookup", null),
	});
	const definition = {
		...base,
		capabilities: new Set(base.capabilities),
		tools: { ...base.tools },
	};
	const pending = createWorkflowEngine({ store }).start(definition, null, {
		runId: "captured",
	});
	await entered.promise;
	definition.name = "changed";
	definition.run = () => "changed";
	definition.tools.lookup = () => "changed";
	definition.capabilities.clear();
	Object.defineProperty(base.run, "call", {
		value: () => "changed",
		configurable: true,
	});
	release.resolve();
	await expect(pending).resolves.toMatchObject({ result: "original" });
	const recorded = await underlying.readStream("run/captured");
	expect(recorded[0]?.data).toMatchObject({ workflowName: "context" });
});

it("captures the resume definition before waiting for the journal", async () => {
	const entered = deferred();
	const release = deferred();
	const baseStore = journal(started());
	const store = {
		...baseStore.store,
		async readStream() {
			entered.resolve();
			await release.promise;
			return baseStore.store.readStream();
		},
	};
	const base = defineWorkflow({ name: "context", run: () => "original" });
	const definition = { ...base };
	const pending = createWorkflowEngine({ store }).resume(
		definition,
		"context",
		null,
	);
	await entered.promise;
	definition.name = "changed";
	definition.run = () => "changed";
	release.resolve();
	await expect(pending).resolves.toMatchObject({ result: "original" });
});

it("captures the definition handed to the replay adapter", async () => {
	const base = defineWorkflow({ name: "context", run: () => "original" });
	const definition = { ...base };
	const engine = createWorkflowEngine();
	const replayDefinition = engine.toReplayDefinition(definition);
	definition.name = "changed";
	definition.run = () => "changed";
	const { store } = journal(started());
	expect(
		(await replayRun(store, "context", replayDefinition, null)).state,
	).toBe("original");
});

it("does not use mutable call properties on captured replay callbacks", async () => {
	const entered = deferred();
	const release = deferred();
	const baseStore = journal(started());
	const store = {
		...baseStore.store,
		async readStream() {
			entered.resolve();
			await release.promise;
			return baseStore.store.readStream();
		},
	};
	const definition = {
		name: "context",
		initialState: () => 1,
		execute: (_ctx, state: number) => state + 1,
	};
	const pending = replayRun(store, "context", definition, null);
	await entered.promise;
	Object.defineProperty(definition.initialState, "call", {
		value: () => 100,
		configurable: true,
	});
	Object.defineProperty(definition.execute, "call", {
		value: () => 200,
		configurable: true,
	});
	release.resolve();
	expect((await pending).state).toBe(2);
});
