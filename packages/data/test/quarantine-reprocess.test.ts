import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { toJson } from "@bufbuild/protobuf";
import type { EventEnvelope } from "@hobo/core";
import { createRuntimeLocalEventStore } from "@hobo/runtime-local";
import { expect, it } from "vitest";
import {
	createInMemoryActorHost,
	defineAggregate,
	defineProjection,
	QuarantineReprocessFindingSchema,
} from "../src/index.js";

const context = {
	tenant: "workspace",
	actor: { kind: "user", id: "operator" } as const,
};

async function read(
	store: ReturnType<typeof createRuntimeLocalEventStore>,
	streamId: string,
) {
	const events: EventEnvelope[] = [];
	for await (const event of store.read(streamId)) events.push(event);
	return events;
}

it("identifies a newly processable aggregate event without changing replay or its journal", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-aggregate-reprocess-"));
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		await store.append(
			"items",
			[
				{ type: "item.Invalid", data: {} },
				{ type: "item.Added", data: {} },
			],
			{ ...context, expectedSeq: 0 },
		);
		const aggregate = (accept: boolean) =>
			defineAggregate<number, "noop">({
				name: "items",
				initialState: 0,
				evolve(state, event) {
					if (event.type === "item.Invalid" && !accept)
						throw new Error("bad item");
					return state + 1;
				},
				decide() {},
			});
		await aggregate(false).execute(
			{ store, actorHost: createInMemoryActorHost() },
			"items",
			"noop",
			context,
		);
		const before = await read(store, "items");
		expect(await aggregate(false).inspectQuarantines(store, "items")).toEqual(
			[],
		);
		const findings = await aggregate(true).inspectQuarantines(store, "items");
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			code: "event-log.quarantine-reprocess-policy-required",
			sourceStreamId: "items",
			offendingSeq: 1n,
			offendingEventId: before[0]?.id,
			fold: "items",
			foldKind: "aggregate",
		});
		expect(await aggregate(true).load(store, "items")).toEqual({
			state: 1,
			seq: 3,
		});
		expect(await read(store, "items")).toEqual(before);
		const finding = findings[0];
		if (!finding) throw new Error("Expected one reprocess finding");
		const jsonPath = join(directory, "finding.json");
		writeFileSync(
			jsonPath,
			JSON.stringify(
				toJson(QuarantineReprocessFindingSchema, finding, {
					alwaysEmitImplicit: true,
				}),
			),
		);
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
			jsonPath,
			"-d",
			"#QuarantineReprocessFinding",
		]);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});

it("inspects projection quarantine records without applying their events", async () => {
	const directory = mkdtempSync(join(tmpdir(), "hobo-projection-reprocess-"));
	const store = createRuntimeLocalEventStore({ dataDir: directory });
	try {
		await store.append(
			"items",
			[
				{ type: "item.Invalid", data: {} },
				{ type: "item.Added", data: {} },
			],
			{ ...context, expectedSeq: 0 },
		);
		const projection = (accept: boolean) =>
			defineProjection({
				name: "items-view",
				key: (event) => event.streamId,
				on: {
					"item.Invalid": (row: { count: number } | undefined) => {
						if (!accept) throw new Error("bad item");
						return { count: (row?.count ?? 0) + 1 };
					},
					"item.Added": (row: { count: number } | undefined) => ({
						count: (row?.count ?? 0) + 1,
					}),
				},
			});
		const options = {
			...context,
			quarantineStore: store,
			quarantineStreamId: "quarantines",
		};
		await projection(false).rebuildWithQuarantine(store, "items", options);
		const source = await read(store, "items");
		const records = await read(store, "quarantines");
		expect(projection(false).inspectQuarantines(source, records)).toEqual([]);
		const findings = projection(true).inspectQuarantines(source, records);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			code: "event-log.quarantine-reprocess-policy-required",
			sourceStreamId: "items",
			offendingSeq: 1n,
			offendingEventId: source[0]?.id,
			fold: "items-view",
			foldKind: "projection",
		});
		const replay = await projection(true).rebuildWithQuarantine(
			store,
			"items",
			options,
		);
		expect(replay.snapshot.rows.items).toEqual({ count: 1 });
		expect(await read(store, "items")).toEqual(source);
		expect(await read(store, "quarantines")).toEqual(records);
	} finally {
		store.close();
		rmSync(directory, { recursive: true, force: true });
	}
});
