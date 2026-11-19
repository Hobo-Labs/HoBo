import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EventEnvelope } from "@hobo/core";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { expect, it } from "vitest";
import {
	createUpcasterRegistry,
	defineProjection,
	UpcasterChainError,
} from "../src/index.js";

const actor = { kind: "user", id: "operator" } as const;
const context = { actor, tenant: "workspace" };

function projection(acceptPoison = false, name = "items") {
	const advance = (row: { count: number } | undefined) => ({
		count: (row?.count ?? 0) + 1,
	});
	return defineProjection({
		name,
		key: (event) => event.streamId,
		on: {
			"item.Added": advance,
			"item.Poison": (row) => {
				if (!acceptPoison) throw new Error("invalid item");
				return advance(row);
			},
		},
	});
}

async function read(
	store: ReturnType<typeof createRuntimeLocalEventStore>,
	stream: string,
): Promise<EventEnvelope[]> {
	const events: EventEnvelope[] = [];
	for await (const event of store.read(stream)) events.push(event);
	return events;
}

it("persists projection-specific quarantine separately from the source and resumes after reopening", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-projection-quarantine-"));
	let store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		await store.append(
			"items",
			[
				{ type: "item.Added", data: {} },
				{ type: "item.Poison", data: {} },
				{ type: "item.Added", data: {} },
			],
			{ ...context, expectedSeq: 0 },
		);
		const source = await read(store, "items");
		const options = {
			quarantineStore: store,
			quarantineStreamId: "projection-quarantines",
			...context,
		};
		await expect(projection().rebuildFromZero(store, "items")).rejects.toThrow(
			"invalid item",
		);
		const result = await projection().rebuildWithQuarantine(
			store,
			"items",
			options,
		);
		expect(result.snapshot).toEqual({
			projection: "items",
			seq: 3,
			rows: { items: { count: 2 } },
		});
		expect(result.quarantined).toEqual([
			{
				sourceStreamId: "items",
				offendingSeq: 2,
				offendingEventId: source[1]?.id,
				offendingType: "item.Poison",
				reason: "invalid item",
				recordedSeq: 1,
			},
		]);
		expect(await read(store, "items")).toEqual(source);
		const records = await read(store, "projection-quarantines");
		expect(records[0]).toMatchObject({
			type: "projection.QuarantineRecorded",
			meta: { quarantines: source[1]?.id },
		});
		const cue =
			process.env.HOBO_CUE_BIN ||
			fileURLToPath(
				new URL("../../../.tools/cue/v0.14.0/cue", import.meta.url),
			);
		const schema = fileURLToPath(
			new URL("../data-models/data.cue", import.meta.url),
		);
		const json = join(directory, "quarantine.json");
		writeFileSync(json, JSON.stringify(records[0]?.data));
		execFileSync(cue, [
			"vet",
			schema,
			json,
			"-d",
			"#ProjectionQuarantinedEventData",
		]);
		store.close();
		store = createRuntimeLocalEventStore({ dataDir: directory });
		const reopened = { ...options, quarantineStore: store };
		expect(
			await projection(true).rebuildWithQuarantine(store, "items", reopened),
		).toEqual(result);
		const other = await projection(true, "other").rebuildWithQuarantine(
			store,
			"items",
			reopened,
		);
		expect(other.snapshot.rows.items).toEqual({ count: 3 });
		expect(other.quarantined).toEqual([]);
		expect(await read(store, "projection-quarantines")).toHaveLength(1);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("coalesces concurrent rebuilds on the same quarantine log", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-projection-race-"));
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		await store.append("items", [{ type: "item.Poison", data: {} }], {
			...context,
			expectedSeq: 0,
		});
		const options = {
			quarantineStore: store,
			quarantineStreamId: "projection-quarantines",
			...context,
		};
		const [first, second] = await Promise.all([
			projection().rebuildWithQuarantine(store, "items", options),
			projection().rebuildWithQuarantine(store, "items", options),
		]);
		expect(first).toEqual(second);
		expect(first.quarantined).toHaveLength(1);
		expect(await read(store, "projection-quarantines")).toHaveLength(1);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("refuses quarantine records that refer to a different source event", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-projection-target-"));
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		await store.append("items", [{ type: "item.Poison", data: {} }], {
			...context,
			expectedSeq: 0,
		});
		await store.append(
			"projection-quarantines",
			[
				{
					type: "projection.QuarantineRecorded",
					data: {
						projection: "items",
						sourceStreamId: "items",
						offendingSeq: 1,
						offendingEventId: "different",
						offendingType: "item.Poison",
						reason: "invalid",
					},
				},
			],
			{ ...context, expectedSeq: 0 },
		);
		const options = {
			quarantineStore: store,
			quarantineStreamId: "projection-quarantines",
			...context,
		};
		await expect(
			projection().rebuildWithQuarantine(store, "items", options),
		).rejects.toThrow("target does not match");
		await expect(
			projection().rebuildWithQuarantine(store, "items", {
				...options,
				quarantineStreamId: "items",
			}),
		).rejects.toThrow("separate stream");
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("does not quarantine any event when a required upcaster chain is incomplete", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-projection-upcast-"));
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		await store.append(
			"items",
			[
				{ type: "item.Poison", data: {} },
				{ type: "item.Added", data: {} },
			],
			{ ...context, expectedSeq: 0 },
		);
		const upcasters = createUpcasterRegistry()
			.register("item.Added", 1, (data) => data)
			.register("item.Added", 3, (data) => data);
		const view = defineProjection({
			name: "items",
			key: (event) => event.streamId,
			upcasters,
			on: {
				"item.Poison": () => {
					throw new Error("invalid item");
				},
				"item.Added": () => ({ count: 1 }),
			},
		});
		const options = {
			quarantineStore: store,
			quarantineStreamId: "projection-quarantines",
			...context,
		};
		await expect(
			view.rebuildWithQuarantine(store, "items", options),
		).rejects.toBeInstanceOf(UpcasterChainError);
		expect(await read(store, "projection-quarantines")).toEqual([]);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
