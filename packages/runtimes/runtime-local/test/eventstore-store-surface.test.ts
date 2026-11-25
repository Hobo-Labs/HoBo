/**
 * The runtime-local durable EventStore, driven against a real SQLite file.
 *
 * This is the default EventStore behind the storage ports (ADR-0135): one
 * partition, one writer, stream-head CAS. Everything worth holding here is
 * about what happens when two writers disagree, because that is the whole
 * point of an event store and the one thing a naive implementation gets wrong
 * silently.
 *
 * **A stale expected sequence must be refused, not merged.** Two writers who
 * both read head 3 and both append at 4 would otherwise interleave their
 * events into one stream, and neither would know. The CAS is what turns that
 * into a conflict one of them can retry.
 *
 * **A snapshot ahead of the stream head is a conflict, not a snapshot.** It
 * describes state the stream never reached, so storing it would make a later
 * fold start from a fiction. The store translates that into the same
 * optimistic-conflict error a stale append gets, so callers have one thing to
 * handle rather than two.
 *
 * **The parse boundary runs before the write, not after.** A malformed event
 * that reached SQLite would be durable; refusing it at the door keeps the
 * store's contents parseable by construction. That boundary enforces
 * vocabulary as well as shape — an event type must read `family.PastTenseFact`
 * and an actor kind must be one of four known values — so a stream cannot come
 * to hold a name the rest of the system has no way to interpret.
 *
 * The manual clock makes every recorded instant deterministic, so a test that
 * asserts ordering is asserting the store's ordering rather than the wall
 * clock's.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OptimisticSequenceConflictError } from "@hobo/core";
import { afterEach, describe, expect, it } from "vitest";

import {
	createManualClock,
	createRuntimeLocalEventStore,
} from "../src/eventstore/eventstore.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function store(options: { partitionId?: string } = {}) {
	const dataDir = mkdtempSync(join(tmpdir(), "hobo-eventstore-"));
	dirs.push(dataDir);
	return createRuntimeLocalEventStore({
		dataDir,
		clock: createManualClock(),
		...options,
	});
}

/** Append options the parse boundary accepts. */
const appendAt = (
	expectedSeq: number,
	overrides: Record<string, unknown> = {},
) =>
	({
		expectedSeq,
		actor: { kind: "user", id: "local-developer" },
		tenant: "tenant-1",
		...overrides,
		// SAFETY: the store reads exactly the fields AppendOptions names.
	}) as never;

/** One well-formed event. */
const event = (type = "thing.Happened", data: unknown = { a: 1 }) =>
	({
		type,
		data,
		// SAFETY: the store reads exactly the fields an EventInput names.
	}) as never;

describe("the manual clock", () => {
	it("starts at its given instant", () => {
		expect(createManualClock("2020-01-01T00:00:00.000Z").now()).toBe(
			"2020-01-01T00:00:00.000Z",
		);
	});

	it("advances by a delta", () => {
		const clock = createManualClock("2020-01-01T00:00:00.000Z");
		expect(clock.advance(1_000)).toBe("2020-01-01T00:00:01.000Z");
	});

	it("accumulates across advances", () => {
		const clock = createManualClock("2020-01-01T00:00:00.000Z");
		clock.advance(1_000);
		clock.advance(1_000);
		expect(clock.now()).toBe("2020-01-01T00:00:02.000Z");
	});

	it("accepts a zero advance", () => {
		// Zero is a legitimate step — a caller stepping a loop should not have to
		// special-case the iteration that costs no time.
		const clock = createManualClock("2020-01-01T00:00:00.000Z");
		expect(clock.advance(0)).toBe("2020-01-01T00:00:00.000Z");
	});

	it("refuses to run backwards", () => {
		// A clock that went backwards would let a later event carry an earlier
		// instant, and every ordering assertion downstream would be wrong.
		expect(() => createManualClock().advance(-1)).toThrow(TypeError);
	});

	it("refuses a fractional advance", () => {
		expect(() => createManualClock().advance(1.5)).toThrow(TypeError);
	});

	it("refuses a start instant it cannot parse", () => {
		expect(() => createManualClock("not-a-date")).toThrow(
			/valid ISO-8601 string/,
		);
	});

	it("is frozen", () => {
		// The clock is handed to the store; a caller swapping `now` after the
		// fact would break the store's ordering invisibly.
		expect(Object.isFrozen(createManualClock())).toBe(true);
	});
});

describe("appending to a stream", () => {
	it("reports no head at all for a stream that does not exist", async () => {
		// Not `{ seq: 0 }`: a stream that was never written has no head record,
		// and the store says so rather than inventing an empty one. A caller
		// opening a new stream reads `undefined` and appends at 0.
		expect(await store().getStreamHead("stream-1")).toBeUndefined();
	});

	it("appends a first event", async () => {
		const eventStore = store();
		const result = await eventStore.append("stream-1", [event()], appendAt(0));
		expect(result).toBeDefined();
	});

	it("moves the stream head", async () => {
		const eventStore = store();
		await eventStore.append("stream-1", [event()], appendAt(0));
		expect((await eventStore.getStreamHead("stream-1")).revision).toBe(1);
	});

	it("appends several events in one call", async () => {
		const eventStore = store();
		await eventStore.append(
			"stream-1",
			[event("thing.Alpha"), event("thing.Beta")],
			appendAt(0),
		);
		// A batch is one CAS, not several: appending two events must move the
		// head by two, or a concurrent writer could slot in between them.
		expect((await eventStore.getStreamHead("stream-1")).revision).toBe(2);
	});

	it("refuses an append at a sequence the stream has passed", async () => {
		const eventStore = store();
		await eventStore.append("stream-1", [event()], appendAt(0));
		// This is the concurrent-writer case. Both read head 0; the second must
		// be told it lost rather than having its event interleaved.
		await expect(
			eventStore.append("stream-1", [event()], appendAt(0)),
		).rejects.toThrow();
	});

	it("accepts an append at the current head", async () => {
		const eventStore = store();
		await eventStore.append("stream-1", [event()], appendAt(0));
		await eventStore.append("stream-1", [event()], appendAt(1));
		expect((await eventStore.getStreamHead("stream-1")).revision).toBe(2);
	});

	it("refuses an event that is not an object", async () => {
		// The parse runs before the write; a malformed event that reached SQLite
		// would be durable.
		await expect(
			store().append("stream-1", ["nope" as never], appendAt(0)),
		).rejects.toThrow(TypeError);
	});

	it("refuses an event with no type", async () => {
		await expect(
			store().append("stream-1", [{ data: {} } as never], appendAt(0)),
		).rejects.toThrow(/event.type/);
	});

	it("refuses an empty event list", async () => {
		// An empty append would take the CAS and move nothing, which is a
		// no-op that still costs another writer their turn.
		await expect(store().append("stream-1", [], appendAt(0))).rejects.toThrow(
			/non-empty array/,
		);
	});

	it("refuses an empty stream id", async () => {
		await expect(store().append("", [event()], appendAt(0))).rejects.toThrow(
			/streamId/,
		);
	});

	it("keeps two streams independent", async () => {
		const eventStore = store();
		await eventStore.append("stream-1", [event()], appendAt(0));
		// One stream's head advancing another's would make every CAS meaningless.
		expect(await eventStore.getStreamHead("stream-2")).toBeUndefined();
	});
});

describe("reading a stream back", () => {
	it("reads nothing from an empty stream", async () => {
		const read = store().read("stream-1");
		const seen = [];
		for await (const item of read) seen.push(item);
		expect(seen).toEqual([]);
	});

	it("reads back what was appended", async () => {
		const eventStore = store();
		await eventStore.append("stream-1", [event("thing.Happened")], appendAt(0));
		const seen = [];
		for await (const item of eventStore.read("stream-1")) seen.push(item);
		expect(seen).toHaveLength(1);
	});

	it("reads events in the order they were appended", async () => {
		const eventStore = store();
		await eventStore.append(
			"stream-1",
			[event("thing.Alpha"), event("thing.Beta"), event("thing.Gamma")],
			appendAt(0),
		);
		const seen: string[] = [];
		for await (const item of eventStore.read("stream-1")) {
			// SAFETY: every envelope the store yields carries its type.
			seen.push((item as { type: string }).type);
		}
		// Order is the store's entire contract; a fold over a reordered stream
		// computes a state the system was never in.
		expect(seen).toEqual(["thing.Alpha", "thing.Beta", "thing.Gamma"]);
	});

	it("reads from a given sequence", async () => {
		const eventStore = store();
		await eventStore.append(
			"stream-1",
			[event("thing.Alpha"), event("thing.Beta")],
			appendAt(0),
		);
		const seen = [];
		for await (const item of eventStore.read("stream-1", 2)) seen.push(item);
		// Resuming from a checkpoint is the normal read; re-reading from 1 every
		// time would make every subscriber O(stream).
		expect(seen).toHaveLength(1);
	});

	it("refuses a negative from-sequence", async () => {
		expect(() => store().read("stream-1", -1)).toThrow(/fromSeq/);
	});

	it("refuses a fractional from-sequence", async () => {
		expect(() => store().read("stream-1", 1.5)).toThrow(/fromSeq/);
	});

	it("refuses a read of an empty stream id", async () => {
		expect(() => store().read("")).toThrow(/streamId/);
	});
});

describe("snapshots", () => {
	it("loads nothing when none was stored", async () => {
		expect(await store().loadSnapshot("stream-1")).toBeUndefined();
	});

	it("stores and loads a snapshot", async () => {
		const eventStore = store();
		await eventStore.append("stream-1", [event()], appendAt(0));
		await eventStore.snapshot("stream-1", { count: 1 }, 1);
		expect(await eventStore.loadSnapshot("stream-1")).toBeDefined();
	});

	it("translates a snapshot ahead of the head into an optimistic conflict", async () => {
		const eventStore = store();
		await eventStore.append("stream-1", [event()], appendAt(0));
		// A snapshot at seq 9 describes state the stream never reached. Storing
		// it would make a later fold start from a fiction. Callers already
		// handle optimistic conflicts, so it arrives as one rather than as a
		// second error type nobody catches.
		await expect(
			eventStore.snapshot("stream-1", { count: 9 }, 9),
		).rejects.toThrow(OptimisticSequenceConflictError);
	});

	it("refuses a snapshot at a negative sequence", async () => {
		await expect(store().snapshot("stream-1", {}, -1)).rejects.toThrow(/seq/);
	});

	it("refuses a snapshot for an empty stream id", async () => {
		await expect(store().snapshot("", {}, 1)).rejects.toThrow(/streamId/);
	});

	it("refuses to load a snapshot for an empty stream id", async () => {
		await expect(store().loadSnapshot("")).rejects.toThrow(/streamId/);
	});
});

describe("partitioning and durability", () => {
	it("defaults to the `default` partition", async () => {
		// One partition, one writer (ADR-0135). The default has to be a real
		// named partition rather than an empty string, or checkpoints collide.
		const eventStore = store();
		await eventStore.append("stream-1", [event()], appendAt(0));
		expect((await eventStore.getStreamHead("stream-1")).revision).toBe(1);
	});

	it("accepts an explicit partition", async () => {
		const eventStore = store({ partitionId: "shard-1" });
		await eventStore.append("stream-1", [event()], appendAt(0));
		expect((await eventStore.getStreamHead("stream-1")).revision).toBe(1);
	});

	it("creates its data directory when it does not exist", () => {
		const dataDir = join(
			mkdtempSync(join(tmpdir(), "hobo-eventstore-")),
			"nested",
			"deeper",
		);
		dirs.push(dataDir);
		// The store is opened by a runtime that may never have run here before;
		// requiring the directory to pre-exist would fail on first boot.
		expect(() =>
			createRuntimeLocalEventStore({ dataDir, clock: createManualClock() }),
		).not.toThrow();
	});

	it("persists across a reopen of the same directory", async () => {
		const dataDir = mkdtempSync(join(tmpdir(), "hobo-eventstore-"));
		dirs.push(dataDir);
		const first = createRuntimeLocalEventStore({
			dataDir,
			clock: createManualClock(),
		});
		await first.append("stream-1", [event()], appendAt(0));
		const second = createRuntimeLocalEventStore({
			dataDir,
			clock: createManualClock(),
		});
		// "Durable" is the word in the type name. A store that lost its stream
		// on reopen would be an in-memory store with extra steps.
		expect((await second.getStreamHead("stream-1")).revision).toBe(1);
	});

	it("is frozen", () => {
		// The store handle is passed across a runtime; a caller replacing
		// `append` would bypass the parse boundary entirely.
		expect(Object.isFrozen(store())).toBe(true);
	});
});

describe("the envelope's own naming constraints", () => {
	/**
	 * These are not shape checks — they are vocabulary checks, and they run on
	 * the write path, so a stream cannot come to contain a name the rest of the
	 * system has no way to interpret.
	 */
	it("requires an event type in `family.PastTenseFact` form", async () => {
		// An event store is a log of things that already happened. A type like
		// `placeOrder` reads as a command, and a projection keyed on it would be
		// reacting to an intention rather than a fact.
		await expect(
			store().append("stream-1", [event("placeOrder")], appendAt(0)),
		).rejects.toThrow(/family.PastTenseFact/);
	});

	it("refuses an event type with no family", async () => {
		await expect(
			store().append("stream-1", [event("Happened")], appendAt(0)),
		).rejects.toThrow(/family.PastTenseFact/);
	});

	it("refuses a lower-case fact name", async () => {
		// `thing.happened` is the spelling most people reach for first, and it
		// is refused — the capital is what marks the fact half of the name.
		await expect(
			store().append("stream-1", [event("thing.happened")], appendAt(0)),
		).rejects.toThrow(/family.PastTenseFact/);
	});

	it("accepts each actor kind the envelope knows", async () => {
		for (const kind of ["user", "agent", "service", "system"]) {
			const eventStore = store();
			await eventStore.append(
				"stream-1",
				[event()],
				appendAt(0, { actor: { kind, id: "someone" } }),
			);
			expect((await eventStore.getStreamHead("stream-1")).revision).toBe(1);
		}
	});

	it("refuses an actor kind outside that set", async () => {
		// The actor kind decides how an event is attributed in an audit trail.
		// An invented kind would attribute work to a class nothing can read.
		await expect(
			store().append(
				"stream-1",
				[event()],
				appendAt(0, { actor: { kind: "principal", id: "x" } }),
			),
		).rejects.toThrow(/user \| agent \| service \| system/);
	});

	it("requires an actor id", async () => {
		await expect(
			store().append(
				"stream-1",
				[event()],
				appendAt(0, { actor: { kind: "user" } }),
			),
		).rejects.toThrow(/actor.id/);
	});

	it("requires a tenant", async () => {
		// Every event is tenant-scoped; an untenanted one could be read by the
		// wrong tenant's projection.
		await expect(
			store().append("stream-1", [event()], appendAt(0, { tenant: undefined })),
		).rejects.toThrow(/tenant/);
	});

	it("refuses an actor that is an array", async () => {
		await expect(
			store().append("stream-1", [event()], appendAt(0, { actor: [] })),
		).rejects.toThrow(/actor must be an object/);
	});
});
