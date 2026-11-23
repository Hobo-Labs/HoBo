import { create, fromJson, toBinary, toJson } from "@bufbuild/protobuf";
import fc from "fast-check";
import { expect, it } from "vitest";
import {
	ReplayDivergenceSchema,
	ReplayReportSchema,
} from "../../src/_generated/replay/replay_report_pb.js";
import type { JsonBag, JsonValue } from "../../src/json.js";
import {
	parseReplayDivergenceBinary,
	parseReplayDivergenceProtoJson,
	parseReplayReportBinary,
	parseReplayReportProtoJson,
} from "../../src/replay/index.js";

const report = {
	runId: "run",
	readSetHash: "a".repeat(64),
	stateDigest: "b".repeat(64),
	mode: "replay",
	seed: "seed",
};
const divergence = {
	runId: "run",
	liveStateDigest: "a".repeat(64),
	replayStateDigest: "b".repeat(64),
	firstDivergentEventKey: "unknown",
};

it("reads default protobuf JSON and binary reports without losing empty arrays", () => {
	const message = create(ReplayReportSchema, report);
	const json = toJson(ReplayReportSchema, message);
	const binary = toBinary(ReplayReportSchema, message);
	expect(() => parseReplayReportProtoJson(json)).not.toThrow();
	expect(() => parseReplayReportBinary(binary)).not.toThrow();
	for (const parsed of [
		parseReplayReportProtoJson(json),
		parseReplayReportBinary(binary),
	]) {
		expect(parsed.seqVector).toEqual([]);
		expect(parsed.runId).toBe(report.runId);
	}
});

it("preserves protobuf uint64 positions exactly through JSON and binary", () => {
	const message = create(ReplayReportSchema, {
		...report,
		seqVector: [
			{ streamId: "zero", seq: 0n },
			{ streamId: "maximum", seq: BigInt(Number.MAX_SAFE_INTEGER) },
		],
	});
	const json = toJson(ReplayReportSchema, message);
	expect(fromJson(ReplayReportSchema, json).seqVector[1]?.seq).toBe(
		BigInt(Number.MAX_SAFE_INTEGER),
	);
	for (const parsed of [
		parseReplayReportProtoJson(json),
		parseReplayReportBinary(toBinary(ReplayReportSchema, message)),
	]) {
		expect(parsed.seqVector).toEqual([
			{ streamId: "zero", seq: 0 },
			{ streamId: "maximum", seq: Number.MAX_SAFE_INTEGER },
		]);
	}
});

it("reads default protobuf JSON and binary divergence records with empty orders", () => {
	const message = create(ReplayDivergenceSchema, divergence);
	for (const parsed of [
		parseReplayDivergenceProtoJson(toJson(ReplayDivergenceSchema, message)),
		parseReplayDivergenceBinary(toBinary(ReplayDivergenceSchema, message)),
	]) {
		expect(parsed.liveOrder).toEqual([]);
		expect(parsed.replayOrder).toEqual([]);
	}
});

it("refuses unsafe numbers before protobuf JSON conversion and unsafe uint64 values after decoding", () => {
	for (const seq of [
		Number.MAX_SAFE_INTEGER + 1,
		"9007199254740992",
		"18446744073709551615",
	]) {
		expect(() =>
			parseReplayReportProtoJson({
				...report,
				seqVector: [{ streamId: "s", seq }],
			}),
		).toThrow(/safe integer/i);
	}
	const unsafe = create(ReplayReportSchema, {
		...report,
		seqVector: [{ streamId: "s", seq: 9007199254740992n }],
	});
	expect(() =>
		parseReplayReportBinary(toBinary(ReplayReportSchema, unsafe)),
	).toThrow(/safe integer/i);
});

it("retains report validation", () => {
	expect(() =>
		parseReplayReportProtoJson({ ...report, unknown: true }),
	).toThrow();
	expect(() =>
		parseReplayReportProtoJson({
			...report,
			seqVector: [
				{ streamId: "s", seq: "1" },
				{ streamId: "s", seq: "2" },
			],
		}),
	).toThrow(/duplicate/i);
	expect(() =>
		parseReplayDivergenceProtoJson({
			...divergence,
			replayStateDigest: "a".repeat(64),
		}),
	).toThrow(/differing/i);
	expect(() => parseReplayReportBinary(new Uint8Array([255]))).toThrow();
});

it("refuses overflowing wire integers before decoding", () => {
	const base = toBinary(ReplayReportSchema, create(ReplayReportSchema, report));
	const concat = (...parts: Uint8Array[]) =>
		Uint8Array.from(parts.flatMap((part) => [...part]));
	const overflowSeq = Uint8Array.from([
		18,
		14,
		10,
		1,
		115,
		16,
		...Array(9).fill(128),
		2,
	]);
	const overflowUnknown = Uint8Array.from([160, 6, ...Array(9).fill(128), 2]);
	for (const suffix of [overflowSeq, overflowUnknown]) {
		expect(() => parseReplayReportBinary(concat(base, suffix))).toThrow();
	}
});

it("refuses overflowing integers and groups in divergence wire records", () => {
	const base = toBinary(
		ReplayDivergenceSchema,
		create(ReplayDivergenceSchema, divergence),
	);
	const overflowUnknown = Uint8Array.from([160, 6, ...Array(9).fill(128), 2]);
	const group = Uint8Array.from([163, 6, 164, 6]);
	for (const suffix of [overflowUnknown, group]) {
		expect(() =>
			parseReplayDivergenceBinary(Uint8Array.from([...base, ...suffix])),
		).toThrow();
	}
});

it("preserves forward-compatible ordinary unknown binary fields", () => {
	const base = toBinary(ReplayReportSchema, create(ReplayReportSchema, report));
	const bytes = Uint8Array.from([...base, 160, 6, 1]);
	expect(parseReplayReportBinary(bytes).runId).toBe("run");
});

it("refuses JSON accessors without invoking them before decoding", () => {
	let reads = 0;
	for (const [raw, parse] of [
		[{ ...report }, parseReplayReportProtoJson],
		[{ ...divergence }, parseReplayDivergenceProtoJson],
	] as const) {
		Object.defineProperty(raw, "runId", {
			enumerable: true,
			get() {
				reads += 1;
				return "run";
			},
		});
		expect(() => parse(raw)).toThrow();
	}
	expect(reads).toBe(0);
});

it("accepts frozen JSON data and null-prototype objects", () => {
	const raw = Object.assign(Object.create(null), report, {
		seqVector: Object.freeze([]),
	});
	Object.freeze(raw);
	expect(parseReplayReportProtoJson(raw).runId).toBe("run");
});

it("refuses proxies and cycles before inspecting their contents", () => {
	let traps = 0;
	const proxy = new Proxy(report, {
		get() {
			traps += 1;
			throw new Error("proxy trap invoked");
		},
	});
	expect(() => parseReplayReportProtoJson(proxy)).toThrow(/prox/i);
	expect(traps).toBe(0);
	const cyclic: JsonBag = { ...report };
	cyclic.loop = cyclic;
	expect(() => parseReplayReportProtoJson(cyclic)).toThrow(/cycle/i);
});

it("refuses excessively nested JSON before recursive decoding", () => {
	let nested: JsonValue = null;
	for (let level = 0; level < 102; level += 1) nested = [nested];
	expect(() =>
		parseReplayReportProtoJson({ ...report, unknown: nested }),
	).toThrow(/nesting/i);
});

it("uses the same captured binary bytes for validation and decoding", () => {
	const original = toBinary(
		ReplayReportSchema,
		create(ReplayReportSchema, {
			...report,
			seqVector: [{ streamId: "s", seq: 1n }],
		}),
	);
	const prefix = [10, 1, 115, 16, 1];
	const start = [...original].findIndex((_, index) =>
		prefix.every((byte, delta) => original[index + delta] === byte),
	);
	expect(start).toBeGreaterThanOrEqual(0);
	const sequenceOffset = start + 4;
	class MutatingBytes extends Uint8Array {
		constructor(
			bytes: Uint8Array,
			private readonly sequenceOffset: number,
		) {
			super(bytes);
		}
		override subarray(begin = 0, end = this.length): Uint8Array {
			const result = Uint8Array.from(Array.from(this).slice(begin, end));
			this[this.sequenceOffset] = 0;
			return result;
		}
	}
	const bytes = new MutatingBytes(original, sequenceOffset);
	expect(parseReplayReportBinary(bytes).seqVector[0]?.seq).toBe(1);
	expect(bytes[sequenceOffset]).toBe(1);
});

it("round trips generated safe positions through both representations", () => {
	fc.assert(
		fc.property(
			fc.oneof(fc.nat({ max: 1000000 }), fc.constant(Number.MAX_SAFE_INTEGER)),
			(seq) => {
				const message = create(ReplayReportSchema, {
					...report,
					seqVector: [{ streamId: "s", seq: BigInt(seq) }],
				});
				expect(
					parseReplayReportProtoJson(toJson(ReplayReportSchema, message))
						.seqVector[0]?.seq,
				).toBe(seq);
				expect(
					parseReplayReportBinary(toBinary(ReplayReportSchema, message))
						.seqVector[0]?.seq,
				).toBe(seq);
			},
		),
		{ seed: 614615, numRuns: 100 },
	);
});
