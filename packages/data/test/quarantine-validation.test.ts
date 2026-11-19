import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { expect, it } from "vitest";
import {
	createInMemoryActorHost,
	defineAggregate,
	defineProjection,
} from "../src/index.js";

const context = {
	tenant: "workspace",
	actor: { kind: "user", id: "operator" } as const,
};

it("does not recursively quarantine an incomplete aggregate quarantine fact", async () => {
	const directory = mkdtempSync(
		join(tmpdir(), "hobo-invalid-aggregate-quarantine-"),
	);
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		await store.append(
			"items",
			[
				{ type: "item.Added", data: {} },
				{ type: "aggregate.QuarantineRecorded", data: { offendingSeq: 1 } },
			],
			{ ...context, expectedSeq: 0 },
		);
		const aggregate = defineAggregate<number, "noop">({
			name: "items",
			initialState: 0,
			evolve: (state) => state + 1,
			decide() {},
		});
		await expect(
			aggregate.execute(
				{ store, actorHost: createInMemoryActorHost() },
				"items",
				"noop",
				context,
			),
		).rejects.toThrow("invalid aggregate quarantine record");
		const eventTypes: string[] = [];
		for await (const event of store.read("items")) eventTypes.push(event.type);
		expect(eventTypes).toEqual(["item.Added", "aggregate.QuarantineRecorded"]);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("rejects incomplete projection quarantine facts before rebuilding", async () => {
	const directory = mkdtempSync(
		join(tmpdir(), "hobo-invalid-projection-quarantine-"),
	);
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		await store.append("items", [{ type: "item.Added", data: {} }], {
			...context,
			expectedSeq: 0,
		});
		await store.append(
			"quarantines",
			[
				{
					type: "projection.QuarantineRecorded",
					data: {
						projection: "items",
						sourceStreamId: "items",
						offendingSeq: 1,
					},
				},
			],
			{ ...context, expectedSeq: 0 },
		);
		const projection = defineProjection({
			name: "items",
			key: (event) => event.streamId,
			on: {
				"item.Added": (row: { count: number } | undefined) => ({
					count: (row?.count ?? 0) + 1,
				}),
			},
		});
		await expect(
			projection.rebuildWithQuarantine(store, "items", {
				...context,
				quarantineStore: store,
				quarantineStreamId: "quarantines",
			}),
		).rejects.toThrow("invalid projection quarantine record");
		const recorded: string[] = [];
		for await (const event of store.read("quarantines"))
			recorded.push(event.type);
		expect(recorded).toEqual(["projection.QuarantineRecorded"]);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("rejects a malformed EventStore quarantine fact during projection replay", async () => {
	const directory = mkdtempSync(
		join(tmpdir(), "hobo-invalid-legacy-quarantine-"),
	);
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		await store.append(
			"items",
			[
				{ type: "item.Added", data: {} },
				{ type: "item.Quarantined", data: {} },
			],
			{ ...context, expectedSeq: 0 },
		);
		const projection = defineProjection({
			name: "items",
			key: (event) => event.streamId,
			on: {
				"item.Added": (row: { count: number } | undefined) => ({
					count: (row?.count ?? 0) + 1,
				}),
			},
		});
		await expect(projection.rebuildFromZero(store, "items")).rejects.toThrow(
			"invalid quarantine target sequence",
		);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
