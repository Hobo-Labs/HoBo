import {
	type AppendOptions,
	type EventEnvelope,
	MissingFenceError,
	OptimisticSequenceConflictError,
	type PositionedEvent,
	StaleFenceError,
} from "@hobo/core";
import { describe, expect, it } from "vitest";
import type { FleetEventStore } from "../../../src/ports.js";
import { createMemoryEventStore } from "../../../src/testing/plumbing/memory-event-store.js";

function options(expectedSeq: number, fenceToken?: bigint): AppendOptions {
	const append: AppendOptions = {
		expectedSeq,
		actor: { kind: "service", id: "hobo-fleet-authority" },
		tenant: "test",
	};
	if (fenceToken !== undefined) append.fenceToken = fenceToken;
	return append;
}

async function collect(
	store: FleetEventStore,
	streamId: string,
	fromSeq?: number,
) {
	const out: EventEnvelope[] = [];
	for await (const event of store.read(streamId, fromSeq)) out.push(event);
	return out;
}

async function collectAll(
	store: FleetEventStore,
	readOptions?: Parameters<FleetEventStore["readAll"]>[0],
) {
	const out: PositionedEvent[] = [];
	for await (const event of store.readAll(readOptions)) out.push(event);
	return out;
}

describe("createMemoryEventStore", () => {
	it("appends with per-stream sequences and refuses a stale expectedSeq", async () => {
		const store = createMemoryEventStore();
		const first = await store.append(
			"fleet-member-a",
			[
				{ type: "fleet.EnrollmentRequested", data: { n: 1 } },
				{ type: "fleet.KeyApproved", data: { n: 2 } },
			],
			options(0),
		);
		expect(first.appended.map((e) => e.seq)).toEqual([1, 2]);
		expect(first.appended[0]?.tenant).toBe("test");
		await expect(
			store.append(
				"fleet-member-a",
				[{ type: "fleet.MemberActivated" }],
				options(1),
			),
		).rejects.toBeInstanceOf(OptimisticSequenceConflictError);
		await store.append(
			"fleet-member-a",
			[{ type: "fleet.MemberActivated" }],
			options(2),
		);
		await store.append(
			"fleet-member-b",
			[{ type: "fleet.EnrollmentRequested" }],
			options(0),
		);

		expect((await collect(store, "fleet-member-a")).map((e) => e.type)).toEqual(
			[
				"fleet.EnrollmentRequested",
				"fleet.KeyApproved",
				"fleet.MemberActivated",
			],
		);
		expect(
			(await collect(store, "fleet-member-a", 3)).map((e) => e.seq),
		).toEqual([3]);
		expect(await collect(store, "fleet-member-none")).toEqual([]);
		expect(store.getStreamHead?.("fleet-member-a")?.revision).toBe(3);
	});

	it("deduplicates meta.idempotencyKey per stream, even on a retry with a stale expectedSeq", async () => {
		const store = createMemoryEventStore();
		const event = {
			type: "fleet.TokenConsumed",
			data: {},
			meta: { idempotencyKey: "token-1" },
		};
		await store.append("fleet-token-x", [event], options(0));
		const retry = await store.append("fleet-token-x", [event], options(0));
		expect(retry.appended).toEqual([]);
		expect(retry.deduped.length).toBe(1);
		expect((await collect(store, "fleet-token-x")).length).toBe(1);

		const other = await store.append("fleet-token-y", [event], options(0));
		expect(other.appended.length).toBe(1);

		const batch = await store.append(
			"fleet-token-z",
			[event, event],
			options(0),
		);
		expect(batch.appended.length).toBe(1);
		expect(batch.deduped.length).toBe(1);
	});

	it("reads every stream in append order with positions, after and limit", async () => {
		const store = createMemoryEventStore();
		await store.append("s-1", [{ type: "fleet.A" }], options(0));
		await store.append(
			"s-2",
			[{ type: "fleet.B" }, { type: "fleet.C" }],
			options(0),
		);
		await store.append("s-1", [{ type: "fleet.D" }], options(1));

		const all = await collectAll(store);
		expect(all.map((p) => [p.position, p.event.type])).toEqual([
			[1n, "fleet.A"],
			[2n, "fleet.B"],
			[3n, "fleet.C"],
			[4n, "fleet.D"],
		]);
		const second = all[1];
		if (second === undefined) throw new Error("expected four events");
		const page = await collectAll(store, { after: second.position, limit: 1 });
		expect(page.map((p) => p.event.type)).toEqual(["fleet.C"]);
	});

	it("appends nothing when an event in the batch is invalid", async () => {
		const store = createMemoryEventStore();
		await expect(
			store.append(
				"s-1",
				[{ type: "fleet.Good" }, { type: "not a fact" }],
				options(0),
			),
		).rejects.toThrow();
		expect(await collectAll(store)).toEqual([]);
		expect(store.getStreamHead?.("s-1")?.revision ?? 0).toBe(0);
	});

	it("wakes subscribers that match the filter, in order", async () => {
		const store = createMemoryEventStore();
		const seen: string[] = [];
		const subscription = store.subscribe({ streamId: "s-1" }, (event) => {
			seen.push(`${event.streamId}:${event.seq}`);
		});
		await store.append(
			"s-1",
			[{ type: "fleet.A" }, { type: "fleet.B" }],
			options(0),
		);
		await store.append("s-2", [{ type: "fleet.A" }], options(0));
		await new Promise<void>((resolve) => setImmediate(resolve));
		subscription.unsubscribe();
		await store.append("s-1", [{ type: "fleet.C" }], options(2));
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(seen).toEqual(["s-1:1", "s-1:2"]);
	});

	it("enforces fencing once a stream is fenced", async () => {
		const store = createMemoryEventStore();
		await store.append("s-1", [{ type: "fleet.A" }], options(0, 2n));
		await expect(
			store.append("s-1", [{ type: "fleet.B" }], options(1)),
		).rejects.toBeInstanceOf(MissingFenceError);
		await expect(
			store.append("s-1", [{ type: "fleet.B" }], options(1, 1n)),
		).rejects.toBeInstanceOf(StaleFenceError);
		await store.append("s-1", [{ type: "fleet.B" }], options(1, 3n));
		expect(store.getStreamHead?.("s-1")?.ownerEpoch).toBe(3n);
	});

	it("snapshots only at or below the head", async () => {
		const store = createMemoryEventStore();
		await store.append("s-1", [{ type: "fleet.A" }], options(0));
		const snapshot = await store.snapshot("s-1", { count: 1 }, 1);
		expect(snapshot.seq).toBe(1);
		await expect(store.snapshot("s-1", {}, 2)).rejects.toBeInstanceOf(
			OptimisticSequenceConflictError,
		);
	});

	it("hands out copies, so callers cannot change stored events", async () => {
		const store = createMemoryEventStore();
		const result = await store.append(
			"s-1",
			[{ type: "fleet.A", data: { n: 1 } }],
			options(0),
		);
		const appended = result.appended[0];
		if (appended !== undefined) appended.type = "fleet.Changed";
		expect((await collect(store, "s-1"))[0]?.type).toBe("fleet.A");
	});
});
