// The migration aggregate: policy is recomputed before every phase, a
// negative verdict holds at a safe state, and a run resumes from its facts.
import assert from "node:assert/strict";
import type { PrincipalRef } from "@hobo/core";
import { describe, test } from "vitest";
import {
	createEventStoreMigrationJournal,
	createMemoryMigrationJournal,
	createReferenceEngine,
	type DatasetSchema,
	type EngineBinding,
	encodeRecordKey,
	evaluateCustodyPath,
	foldMigration,
	isSafeHold,
	MIGRATION_EVENTS,
	MIGRATION_PHASES,
	type MigrationPhase,
	type PolicyVerdict,
	parseCanonicalRecord,
	parseCustodyPath,
	parseDatasetSchema,
	requirePort,
	runInPlaceEvolve,
	runSnapshotAndTail,
	type SchemaApplyPort,
	scopeOf,
	upsertMutation,
} from "../src/index.js";
import { createMemoryEventStore } from "./support/memory-event-store.js";

const NOW = "2026-11-10T00:00:00.000Z";
const ACTOR: PrincipalRef = { kind: "system", id: "migration-test" };

const ORDERS: DatasetSchema = parseDatasetSchema({
	name: "orders",
	keyFields: ["id"],
	fields: [
		{ name: "id", type: "string", nullable: false },
		{ name: "total", type: "decimal", nullable: false },
	],
});

const FULL = [
	"encryptedAtRest",
	"encryptedInTransit",
	"accessScoped",
	"auditLogged",
];

function verdict(targetRegion: string): PolicyVerdict {
	return evaluateCustodyPath({
		path: parseCustodyPath({
			points: [
				{
					id: "source",
					role: "source",
					region: "eu-west-1",
					protections: FULL,
				},
				{
					id: "target",
					role: "target",
					region: targetRegion,
					protections: FULL,
				},
			],
		}),
		policy: {
			classification: "pii",
			residency: { classifications: [], allowedJurisdictions: ["eu"] },
		},
		now: NOW,
	});
}

async function seeded(rows: number): Promise<EngineBinding> {
	const source = createReferenceEngine({ engine: "source" });
	await source.datasets.ensureDataset(ORDERS);
	await source.records.write({
		dataset: "orders",
		mutations: Array.from({ length: rows }, (_, index) => {
			const record = parseCanonicalRecord(ORDERS, {
				id: `o-${index}`,
				total: `${index}`,
			});
			return upsertMutation("", encodeRecordKey(ORDERS, record), record);
		}),
	});
	return source;
}

describe("continuous policy", () => {
	test("a verdict that turns negative mid-migration holds at the last safe state, then resumes", async () => {
		const source = await seeded(8);
		const target = createReferenceEngine({ engine: "target" });
		const journal = createMemoryMigrationJournal();
		// The residency rule changes after the seed: the target's region is no
		// longer allowed. Nothing about the migration's own inputs changed.
		let allowed = true;
		const asked: MigrationPhase[] = [];
		const policy = (phase: MigrationPhase): PolicyVerdict => {
			asked.push(phase);
			return verdict(allowed ? "eu-central-1" : "us-east-1");
		};
		const options = {
			source,
			target,
			schema: ORDERS,
			scope: scopeOf("orders"),
			flipAuthority: () => {},
		};
		const held = await runSnapshotAndTail({
			...options,
			runtime: {
				migrationId: "policy",
				journal,
				clock: () => NOW,
				policy,
				afterPhase: (phase) => {
					if (phase === "seed") allowed = false;
				},
			},
		});
		assert.equal(held.status, "held");
		assert.equal(held.phase, "seed");
		assert.equal(held.rollback, "lossless");
		assert.match(held.reason ?? "", /CUSTODY_RESIDENCY_CONFLICT/u);
		assert.deepEqual(asked, ["gate", "prepare", "seed", "converge"]);
		assert.equal(held.state.heldAt, "seed");
		// The source never stopped being writable: a hold is not an outage.
		const record = parseCanonicalRecord(ORDERS, {
			id: "while-held",
			total: "1",
		});
		await source.records.write({
			dataset: "orders",
			mutations: [upsertMutation("", encodeRecordKey(ORDERS, record), record)],
		});

		// Still denied: re-running changes nothing and moves nothing.
		const stillHeld = await runSnapshotAndTail({
			...options,
			runtime: { migrationId: "policy", journal, clock: () => NOW, policy },
		});
		assert.equal(stillHeld.status, "held");

		allowed = true;
		const resumed = await runSnapshotAndTail({
			...options,
			runtime: { migrationId: "policy", journal, clock: () => NOW, policy },
		});
		assert.equal(resumed.status, "completed");
		assert.ok(
			resumed.facts.some((fact) => fact.type === MIGRATION_EVENTS.Resumed),
		);
		const digest = await requirePort(target, "verify").digest({
			scope: scopeOf("orders"),
			buckets: 4,
		});
		assert.equal(digest.count, 9, "the write made during the hold arrived too");
	});

	test("a negative verdict straight after the flip holds in the soak window, not inside the flip", async () => {
		const source = await seeded(3);
		const target = createReferenceEngine({ engine: "target" });
		let allowed = true;
		const held = await runSnapshotAndTail({
			source,
			target,
			schema: ORDERS,
			scope: scopeOf("orders"),
			flipAuthority: () => {
				allowed = false;
			},
			runtime: {
				migrationId: "post-flip",
				journal: createMemoryMigrationJournal(),
				clock: () => NOW,
				policy: () => verdict(allowed ? "eu-central-1" : "us-east-1"),
			},
		});
		assert.equal(held.status, "held");
		assert.equal(held.state.heldAt, "soak");
		assert.equal(held.state.cutOver, true);
	});

	test("fence-and-flip and the terminal finalize are the only phases that cannot hold", () => {
		assert.deepEqual(
			MIGRATION_PHASES.filter((phase) => !isSafeHold(phase)),
			["fence-and-flip", "finalize"],
		);
	});
});

describe("a crash at the worst moment", () => {
	test("a crash after authority moved but before it was recorded resumes by finishing the move — never by releasing the old side", async () => {
		const source = await seeded(6);
		const target = createReferenceEngine({ engine: "target" });
		const journal = createMemoryMigrationJournal();
		let authority: "source" | "target" = "source";
		let flips = 0;
		const options = {
			source,
			target,
			schema: ORDERS,
			scope: scopeOf("orders"),
			soakDecision: () => "hold" as const,
		};
		// The flip lands, the application starts writing to the target, and
		// the process dies before the phase is recorded as complete.
		await assert.rejects(
			runSnapshotAndTail({
				...options,
				flipAuthority: () => {
					flips += 1;
					authority = "target";
					throw new Error("process died after the flip");
				},
				runtime: {
					migrationId: "worst-moment",
					journal,
					clock: () => NOW,
					policy: () => verdict("eu-central-1"),
				},
			}),
			/process died/u,
		);
		assert.equal(authority, "target");
		const written = parseCanonicalRecord(ORDERS, {
			id: "after-flip",
			total: "7",
		});
		await target.records.write({
			dataset: "orders",
			mutations: [
				upsertMutation("", encodeRecordKey(ORDERS, written), written),
			],
		});

		const resumed = await runSnapshotAndTail({
			...options,
			flipAuthority: () => {
				flips += 1;
				authority = "target";
			},
			runtime: {
				migrationId: "worst-moment",
				journal,
				clock: () => NOW,
				policy: () => verdict("eu-central-1"),
			},
		});
		// The resume did not re-verify against a target that had moved on, and
		// so did not "compensate" by handing writes back to the source.
		assert.equal(resumed.status, "held");
		assert.equal(resumed.state.heldAt, "soak");
		assert.equal(resumed.state.cutOver, true);
		assert.equal(authority, "target");
		assert.equal(flips, 2, "the flip is repeated, which its contract allows");
		// Exactly one side is writable: the source is still fenced.
		await assert.rejects(async () => {
			await source.records.write({
				dataset: "orders",
				mutations: [
					upsertMutation("", encodeRecordKey(ORDERS, written), written),
				],
			});
		}, /fenced/u);
		// And the write the application made in between survived, here and — by
		// the reverse tail — on the old side too.
		const kept = await target.records.read({
			dataset: "orders",
			tenant: "",
			key: encodeRecordKey(ORDERS, written),
		});
		assert.equal(kept?.total, "7");
		const mirrored = await source.records.read({
			dataset: "orders",
			tenant: "",
			key: encodeRecordKey(ORDERS, written),
		});
		assert.equal(mirrored?.total, "7");
		assert.equal(
			(await journal.load("worst-moment")).filter(
				(fact) => fact.type === MIGRATION_EVENTS.CutOver,
			).length,
			1,
			"the cutover was decided once",
		);
	});
});

describe("migration journal", () => {
	test("a completed migration is a no-op when run again", async () => {
		const source = await seeded(4);
		const target = createReferenceEngine({ engine: "target" });
		const journal = createMemoryMigrationJournal();
		let flips = 0;
		const options = {
			source,
			target,
			schema: ORDERS,
			scope: scopeOf("orders"),
			flipAuthority: () => {
				flips += 1;
			},
			runtime: {
				migrationId: "once",
				journal,
				clock: () => NOW,
				policy: () => verdict("eu-central-1"),
			},
		};
		assert.equal((await runSnapshotAndTail(options)).status, "completed");
		const before = (await journal.load("once")).length;
		assert.equal((await runSnapshotAndTail(options)).status, "completed");
		assert.equal(flips, 1, "authority moved exactly once");
		assert.equal(
			(await journal.load("once")).length,
			before,
			"no fact was appended",
		);
	});

	test("a migration cannot continue as a different pattern", async () => {
		const journal = createMemoryMigrationJournal();
		await journal.append("mixed", {
			type: MIGRATION_EVENTS.Planned,
			data: { migrationId: "mixed", pattern: "offline-copy" },
		});
		await assert.rejects(
			runSnapshotAndTail({
				source: await seeded(1),
				target: createReferenceEngine(),
				schema: ORDERS,
				scope: scopeOf("orders"),
				flipAuthority: () => {},
				runtime: {
					migrationId: "mixed",
					journal,
					clock: () => NOW,
					policy: () => verdict("eu-central-1"),
				},
			}),
			/planned as offline-copy/u,
		);
	});

	test("the event-store journal persists facts as a stream and replays them", async () => {
		const store = createMemoryEventStore(() => NOW);
		const journal = createEventStoreMigrationJournal(store, {
			tenant: "acme",
			actor: ACTOR,
		});
		const source = await seeded(5);
		const target = createReferenceEngine({ engine: "target" });
		const result = await runSnapshotAndTail({
			source,
			target,
			schema: ORDERS,
			scope: scopeOf("orders"),
			flipAuthority: () => {},
			runtime: {
				migrationId: "durable",
				journal,
				clock: () => NOW,
				policy: () => verdict("eu-central-1"),
			},
		});
		assert.equal(result.status, "completed");
		const replayed = await journal.load("durable");
		assert.deepEqual(
			replayed.map((fact) => fact.type),
			result.facts.map((fact) => fact.type),
		);
		const state = foldMigration("durable", replayed);
		assert.equal(state.status, "completed");
		assert.equal(state.pattern, "snapshot-and-tail");
		assert.equal(
			store.getStreamHead("migration:durable")?.revision,
			replayed.length,
		);
		// Facts carry positions, counts, and digests — nothing else.
		assert.ok(!JSON.stringify(replayed).includes("o-3"));
	});
});

describe("in-place-evolve policy and erasure", () => {
	/** A schema port over a plain array of applied statements. */
	interface FakePort extends SchemaApplyPort {
		readonly applied: readonly string[];
		readonly restored: number;
	}

	function fakePort(): FakePort {
		let applied: string[] = [];
		let restored = 0;
		return {
			get applied() {
				return applied;
			},
			get restored() {
				return restored;
			},
			snapshot: () => ({ ref: "snap-1", takenAt: NOW }),
			applyPhase(phase, statements) {
				if (statements.includes("FAIL")) throw new Error("statement failed");
				applied.push(...statements);
				return { phase, statements: statements.length, changes: 0 };
			},
			verify: () => [],
			restore() {
				applied = [];
				restored += 1;
			},
		};
	}

	const plan = {
		migrationId: "evolve",
		expand: ["ADD"],
		backfill: ["FILL"],
		contract: ["DROP"],
		verify: { afterBackfill: "SELECT" },
	};
	const gate = () => ({
		gateId: "g",
		consumersOnLegacySchema: [],
		verifiedAt: NOW,
	});

	test("a negative verdict before the destructive phase holds with the dual window open", async () => {
		const port = fakePort();
		const result = await runInPlaceEvolve({
			port,
			plan,
			compatGate: gate,
			clock: () => NOW,
			policy: (phase) => ({
				ok: phase !== "contract",
				findings:
					phase === "contract" ? [{ code: "CUSTODY_RETENTION_EXPIRED" }] : [],
			}),
		});
		assert.equal(result.status, "held");
		assert.equal(result.dualWindowOpen, true);
		assert.deepEqual(port.applied, ["ADD", "FILL"], "the drop never ran");
		assert.match(result.blockedReasons[0] ?? "", /CUSTODY_RETENTION_EXPIRED/u);
	});

	test("a restore re-applies erasures, and the count is recorded", async () => {
		const port = fakePort();
		const result = await runInPlaceEvolve({
			port,
			plan: { ...plan, contract: ["FAIL"] },
			compatGate: gate,
			clock: () => NOW,
			replayErasures: () => 3,
		});
		assert.equal(result.status, "rolled-back");
		assert.equal(port.restored, 1);
		const rolled = result.facts.find(
			(fact) => fact.type === MIGRATION_EVENTS.RolledBack,
		);
		assert.equal(rolled?.data.erasuresReplayed, 3);
	});

	test("without the new hooks the fact sequence is the original executor's", async () => {
		const result = await runInPlaceEvolve({
			port: fakePort(),
			plan,
			compatGate: gate,
			clock: () => NOW,
		});
		assert.deepEqual(
			result.facts.map((fact) => fact.type),
			[
				"migration.Planned",
				"migration.SnapshotTaken",
				"migration.PhaseApplied",
				"migration.PhaseApplied",
				"migration.Verified",
				"migration.PhaseApplied",
				"migration.CutOver",
			],
		);
		assert.deepEqual(result.facts[0]?.data, {
			migrationId: "evolve",
			phases: ["expand", "backfill", "contract"],
			plannedAt: NOW,
		});
	});
});
