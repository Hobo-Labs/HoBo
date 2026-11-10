// Real records moving between real engines of different kinds, live:
// SQLite files, a PostgreSQL server, and a MongoDB replica set.
//
// PostgreSQL ↔ MongoDB is the case the design exists for — a relational
// engine and a document engine, with different type systems, different change
// capture, and different fencing — moved through one canonical hub with no
// pairwise migrator. The conformance kit's pattern cases are the proof: zero
// loss with writes arriving between every phase, one write authority, resume
// after a crash at every phase boundary, a lossless soak rollback, and a
// rollback that cannot resurrect an erased subject.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type EngineBinding,
	type EngineConformanceResult,
	type EngineHarness,
	runEngineConformance,
} from "@hobo/data-core";
import {
	createPgExecutor,
	createPostgresEngine,
	POSTGRES_SCHEMA_FIXTURE,
	POSTGRES_SCHEMA_FIXTURE_TABLE,
} from "@hobo/data-postgres";
import { createSqliteEngine, SQLITE_SCHEMA_FIXTURE } from "@hobo/data-sqlite";
import pg from "pg";
import { afterAll, beforeAll, describe, test } from "vitest";
import { connectLive, LIVE_URL, type LiveMongo } from "./support/live.js";

const NOW = "2026-11-10T00:00:00.000Z";
const POSTGRES_URL = process.env.HOBO_TEST_POSTGRES_URL ?? "";
const RUN_ID = `${Date.now().toString(36)}${process.pid.toString(36)}`;

function failures(results: readonly EngineConformanceResult[]): string {
	return results
		.filter((result) => result.status !== "pass")
		.map((result) => `${result.caseId}: ${result.status} — ${result.detail}`)
		.join("\n");
}

/** One SQLite file per binding, each in its own temp directory. */
function sqliteHarness(): EngineHarness {
	const dirs = new Map<EngineBinding, string>();
	return {
		schemaFixture: SQLITE_SCHEMA_FIXTURE,
		create() {
			const dir = mkdtempSync(path.join(tmpdir(), "hobo-cross-engine-"));
			const binding = createSqliteEngine({
				path: path.join(dir, "store.db"),
				clock: () => NOW,
			});
			dirs.set(binding, dir);
			return binding;
		},
		dispose(binding) {
			const dir = dirs.get(binding);
			if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
			dirs.delete(binding);
		},
	};
}

/** One PostgreSQL namespace per binding, dropped — slots included — on close. */
function postgresHarness(pool: pg.Pool): EngineHarness {
	const executor = createPgExecutor(pool);
	let counter = 0;
	return {
		schemaFixture: POSTGRES_SCHEMA_FIXTURE,
		create() {
			counter += 1;
			return createPostgresEngine({
				executor,
				namespace: `hobo_x_${RUN_ID}_${counter}`,
				capture: true,
				schemaTables: [POSTGRES_SCHEMA_FIXTURE_TABLE],
				ephemeral: true,
				clock: () => NOW,
			});
		},
	};
}

describe.skipIf(LIVE_URL === "")(
	"SQLite ↔ MongoDB — live, cross-paradigm",
	() => {
		let live: LiveMongo;

		beforeAll(async () => {
			live = await connectLive();
		});

		afterAll(async () => {
			assert.deepEqual(await live.leftovers(), []);
			await live.close();
		});

		test("SQLite → MongoDB: relational rows become documents", async () => {
			const report = await runEngineConformance({
				engine: sqliteHarness(),
				peer: live.harness(),
				now: NOW,
			});
			assert.equal(report.outcome, "pass", failures(report.results));
			assert.equal(report.engine, "sqlite");
		}, 300_000);

		test("MongoDB → SQLite: documents become relational rows", async () => {
			const report = await runEngineConformance({
				engine: live.harness(),
				peer: sqliteHarness(),
				now: NOW,
			});
			assert.equal(report.outcome, "pass", failures(report.results));
			assert.equal(report.engine, "mongodb");
		}, 300_000);
	},
);

describe.skipIf(LIVE_URL === "" || POSTGRES_URL === "")(
	"PostgreSQL ↔ MongoDB — live, cross-paradigm between two servers",
	() => {
		let live: LiveMongo;
		let pool: pg.Pool;

		beforeAll(async () => {
			live = await connectLive();
			pool = new pg.Pool({ connectionString: POSTGRES_URL, max: 12 });
			// An idle client dropped by the server is not a test failure.
			pool.on("error", () => {});
		});

		afterAll(async () => {
			assert.deepEqual(await live.leftovers(), []);
			await live.close();
			const slots = await pool.query(
				"SELECT count(*)::int AS leaked FROM pg_replication_slots WHERE slot_name LIKE 'hobo_s_%'",
			);
			await pool.end();
			// A leaked slot pins WAL forever; the lane fails if one outlives it.
			assert.equal(slots.rows[0]?.leaked, 0);
		});

		test("PostgreSQL → MongoDB: captured from the write-ahead log, applied as documents", async () => {
			const report = await runEngineConformance({
				engine: postgresHarness(pool),
				peer: live.harness(),
				now: NOW,
			});
			assert.equal(report.outcome, "pass", failures(report.results));
			assert.equal(report.engine, "postgres");
			assert.deepEqual(report.skipped, []);
		}, 300_000);

		test("MongoDB → PostgreSQL: captured from a change stream, applied as rows", async () => {
			const report = await runEngineConformance({
				engine: live.harness(),
				peer: postgresHarness(pool),
				now: NOW,
			});
			assert.equal(report.outcome, "pass", failures(report.results));
			assert.equal(report.engine, "mongodb");
		}, 300_000);
	},
);
