// The three event-log migration patterns, end to end on real storage: the
// real SQLite-backed event store (`@hobo/runtime-local`) and real SQLite data
// engines (`@hobo/data-sqlite`). Nothing here is simulated — every event is
// appended to a journal on disk and every record lands in a table on disk.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type ChangeEnvelope,
	compareDigests,
	createEventStoreMigrationJournal,
	createMemoryMigrationJournal,
	type DatasetSchema,
	deleteMutation,
	type EngineBinding,
	encodeRecordKey,
	evaluateCustodyPath,
	eventLogDigest,
	foldMigration,
	HANDOFF_IDENTITY_IMPEDANCE,
	type MigrationPhase,
	type MigrationRuntime,
	type PivotEvent,
	type ProjectionFold,
	parseCanonicalRecord,
	parseCustodyPath,
	parseDatasetSchema,
	type RecordMutation,
	requirePort,
	runLogPivot,
	runRebuildAndSwap,
	runStreamHandoff,
	scopeOf,
	upsertMutation,
} from "@hobo/data-core";
import { createSqliteEngine } from "@hobo/data-sqlite";
import {
	createManualClock,
	createRuntimeLocalEventStore,
	type RuntimeLocalEventStore,
} from "@hobo/runtime-local";
import { afterEach, describe, test } from "vitest";

const NOW = "2026-11-10T00:00:00.000Z";
const ACTOR = { kind: "system" as const, id: "trails-e2e" };
const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "hobo-trails-e2e-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function eventStore(name: string): RuntimeLocalEventStore {
	const store = createRuntimeLocalEventStore({
		dataDir: path.join(tempDir(), name),
		clock: createManualClock(),
	});
	cleanups.push(() => store.close());
	return store;
}

function sqlite(name: string): EngineBinding {
	const engine = createSqliteEngine({
		path: path.join(tempDir(), `${name}.db`),
		clock: () => NOW,
	});
	cleanups.push(() => engine.close());
	return engine;
}

const ORDERS: DatasetSchema = parseDatasetSchema({
	name: "orders",
	keyFields: ["id"],
	fields: [
		{ name: "id", type: "string", nullable: false },
		{ name: "status", type: "string", nullable: false },
		{ name: "total", type: "decimal", nullable: false },
	],
});

const PATH = parseCustodyPath({
	points: [
		{ id: "log", role: "event-log", region: "eu-west-1", protections: [] },
		{ id: "sink", role: "target", region: "eu-west-1", protections: [] },
	],
});

function runtime(
	id: string,
	extra: Partial<MigrationRuntime> = {},
): MigrationRuntime {
	return {
		migrationId: id,
		journal: createMemoryMigrationJournal(),
		clock: () => NOW,
		policy: () =>
			evaluateCustodyPath({
				path: PATH,
				policy: { classification: "public" },
				now: NOW,
			}),
		...extra,
	};
}

function order(id: string, status: string, total: string) {
	const record = parseCanonicalRecord(ORDERS, { id, status, total });
	return { key: encodeRecordKey(ORDERS, record), record };
}

async function append(
	store: RuntimeLocalEventStore,
	type: string,
	id: string,
	data: { status?: string; total?: string } = {},
): Promise<void> {
	const streamId = `order:${id}`;
	let expectedSeq = 0;
	for await (const event of store.read(streamId)) expectedSeq = event.seq;
	await store.append(streamId, [{ type, data: { id, ...data } }], {
		expectedSeq,
		actor: ACTOR,
		tenant: "acme",
	});
}

const ORDER_EVENTS = new Set(["order.Recorded", "order.Paid", "order.Removed"]);

/**
 * Orders as a deterministic fold over the event log. A journal holds every
 * stream — including the migration's own facts — so a fold reads only the
 * event types it owns and ignores the rest.
 */
const ordersFold: ProjectionFold = {
	name: "orders-projection",
	async project(event, read): Promise<readonly RecordMutation[]> {
		if (!ORDER_EVENTS.has(event.type)) return [];
		// SAFETY: the order events appended by this file carry these JSON bodies.
		const data = event.data as { id: string; status?: string; total?: string };
		const { key } = order(data.id, "-", "0");
		if (event.type === "order.Recorded") {
			return [
				upsertMutation(
					"",
					key,
					order(data.id, data.status ?? "placed", data.total ?? "0").record,
				),
			];
		}
		if (event.type === "order.Paid") {
			const current = await read("", key);
			return current === undefined
				? []
				: [
						upsertMutation(
							"",
							key,
							parseCanonicalRecord(ORDERS, { ...current, status: "paid" }),
						),
					];
		}
		return [deleteMutation("", key)];
	},
};

async function digest(binding: EngineBinding) {
	return requirePort(binding, "verify").digest({
		scope: scopeOf("orders"),
		buckets: 8,
	});
}

describe("event-log patterns on the real event store and real SQLite engines", () => {
	test("rebuild-and-swap: a projected sink is rebuilt from the journal and swapped in", async () => {
		const log = eventStore("log");
		for (let index = 0; index < 30; index += 1) {
			await append(log, "order.Recorded", `o-${index}`, {
				total: `${index}.50`,
			});
			if (index % 3 === 0) await append(log, "order.Paid", `o-${index}`);
			if (index % 7 === 0) await append(log, "order.Removed", `o-${index}`);
		}
		const previous = sqlite("old-sink");
		const built = await runRebuildAndSwap({
			runtime: runtime("build-old"),
			log,
			fold: ordersFold,
			target: previous,
			schema: ORDERS,
			scope: scopeOf("orders"),
			batch: 11,
		});
		assert.equal(built.status, "completed");

		const target = sqlite("new-sink");
		const ramps: number[] = [];
		const result = await runRebuildAndSwap({
			runtime: runtime("swap"),
			log,
			fold: ordersFold,
			target,
			schema: ORDERS,
			scope: scopeOf("orders"),
			previous,
			batch: 4,
			shiftReads: (percent) => {
				ramps.push(percent);
			},
		});
		assert.equal(result.status, "completed");
		assert.deepEqual(ramps, [10, 50, 100]);
		const [oldDigest, newDigest] = [
			await digest(previous),
			await digest(target),
		];
		assert.ok(compareDigests(oldDigest, newDigest).equal);
		// 30 recorded, o-0/7/14/21/28 removed.
		assert.equal(newDigest.count, 25);
		const paid = await target.records.read({
			dataset: "orders",
			tenant: "",
			key: order("o-3", "-", "0").key,
		});
		assert.equal(paid?.status, "paid");
	});

	test("log-pivot: an authoritative SQLite store's authority moves into the real journal", async () => {
		const source = sqlite("adopted");
		await source.datasets.ensureDataset(ORDERS);
		await source.records.write({
			dataset: "orders",
			mutations: Array.from({ length: 20 }, (_, index) => {
				const { key, record } = order(`o-${index}`, "placed", `${index}.25`);
				return upsertMutation("", key, record);
			}),
		});
		const log = eventStore("log");
		const target = sqlite("projected");
		const toEvents = (change: ChangeEnvelope): readonly PivotEvent[] => {
			// SAFETY: the canonical key of the orders schema is a one-element array.
			const [id] = JSON.parse(change.key) as [string];
			return change.op === "delete" || change.record === undefined
				? [{ streamId: `order:${id}`, type: "order.Removed", data: { id } }]
				: [
						{
							streamId: `order:${id}`,
							type: "order.Recorded",
							data: {
								id,
								status: String(change.record.status),
								total: String(change.record.total),
							},
						},
					];
		};
		let flipped = false;
		const afterPhase = async (phase: MigrationPhase): Promise<void> => {
			if (flipped) return;
			const added = order(`during-${phase}`, "placed", "1");
			await source.records.write({
				dataset: "orders",
				mutations: [
					upsertMutation("", added.key, added.record),
					deleteMutation("", order(`o-${phase.length}`, "-", "0").key),
				],
			});
		};
		const journal = createEventStoreMigrationJournal(log, {
			tenant: "acme",
			actor: ACTOR,
		});
		const result = await runLogPivot({
			runtime: runtime("pivot", { journal, afterPhase }),
			source,
			schema: ORDERS,
			scope: scopeOf("orders"),
			log,
			toEvents,
			append: { actor: ACTOR, tenant: "acme" },
			fold: ordersFold,
			target,
			targetSchema: ORDERS,
			targetScope: scopeOf("orders"),
			flipAuthority: () => {
				flipped = true;
			},
			chunkSize: 6,
			tailBatch: 3,
		});
		assert.equal(result.status, "completed");
		assert.ok(flipped);
		assert.ok(compareDigests(await digest(source), await digest(target)).equal);
		// The old store is fenced; authority lives in the log now.
		await assert.rejects(async () => {
			await source.records.write({
				dataset: "orders",
				mutations: [deleteMutation("", order("o-1", "-", "0").key)],
			});
		}, /fenced/u);
		// The migration's own facts are a stream in the same journal, and replay.
		const replayed = foldMigration("pivot", await journal.load("pivot"));
		assert.equal(replayed.status, "completed");
		assert.equal(replayed.pattern, "log-pivot");
		assert.equal(replayed.cutOver, true);
	});

	test("stream-handoff: the journal itself moves to a second real event store", async () => {
		const source = eventStore("source-log");
		for (let index = 0; index < 15; index += 1) {
			await append(source, "order.Recorded", `o-${index}`, {
				total: `${index}`,
			});
			if (index % 4 === 0) await append(source, "order.Paid", `o-${index}`);
		}
		const target = eventStore("target-log");
		let quiesced = false;
		const afterPhase = async (phase: MigrationPhase): Promise<void> => {
			if (quiesced) return;
			await append(source, "order.Recorded", `during-${phase}`, { total: "2" });
		};
		const result = await runStreamHandoff({
			runtime: runtime("handoff", { afterPhase }),
			source,
			target,
			batch: 5,
			quiesce: () => {
				quiesced = true;
				return { fenceToken: "owner-epoch-2" };
			},
			unquiesce: () => {
				quiesced = false;
			},
			flipWriter: () => {},
		});
		assert.equal(result.status, "completed");
		assert.deepEqual(result.impedance, [HANDOFF_IDENTITY_IMPEDANCE]);
		const [before, after] = [
			await eventLogDigest(source),
			await eventLogDigest(target),
		];
		assert.deepEqual(after, before);
		assert.ok(after.count >= 19);
		// Stream and sequence survive; the new store continues each stream.
		const copied: { seq: number; type: string }[] = [];
		for await (const event of target.read("order:o-4")) {
			copied.push({ seq: event.seq, type: event.type });
		}
		assert.deepEqual(copied, [
			{ seq: 1, type: "order.Recorded" },
			{ seq: 2, type: "order.Paid" },
		]);
		await append(target, "order.Removed", "o-4");
	});
});
