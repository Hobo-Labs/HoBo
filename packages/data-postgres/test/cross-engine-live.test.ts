// Real records moving between two real, different engines: SQLite files and a
// live PostgreSQL server, in both directions, through the canonical hub.
//
// The conformance kit's pattern cases are the proof: zero loss with writes
// arriving between every phase, one write authority, resume after a crash at
// every phase boundary, a lossless soak rollback, a rollback that cannot
// resurrect an erased subject, and a pooled-to-silo tenant move.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	type EngineBinding,
	type EngineHarness,
	NATIVE_CONFORMANCE_CASE_IDS,
	runEngineConformance,
} from "@hobo/data-core";
import { createSqliteEngine, SQLITE_SCHEMA_FIXTURE } from "@hobo/data-sqlite";
import type pg from "pg";
import { afterAll, beforeAll, describe, test } from "vitest";
import {
	failures,
	LIVE_URL,
	leftoverCaptureObjects,
	livePool,
	NOW,
	postgresHarness,
} from "./engine-support.js";

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

describe.skipIf(!LIVE_URL)("SQLite ↔ PostgreSQL — live, cross-engine", () => {
	let pool: pg.Pool;

	beforeAll(() => {
		pool = livePool();
	});

	afterAll(async () => {
		// A leaked slot pins WAL forever; the lane fails if one of this file's
		// outlives it. Other suites share the server, so only the objects of
		// the namespaces this file used are counted.
		const leftovers = await leftoverCaptureObjects(pool);
		await pool.end();
		assert.deepEqual(leftovers, []);
	});

	test("SQLite → PostgreSQL: an embedded store moves onto a server", async () => {
		const report = await runEngineConformance({
			engine: sqliteHarness(),
			peer: postgresHarness(pool),
			now: NOW,
		});
		assert.equal(report.outcome, "pass", failures(report.results));
		assert.equal(report.engine, "sqlite");
		assert.ok(
			report.results.some(
				(result) =>
					result.caseId === "pattern.snapshot-and-tail.zero-loss-under-load" &&
					result.status === "pass",
			),
		);
	}, 300_000);

	test("PostgreSQL → SQLite: and back, captured from the write-ahead log", async () => {
		const report = await runEngineConformance({
			engine: postgresHarness(pool),
			peer: sqliteHarness(),
			now: NOW,
		});
		assert.equal(report.outcome, "pass", failures(report.results));
		assert.equal(report.engine, "postgres");
		// A native fast path exists only within one engine.
		assert.deepEqual(report.skipped, NATIVE_CONFORMANCE_CASE_IDS);
	}, 300_000);
});
