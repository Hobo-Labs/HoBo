// M2 Private Beta: live expand → backfill → contract over a REAL SQLite
// store. The contract phase is compat-gated (blocked ≠ failed: the dual
// window stays open); verification failure restores the pre-migration
// snapshot (forward-only rollback, no .down scripts).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createSqliteSchemaApplyPort } from "@hobo/data-sqlite";
import { afterEach, test } from "vitest";
import {
	type CompatGateEvidence,
	executeDataMigration,
	MIGRATION_EVENTS,
} from "../src/migration-executor.js";

const cleanups: (() => void)[] = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function seededStore(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "hobo-mig-"));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	const storePath = path.join(dir, "app.db");
	const db = new DatabaseSync(storePath);
	db.exec(`
		CREATE TABLE checkout (id TEXT PRIMARY KEY, email TEXT NOT NULL);
		INSERT INTO checkout (id, email) VALUES
			('c1', 'a@example.test'), ('c2', 'b@example.test');
	`);
	db.close();
	return storePath;
}

// Rename email → requester_ref via expand/backfill/contract.
const PLAN = {
	migrationId: "mig-checkout-ref",
	expand: ["ALTER TABLE checkout ADD COLUMN requester_ref TEXT"],
	backfill: [
		"UPDATE checkout SET requester_ref = 'email:' || email WHERE requester_ref IS NULL",
	],
	contract: ["ALTER TABLE checkout DROP COLUMN email"],
	verify: {
		afterBackfill:
			"SELECT id FROM checkout WHERE requester_ref IS NULL OR requester_ref = ''",
		afterContract: "SELECT id FROM checkout WHERE requester_ref IS NULL",
	},
} as const;

function gate(consumers: readonly string[]): () => CompatGateEvidence {
	return () => ({
		gateId: "compat:checkout-readers",
		consumersOnLegacySchema: consumers,
		verifiedAt: "2026-08-03T00:00:00.000Z",
	});
}

test("milestone: full expand→backfill→contract completes with the migration.* ladder", async () => {
	const storePath = seededStore();
	const port = createSqliteSchemaApplyPort({ path: storePath });
	cleanups.push(() => port.close());

	const result = await executeDataMigration({
		port,
		plan: PLAN,
		compatGate: gate([]),
	});

	assert.equal(result.status, "completed");
	assert.equal(result.dualWindowOpen, false);
	assert.deepEqual(
		result.facts.map((fact) => fact.type),
		[
			MIGRATION_EVENTS.Planned,
			MIGRATION_EVENTS.SnapshotTaken,
			MIGRATION_EVENTS.PhaseApplied,
			MIGRATION_EVENTS.PhaseApplied,
			MIGRATION_EVENTS.Verified,
			MIGRATION_EVENTS.PhaseApplied,
			MIGRATION_EVENTS.Verified,
			MIGRATION_EVENTS.CutOver,
		],
	);

	// The store REALLY changed: old column gone, new shape backfilled.
	const db = new DatabaseSync(storePath);
	cleanups.push(() => db.close());
	// SAFETY: the SELECT fixes the returned row columns.
	const rows = (
		db.prepare("SELECT id, requester_ref FROM checkout ORDER BY id").all() as {
			id: string;
			requester_ref: string;
		}[]
	).map((row) => ({ ...row }));
	assert.deepEqual(rows, [
		{ id: "c1", requester_ref: "email:a@example.test" },
		{ id: "c2", requester_ref: "email:b@example.test" },
	]);
	assert.throws(() => db.prepare("SELECT email FROM checkout").all());
});

test("milestone: a consumer still on the old shape BLOCKS contract; the dual window stays open", async () => {
	const storePath = seededStore();
	const port = createSqliteSchemaApplyPort({ path: storePath });
	cleanups.push(() => port.close());

	const result = await executeDataMigration({
		port,
		plan: PLAN,
		compatGate: gate(["billing-projector@1.2"]),
	});

	assert.equal(result.status, "contract-blocked");
	assert.equal(result.dualWindowOpen, true);
	assert.match(result.blockedReasons[0] ?? "", /billing-projector@1\.2/u);
	// No RolledBack/Failed fact — blocked is a held dual window, not a failure.
	assert.ok(
		!result.facts.some(
			(fact) =>
				fact.type === MIGRATION_EVENTS.RolledBack ||
				fact.type === MIGRATION_EVENTS.Failed,
		),
	);

	// Expand + backfill retained; old column STILL present.
	const db = new DatabaseSync(storePath);
	cleanups.push(() => db.close());
	// SAFETY: the SELECT fixes the returned row columns.
	const rows = db
		.prepare("SELECT id, email, requester_ref FROM checkout ORDER BY id")
		.all() as { id: string; email: string; requester_ref: string }[];
	assert.equal(rows.length, 2);
	assert.equal(rows[0]?.requester_ref, "email:a@example.test");
});

test("milestone: failed verification restores the pre-migration snapshot", async () => {
	const storePath = seededStore();
	const port = createSqliteSchemaApplyPort({ path: storePath });
	cleanups.push(() => port.close());

	const result = await executeDataMigration({
		port,
		plan: {
			...PLAN,
			migrationId: "mig-checkout-broken",
			// Backfill "forgets" one row → verification finds a violation.
			backfill: [
				"UPDATE checkout SET requester_ref = 'email:' || email WHERE id = 'c1'",
			],
		},
		compatGate: gate([]),
	});

	assert.equal(result.status, "rolled-back");
	assert.equal(
		result.facts[result.facts.length - 1]?.type,
		MIGRATION_EVENTS.RolledBack,
	);
	assert.equal(result.violations.length, 1);

	// Restored: the new column is GONE again (pre-migration snapshot state).
	const db = new DatabaseSync(storePath);
	cleanups.push(() => db.close());
	assert.throws(() => db.prepare("SELECT requester_ref FROM checkout").all());
	const rows = db.prepare("SELECT id, email FROM checkout ORDER BY id").all();
	assert.equal(rows.length, 2);
});

test("a failing contract statement rolls back to the snapshot", async () => {
	const storePath = seededStore();
	const port = createSqliteSchemaApplyPort({ path: storePath });
	cleanups.push(() => port.close());

	const result = await executeDataMigration({
		port,
		plan: {
			...PLAN,
			migrationId: "mig-checkout-bad-contract",
			contract: ["ALTER TABLE checkout DROP COLUMN does_not_exist"],
		},
		compatGate: gate([]),
	});

	assert.equal(result.status, "rolled-back");
	const db = new DatabaseSync(storePath);
	cleanups.push(() => db.close());
	// Snapshot state: no requester_ref, email intact.
	assert.throws(() => db.prepare("SELECT requester_ref FROM checkout").all());
});
