import type {
	EventEnvelope as CoreEventEnvelope,
	EventStore,
} from "@hobo/core";
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
	runId: "run-1",
	seed: "seed-1",
	mode: "replay",
	seqVector: [{ streamId: "s1", seq: 3 }],
	readSetHash: DIGEST_A,
	stateDigest: DIGEST_B,
};

const DIVERGENCE = {
	runId: "run-1",
	liveStateDigest: DIGEST_A,
	replayStateDigest: DIGEST_B,
	liveOrder: ["s1:1", "s1:2"],
	replayOrder: ["s1:2", "s1:1"],
	firstDivergentEventKey: "s1:1",
};

function messageOf(thunk: () => void): string {
	try {
		thunk();
	} catch (error) {
		expect(error).toBeInstanceOf(ReplayParseError);
		return (error as Error).message;
	}
	return expect.unreachable("expected a ReplayParseError") as never;
}

type FixtureEnvelope = CoreEventEnvelope<{ name: string }> & { extra?: string };

function envelope(overrides: Partial<FixtureEnvelope> = {}): FixtureEnvelope {
	return {
		id: "01",
		streamId: "s1",
		seq: 1,
		type: "greeting.Served",
		v: 1,
		data: { name: "a" },
		ts: "2026-01-01T00:00:00.000Z",
		actor: { kind: "system", id: "fixture" },
		tenant: "fixture",
		...overrides,
	};
}

describe("parseReplayReport", () => {
	it("parses a report and freezes it", () => {
		const report = parseReplayReport(REPORT);
		expect(report.runId).toBe("run-1");
		expect(report.mode).toBe("replay");
		expect(report.stateDigest).toBe(DIGEST_B);
		expect(Object.isFrozen(report)).toBe(true);
	});

	it("copies the seq vector rather than aliasing the input", () => {
		const input = { ...REPORT, seqVector: [{ streamId: "s1", seq: 3 }] };
		const report = parseReplayReport(input);
		input.seqVector.push({ streamId: "s2", seq: 1 });
		expect(report.seqVector).toHaveLength(1);
	});

	it("refuses a non-object, an array and a null", () => {
		for (const bad of [null, undefined, 7, "report", []]) {
			expect(messageOf(() => parseReplayReport(bad as never))).toContain(
				"ReplayReport must be an object",
			);
		}
	});

	it("accepts only live and replay as the mode", () => {
		expect(parseReplayReport({ ...REPORT, mode: "live" }).mode).toBe("live");
		for (const bad of ["Live", "replaying", "", 7, undefined]) {
			expect(
				messageOf(() => parseReplayReport({ ...REPORT, mode: bad } as never)),
			).toBe('mode must be "live" or "replay"');
		}
	});

	it("requires each digest to be 64 lowercase hex characters", () => {
		for (const field of ["readSetHash", "stateDigest"] as const) {
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
		expect(messageOf(() => parseReplayReport({ ...REPORT, runId: "" }))).toBe(
			"runId must be a non-empty string",
		);
		expect(messageOf(() => parseReplayReport({ ...REPORT, seed: 7 }))).toBe(
			"seed must be a non-empty string",
		);
	});

	it("requires the seq vector to be an array of objects", () => {
		for (const bad of [undefined, {}, "s1:1"]) {
			expect(
				messageOf(() =>
					parseReplayReport({ ...REPORT, seqVector: bad } as never),
				),
			).toBe("seqVector must be an array");
		}
		expect(
			messageOf(() => parseReplayReport({ ...REPORT, seqVector: [7] })),
		).toContain("seqVector[0] must be an object");
	});

	it("accepts an empty seq vector", () => {
		expect(parseReplayReport({ ...REPORT, seqVector: [] }).seqVector).toEqual(
			[],
		);
	});

	it("refuses a duplicated stream id, naming it", () => {
		expect(
			messageOf(() =>
				parseReplayReport({
					...REPORT,
					seqVector: [
						{ streamId: "s1", seq: 1 },
						{ streamId: "s1", seq: 2 },
					],
				}),
			),
		).toBe("duplicate streamId s1");
	});

	it("accepts seq zero but refuses negative, fractional and non-numeric", () => {
		expect(
			parseReplayReport({
				...REPORT,
				seqVector: [{ streamId: "s1", seq: 0 }],
			}).seqVector[0]?.seq,
		).toBe(0);
		for (const bad of [
			-1,
			1.5,
			Number.NaN,
			Number.MAX_SAFE_INTEGER + 1,
			"3",
			undefined,
		]) {
			expect(
				messageOf(() =>
					parseReplayReport({
						...REPORT,
						seqVector: [{ streamId: "s1", seq: bad }],
					} as never),
				),
			).toBe("seq must be a non-negative integer");
		}
	});

	it("rejects fields outside the report schema", () => {
		expect(() => parseReplayReport({ ...REPORT, extra: true })).toThrow(
			"ReplayReport has an unexpected field: extra",
		);
		expect(() =>
			parseReplayReport({
				...REPORT,
				seqVector: [{ streamId: "s1", seq: 1, extra: true }],
			}),
		).toThrow("seqVector[0] has an unexpected field: extra");
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

	it("refuses a record whose two digests agree", () => {
		expect(
			messageOf(() =>
				parseReplayDivergence({
					...DIVERGENCE,
					replayStateDigest: DIGEST_A,
				}),
			),
		).toBe("ReplayDivergence requires differing state digests");
	});

	it("refuses a non-object", () => {
		for (const bad of [null, undefined, [], "record"]) {
			expect(messageOf(() => parseReplayDivergence(bad as never))).toContain(
				"ReplayDivergence must be an object",
			);
		}
	});

	it("requires both digests to be well-formed hex", () => {
		expect(
			messageOf(() =>
				parseReplayDivergence({ ...DIVERGENCE, liveStateDigest: "nope" }),
			),
		).toContain("liveStateDigest");
		expect(
			messageOf(() =>
				parseReplayDivergence({ ...DIVERGENCE, replayStateDigest: "" }),
			),
		).toContain("replayStateDigest");
	});

	it("requires both orders to be string arrays", () => {
		for (const field of ["liveOrder", "replayOrder"] as const) {
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
			liveOrder: [],
			replayOrder: [],
		});
		expect(record.liveOrder).toEqual([]);
	});

	it("requires a first divergent event key", () => {
		expect(
			messageOf(() =>
				parseReplayDivergence({
					...DIVERGENCE,
					firstDivergentEventKey: "",
				}),
			),
		).toBe("firstDivergentEventKey must be a non-empty string");
	});

	it("copies the order arrays", () => {
		const input = { ...DIVERGENCE, liveOrder: ["s1:1"] };
		const record = parseReplayDivergence(input);
		input.liveOrder.push("s1:2");
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
		expect(await createInMemoryEventStore().readStream("nope")).toEqual([]);
	});

	it("refuses a seq that is not exactly one past the head", async () => {
		const store = createInMemoryEventStore();
		await store.append(envelope({ seq: 1 }));
		for (const seq of [1, 3, 0]) {
			await expect(store.append(envelope({ seq }))).rejects.toThrow(
				/invalid seq/u,
			);
		}
	});

	it("enforces optimistic concurrency when an expectedSeq is given", async () => {
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
		const store = createInMemoryEventStore();
		await store.append(envelope({ seq: 1 }));
		const events = await store.readStream("s1");
		expect(Object.isFrozen(events[0])).toBe(true);
		events.length = 0;
		expect(await store.readStream("s1")).toHaveLength(1);
	});

	it("keeps streams independent", async () => {
		const store = createInMemoryEventStore();
		await store.append(envelope({ streamId: "a", seq: 1 }));
		await store.append(envelope({ streamId: "b", seq: 1 }));
		expect(await store.readStream("a")).toHaveLength(1);
		expect(await store.readStream("b")).toHaveLength(1);
	});

	it("finds an event by seq and returns null when absent", async () => {
		const store = createInMemoryEventStore();
		await store.append(envelope({ seq: 1 }));
		expect((await store.readBySeq("s1", 1))?.seq).toBe(1);
		expect(await store.readBySeq("s1", 2)).toBeNull();
		expect(await store.readBySeq("nope", 1)).toBeNull();
	});
});

describe("createEventStoreReader", () => {
	function coreStore(events: FixtureEnvelope[]): EventStore {
		return {
			read(streamId: string, fromSeq?: number) {
				const matching = events.filter(
					(event) =>
						event.streamId === streamId &&
						(fromSeq === undefined || event.seq >= fromSeq),
				);
				return {
					async *[Symbol.asyncIterator]() {
						for (const event of matching) yield event;
					},
				};
			},
			async append() {
				throw new Error("replay reader fixture cannot append");
			},
			subscribe() {
				throw new Error("replay reader fixture cannot subscribe");
			},
			async snapshot() {
				throw new Error("replay reader fixture cannot write snapshots");
			},
		};
	}

	it("drains the async iterator into an array", async () => {
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
		const reader = createEventStoreReader(
			coreStore([envelope({ seq: 1 }), envelope({ seq: 3 })]),
		);
		expect(await reader.readBySeq("s1", 2)).toBeNull();
		expect(await reader.readBySeq("s1", 9)).toBeNull();
	});
});
