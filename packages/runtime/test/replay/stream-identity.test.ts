import fc from "fast-check";
import { expect, it } from "vitest";
import { ReplayDivergenceError } from "../../src/replay/divergence.js";
import {
	assertReplayEqualsLive,
	hashReadSet,
	seqVector,
} from "../../src/replay/equivalence.js";
import {
	parseReplayDivergence,
	parseReplayReport,
} from "../../src/replay/parse.js";
import { replayRun } from "../../src/replay/replayer.js";
import { createWorkflowEngine, defineWorkflow } from "../../src/workflow.js";

const report = {
	runId: "run",
	seqVector: [{ streamId: "s", seq: 1 }],
	readSetHash: "a".repeat(64),
	stateDigest: "b".repeat(64),
	mode: "replay",
	seed: "seed",
};
const divergence = {
	runId: "run",
	liveStateDigest: "a".repeat(64),
	replayStateDigest: "b".repeat(64),
	liveOrder: ["a"],
	replayOrder: ["b"],
	firstDivergentEventKey: "a",
};

it("rejects boxed strings and duplicate logical stream names in parsed evidence", () => {
	for (const field of [
		"runId",
		"readSetHash",
		"stateDigest",
		"seed",
	] as const) {
		expect(() =>
			parseReplayReport({ ...report, [field]: Object(report[field]) }),
		).toThrow();
	}
	expect(() =>
		parseReplayReport({
			...report,
			seqVector: [
				{ streamId: Object("s"), seq: 1 },
				{ streamId: "s", seq: 2 },
			],
		}),
	).toThrow();
	expect(() =>
		parseReplayDivergence({ ...divergence, liveOrder: [Object("a")] }),
	).toThrow();
});

it("does not inspect an object masquerading as a string", () => {
	let reads = 0;
	const impostor = {
		get [Symbol.toStringTag]() {
			reads++;
			return "String";
		},
		length: 1,
	};
	expect(() => parseReplayReport({ ...report, runId: impostor })).toThrow();
	expect(reads).toBe(0);
});

it("rejects invalid generated report identities and streams before folding", () => {
	let calls = 0;
	const fold = (state: number) => {
		calls++;
		return state + 1;
	};
	const event = { id: "one", streamId: "s", seq: 1, type: "value", data: null };
	for (const invalid of ["", Object("wrapped"), 42, null]) {
		expect(() =>
			assertReplayEqualsLive({
				events: [event],
				initialState: 0,
				fold,
				runId: invalid,
			}),
		).toThrow();
		expect(() =>
			assertReplayEqualsLive({
				events: [event],
				initialState: 0,
				fold,
				seed: invalid,
			}),
		).toThrow();
		expect(() => seqVector([{ ...event, streamId: invalid }])).toThrow();
		expect(() => hashReadSet([{ ...event, streamId: invalid }])).toThrow();
	}
	expect(() =>
		assertReplayEqualsLive({
			events: [event],
			initialState: 0,
			fold,
			targetSeq: { "": 1 },
		}),
	).toThrow(/stream/i);
	expect(
		() =>
			new ReplayDivergenceError({
				runId: "",
				liveState: 1,
				replayState: 2,
				liveOrder: [],
				replayOrder: [],
			}),
	).toThrow(/run/i);
	expect(calls).toBe(0);
});

it("refuses foreign journal events before resume, terminal reuse, replay and journal reads", async () => {
	for (const foreignIndex of [0, 1]) {
		const events = [
			{
				id: "start",
				streamId: "run/context",
				seq: 1,
				type: "run.Started",
				data: {
					args: null,
					workflowName: "context",
					seed: "seed",
					commandTreeVersion: 3,
				},
			},
			{
				id: "done",
				streamId: "run/context",
				seq: 2,
				type: "run.Completed",
				data: { result: "old" },
			},
		];
		events[foreignIndex].streamId = "run/foreign";
		let calls = 0;
		let writes = 0;
		const store = {
			readStream: async () => events,
			readBySeq: async () => null,
			append: async () => {
				writes++;
			},
		};
		const definition = defineWorkflow({
			name: "context",
			run: () => {
				calls++;
				return "new";
			},
		});
		const engine = createWorkflowEngine({ store });
		await expect(engine.resume(definition, "context", null)).rejects.toThrow(
			/stream/i,
		);
		await expect(engine.journal("context")).rejects.toThrow(/stream/i);
		const replayDefinition = {
			name: "context",
			initialState: () => {
				calls++;
				return null;
			},
			execute: () => {
				calls++;
				return null;
			},
		};
		await expect(
			replayRun(store, "context", replayDefinition, null),
		).rejects.toThrow(/stream/i);
		expect(calls).toBe(0);
		expect(writes).toBe(0);
	}
});

it("keeps generated nonempty primitive stream IDs distinct", () => {
	fc.assert(
		fc.property(
			fc.constantFrom("s", "__proto__", "constructor", "é", "e\u0301"),
			(streamId) => {
				const event = {
					id: "one",
					streamId,
					seq: 1,
					type: "value",
					data: null,
				};
				expect(seqVector([event])[streamId]).toBe(1);
				expect(() =>
					seqVector([{ ...event, streamId: Object(streamId) }]),
				).toThrow();
			},
		),
		{ seed: 614618, numRuns: 100 },
	);
});

it("uses captured journal events when the caller changes the original during replay", async () => {
	const started = {
		id: "start",
		streamId: "run/context",
		seq: 1,
		type: "run.Started",
		data: {
			args: null,
			workflowName: "context",
			seed: "seed",
			commandTreeVersion: 3,
		},
	};
	const store = {
		readStream: async () => [started],
		readBySeq: async () => null,
	};
	const workflow = {
		name: "context",
		initialState: () => {
			started.streamId = "run/foreign";
			return null;
		},
		execute: () => null,
	};
	const { report: replayReport } = await replayRun(
		store,
		"context",
		workflow,
		null,
	);
	expect(replayReport.seqVector.map((entry) => entry.streamId)).toEqual([
		"run/context",
	]);
	expect(replayReport.readSetHash).toBe(
		hashReadSet([{ ...started, streamId: "run/context" }]),
	);
});
