// M2 Private Beta: live expand → backfill → contract over a REAL SQLite
// store. The contract phase is compat-gated (blocked ≠ failed: the dual
// window stays open); verification failure restores the pre-migration
// snapshot (forward-only rollback, no .down scripts).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createMemoryMigrationJournal } from "@hobo/data-core";
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
			// Every phase is write-ahead: its intent, then its fact.
			MIGRATION_EVENTS.PhaseIntended,
			MIGRATION_EVENTS.PhaseApplied,
			MIGRATION_EVENTS.PhaseIntended,
			MIGRATION_EVENTS.PhaseApplied,
			MIGRATION_EVENTS.Verified,
			MIGRATION_EVENTS.PhaseIntended,
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
		// A restore needs the erasure replay; nothing was erased here.
		replayErasures: () => 0,
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
		// A restore needs the erasure replay; nothing was erased here.
		replayErasures: () => 0,
	});

	assert.equal(result.status, "rolled-back");
	const db = new DatabaseSync(storePath);
	cleanups.push(() => db.close());
	// Snapshot state: no requester_ref, email intact.
	assert.throws(() => db.prepare("SELECT requester_ref FROM checkout").all());
});

// M6: a held migration is resumable. Before the journal was threaded through,
// running the same plan again re-applied `expand` ("duplicate column"), took a
// second snapshot after that first expand, "restored" it, and reported
// rolled-back over a store that was still expanded.
test("a migration held before backfill resumes from its journal: expand runs once and the first snapshot is the one kept", async () => {
	const storePath = seededStore();
	const port = createSqliteSchemaApplyPort({ path: storePath });
	cleanups.push(() => port.close());
	const journal = createMemoryMigrationJournal();
	let allowed = false;
	const run = () =>
		executeDataMigration({
			port,
			plan: { ...PLAN, migrationId: "mig-checkout-resumed" },
			compatGate: gate([]),
			journal,
			replayErasures: () => 0,
			policy: (phase) => ({
				ok: phase !== "backfill" || allowed,
				findings:
					phase !== "backfill" || allowed
						? []
						: [{ code: "CUSTODY_RETENTION_EXPIRED" }],
				roles: ["source", "rollback-snapshot"],
			}),
		});

	const held = await run();
	assert.equal(held.status, "held");
	assert.deepEqual(
		held.facts.map((fact) => fact.type),
		[
			MIGRATION_EVENTS.Planned,
			MIGRATION_EVENTS.SnapshotTaken,
			MIGRATION_EVENTS.PhaseIntended,
			MIGRATION_EVENTS.PhaseApplied,
			MIGRATION_EVENTS.Held,
		],
	);

	allowed = true;
	const done = await run();
	assert.equal(done.status, "completed", done.blockedReasons.join("; "));
	assert.equal(done.snapshot?.ref, held.snapshot?.ref);
	const applied = done.facts.filter(
		(fact) => fact.type === MIGRATION_EVENTS.PhaseApplied,
	);
	assert.deepEqual(
		applied.map((fact) => fact.data.phase),
		["expand", "backfill", "contract"],
	);
	assert.equal(
		done.facts.filter((fact) => fact.type === MIGRATION_EVENTS.SnapshotTaken)
			.length,
		1,
	);
	assert.deepEqual(
		done.facts.slice(4, 6).map((fact) => fact.type),
		[MIGRATION_EVENTS.Held, MIGRATION_EVENTS.Resumed],
	);

	// The store really is migrated: the new column is filled, the old is gone.
	const db = new DatabaseSync(storePath);
	cleanups.push(() => db.close());
	const rows = db
		.prepare("SELECT id, requester_ref FROM checkout ORDER BY id")
		.all();
	assert.deepEqual(
		rows.map((row) => ({ ...row })),
		[
			{ id: "c1", requester_ref: "email:a@example.test" },
			{ id: "c2", requester_ref: "email:b@example.test" },
		],
	);
	assert.throws(() => db.prepare("SELECT email FROM checkout").all());

	// And a third run is a no-op.
	const again = await run();
	assert.equal(again.status, "completed");
	assert.equal(again.facts.length, done.facts.length);
});

test("without an erasure replay a failed phase holds instead of restoring; no fact or result carries the store's error text", async () => {
	const storePath = seededStore();
	const port = createSqliteSchemaApplyPort({ path: storePath });
	cleanups.push(() => port.close());
	const journal = createMemoryMigrationJournal();
	const plan = {
		...PLAN,
		migrationId: "mig-checkout-no-ledger",
		contract: ["ALTER TABLE checkout DROP COLUMN does_not_exist"],
	};
	const held = await executeDataMigration({
		port,
		plan,
		compatGate: gate([]),
		journal,
	});
	assert.equal(held.status, "held");
	assert.match(
		held.blockedReasons.join("; "),
		/no erasure replay was supplied/u,
	);
	// M10: SQLite's message names the column; none of it is recorded.
	assert.doesNotMatch(JSON.stringify(held), /does_not_exist|no such column/u);
	assert.match(held.blockedReasons[0] ?? "", /^contract phase failed: \w+$/u);
	{
		// Not restored: the new column is still there.
		const db = new DatabaseSync(storePath);
		assert.equal(
			db.prepare("SELECT requester_ref FROM checkout").all().length,
			2,
		);
		db.close();
	}
	// Supplied with one, the next run restores the first snapshot.
	const rolled = await executeDataMigration({
		port,
		plan,
		compatGate: gate([]),
		journal,
		replayErasures: () => 0,
	});
	assert.equal(rolled.status, "rolled-back");
	assert.equal(rolled.snapshot?.ref, held.snapshot?.ref);
	const db = new DatabaseSync(storePath);
	cleanups.push(() => db.close());
	assert.throws(() => db.prepare("SELECT requester_ref FROM checkout").all());
});

// ── a crash between a phase and its fact ─────────────────────────────────────
//
// The phase commits, the process dies before `PhaseApplied` is journaled, and
// the application keeps writing. The resumed run finds the phase's intent
// with no answer. It must not run the statements again on a guess, and it
// must never answer them with a restore: the snapshot predates every write
// the application has made since.

/** A journal that dies on the `PhaseApplied` of one phase, once. */
function dyingAfter(phase: string) {
	const inner = createMemoryMigrationJournal();
	let armed = true;
	return {
		load: (id: string) => inner.load(id),
		append(
			id: string,
			fact: Parameters<typeof inner.append>[1],
			expectedCount: number,
		) {
			if (
				armed &&
				fact.type === MIGRATION_EVENTS.PhaseApplied &&
				fact.data.phase === phase
			) {
				armed = false;
				throw new Error("process died after the phase committed");
			}
			return inner.append(id, fact, expectedCount);
		},
	};
}

/** What the application writes while the migration's process is down. */
function applicationWrites(storePath: string): void {
	const db = new DatabaseSync(storePath);
	const columns = db
		.prepare("SELECT name FROM pragma_table_info('checkout')")
		.all()
		.map((row) => String(row.name));
	// The application writes whichever columns the store has now.
	db.exec(
		columns.includes("email")
			? "INSERT INTO checkout (id, email) VALUES ('c3', 'c@example.test')"
			: "INSERT INTO checkout (id, requester_ref) VALUES ('c3', 'email:c@example.test')",
	);
	db.close();
}

function idsOf(storePath: string): string[] {
	const db = new DatabaseSync(storePath);
	const ids = db
		.prepare("SELECT id FROM checkout ORDER BY id")
		.all()
		.map((row) => String(row.id));
	db.close();
	return ids;
}

/** No rows exactly when the phase's statements are in effect. */
const PROBES = {
	expand:
		"SELECT 'requester_ref' AS missing WHERE NOT EXISTS (SELECT 1 FROM pragma_table_info('checkout') WHERE name = 'requester_ref')",
	backfill: "SELECT id FROM checkout WHERE requester_ref IS NULL",
	contract:
		"SELECT name FROM pragma_table_info('checkout') WHERE name = 'email'",
} as const;

for (const crashed of ["expand", "contract"] as const) {
	test(`a crash after ${crashed} committed and before its fact: the resumed run holds, restores nothing, and the write made since is still there`, async () => {
		const storePath = seededStore();
		const journal = dyingAfter(crashed);
		let restores = 0;
		const run = async (probes?: typeof PROBES) => {
			const port = createSqliteSchemaApplyPort({ path: storePath });
			try {
				return await executeDataMigration({
					port: {
						snapshot: () => port.snapshot(),
						applyPhase: (phase, statements) =>
							port.applyPhase(phase, statements),
						verify: (query) => port.verify(query),
						restore: (ref) => {
							restores += 1;
							return port.restore(ref);
						},
					},
					plan: {
						...PLAN,
						migrationId: `mig-crash-${crashed}`,
						...(probes === undefined ? undefined : { probes }),
					},
					compatGate: gate([]),
					journal,
					// Wired: before the fix this is what let the restore happen.
					replayErasures: () => 0,
				});
			} finally {
				port.close();
			}
		};
		await assert.rejects(run(), /process died/u);
		applicationWrites(storePath);
		assert.deepEqual(idsOf(storePath), ["c1", "c2", "c3"]);

		// No probe: nothing says whether the phase committed. Hold.
		const held = await run();
		assert.equal(held.status, "held");
		assert.match(held.blockedReasons[0] ?? "", /^PHASE_OUTCOME_UNKNOWN: /u);
		assert.equal(restores, 0, "the snapshot was restored");
		assert.deepEqual(
			idsOf(storePath),
			["c1", "c2", "c3"],
			"an acknowledged write made after the phase committed was lost",
		);
		assert.deepEqual(
			held.facts.filter(
				(fact) =>
					fact.type === MIGRATION_EVENTS.RollbackDecided ||
					fact.type === MIGRATION_EVENTS.RolledBack,
			),
			[],
		);

		// With the probe the run finds the phase in effect, records it without
		// running it again, and carries on to the end.
		const done = await run(PROBES);
		assert.equal(done.status, "completed", done.blockedReasons.join("; "));
		assert.equal(restores, 0);
		const recovered = done.facts.find(
			(fact) =>
				fact.type === MIGRATION_EVENTS.PhaseApplied &&
				fact.data.phase === crashed,
		);
		assert.equal(recovered?.data.recovered, true);
		const db = new DatabaseSync(storePath);
		cleanups.push(() => db.close());
		assert.deepEqual(
			db
				.prepare("SELECT id, requester_ref FROM checkout ORDER BY id")
				.all()
				.map((row) => ({ ...row })),
			[
				{ id: "c1", requester_ref: "email:a@example.test" },
				{ id: "c2", requester_ref: "email:b@example.test" },
				{ id: "c3", requester_ref: "email:c@example.test" },
			],
		);
		assert.throws(() => db.prepare("SELECT email FROM checkout").all());
	});
}
