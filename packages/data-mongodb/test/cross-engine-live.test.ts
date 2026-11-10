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
import { randomUUID } from "node:crypto";
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
	captureObjectPrefixes,
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
// Random, not derived from the clock and the process id: two test files can
// start in the same millisecond, and a worker thread shares its parent's pid.
const RUN_ID = randomUUID().replaceAll("-", "").slice(0, 12);

/** Every PostgreSQL namespace this file has used; what its leak check covers. */
const OWN_NAMESPACES: string[] = [];

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
			const namespace = `hobo_x_${RUN_ID}_${counter}`;
			OWN_NAMESPACES.push(namespace);
			return createPostgresEngine({
				executor,
				namespace,
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
			// A leaked slot pins WAL forever; the lane fails if one of this
			// file's outlives it. Slot names are cluster-wide and other suites
			// share the server, so only the objects carrying the digests of the
			// namespaces this file used are counted — every name the binding
			// derives starts with one.
			const current = await pool.query(
				"SELECT current_database()::text AS database",
			);
			const prefixes = OWN_NAMESPACES.map((namespace) =>
				captureObjectPrefixes(String(current.rows[0]?.database), namespace),
			);
			const slotPrefixes = prefixes.map((prefix) => prefix.slot);
			const publicationPrefixes = prefixes.map((prefix) => prefix.publication);
			const slots = await pool.query(
				"SELECT slot_name::text AS name FROM pg_replication_slots WHERE left(slot_name::text, $2::integer) = ANY($1::text[])",
				[slotPrefixes, slotPrefixes[0]?.length ?? 0],
			);
			const publications = await pool.query(
				"SELECT pubname::text AS name FROM pg_publication WHERE left(pubname::text, $2::integer) = ANY($1::text[])",
				[publicationPrefixes, publicationPrefixes[0]?.length ?? 0],
			);
			await pool.end();
			assert.ok(OWN_NAMESPACES.length > 0, "the lane used PostgreSQL");
			assert.deepEqual(
				[...slots.rows, ...publications.rows].map((row) => String(row.name)),
				[],
			);
		});

		test("PostgreSQL → MongoDB: captured from the write-ahead log, applied as documents", async () => {
			const report = await runEngineConformance({
				engine: postgresHarness(pool),
				peer: live.harness(),
				now: NOW,
			});
			assert.equal(report.outcome, "pass", failures(report.results));
			assert.equal(report.engine, "postgres");
			// PostgreSQL has every port, the schema port included, so nothing is
			// skipped for want of one. The native cases are an engine moving its
			// own records to itself: they cannot apply to a cross-engine pair.
			assert.deepEqual(
				report.skipped.filter((caseId) => !caseId.includes(".native.")),
				[],
			);
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
