import fc from "fast-check";
import { expect, it } from "vitest";
import {
	assertReplayEqualsLive,
	seqVector,
} from "../../src/replay/equivalence.js";
import { parseReplayReport } from "../../src/replay/parse.js";
import { replayRun } from "../../src/replay/replayer.js";

function event(seq: number) {
	return { id: "one", streamId: "stream", seq, type: "value", data: null };
}

function report(seq: number) {
	return {
		run_id: "run",
		seq_vector: [{ stream_id: "stream", seq }],
		read_set_hash: "a".repeat(64),
		state_digest: "b".repeat(64),
		mode: "replay",
		seed: "seed",
	};
}

it("refuses invalid event and target sequences before a fold runs", () => {
	let calls = 0;
	const fold = () => {
		calls++;
		return null;
	};
	for (const seq of [
		-1,
		0.5,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		Number.MAX_SAFE_INTEGER + 1,
	]) {
		expect(() => seqVector([event(seq)])).toThrow(/safe integer/i);
		expect(() =>
			assertReplayEqualsLive({
				events: [event(seq)],
				targetSeq: { stream: 1 },
				initialState: null,
				fold,
			}),
		).toThrow(/safe integer/i);
		expect(() =>
			assertReplayEqualsLive({
				events: [event(1)],
				targetSeq: { stream: seq },
				initialState: null,
				fold,
			}),
		).toThrow(/safe integer/i);
	}
	expect(calls).toBe(0);
});

it("rejects unsafe report positions while preserving valid endpoints", () => {
	expect(() => parseReplayReport(report(Number.MAX_SAFE_INTEGER + 1))).toThrow(
		/safe integer/i,
	);
	for (const value of [0, Number.MAX_SAFE_INTEGER]) {
		expect(parseReplayReport(report(value)).seqVector[0]?.seq).toBe(value);
		expect(seqVector([event(value)]).stream).toBe(value);
		expect(
			assertReplayEqualsLive({
				events: [event(value)],
				targetSeq: { stream: value },
				initialState: 0,
				fold: (count) => count + 1,
			}).seqVector[0]?.seq,
		).toBe(value);
	}
});

it("refuses invalid legacy journal sequences before replay callbacks", async () => {
	let calls = 0;
	const workflow = {
		name: "legacy-sequence",
		initialState: () => {
			calls++;
			return null;
		},
		execute: () => {
			calls++;
			return null;
		},
	};
	const reader = {
		readStream: async () => [
			{
				id: "start",
				streamId: "run/legacy",
				seq: Number.MAX_SAFE_INTEGER + 1,
				type: "run.Started",
				data: { args: null, workflowName: "legacy-sequence", seed: "s" },
			},
		],
		readBySeq: async () => null,
	};
	await expect(replayRun(reader, "legacy", workflow, null)).rejects.toThrow(
		/safe integer/i,
	);
	expect(calls).toBe(0);
});

it("retains generated safe positions and rejects generated unsafe positions", () => {
	fc.assert(
		fc.property(
			fc.oneof(
				fc.nat({ max: 1_000_000 }),
				fc.constant(Number.MAX_SAFE_INTEGER),
			),
			(seq) => {
				expect(seqVector([event(seq)]).stream).toBe(seq);
				expect(parseReplayReport(report(seq)).seqVector[0]?.seq).toBe(seq);
			},
		),
		{ seed: 614612, numRuns: 100 },
	);
	fc.assert(
		fc.property(fc.integer({ min: 1, max: 10_000 }), (offset) => {
			const unsafe = Number.MAX_SAFE_INTEGER + offset;
			expect(() => seqVector([event(unsafe)])).toThrow(/safe integer/i);
			expect(() => parseReplayReport(report(unsafe))).toThrow(/safe integer/i);
		}),
		{ seed: 614613, numRuns: 100 },
	);
});
