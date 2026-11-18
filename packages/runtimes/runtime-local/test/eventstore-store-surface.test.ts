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
		const clock = createManualClock("2020-01-01T00:00:00.000Z");
		expect(clock.advance(0)).toBe("2020-01-01T00:00:00.000Z");
	});

	it("refuses to run backwards", () => {
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
		expect(Object.isFrozen(createManualClock())).toBe(true);
	});
});

describe("appending to a stream", () => {
	it("reports no head at all for a stream that does not exist", async () => {
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

		expect((await eventStore.getStreamHead("stream-1")).revision).toBe(2);
	});

	it("refuses an append at a sequence the stream has passed", async () => {
		const eventStore = store();
		await eventStore.append("stream-1", [event()], appendAt(0));

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
			seen.push((item as { type: string }).type);
		}

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

		expect((await second.getStreamHead("stream-1")).revision).toBe(1);
	});

	it("is frozen", () => {
		expect(Object.isFrozen(store())).toBe(true);
	});
});

describe("the envelope's own naming constraints", () => {
	it("requires an event type in `family.PastTenseFact` form", async () => {
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
