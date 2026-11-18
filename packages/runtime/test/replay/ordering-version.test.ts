import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { create, fromBinary, toBinary, toJson } from "@bufbuild/protobuf";
import fc from "fast-check";
import { expect, it } from "vitest";
import {
	ReplayDivergenceSchema,
	ReplayReportSchema,
} from "../../src/_generated/replay/replay_report_pb.js";
import {
	digest,
	digestForVersion,
	ReplayDivergenceError,
} from "../../src/replay/divergence.js";
import {
	assertReplayEqualsLive,
	compareCanonicalEventOrder,
	stableStringify,
	stableStringifyForVersion,
	stableValue,
} from "../../src/replay/equivalence.js";
import {
	parseReplayDivergence,
	parseReplayReport,
} from "../../src/replay/parse.js";
import {
	replayRun,
	type WorkflowReplayContext,
} from "../../src/replay/replayer.js";

const state = { ä: 2, z: 3, a: 1 };

it("canonicalizes equivalent Unicode keys independently of insertion order", () => {
	const first = { é: 1, "e\u0301": 2 };
	const second = { "e\u0301": 2, é: 1 };
	expect(stableStringify(first)).toBe(stableStringify(second));
	expect(digest(first)).toBe(digest(second));
});

it("produces the same new canonical bytes, digest and event ordering under different locales", () => {
	const helper = fileURLToPath(
		new URL("./helpers/ordering-probe.ts", import.meta.url),
	);
	const outputs = ["en_US.UTF-8", "sv_SE.UTF-8"].map((locale) =>
		spawnSync(process.execPath, ["--import", "tsx", helper], {
			encoding: "utf8",
			env: { ...process.env, LC_ALL: locale },
		}),
	);
	for (const result of outputs) expect(result.status, result.stderr).toBe(0);
	const [english, swedish] = outputs.map((result) => JSON.parse(result.stdout));
	expect(english.canonical).toBe(swedish.canonical);
	expect(english.digest).toBe(swedish.digest);
	expect(english.order).toEqual(swedish.order);
	expect(english.legacy).not.toBe(swedish.legacy);
	expect(english.legacyOrder).not.toEqual(swedish.legacyOrder);
});

it("marks new reports and interprets unmarked reports as legacy", () => {
	const fresh = assertReplayEqualsLive({
		events: [],
		initialState: state,
		fold: (current) => current,
	});
	expect(fresh.canonicalizationVersion).toBe(2);
	const raw = {
		runId: "run",
		seqVector: [],
		readSetHash: "a".repeat(64),
		stateDigest: "b".repeat(64),
		mode: "replay",
		seed: "seed",
	};
	expect(parseReplayReport(raw).canonicalizationVersion).toBe(1);
	expect(
		parseReplayReport({ ...raw, canonicalizationVersion: 2 })
			.canonicalizationVersion,
	).toBe(2);
	expect(() =>
		parseReplayReport({ ...raw, canonicalizationVersion: 3 }),
	).toThrow(/canonicalization/i);
});

it("retains the original locale-sensitive encoding when legacy is requested", () => {
	const legacy = JSON.stringify(
		Object.fromEntries(
			Object.entries(state).sort(([left], [right]) =>
				left.localeCompare(right),
			),
		),
	);
	expect(stableStringifyForVersion(state, 1)).toBe(legacy);
	const report = assertReplayEqualsLive({
		events: [],
		initialState: state,
		fold: (current) => current,
		canonicalizationVersion: 1,
	});
	expect(report.canonicalizationVersion).toBe(1);
	expect(report.stateDigest).toBe(digestForVersion(state, 1));
	const tied = { é: 1, "e\u0301": 2 };
	expect("é".localeCompare("e\u0301")).toBe(0);
	expect(stableStringifyForVersion(tied, 1)).not.toBe(stableStringify(tied));
});

it("is insertion independent for generated Unicode keys and event orders", () => {
	fc.assert(
		fc.property(
			fc.uniqueArray(
				fc.constantFrom(
					"a",
					"z",
					"ä",
					"é",
					"e\u0301",
					"__proto__",
					"constructor",
					"2",
				),
				{ minLength: 1 },
			),
			(keys) => {
				const entries = keys.map((key) => [key, `value:${key}`] as const);
				const left = Object.fromEntries(entries);
				const right = Object.fromEntries([...entries].reverse());
				expect(stableStringify(left)).toBe(stableStringify(right));
				expect(digest(left)).toBe(digest(right));
				const events = keys.map((streamId) => ({
					id: streamId,
					streamId,
					seq: 1,
					type: "value",
					data: null,
				}));
				expect([...events].sort(compareCanonicalEventOrder)).toEqual(
					[...events].reverse().sort(compareCanonicalEventOrder),
				);
			},
		),
		{ seed: 614614, numRuns: 150 },
	);
});

it("orders distinct Map entries consistently when their keys encode alike", () => {
	const a = new Map([
		[{ x: 1 }, "a"],
		[{ x: 1 }, "b"],
	]);
	const b = new Map([...a.entries()].reverse());
	// SAFETY: this deliberately exercises the runtime's Map branch beyond its JSON type.
	const first = stableValue(a as never);
	// SAFETY: this deliberately exercises the runtime's Map branch beyond its JSON type.
	const second = stableValue(b as never);
	expect(JSON.stringify(first)).toBe(JSON.stringify(second));
});

it("preserves callback use of the existing unary helpers", () => {
	const states = [state, { a: 4 }];
	expect(states.map(stableStringify)).toEqual(
		states.map((entry) => stableStringify(entry)),
	);
	expect(states.map(stableValue)).toEqual(
		states.map((entry) => stableValue(entry)),
	);
	expect(states.map(digest)).toEqual(states.map((entry) => digest(entry)));
});

it("round trips report and divergence version markers on the protobuf wire", () => {
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
		liveOrder: ["a"],
		replayOrder: ["b"],
		firstDivergentEventKey: "a",
	};
	for (const version of [undefined, 1, 2] as const) {
		const encodedReport = create(ReplayReportSchema, {
			...report,
			canonicalizationVersion: version,
		});
		const decodedReport = fromBinary(
			ReplayReportSchema,
			toBinary(ReplayReportSchema, encodedReport),
		);
		expect(decodedReport.canonicalizationVersion).toBe(version);
		expect(
			parseReplayReport(
				toJson(ReplayReportSchema, decodedReport, { alwaysEmitImplicit: true }),
			).canonicalizationVersion,
		).toBe(version ?? 1);
		const encodedDivergence = create(ReplayDivergenceSchema, {
			...divergence,
			canonicalizationVersion: version,
		});
		const decodedDivergence = fromBinary(
			ReplayDivergenceSchema,
			toBinary(ReplayDivergenceSchema, encodedDivergence),
		);
		expect(decodedDivergence.canonicalizationVersion).toBe(version);
		expect(
			parseReplayDivergence(toJson(ReplayDivergenceSchema, decodedDivergence))
				.canonicalizationVersion,
		).toBe(version ?? 1);
	}
});

it("rejects invalid or conflicting versions rather than reinterpreting them", async () => {
	const raw = {
		runId: "run",
		seqVector: [],
		readSetHash: "a".repeat(64),
		stateDigest: "b".repeat(64),
		mode: "replay",
		seed: "seed",
	};
	for (const version of [null, 0, 3, "2"]) {
		expect(() =>
			parseReplayReport({ ...raw, canonicalization_version: version }),
		).toThrow(/canonicalization/i);
		// SAFETY: intentionally pass invalid JavaScript values to test runtime validation.
		expect(() => stableStringifyForVersion(state, version as never)).toThrow(
			/canonicalization/i,
		);
	}
	expect(() =>
		parseReplayReport({
			...raw,
			canonicalization_version: 1,
			canonicalizationVersion: 2,
		}),
	).toThrow(/canonicalization/i);
	let reads = 0;
	const reader = {
		readStream: async () => {
			reads++;
			return [];
		},
		readBySeq: async () => null,
	};
	const workflow = {
		name: "version",
		initialState: () => null,
		execute: () => null,
	};
	await expect(
		replayRun(reader, "run", workflow, null, {
			// SAFETY: intentionally pass an unsupported version to test runtime validation.
			canonicalizationVersion: 3 as never,
		}),
	).rejects.toThrow(/canonicalization/i);
	expect(reads).toBe(0);
});

it("uses the requested version in workflow and divergence reports", async () => {
	const workflowState = { é: 1, "e\u0301": 2 };
	const workflow = {
		name: "version",
		initialState: () => workflowState,
		execute: (_ctx: WorkflowReplayContext, current: typeof workflowState) =>
			current,
	};
	const reader = {
		readStream: async () => [
			{
				id: "s",
				streamId: "run/run",
				seq: 1,
				type: "run.Started",
				data: { args: null, workflowName: "version", seed: "seed" },
			},
		],
		readBySeq: async () => null,
	};
	for (const version of [1, 2] as const) {
		const { report } = await replayRun(reader, "run", workflow, null, {
			canonicalizationVersion: version,
		});
		expect(report.canonicalizationVersion).toBe(version);
		expect(report.stateDigest).toBe(digestForVersion(workflowState, version));
		const divergence = new ReplayDivergenceError({
			runId: "run",
			liveState: state,
			replayState: {},
			liveOrder: [],
			replayOrder: [],
			canonicalizationVersion: version,
		}).divergence;
		expect(divergence.canonicalizationVersion).toBe(version);
		expect(divergence.liveStateDigest).toBe(digestForVersion(state, version));
	}
});

it("carries the requested version into a harness divergence", () => {
	const events = ["b", "a"].map((streamId) => ({
		id: streamId,
		streamId,
		seq: 1,
		type: "value",
		data: null,
	}));
	for (const version of [1, 2] as const) {
		try {
			assertReplayEqualsLive({
				events,
				initialState: "",
				fold: (current, event) => current + event.streamId,
				canonicalizationVersion: version,
			});
			expect.fail("expected different fold orders to diverge");
		} catch (error) {
			if (!(error instanceof ReplayDivergenceError)) throw error;
			expect(error.divergence.canonicalizationVersion).toBe(version);
			expect(error.divergence.liveStateDigest).toBe(
				digestForVersion("ba", version),
			);
		}
	}
});

it("uses the requested ordering for event and sequence-vector ties", () => {
	const events = ["é", "e\u0301"].map((streamId) => ({
		id: streamId,
		streamId,
		seq: 1,
		type: "value",
		data: null,
	}));
	const input = {
		events,
		initialState: "",
		fold: (current: string, event: { streamId: string }) =>
			current + event.streamId,
	};
	expect(() =>
		assertReplayEqualsLive({ ...input, canonicalizationVersion: 1 }),
	).not.toThrow();
	const legacy = assertReplayEqualsLive({
		...input,
		canonicalizationVersion: 1,
	});
	expect(legacy.seqVector.map((entry) => entry.streamId)).toEqual([
		"é",
		"e\u0301",
	]);
	expect(() =>
		assertReplayEqualsLive({ ...input, canonicalizationVersion: 2 }),
	).toThrow(ReplayDivergenceError);
});
