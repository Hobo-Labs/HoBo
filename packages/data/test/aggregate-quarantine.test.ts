import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EVENTSTORE_LIMITS, type EventEnvelope } from "@hobo/core";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { expect, it } from "vitest";
import {
	AggregateConflictError,
	createInMemoryActorHost,
	defineAggregate,
	defineProjection,
	foldEvents,
	UnpersistedQuarantineError,
} from "../src/index.js";

const actor = { kind: "user", id: "operator" } as const;
const context = { actor, tenant: "workspace" };
type Command = "record" | "no-op" | "reject";

function aggregate(acceptPoison = false, name = "items") {
	return defineAggregate<{ count: number }, Command>({
		name,
		initialState: { count: 0 },
		evolve(state, event) {
			if (event.type === "item.Poison" && !acceptPoison)
				throw new Error("invalid item");
			return { count: state.count + 1 };
		},
		decide(_state, command, emitter) {
			if (command === "reject") throw new Error("command rejected");
			if (command === "record") emitter.emit("item.Added", {});
		},
	});
}

async function collect(
	store: ReturnType<typeof createRuntimeLocalEventStore>,
): Promise<EventEnvelope[]> {
	const events: EventEnvelope[] = [];
	for await (const event of store.read("items")) events.push(event);
	return events;
}

it("persists quarantine records before a command and preserves them across a store restart", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-aggregate-quarantine-"));
	let store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		await store.append(
			"items",
			[
				{ type: "item.Added", data: {} },
				{ type: "item.Poison", data: {} },
				{ type: "item.Added", data: {} },
				{ type: "item.Poison", data: {} },
			],
			{ ...context, expectedSeq: 0 },
		);
		const original = await collect(store);
		const before = aggregate();
		await expect(before.load(store, "items")).rejects.toBeInstanceOf(
			UnpersistedQuarantineError,
		);
		const result = await before.execute(
			{ store, actorHost: createInMemoryActorHost() },
			"items",
			"record",
			context,
		);
		expect(result.seq).toBe(7);
		expect(result.state).toEqual({ count: 3 });
		expect(
			result.quarantined.map((entry) => [
				entry.offendingSeq,
				entry.quarantineSeq,
			]),
		).toEqual([
			[2, 5],
			[4, 6],
		]);
		expect(result.appended.map((event) => event.type)).toEqual([
			"aggregate.QuarantineRecorded",
			"aggregate.QuarantineRecorded",
			"item.Added",
		]);
		const stored = await collect(store);
		expect(stored.slice(0, 4)).toEqual(original);
		expect(stored[4]).toMatchObject({
			data: {
				offendingSeq: 2,
				offendingType: "item.Poison",
				offendingEventId: original[1]?.id,
				fold: "items",
				foldKind: "aggregate",
				reason: "invalid item",
			},
			meta: { quarantines: original[1]?.id },
		});
		const json = join(directory, "quarantine.json");
		writeFileSync(json, JSON.stringify(stored[4]?.data));
		const cue =
			process.env.HOBO_CUE_BIN ||
			fileURLToPath(
				new URL("../../../.tools/cue/v0.14.0/cue", import.meta.url),
			);
		const schema = fileURLToPath(
			new URL("../data-models/data.cue", import.meta.url),
		);
		execFileSync(cue, [
			"vet",
			schema,
			json,
			"-d",
			"#AggregateQuarantinedEventData",
		]);
		store.close();
		store = createRuntimeLocalEventStore({ dataDir: directory });
		expect(await aggregate(true).load(store, "items")).toEqual({
			state: { count: 3 },
			seq: 7,
		});
		expect(await aggregate(true, "other").load(store, "items")).toEqual({
			state: { count: 5 },
			seq: 7,
		});
		const projection = defineProjection({
			name: "item-count",
			key: () => "all",
			on: {
				"item.Added": (row: { count: number } | undefined) => ({
					count: (row?.count ?? 0) + 1,
				}),
				"item.Poison": (row: { count: number } | undefined) => ({
					count: (row?.count ?? 0) + 1,
				}),
			},
		});
		expect((await projection.rebuildFromZero(store, "items")).rows.all).toEqual(
			{ count: 5 },
		);
		const noOp = await aggregate(true).execute(
			{ store, actorHost: createInMemoryActorHost() },
			"items",
			"no-op",
			context,
		);
		expect(noOp.appended).toEqual([]);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("records quarantines even when the subsequent command is rejected", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-aggregate-reject-"));
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		await store.append("items", [{ type: "item.Poison", data: {} }], {
			...context,
			expectedSeq: 0,
		});
		await expect(
			aggregate().execute(
				{ store, actorHost: createInMemoryActorHost() },
				"items",
				"reject",
				context,
			),
		).rejects.toThrow("command rejected");
		expect((await collect(store)).map((event) => event.type)).toEqual([
			"item.Poison",
			"aggregate.QuarantineRecorded",
		]);
		expect(await aggregate(true).load(store, "items")).toEqual({
			state: { count: 0 },
			seq: 2,
		});
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("rejects a competing append before writing quarantine markers", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-aggregate-conflict-"));
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		await store.append("items", [{ type: "item.Poison", data: {} }], {
			...context,
			expectedSeq: 0,
		});
		const racing = {
			...store,
			async append(
				streamId: string,
				events: Parameters<typeof store.append>[1],
				options: Parameters<typeof store.append>[2],
			) {
				await store.append(streamId, [{ type: "item.Added", data: {} }], {
					...context,
					expectedSeq: 1,
				});
				return store.append(streamId, events, options);
			},
		};
		await expect(
			aggregate().execute(
				{ store: racing, actorHost: createInMemoryActorHost() },
				"items",
				"no-op",
				context,
			),
		).rejects.toBeInstanceOf(AggregateConflictError);
		expect((await collect(store)).map((event) => event.type)).toEqual([
			"item.Poison",
			"item.Added",
		]);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("persists more quarantines than one event-store batch can hold", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-aggregate-batches-"));
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		const count = EVENTSTORE_LIMITS.maxBatchEvents;
		await store.append(
			"items",
			Array.from({ length: count }, () => ({ type: "item.Poison", data: {} })),
			{ ...context, expectedSeq: 0 },
		);
		await store.append("items", [{ type: "item.Poison", data: {} }], {
			...context,
			expectedSeq: count,
		});
		const result = await aggregate().execute(
			{ store, actorHost: createInMemoryActorHost() },
			"items",
			"no-op",
			context,
		);
		expect(result.quarantined).toHaveLength(count + 1);
		expect(result.seq).toBe((count + 1) * 2);
		expect(await aggregate(true).load(store, "items")).toEqual({
			state: { count: 0 },
			seq: result.seq,
		});
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("assigns distinct quarantine positions after the complete event-stream head", () => {
	const make = (seq: number, type: string): EventEnvelope => ({
		id: `event-${seq}`,
		type,
		v: 1,
		streamId: "items",
		seq,
		ts: "2026-01-01T00:00:00.000Z",
		actor,
		tenant: "workspace",
		data: {},
	});
	const result = foldEvents(
		[make(1, "item.Poison"), make(2, "item.Poison"), make(3, "item.Added")],
		{
			initialState: 0,
			evolve(state, event) {
				if (event.type === "item.Poison") throw new Error("invalid");
				return state + 1;
			},
		},
	);
	expect(result.state).toBe(1);
	expect(result.quarantined.map((entry) => entry.quarantineSeq)).toEqual([
		4, 5,
	]);
});
