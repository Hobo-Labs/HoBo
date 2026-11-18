import { create, toBinary, toJson } from "@bufbuild/protobuf";
import fc from "fast-check";
import { expect, it } from "vitest";
import { ReplayReportSchema } from "../../src/_generated/replay/replay_report_pb.js";
import { ReplayDivergenceError } from "../../src/replay/divergence.js";
import { assertReplayEqualsLive } from "../../src/replay/equivalence.js";
import {
	parseReplayDivergence,
	parseReplayReport,
} from "../../src/replay/parse.js";
import {
	parseReplayReportBinary,
	parseReplayReportProtoJson,
} from "../../src/replay/proto.js";
import { replayRun } from "../../src/replay/replayer.js";

const raw = {
	runId: "run",
	seqVector: [{ streamId: "s", seq: 1 }],
	readSetHash: "a".repeat(64),
	stateDigest: "b".repeat(64),
	mode: "replay",
	seed: "seed",
	canonicalizationVersion: 2,
};

it("keeps parsed report evidence immutable through every entry point", () => {
	const message = create(ReplayReportSchema, {
		...raw,
		seqVector: [{ streamId: "s", seq: 1n }],
	});
	const reports = [
		parseReplayReport(raw),
		parseReplayReportProtoJson(toJson(ReplayReportSchema, message)),
		parseReplayReportBinary(toBinary(ReplayReportSchema, message)),
	];
	for (const report of reports) {
		expect(Object.isFrozen(report)).toBe(true);
		expect(Object.isFrozen(report.seqVector)).toBe(true);
		expect(Object.isFrozen(report.seqVector[0])).toBe(true);
		expect(
			Reflect.set(report.seqVector, "0", {
				streamId: "s",
				seq: Number.MAX_SAFE_INTEGER + 1,
			}),
		).toBe(false);
		expect(() =>
			Array.prototype.push.call(report.seqVector, {
				streamId: "other",
				seq: 1,
			}),
		).toThrow(TypeError);
		expect(Reflect.set(report.seqVector[0], "seq", 5)).toBe(false);
		expect(Reflect.set(report, "canonicalizationVersion", 1)).toBe(false);
		expect(report.seqVector).toEqual([{ streamId: "s", seq: 1 }]);
	}
});

it("keeps parsed divergence orders immutable", () => {
	const record = parseReplayDivergence({
		runId: "run",
		liveStateDigest: "a".repeat(64),
		replayStateDigest: "b".repeat(64),
		liveOrder: ["a"],
		replayOrder: ["b"],
		firstDivergentEventKey: "a",
	});
	expect(Object.isFrozen(record)).toBe(true);
	expect(Object.isFrozen(record.liveOrder)).toBe(true);
	expect(Object.isFrozen(record.replayOrder)).toBe(true);
	expect(() => Array.prototype.push.call(record.liveOrder, "changed")).toThrow(
		TypeError,
	);
	expect(Reflect.set(record.replayOrder, "0", "changed")).toBe(false);
});

it("protects new harness and workflow reports before they are parsed", async () => {
	const events = [
		{ id: "s", streamId: "s", seq: 1, type: "value", data: null },
	];
	const harness = assertReplayEqualsLive({
		events,
		initialState: 0,
		fold: (state) => state + 1,
	});
	const workflow = {
		name: "evidence",
		initialState: () => 1,
		execute: () => 1,
	};
	const reader = {
		readStream: async () => [
			{
				id: "start",
				streamId: "run/run",
				seq: 1,
				type: "run.Started",
				data: { args: null, workflowName: "evidence", seed: "seed" },
			},
		],
		readBySeq: async () => null,
	};
	const replayed = (await replayRun(reader, "run", workflow, null)).report;
	for (const report of [harness, replayed]) {
		expect(Object.isFrozen(report)).toBe(true);
		expect(Object.isFrozen(report.seqVector)).toBe(true);
		expect(Object.isFrozen(report.seqVector[0])).toBe(true);
		expect(
			Reflect.set(report.seqVector[0], "seq", Number.MAX_SAFE_INTEGER + 1),
		).toBe(false);
	}
});

it("protects divergence evidence from later edits to its input arrays", () => {
	const liveOrder = ["a"];
	const replayOrder = ["b"];
	const error = new ReplayDivergenceError({
		runId: "run",
		liveState: 1,
		replayState: 2,
		liveOrder,
		replayOrder,
	});
	expect(() => {
		liveOrder.push("changed");
		replayOrder[0] = "changed";
	}).not.toThrow();
	expect(Object.isFrozen(error.divergence)).toBe(true);
	expect(Object.isFrozen(error.divergence.liveOrder)).toBe(true);
	expect(Object.isFrozen(error.divergence.replayOrder)).toBe(true);
	expect(error.divergence.liveOrder).toEqual(["a"]);
	expect(error.divergence.replayOrder).toEqual(["b"]);
});

it("keeps generated report positions detached and immutable", () => {
	fc.assert(
		fc.property(
			fc.nat({ max: 1000000 }),
			fc.constantFrom("s", "__proto__", "é", "constructor"),
			(seq, streamId) => {
				const input = { ...raw, seqVector: [{ streamId, seq }] };
				const report = parseReplayReport(input);
				expect(() => {
					input.seqVector[0].seq = seq + 1;
					input.seqVector.push({ streamId: "other", seq: 1 });
				}).not.toThrow();
				expect(
					Reflect.set(report.seqVector, "0", { streamId, seq: seq + 2 }),
				).toBe(false);
				expect(report.seqVector).toEqual([{ streamId, seq }]);
			},
		),
		{ seed: 614616, numRuns: 100 },
	);
});
