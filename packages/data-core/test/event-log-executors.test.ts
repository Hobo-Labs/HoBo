// The three patterns that move data through the event log, each run end to
// end: rebuild-and-swap (projected data), log-pivot (authority moves into the
// log), and stream-handoff (the journal itself).
import assert from "node:assert/strict";
import type { EventEnvelope, PrincipalRef } from "@hobo/core";
import { describe, test } from "vitest";
import {
	type CanonicalRecord,
	type ChangeEnvelope,
	compareDigests,
	createMemoryMigrationJournal,
	createReferenceEngine,
	type DatasetSchema,
	deleteMutation,
	type EngineBinding,
	encodeRecordKey,
	evaluateCustodyPath,
	eventLogDigest,
	HANDOFF_IDENTITY_IMPEDANCE,
	type MigrationPhase,
	type MigrationRuntime,
	type PivotEvent,
	type PolicyVerdict,
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
} from "../src/index.js";
import {
	createMemoryEventStore,
	type MemoryEventStore,
} from "./support/memory-event-store.js";

const NOW = "2026-11-10T00:00:00.000Z";
const ACTOR: PrincipalRef = { kind: "system", id: "migration-test" };

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

function allow(): PolicyVerdict {
	return evaluateCustodyPath({
		path: PATH,
		policy: { classification: "public" },
		now: NOW,
	});
}

function runtime(
	id: string,
	extra: Partial<MigrationRuntime> = {},
): MigrationRuntime {
	return {
		migrationId: id,
		journal: createMemoryMigrationJournal(),
		clock: () => NOW,
		policy: allow,
		...extra,
	};
}

/** Orders as a fold: Placed creates, Paid updates in place, Cancelled removes. */
const ordersFold: ProjectionFold = {
	name: "orders-projection",
	async project(
		event: EventEnvelope,
		read,
	): Promise<readonly RecordMutation[]> {
		// SAFETY: test events carry the JSON bodies appended below.
		const data = event.data as { id: string; total?: string };
		const key = encodeRecordKey(
			ORDERS,
			parseCanonicalRecord(ORDERS, {
				id: data.id,
				status: "-",
				total: "0",
			}),
		);
		switch (event.type) {
			case "order.Placed":
				return [
					upsertMutation(
						event.tenant,
						key,
						parseCanonicalRecord(ORDERS, {
							id: data.id,
							status: "placed",
							total: data.total ?? "0",
						}),
					),
				];
			case "order.Paid": {
				const current = await read(event.tenant, key);
				if (current === undefined) return [];
				return [
					upsertMutation(
						event.tenant,
						key,
						parseCanonicalRecord(ORDERS, { ...current, status: "paid" }),
					),
				];
			}
			case "order.Cancelled":
				return [deleteMutation(event.tenant, key)];
			default:
				return [];
		}
	},
};

async function emit(
	log: MemoryEventStore,
	type: string,
	id: string,
	total?: string,
): Promise<void> {
	const streamId = `order:${id}`;
	await log.append(
		streamId,
		[{ type, data: { id, ...(total === undefined ? undefined : { total }) } }],
		{
			expectedSeq: log.getStreamHead(streamId)?.revision ?? 0,
			actor: ACTOR,
			tenant: "acme",
		},
	);
}

async function seedLog(log: MemoryEventStore, orders: number): Promise<void> {
	for (let index = 0; index < orders; index += 1) {
		await emit(log, "order.Placed", `o-${index}`, `${index}.50`);
		if (index % 3 === 0) await emit(log, "order.Paid", `o-${index}`);
		if (index % 7 === 0) await emit(log, "order.Cancelled", `o-${index}`);
	}
}

async function digest(binding: EngineBinding, dataset = "orders") {
	return requirePort(binding, "verify").digest({
		scope: scopeOf(dataset),
		buckets: 8,
	});
}

describe("rebuild-and-swap", () => {
	test("a projected sink moves to another engine by replay, with no capture and no fence", async () => {
		const log = createMemoryEventStore(() => NOW);
		await seedLog(log, 40);
		// The sink being replaced, built by the same fold.
		const previous = createReferenceEngine({ engine: "old-sink" });
		const first = await runRebuildAndSwap({
			runtime: runtime("build-previous"),
			log,
			fold: ordersFold,
			target: previous,
			schema: ORDERS,
			scope: scopeOf("orders"),
			batch: 7,
		});
		assert.equal(first.status, "completed");

		// The new sink declares neither capture nor fence: replay needs neither.
		const target = createReferenceEngine({
			engine: "new-sink",
			omit: ["capture", "fence", "snapshot", "retire"],
		});
		const ramps: number[] = [];
		let retired = false;
		// Events keep arriving while the rebuild runs.
		const afterPhase = async (phase: MigrationPhase): Promise<void> => {
			if (phase === "finalize") return;
			await emit(log, "order.Placed", `late-${phase}`, "9.99");
			await runRebuildAndSwap({
				runtime: runtime(`keep-previous-current-${phase}`),
				log,
				fold: ordersFold,
				target: previous,
				schema: ORDERS,
				scope: scopeOf("orders"),
			});
		};
		const result = await runRebuildAndSwap({
			runtime: runtime("swap", { afterPhase }),
			log,
			fold: ordersFold,
			target,
			schema: ORDERS,
			scope: scopeOf("orders"),
			previous,
			batch: 7,
			shiftReads: (percent) => {
				ramps.push(percent);
			},
			retirePrevious: () => {
				retired = true;
			},
		});
		assert.equal(result.status, "completed");
		assert.deepEqual(ramps, [10, 50, 100]);
		assert.ok(retired);
		assert.ok(result.facts.some((fact) => fact.type === "migration.Verified"));
		assert.ok(
			!result.facts.some((fact) => fact.type === "migration.CutOver"),
			"a projected swap has no write cutover: writes never touched the sink",
		);
	});

	test("replaying from zero twice produces the identical sink", async () => {
		const log = createMemoryEventStore(() => NOW);
		await seedLog(log, 25);
		const build = async (name: string, batch: number) => {
			const sink = createReferenceEngine({ engine: name });
			await runRebuildAndSwap({
				runtime: runtime(name),
				log,
				fold: ordersFold,
				target: sink,
				schema: ORDERS,
				scope: scopeOf("orders"),
				batch,
			});
			return digest(sink);
		};
		// Different batch sizes exercise the read-through overlay differently.
		const a = await build("a", 1);
		const b = await build("b", 1000);
		assert.ok(compareDigests(a, b).equal);
		assert.ok(a.count > 0);
	});

	test("a rollback in soak sends reads home and loses nothing", async () => {
		const log = createMemoryEventStore(() => NOW);
		await seedLog(log, 10);
		const ramps: number[] = [];
		const result = await runRebuildAndSwap({
			runtime: runtime("swap-rollback"),
			log,
			fold: ordersFold,
			target: createReferenceEngine(),
			schema: ORDERS,
			scope: scopeOf("orders"),
			shiftReads: (percent) => {
				ramps.push(percent);
			},
			soakDecision: () => "rollback",
		});
		assert.equal(result.status, "rolled-back");
		assert.equal(ramps.at(-1), 0);
		const rolled = result.facts.find(
			(fact) => fact.type === "migration.RolledBack",
		);
		assert.equal(rolled?.data.lossless, true);
	});

	test("a rebuilt sink that disagrees with the one it replaces holds instead of swapping", async () => {
		const log = createMemoryEventStore(() => NOW);
		await seedLog(log, 10);
		const previous = createReferenceEngine({ engine: "old-sink" });
		await previous.datasets.ensureDataset(ORDERS);
		// The old sink is missing everything: digests cannot agree.
		const ramps: number[] = [];
		const result = await runRebuildAndSwap({
			runtime: runtime("swap-mismatch"),
			log,
			fold: ordersFold,
			target: createReferenceEngine(),
			schema: ORDERS,
			scope: scopeOf("orders"),
			previous,
			verifyRechecks: 1,
			shiftReads: (percent) => {
				ramps.push(percent);
			},
		});
		assert.equal(result.status, "held");
		assert.equal(result.rollback, "lossless");
		assert.deepEqual(ramps, [], "reads never moved");
	});
});

describe("log-pivot", () => {
	/** The authored re-model: a row change becomes a domain event. */
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

	const pivotFold: ProjectionFold = {
		name: "orders-pivot",
		project(event: EventEnvelope): readonly RecordMutation[] {
			// SAFETY: pivot events carry the bodies `toEvents` built above.
			const data = event.data as {
				id: string;
				status?: string;
				total?: string;
			};
			const record: CanonicalRecord = parseCanonicalRecord(ORDERS, {
				id: data.id,
				status: data.status ?? "-",
				total: data.total ?? "0",
			});
			const key = encodeRecordKey(ORDERS, record);
			if (event.type === "order.Recorded")
				return [upsertMutation("", key, record)];
			if (event.type === "order.Removed") return [deleteMutation("", key)];
			return [];
		},
	};

	async function seedStore(store: EngineBinding, rows: number): Promise<void> {
		await store.datasets.ensureDataset(ORDERS);
		const mutations: RecordMutation[] = [];
		for (let index = 0; index < rows; index += 1) {
			const record = parseCanonicalRecord(ORDERS, {
				id: `o-${index}`,
				status: "placed",
				total: `${index}.25`,
			});
			mutations.push(
				upsertMutation("", encodeRecordKey(ORDERS, record), record),
			);
		}
		await store.records.write({ dataset: "orders", mutations });
	}

	test("an authoritative store's authority moves into the log, verified by digest, and stays there", async () => {
		const source = createReferenceEngine({ engine: "adopted-store" });
		await seedStore(source, 30);
		const log = createMemoryEventStore(() => NOW);
		const target = createReferenceEngine({ engine: "projected-sink" });
		let flipped = false;
		// The store keeps taking writes until the fence.
		const afterPhase = async (phase: MigrationPhase): Promise<void> => {
			if (flipped) return;
			const record = parseCanonicalRecord(ORDERS, {
				id: `during-${phase}`,
				status: "placed",
				total: "1",
			});
			await source.records.write({
				dataset: "orders",
				mutations: [
					upsertMutation("", encodeRecordKey(ORDERS, record), record),
					deleteMutation(
						"",
						encodeRecordKey(
							ORDERS,
							parseCanonicalRecord(ORDERS, {
								id: `o-${phase.length}`,
								status: "-",
								total: "0",
							}),
						),
					),
				],
			});
		};
		const result = await runLogPivot({
			runtime: runtime("pivot", { afterPhase }),
			source,
			schema: ORDERS,
			scope: scopeOf("orders"),
			log,
			toEvents,
			append: { actor: ACTOR, tenant: "acme" },
			fold: pivotFold,
			target,
			targetSchema: ORDERS,
			targetScope: scopeOf("orders"),
			flipAuthority: () => {
				flipped = true;
			},
			chunkSize: 7,
			tailBatch: 4,
		});
		assert.equal(result.status, "completed");
		assert.ok(flipped);
		assert.ok(compareDigests(await digest(source), await digest(target)).equal);
		const cutOver = result.facts.find(
			(fact) => fact.type === "migration.CutOver",
		);
		assert.equal(cutOver?.data.authority, "log");
		// The old store is fenced: authority does not come back.
		await assert.rejects(async () => {
			await source.records.write({
				dataset: "orders",
				mutations: [deleteMutation("", '["o-1"]')],
			});
		}, /fenced/u);
		assert.ok(log.size() > 30, "the log now holds the data as events");
	});

	test("re-running after a crash appends no event twice", async () => {
		const source = createReferenceEngine({ engine: "adopted-store" });
		await seedStore(source, 12);
		const log = createMemoryEventStore(() => NOW);
		const target = createReferenceEngine({ engine: "projected-sink" });
		const journal = createMemoryMigrationJournal();
		const options = {
			source,
			schema: ORDERS,
			scope: scopeOf("orders"),
			log,
			toEvents,
			append: { actor: ACTOR, tenant: "acme" },
			fold: pivotFold,
			target,
			targetSchema: ORDERS,
			targetScope: scopeOf("orders"),
			flipAuthority: () => {},
		};
		let crashed = false;
		await assert.rejects(
			runLogPivot({
				...options,
				runtime: runtime("pivot-crash", {
					journal,
					afterPhase: (phase) => {
						if (phase === "seed" && !crashed) {
							crashed = true;
							throw new Error("injected crash after seed");
						}
					},
				}),
			}),
			/injected crash/u,
		);
		const afterCrash = log.size();
		assert.equal(afterCrash, 12);
		const resumed = await runLogPivot({
			...options,
			runtime: runtime("pivot-crash", { journal }),
		});
		assert.equal(resumed.status, "completed");
		assert.equal(log.size(), 12, "no event was appended twice");
		assert.equal((await digest(target)).count, 12);
	});
});

describe("stream-handoff", () => {
	test("the journal moves to a new store with stream, sequence, and payload intact", async () => {
		const source = createMemoryEventStore(() => "2026-01-01T00:00:00.000Z");
		await seedLog(source, 20);
		const target = createMemoryEventStore(() => NOW);
		let flipped = false;
		const afterPhase = async (phase: MigrationPhase): Promise<void> => {
			if (source.quiesced) return;
			await emit(source, "order.Placed", `during-${phase}`, "2.00");
		};
		const result = await runStreamHandoff({
			runtime: runtime("handoff", { afterPhase }),
			source,
			target,
			batch: 6,
			quiesce: () => {
				source.quiesced = true;
				return { fenceToken: "epoch-2" };
			},
			unquiesce: () => {
				source.quiesced = false;
			},
			flipWriter: () => {
				flipped = true;
			},
		});
		assert.equal(result.status, "completed");
		assert.ok(flipped);
		assert.equal(target.size(), source.size());
		assert.deepEqual(
			await eventLogDigest(source),
			await eventLogDigest(target),
		);
		// The honest limit, reported rather than hidden.
		assert.deepEqual(result.impedance, [HANDOFF_IDENTITY_IMPEDANCE]);
		const copied: EventEnvelope[] = [];
		for await (const event of target.read("order:o-0")) copied.push(event);
		const original: EventEnvelope[] = [];
		for await (const event of source.read("order:o-0")) original.push(event);
		assert.deepEqual(
			copied.map((event) => [event.seq, event.type]),
			original.map((event) => [event.seq, event.type]),
		);
		assert.deepEqual(copied[0]?.meta?.handoff, {
			id: original[0]?.id,
			ts: original[0]?.ts,
			position: "1",
		});
		// The new store is writable where the old one left off.
		await emit(target, "order.Paid", "o-1");
	});

	test("a handoff resumed from scratch copies nothing twice", async () => {
		const source = createMemoryEventStore(() => NOW);
		await seedLog(source, 9);
		const target = createMemoryEventStore(() => NOW);
		const journal = createMemoryMigrationJournal();
		const options = {
			source,
			target,
			quiesce: () => ({ fenceToken: "epoch-2" }),
			unquiesce: () => {},
			flipWriter: () => {},
		};
		let crashed = false;
		await assert.rejects(
			runStreamHandoff({
				...options,
				runtime: runtime("handoff-crash", {
					journal,
					afterPhase: (phase) => {
						if (phase === "seed" && !crashed) {
							crashed = true;
							throw new Error("injected crash after seed");
						}
					},
				}),
			}),
			/injected crash/u,
		);
		const resumed = await runStreamHandoff({
			...options,
			runtime: runtime("handoff-crash", { journal }),
		});
		assert.equal(resumed.status, "completed");
		assert.equal(target.size(), source.size());
	});

	test("a target that already diverged is refused, and the source stays the writer", async () => {
		const source = createMemoryEventStore(() => NOW);
		await seedLog(source, 5);
		const target = createMemoryEventStore(() => NOW);
		// A stream the source never had: the logs can no longer be equal.
		await emit(target, "order.Placed", "rogue", "1.00");
		let quiesced = false;
		let flipped = false;
		const result = await runStreamHandoff({
			runtime: runtime("handoff-diverged"),
			source,
			target,
			quiesce: () => {
				quiesced = true;
				return { fenceToken: "epoch-2" };
			},
			unquiesce: () => {
				quiesced = false;
			},
			flipWriter: () => {
				flipped = true;
			},
		});
		assert.equal(result.status, "held");
		assert.ok(!flipped, "the writer never moved");
		assert.ok(!quiesced, "the source was released to keep writing");
	});
});
