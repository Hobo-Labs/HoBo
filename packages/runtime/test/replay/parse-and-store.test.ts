/**
 * The replay report/divergence parse boundary and the event-store readers.
 *
 * A `ReplayReport` is the artifact that says "this run replayed to the same
 * state it lived through". Everything downstream treats a parsed report as
 * evidence, so a parser that accepted a malformed one would let a run be
 * certified on a record nobody wrote — the digest could be truncated, the seq
 * vector could name one stream twice, the mode could say `live` for a replay.
 *
 * The divergence record has a sharper requirement still: it exists only to
 * describe a *disagreement*, so a record whose two digests are equal is
 * self-contradictory and is refused rather than stored as a divergence with
 * nothing divergent in it.
 */
import { describe, expect, it } from "vitest";

import {
	parseReplayDivergence,
	parseReplayReport,
	ReplayParseError,
} from "../../src/replay/parse.js";
import {
	createEventStoreReader,
	createInMemoryEventStore,
} from "../../src/replay/store.js";

const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);

const REPORT = {
	run_id: "run-1",
	seed: "seed-1",
	mode: "replay",
	seq_vector: [{ stream_id: "s1", seq: 3 }],
	read_set_hash: DIGEST_A,
	state_digest: DIGEST_B,
};

const DIVERGENCE = {
	run_id: "run-1",
	live_state_digest: DIGEST_A,
	replay_state_digest: DIGEST_B,
	live_order: ["s1:1", "s1:2"],
	replay_order: ["s1:2", "s1:1"],
	first_divergent_event_key: "s1:1",
};

function messageOf(thunk: () => unknown): string {
	try {
		thunk();
	} catch (error) {
		expect(error).toBeInstanceOf(ReplayParseError);
		return (error as Error).message;
	}
	return expect.unreachable("expected a ReplayParseError") as never;
}

function envelope(overrides: Record<string, unknown> = {}) {
	return {
		id: "01",
		streamId: "s1",
		seq: 1,
		type: "greeting.Served",
		v: 1,
		data: { name: "a" },
		ts: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

describe("parseReplayReport", () => {
	it("parses a snake_case report and freezes it", () => {
		const report = parseReplayReport(REPORT);
		expect(report.runId).toBe("run-1");
		expect(report.mode).toBe("replay");
		expect(report.stateDigest).toBe(DIGEST_B);
		expect(Object.isFrozen(report)).toBe(true);
	});

	it("accepts camelCase for every dual-spelled field", () => {
		// Both spellings exist because the report crosses a wire boundary in
		// snake_case but is authored in TypeScript in camelCase. Accepting only
		// one would make a report round-trip lossy in whichever direction lost.
		const report = parseReplayReport({
			runId: "run-1",
			seed: "seed-1",
			mode: "live",
			seqVector: [{ streamId: "s1", seq: 0 }],
			readSetHash: DIGEST_A,
			stateDigest: DIGEST_B,
		});
		expect(report.runId).toBe("run-1");
		expect(report.seqVector).toEqual([{ streamId: "s1", seq: 0 }]);
	});

	it("prefers the snake_case spelling when both are present", () => {
		// `snake ?? camel`, so the wire form wins. Pinned because the alternative
		// would silently prefer a locally-constructed value over the one that
		// actually arrived.
		expect(parseReplayReport({ ...REPORT, runId: "other" }).runId).toBe(
			"run-1",
		);
	});

	it("copies the seq vector rather than aliasing the input", () => {
		// `[...seqVector]`. A parsed report is evidence; aliasing would let the
		// caller's array mutate the record after it was accepted.
		const input = { ...REPORT, seq_vector: [{ stream_id: "s1", seq: 3 }] };
		const report = parseReplayReport(input);
		input.seq_vector.push({ stream_id: "s2", seq: 1 });
		expect(report.seqVector).toHaveLength(1);
	});

	it("refuses a non-object, an array and a null", () => {
		for (const bad of [null, undefined, 7, "report", []]) {
			expect(messageOf(() => parseReplayReport(bad))).toContain(
				"ReplayReport must be an object",
			);
		}
	});

	it("accepts only live and replay as the mode", () => {
		// The mode decides how the report is read. A report labelled `live` that
		// was actually a replay would be counted as the baseline it was supposed
		// to be compared against.
		expect(parseReplayReport({ ...REPORT, mode: "live" }).mode).toBe("live");
		for (const bad of ["Live", "replaying", "", 7, undefined]) {
			expect(messageOf(() => parseReplayReport({ ...REPORT, mode: bad }))).toBe(
				'mode must be "live" or "replay"',
			);
		}
	});

	it("requires each digest to be 64 lowercase hex characters", () => {
		// Strict on length and case: a truncated digest would let two different
		// states share a prefix and compare equal, and an uppercase one would
		// compare unequal to the same digest written the usual way.
		for (const field of ["read_set_hash", "state_digest"] as const) {
			for (const bad of [
				"a".repeat(63),
				"a".repeat(65),
				"A".repeat(64),
				`sha256:${"a".repeat(64)}`,
				"",
				7,
			]) {
				expect(
					messageOf(() => parseReplayReport({ ...REPORT, [field]: bad })),
				).toContain(field);
			}
		}
	});

	it("requires a non-empty run id and seed", () => {
		// The seed is what makes the run reproducible; the run id is what ties
		// the report to the run. A report missing either is unverifiable.
		expect(messageOf(() => parseReplayReport({ ...REPORT, run_id: "" }))).toBe(
			"run_id must be a non-empty string",
		);
		expect(messageOf(() => parseReplayReport({ ...REPORT, seed: 7 }))).toBe(
			"seed must be a non-empty string",
		);
	});

	it("requires the seq vector to be an array of objects", () => {
		for (const bad of [undefined, {}, "s1:1"]) {
			expect(
				messageOf(() => parseReplayReport({ ...REPORT, seq_vector: bad })),
			).toBe("seq_vector must be an array");
		}
		expect(
			messageOf(() => parseReplayReport({ ...REPORT, seq_vector: [7] })),
		).toContain("seq_vector[0] must be an object");
	});

	it("accepts an empty seq vector", () => {
		// A run that read nothing is a legitimate run, and refusing it would make
		// the first report of a fresh stream unparseable.
		expect(parseReplayReport({ ...REPORT, seq_vector: [] }).seqVector).toEqual(
			[],
		);
	});

	it("refuses a duplicated stream id, naming it", () => {
		// A seq vector is a map from stream to position. Two entries for one
		// stream means the report cannot say where that stream was read to, and
		// whichever entry won would be arbitrary.
		expect(
			messageOf(() =>
				parseReplayReport({
					...REPORT,
					seq_vector: [
						{ stream_id: "s1", seq: 1 },
						{ stream_id: "s1", seq: 2 },
					],
				}),
			),
		).toBe("duplicate stream_id s1");
	});

	it("accepts seq zero but refuses negative, fractional and non-numeric", () => {
		// Zero is "read nothing from this stream", which is meaningful. A
		// fractional seq would never match a real event's seq and would make
		// every comparison against it silently false.
		expect(
			parseReplayReport({
				...REPORT,
				seq_vector: [{ stream_id: "s1", seq: 0 }],
			}).seqVector[0]?.seq,
		).toBe(0);
		for (const bad of [-1, 1.5, Number.NaN, "3", undefined]) {
			expect(
				messageOf(() =>
					parseReplayReport({
						...REPORT,
						seq_vector: [{ stream_id: "s1", seq: bad }],
					}),
				),
			).toBe("seq must be a non-negative integer");
		}
	});

	it("freezes each seq vector entry", () => {
		expect(Object.isFrozen(parseReplayReport(REPORT).seqVector[0])).toBe(true);
	});
});

describe("parseReplayDivergence", () => {
	it("parses a divergence record and freezes it", () => {
		const record = parseReplayDivergence(DIVERGENCE);
		expect(record.runId).toBe("run-1");
		expect(record.liveStateDigest).toBe(DIGEST_A);
		expect(record.replayStateDigest).toBe(DIGEST_B);
		expect(record.firstDivergentEventKey).toBe("s1:1");
		expect(Object.isFrozen(record)).toBe(true);
	});

	it("accepts camelCase throughout", () => {
		const record = parseReplayDivergence({
			runId: "run-1",
			liveStateDigest: DIGEST_A,
			replayStateDigest: DIGEST_B,
			liveOrder: ["s1:1"],
			replayOrder: ["s1:2"],
			firstDivergentEventKey: "s1:1",
		});
		expect(record.liveOrder).toEqual(["s1:1"]);
	});

	it("refuses a record whose two digests agree", () => {
		// The self-contradiction check, and the most valuable assertion here: a
		// divergence record with matching digests describes no divergence. Storing
		// one would put a phantom failure in the run's history that nobody can
		// reproduce, because there is nothing to reproduce.
		expect(
			messageOf(() =>
				parseReplayDivergence({
					...DIVERGENCE,
					replay_state_digest: DIGEST_A,
				}),
			),
		).toBe("ReplayDivergence requires differing state digests");
	});

	it("refuses a non-object", () => {
		for (const bad of [null, undefined, [], "record"]) {
			expect(messageOf(() => parseReplayDivergence(bad))).toContain(
				"ReplayDivergence must be an object",
			);
		}
	});

	it("requires both digests to be well-formed hex", () => {
		expect(
			messageOf(() =>
				parseReplayDivergence({ ...DIVERGENCE, live_state_digest: "nope" }),
			),
		).toContain("live_state_digest");
		expect(
			messageOf(() =>
				parseReplayDivergence({ ...DIVERGENCE, replay_state_digest: "" }),
			),
		).toContain("replay_state_digest");
	});

	it("requires both orders to be string arrays", () => {
		// The orders are the event keys as each side saw them; a non-string entry
		// would compare unequal to every real key and make the diff useless.
		for (const field of ["live_order", "replay_order"] as const) {
			for (const bad of [undefined, "s1:1", [1], [null]]) {
				expect(
					messageOf(() =>
						parseReplayDivergence({ ...DIVERGENCE, [field]: bad }),
					),
				).toBe(`${field} must be a string array`);
			}
		}
	});

	it("accepts empty orders", () => {
		const record = parseReplayDivergence({
			...DIVERGENCE,
			live_order: [],
			replay_order: [],
		});
		expect(record.liveOrder).toEqual([]);
	});

	it("requires a first divergent event key", () => {
		// The key is the whole point of the record: it says where to start
		// looking. A divergence with no starting point is a bug report with no
		// reproduction.
		expect(
			messageOf(() =>
				parseReplayDivergence({
					...DIVERGENCE,
					first_divergent_event_key: "",
				}),
			),
		).toBe("first_divergent_event_key must be a non-empty string");
	});

	it("copies the order arrays", () => {
		const input = { ...DIVERGENCE, live_order: ["s1:1"] };
		const record = parseReplayDivergence(input);
		input.live_order.push("s1:2");
		expect(record.liveOrder).toHaveLength(1);
	});
});

describe("createInMemoryEventStore", () => {
	it("appends and reads back a stream in order", async () => {
		const store = createInMemoryEventStore();
		await store.append(envelope({ seq: 1 }));
		await store.append(envelope({ seq: 2 }));
		const events = await store.readStream("s1");
		expect(events.map((event) => event.seq)).toEqual([1, 2]);
	});

	it("returns an empty array for an unknown stream", async () => {
		// Not a throw: a projector reading a stream that has not been written yet
		// is the normal cold-start case.
		expect(await createInMemoryEventStore().readStream("nope")).toEqual([]);
	});

	it("refuses a seq that is not exactly one past the head", async () => {
		// Contiguity is what makes a fold complete. A gap would be folded as
		// though the missing event never happened, and the resulting state would
		// differ from a replay that read the full stream.
		const store = createInMemoryEventStore();
		await store.append(envelope({ seq: 1 }));
		for (const seq of [1, 3, 0]) {
			await expect(store.append(envelope({ seq }))).rejects.toThrow(
				/invalid seq/u,
			);
		}
	});

	it("enforces optimistic concurrency when an expectedSeq is given", async () => {
		// The OCC check is what stops two writers from both appending seq 2. It
		// reports both the expected and the actual head so a caller can tell a
		// lost race from a bug in its own bookkeeping.
		const store = createInMemoryEventStore();
		await store.append(envelope({ seq: 1 }));
		await expect(store.append(envelope({ seq: 2 }), 0)).rejects.toThrow(
			/expected 0, got 1/u,
		);
		await expect(
			store.append(envelope({ seq: 2 }), 1),
		).resolves.toBeUndefined();
	});

	it("allows an unchecked append when no expectedSeq is given", async () => {
		// `expectedSeq !== undefined`, so omitting it opts out of OCC rather than
		// being read as expecting seq 0 — which would make every unchecked append
		// after the first one fail.
		const store = createInMemoryEventStore();
		await store.append(envelope({ seq: 1 }));
		await expect(store.append(envelope({ seq: 2 }))).resolves.toBeUndefined();
	});

	it("accepts expectedSeq zero for a fresh stream", async () => {
		const store = createInMemoryEventStore();
		await expect(
			store.append(envelope({ seq: 1 }), 0),
		).resolves.toBeUndefined();
	});

	it("freezes each stored event and hands back a copied list", async () => {
		// Both halves matter: a caller must not be able to rewrite history in
		// place, nor to splice the returned list and have the store forget.
		const store = createInMemoryEventStore();
		await store.append(envelope({ seq: 1 }));
		const events = await store.readStream("s1");
		expect(Object.isFrozen(events[0])).toBe(true);
		events.length = 0;
		expect(await store.readStream("s1")).toHaveLength(1);
	});

	it("keeps streams independent", async () => {
		// Each stream has its own seq space. Sharing one would make the second
		// stream's first event fail contiguity against the first stream's head.
		const store = createInMemoryEventStore();
		await store.append(envelope({ streamId: "a", seq: 1 }));
		await store.append(envelope({ streamId: "b", seq: 1 }));
		expect(await store.readStream("a")).toHaveLength(1);
		expect(await store.readStream("b")).toHaveLength(1);
	});

	it("finds an event by seq and returns null when absent", async () => {
		// Null rather than undefined, and null rather than a throw: "no event at
		// that position" is an answer, not a failure.
		const store = createInMemoryEventStore();
		await store.append(envelope({ seq: 1 }));
		expect((await store.readBySeq("s1", 1))?.seq).toBe(1);
		expect(await store.readBySeq("s1", 2)).toBeNull();
		expect(await store.readBySeq("nope", 1)).toBeNull();
	});
});

describe("createEventStoreReader", () => {
	function coreStore(events: Array<Record<string, unknown>>) {
		return {
			read(streamId: string, fromSeq?: number) {
				const matching = events.filter(
					(event) =>
						event.streamId === streamId &&
						(fromSeq === undefined || (event.seq as number) >= fromSeq),
				);
				return {
					async *[Symbol.asyncIterator]() {
						for (const event of matching) yield event;
					},
				};
			},
		} as never;
	}

	it("drains the async iterator into an array", async () => {
		// The core store exposes an async iterable; the replay engine wants a
		// list it can order and fold. Collecting here is what keeps the engine
		// free of transport concerns.
		const reader = createEventStoreReader(
			coreStore([envelope({ seq: 1 }), envelope({ seq: 2 })]),
		);
		expect((await reader.readStream("s1")).map((event) => event.seq)).toEqual([
			1, 2,
		]);
	});

	it("returns an empty array for a stream with no events", async () => {
		expect(
			await createEventStoreReader(coreStore([])).readStream("s1"),
		).toEqual([]);
	});

	it("projects only the replay envelope fields and freezes the result", async () => {
		// A narrowing projection, not a pass-through. Carrying an extra field
		// from the core envelope into the replay envelope would make it part of
		// the state digest and change every recorded digest.
		const reader = createEventStoreReader(
			coreStore([envelope({ extra: "should not survive" })]),
		);
		const [event] = await reader.readStream("s1");
		expect(Object.isFrozen(event)).toBe(true);
		expect(Object.hasOwn(event as object, "extra")).toBe(false);
		expect(Object.keys(event as object).sort()).toEqual([
			"data",
			"id",
			"seq",
			"streamId",
			"ts",
			"type",
			"v",
		]);
	});

	it("omits meta when the source event has none", async () => {
		// Conditional, so an absent `meta` stays absent rather than becoming a
		// present `undefined` — which would serialize differently and perturb the
		// digest for events that never carried metadata.
		const reader = createEventStoreReader(coreStore([envelope()]));
		const [event] = await reader.readStream("s1");
		expect(Object.hasOwn(event as object, "meta")).toBe(false);
	});

	it("carries meta through when present", async () => {
		const reader = createEventStoreReader(
			coreStore([envelope({ meta: { causationId: "c1" } })]),
		);
		const [event] = await reader.readStream("s1");
		expect(event?.meta).toEqual({ causationId: "c1" });
	});

	it("finds an event by seq, reading from that seq onward", async () => {
		const reader = createEventStoreReader(
			coreStore([envelope({ seq: 1 }), envelope({ seq: 2 })]),
		);
		expect((await reader.readBySeq("s1", 2))?.seq).toBe(2);
	});

	it("returns null when the requested seq is not in the stream", async () => {
		// The loop checks `event.seq === seq` rather than taking the first event
		// the store yields, because `read(streamId, fromSeq)` is a *from* — a
		// gap at the requested position would otherwise return the next event
		// under the wrong seq.
		const reader = createEventStoreReader(
			coreStore([envelope({ seq: 1 }), envelope({ seq: 3 })]),
		);
		expect(await reader.readBySeq("s1", 2)).toBeNull();
		expect(await reader.readBySeq("s1", 9)).toBeNull();
	});
});
