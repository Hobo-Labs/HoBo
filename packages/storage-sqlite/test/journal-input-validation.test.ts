/**
 * Journal input validation and the optional-column round trip.
 *
 * Every refusal here happens *before* anything is written, which is the point:
 * once a malformed event is in the log it is there forever, and a replay years
 * later has to make sense of it. The optional-column assertions guard the
 * other direction — SQLite has one absent value and the envelope has two, so a
 * column that round-trips as `null` where the writer meant "absent" changes
 * what a consumer sees on every read.
 */
import { describe, expect, it } from "vitest";

import { createMemoryNodeSqliteDriver, SqliteJournal } from "../src/index.js";

const clock = { now: () => "2026-07-27T12:00:00.000Z" };
const actor = { kind: "system" as const, id: "test" };

function journal(): SqliteJournal {
	return new SqliteJournal(createMemoryNodeSqliteDriver(), {
		clock,
		nativePragmas: false,
	});
}

/** `read` is an async iterator; collect it. */
async function readAll(j: SqliteJournal, streamId: string) {
	const events = [];
	for await (const event of j.read(streamId)) events.push(event);
	return events;
}

function baseOpts(overrides: Record<string, unknown> = {}) {
	return { expectedSeq: 0, actor, tenant: "t", ...overrides } as never;
}

describe("event batch validation", () => {
	it("refuses a non-array batch", async () => {
		const j = journal();
		try {
			for (const events of [undefined, null, {}, "event"]) {
				await expect(
					j.append("s1", events as never, baseOpts()),
				).rejects.toThrowError(/events must be an array/u);
			}
		} finally {
			j.close();
		}
	});

	it("accepts an empty batch", async () => {
		const j = journal();
		try {
			// An empty append is a legitimate no-op — a command that decided
			// nothing happened must not have to special-case the call.
			const result = await j.append("s1", [], baseOpts());
			// `appended` and `deduped` are the envelope *arrays*, not counts — the
			// caller gets back the events as written (with ids, positions and
			// timestamps assigned), which is what it needs to publish them.
			expect(result.appended).toEqual([]);
			expect(result.deduped).toEqual([]);
			expect(j.getStreamHead("s1")).toBeUndefined();
		} finally {
			j.close();
		}
	});

	it("refuses a non-object event inside the batch", async () => {
		const j = journal();
		try {
			for (const event of [null, "a.A", 7, undefined]) {
				await expect(
					j.append("s1", [event] as never, baseOpts()),
				).rejects.toThrowError(/event must be an object/u);
			}
		} finally {
			j.close();
		}
	});

	it("refuses an event with no type", async () => {
		const j = journal();
		try {
			for (const type of ["", undefined, null, 7]) {
				// The type is how every consumer dispatches. An event with none is
				// unreadable by construction, and it would be unreadable forever.
				await expect(
					j.append("s1", [{ type, data: {} }] as never, baseOpts()),
				).rejects.toThrowError(/event\.type must be a non-empty string/u);
			}
		} finally {
			j.close();
		}
	});

	it("defaults the event version to 1 and refuses a bad one", async () => {
		const j = journal();
		try {
			await j.append("s1", [{ type: "a.A", data: {} }], baseOpts());
			const read = j.getStreamHead("s1");
			expect(read?.revision).toBe(1);

			for (const v of [0, -1, 1.5, "1", Number.NaN, 2 ** 53]) {
				// The version selects the upcaster on read. A zero or fractional one
				// would match no migration and quarantine the event on every replay.
				await expect(
					j.append("s2", [{ type: "a.A", v, data: {} }] as never, baseOpts()),
				).rejects.toThrowError(/event\.v must be a positive safe integer/u);
			}
		} finally {
			j.close();
		}
	});

	it("refuses an empty stream id", async () => {
		const j = journal();
		try {
			for (const streamId of ["", undefined, null, 7]) {
				await expect(
					j.append(streamId as never, [{ type: "a.A", data: {} }], baseOpts()),
				).rejects.toThrowError(/streamId must be a non-empty string/u);
			}
		} finally {
			j.close();
		}
	});

	it("defaults absent data to an empty object", async () => {
		const j = journal();
		try {
			await j.append("s1", [{ type: "a.A" }] as never, baseOpts());
			const events = await readAll(j, "s1");
			// Absent data becomes `{}` rather than `undefined`, so a fold that
			// reads `event.data.x` gets a miss instead of a TypeError.
			expect(events[0]?.data).toEqual({});
		} finally {
			j.close();
		}
	});

	it("clones data and meta so a caller cannot mutate what was written", async () => {
		const j = journal();
		try {
			const data = { nested: { value: 1 } };
			await j.append("s1", [{ type: "a.A", data }], baseOpts());
			data.nested.value = 999;
			const events = await readAll(j, "s1");
			// The log is immutable by contract. Holding a live reference into a
			// written event would let a caller rewrite history in memory.
			expect((events[0]?.data as typeof data).nested.value).toBe(1);
		} finally {
			j.close();
		}
	});

	it("lifts an idempotency key out of meta", async () => {
		const j = journal();
		try {
			const first = await j.append(
				"s1",
				[{ type: "a.A", data: {}, meta: { idempotencyKey: "k1" } }],
				baseOpts(),
			);
			expect(first.appended).toHaveLength(1);

			const retry = await j.append(
				"s1",
				[{ type: "a.A", data: {}, meta: { idempotencyKey: "k1" } }],
				baseOpts({ expectedSeq: 1 }),
			);
			// The key is what makes a retried command safe. Without dedup, a
			// network retry would double-apply the effect the event represents.
			expect(retry.deduped).toHaveLength(1);
			expect(retry.appended).toEqual([]);
			// The stream did not grow: dedup is a no-op append, not a second write
			// that happens to carry the same key.
			expect(j.getStreamHead("s1")?.revision).toBe(1);
		} finally {
			j.close();
		}
	});

	it("ignores an empty or non-string idempotency key", async () => {
		const j = journal();
		try {
			// `""` is not a key. Treating it as one would collapse every
			// keyless event in a stream onto a single dedup slot and drop all but
			// the first.
			await j.append(
				"s1",
				[
					{ type: "a.A", data: {}, meta: { idempotencyKey: "" } },
					{ type: "a.B", data: {}, meta: { idempotencyKey: 7 } },
				] as never,
				baseOpts(),
			);
			expect(j.getStreamHead("s1")?.revision).toBe(2);
		} finally {
			j.close();
		}
	});

	it("freezes the parsed meta", async () => {
		const j = journal();
		try {
			await j.append(
				"s1",
				[{ type: "a.A", data: {}, meta: { a: 1 } }],
				baseOpts(),
			);
			const events = await readAll(j, "s1");
			expect(events[0]?.meta).toMatchObject({ a: 1 });
		} finally {
			j.close();
		}
	});
});

describe("optional envelope columns", () => {
	it("round-trips every optional field when supplied", async () => {
		const j = journal();
		try {
			await j.append(
				"s1",
				[{ type: "a.A", data: {} }],
				baseOpts({
					project: "p1",
					causationId: "c1",
					correlationId: "r1",
					lane: "l1",
				}),
			);
			const event = (await readAll(j, "s1"))[0];
			// These four are how a consumer joins an event back to the command
			// and the trace that produced it. Losing one breaks causality
			// reconstruction without breaking anything that would fail loudly.
			expect(event?.project).toBe("p1");
			expect(event?.causationId).toBe("c1");
			expect(event?.correlationId).toBe("r1");
			expect(event?.lane).toBe("l1");
		} finally {
			j.close();
		}
	});

	it("reads an absent optional field back as undefined, never null", async () => {
		const j = journal();
		try {
			await j.append("s1", [{ type: "a.A", data: {} }], baseOpts());
			const event = (await readAll(j, "s1"))[0];
			// SQLite stores one absent value; the envelope distinguishes `null`
			// from `undefined`. A column that came back as `null` would serialize
			// into a JSON envelope carrying explicit nulls the writer never wrote.
			for (const field of [
				"project",
				"causationId",
				"correlationId",
				"lane",
			] as const) {
				expect(event?.[field], field).toBeUndefined();
			}
		} finally {
			j.close();
		}
	});

	it("keeps the required fields on every event", async () => {
		const j = journal();
		try {
			await j.append("s1", [{ type: "a.A", data: { x: 1 } }], baseOpts());
			const event = (await readAll(j, "s1"))[0];
			expect(event?.streamId).toBe("s1");
			expect(event?.seq).toBe(1);
			expect(event?.type).toBe("a.A");
			expect(event?.tenant).toBe("t");
			expect(event?.actor).toEqual(actor);
			expect(event?.ts).toBe(clock.now());
			// The id is minted per event and must be unique — it carries a UNIQUE
			// constraint in the schema.
			expect(event?.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
		} finally {
			j.close();
		}
	});

	it("mints a distinct id for every event in one batch", async () => {
		const j = journal();
		try {
			const types = Array.from({ length: 40 }, (_, i) => ({
				type: `a.E${i}`,
				data: {},
			}));
			await j.append("s1", types, baseOpts());
			const ids = (await readAll(j, "s1")).map((event) => event.id);
			// All 40 share one clock reading, so this exercises the counter path
			// that the id generator's comment says used to wrap at 32.
			expect(new Set(ids).size).toBe(40);
		} finally {
			j.close();
		}
	});
});

describe("stream head accounting", () => {
	it("reports no head for a stream that was never written", () => {
		const j = journal();
		try {
			// Undefined, not a zero-revision head: a caller appending with
			// `expectedSeq: 0` needs to tell "new stream" from "stream at 0".
			expect(j.getStreamHead("nope")).toBeUndefined();
			expect(j.getStreamLength("nope")).toBe(0);
		} finally {
			j.close();
		}
	});

	it("advances the head by the number of events appended", async () => {
		const j = journal();
		try {
			await j.append(
				"s1",
				[
					{ type: "a.A", data: {} },
					{ type: "a.B", data: {} },
				],
				baseOpts(),
			);
			expect(j.getStreamHead("s1")?.revision).toBe(2);
			expect(j.getStreamLength("s1")).toBe(2);
		} finally {
			j.close();
		}
	});

	it("refuses an append whose expected sequence does not match the head", async () => {
		const j = journal();
		try {
			await j.append("s1", [{ type: "a.A", data: {} }], baseOpts());
			// Optimistic concurrency is the one-writer guarantee. Accepting a
			// stale expectation would silently drop a concurrent writer's event.
			await expect(
				j.append(
					"s1",
					[{ type: "a.B", data: {} }],
					baseOpts({ expectedSeq: 0 }),
				),
			).rejects.toThrow();
			expect(j.getStreamHead("s1")?.revision).toBe(1);
		} finally {
			j.close();
		}
	});

	it("refuses a batch larger than the configured maximum", async () => {
		const j = journal();
		try {
			const huge = Array.from({ length: 100_000 }, () => ({
				type: "a.A",
				data: {},
			}));
			// The cap exists so one command cannot hold the single-writer
			// transaction open long enough to stall every other appender.
			await expect(j.append("s1", huge, baseOpts())).rejects.toThrowError(
				/maxBatchEvents/u,
			);
		} finally {
			j.close();
		}
	});
});
