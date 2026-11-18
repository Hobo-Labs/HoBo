import fc from "fast-check";
import { expect, it } from "vitest";
import { isJsonObject } from "../../src/json.js";
import { nextEnvelope } from "../../src/replay/recorder.js";
import {
	replayRun,
	type WorkflowReplayContext,
} from "../../src/replay/replayer.js";
import { createInMemoryEventStore } from "../../src/replay/store.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

it("refuses changed input, workflow identity and seed before replaying", async () => {
	let executions = 0;
	const wf = defineWorkflow({
		name: "binding",
		run: (_ctx, args: { value: string }) => {
			executions++;
			return args.value;
		},
	});
	const engine = createWorkflowEngine({ seed: "recorded-seed" });
	await engine.start(wf, { value: "recorded" }, { runId: "binding" });
	executions = 0;
	const definition = engine.toReplayDefinition(wf);
	await expect(
		replayRun(engine.store, "binding", definition, { value: "changed" }),
	).rejects.toThrow(/input.*run.Started/i);
	await expect(
		replayRun(
			engine.store,
			"binding",
			{ ...definition, name: "other" },
			{ value: "recorded" },
		),
	).rejects.toThrow(/name.*run.Started/i);
	await expect(
		replayRun(
			engine.store,
			"binding",
			definition,
			{ value: "recorded" },
			{ seed: "changed" },
		),
	).rejects.toThrow(/seed.*run.Started/i);
	expect(executions).toBe(0);
});

it("captures replay input before waiting for the journal", async () => {
	const wf = defineWorkflow({
		name: "replay-snapshot",
		run: (_ctx, args: { nested: { value: string } }) => args.nested.value,
	});
	const engine = createWorkflowEngine({ seed: "snapshot-seed" });
	await engine.start(
		wf,
		{ nested: { value: "recorded" } },
		{ runId: "snapshot" },
	);
	const entered = deferred();
	const release = deferred();
	const reader = {
		...engine.store,
		async readStream(stream: string) {
			entered.resolve();
			await release.promise;
			return engine.store.readStream(stream);
		},
	};
	const input = { nested: { value: "recorded" } };
	const options = { seed: "snapshot-seed" };
	const definition = engine.toReplayDefinition(wf);
	const running = replayRun(reader, "snapshot", definition, input, options);
	await entered.promise;
	input.nested.value = "changed";
	options.seed = "changed";
	definition.name = "changed";
	definition.execute = async () => "changed";
	release.resolve();
	const replay = await running;
	expect(replay.state).toBe("recorded");
	expect(replay.report.seed).toBe("snapshot-seed");
});

it("captures the initial-state callback before waiting for the journal", async () => {
	const store = createInMemoryEventStore();
	await store.append(
		nextEnvelope("run/callback", 1, "run.Started", {
			args: "recorded",
			workflowName: "callback",
			seed: "s",
			commandTreeVersion: 3,
		}),
		0,
	);
	const entered = deferred();
	const release = deferred();
	const reader = {
		...store,
		async readStream(stream: string) {
			entered.resolve();
			await release.promise;
			return store.readStream(stream);
		},
	};
	const wf = {
		name: "callback",
		initialState: (input: string) => ({ value: input }),
		execute: (_ctx: WorkflowReplayContext, state: { value: string }) => state,
	};
	const running = replayRun(reader, "callback", wf, "recorded");
	await entered.promise;
	wf.initialState = () => ({ value: "changed" });
	release.resolve();
	expect((await running).state).toEqual({ value: "recorded" });
});

it("rejects generated changed replay inputs", async () => {
	const wf = defineWorkflow({
		name: "generated-binding",
		run: (_ctx, value: string) => value,
	});
	const engine = createWorkflowEngine();
	await engine.start(wf, "original", { runId: "generated" });
	await fc.assert(
		fc.asyncProperty(
			fc.string().filter((value) => value !== "original"),
			async (changed) => {
				await expect(
					replayRun(
						engine.store,
						"generated",
						engine.toReplayDefinition(wf),
						changed,
					),
				).rejects.toThrow(/input.*run.Started/i);
			},
		),
		{ seed: 614608, numRuns: 100 },
	);
});

it("requires input, name and seed in a version-three start record", async () => {
	const wf = defineWorkflow({ name: "required-binding", run: () => null });
	const engine = createWorkflowEngine();
	await engine.start(wf, null, { runId: "required" });
	const events = await engine.store.readStream("run/required");
	for (const key of ["args", "workflowName", "seed"] as const) {
		const reader = {
			...engine.store,
			readStream: async () =>
				events.map((event) => {
					if (event.type !== "run.Started" || !isJsonObject(event.data))
						return event;
					const data = { ...event.data };
					delete data[key];
					return { ...event, data };
				}),
		};
		await expect(
			replayRun(reader, "required", engine.toReplayDefinition(wf), null),
		).rejects.toThrow(/run.Started/i);
	}
	const malformedSeed = {
		...engine.store,
		readStream: async () =>
			events.map((event) =>
				event.type === "run.Started" && isJsonObject(event.data)
					? { ...event, data: { ...event.data, seed: null } }
					: event,
			),
	};
	await expect(
		replayRun(malformedSeed, "required", engine.toReplayDefinition(wf), null),
	).rejects.toThrow(/seed.*run.Started/i);
});

it("allows an explicitly supplied seed for an older record without a name or seed", async () => {
	const store = createInMemoryEventStore();
	await store.append(
		nextEnvelope("run/legacy", 1, "run.Started", { args: "old" }),
		0,
	);
	const wf = {
		name: "legacy",
		initialState: (input: string) => input,
		execute: (_ctx: WorkflowReplayContext, state: string) => state,
	};
	const replay = await replayRun(store, "legacy", wf, "old", {
		seed: "fallback",
	});
	expect(replay.state).toBe("old");
	expect(replay.report.seed).toBe("fallback");
});

it("rejects invalid IDs and unreproducible input before reading the journal", async () => {
	const base = createInMemoryEventStore();
	let reads = 0;
	const reader = {
		...base,
		async readStream(stream: string) {
			reads++;
			return base.readStream(stream);
		},
	};
	const wf = { name: "invalid", initialState: () => null, execute: () => null };
	for (const id of ["", JSON.parse("1"), null]) {
		await expect(replayRun(reader, id, wf, null)).rejects.toThrow(/runId/i);
	}
	const shared = { value: 1 };
	await expect(
		replayRun(reader, "valid", wf, { left: shared, right: shared }),
	).rejects.toThrow(/JSON-normalized/i);
	expect(reads).toBe(0);
});
