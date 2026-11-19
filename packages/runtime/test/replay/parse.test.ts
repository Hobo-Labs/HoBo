import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { ReplayDivergenceError } from "../../src/replay/divergence.js";
import { assertReplayEqualsLive } from "../../src/replay/equivalence.js";
import {
	parseReplayDivergence,
	parseReplayReport,
	ReplayParseError,
} from "../../src/replay/parse.js";

it("validates actual replay reports and divergence records against CUE", () => {
	const report = assertReplayEqualsLive({
		events: [
			{
				id: "event-1",
				streamId: "stream-1",
				seq: 1,
				type: "item.Added",
				data: {},
			},
		],
		initialState: { count: 0 },
		fold: (state) => ({ count: state.count + 1 }),
	});
	const divergence = new ReplayDivergenceError({
		runId: "run-1",
		liveState: { count: 1 },
		replayState: { count: 2 },
		liveOrder: ["stream-1:1"],
		replayOrder: ["stream-1:2"],
	}).divergence;
	const directory = mkdtempSync(join(tmpdir(), "hobo-replay-schema-"));
	try {
		const cue =
			process.env.HOBO_CUE_BIN ||
			fileURLToPath(
				new URL("../../../../.tools/cue/v0.14.0/cue", import.meta.url),
			);
		const schema = fileURLToPath(
			new URL("../../data-models/replay/replay_report.cue", import.meta.url),
		);
		for (const [name, value] of [
			["ReplayReport", report],
			["ReplayDivergence", divergence],
		] as const) {
			const path = join(directory, `${name}.json`);
			writeFileSync(path, JSON.stringify(value));
			execFileSync(cue, ["vet", schema, path, "-d", `#${name}`]);
		}
		expect(parseReplayReport(JSON.parse(JSON.stringify(report)))).toEqual(
			report,
		);
		expect(
			parseReplayDivergence(JSON.parse(JSON.stringify(divergence))),
		).toEqual(divergence);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("parseReplayReport", () => {
	it("accepts a valid report", () => {
		const digest = "a".repeat(64);
		const report = parseReplayReport({
			runId: "run-1",
			seqVector: [{ streamId: "run/run-1", seq: 3 }],
			readSetHash: digest,
			stateDigest: digest,
			mode: "replay",
			seed: "seed-1",
		});

		expect(report.runId).toBe("run-1");
		expect(report.mode).toBe("replay");
		expect(report.readSetHash).toBe(digest);
	});

	it("rejects malformed digests", () => {
		expect(() =>
			parseReplayReport({
				runId: "run-1",
				seqVector: [],
				readSetHash: "not-hex",
				stateDigest: "a".repeat(64),
				mode: "replay",
				seed: "seed",
			}),
		).toThrow(ReplayParseError);
	});
});

describe("parseReplayDivergence", () => {
	it("requires differing digests", () => {
		const digest = "b".repeat(64);
		expect(() =>
			parseReplayDivergence({
				runId: "run-1",
				liveStateDigest: digest,
				replayStateDigest: digest,
				liveOrder: ["a:1"],
				replayOrder: ["b:1"],
				firstDivergentEventKey: "a:1",
			}),
		).toThrow(ReplayParseError);
	});
});
