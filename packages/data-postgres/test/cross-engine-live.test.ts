import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	ENGINE_CONFORMANCE_CASE_IDS,
	type EngineBinding,
	type EngineHarness,
	NATIVE_CONFORMANCE_CASE_IDS,
	runEngineConformance,
} from "@hobo/data-core";
import { createSqliteEngine, SQLITE_SCHEMA_FIXTURE } from "@hobo/data-sqlite";
import type pg from "pg";
import { afterAll, beforeAll, describe, test } from "vitest";
import {
	conformanceFailureSink,
	failures,
	LIVE_URL,
	leftoverCaptureObjects,
	livePool,
	NOW,
	postgresHarness,
} from "./engine-support.js";

const SIZE_CASE_ID = "records.oversize-record-refuses-the-batch";

function sqliteHarness(): EngineHarness {
	const dirs = new Map<EngineBinding, string>();
	const file = (dir: string): string => path.join(dir, "store.db");
	return {
		schemaFixture: SQLITE_SCHEMA_FIXTURE,
		reservedDatasetNames: ["sqlite_sequence", "sqlite_master"],
		positionPastHead: (head) => String(Number(head) + 1_000_000),
		create() {
			const dir = mkdtempSync(path.join(tmpdir(), "hobo-cross-engine-"));
			const binding = createSqliteEngine({
				path: file(dir),
				clock: () => NOW,
			});
			dirs.set(binding, dir);
			return binding;
		},
		attach(binding) {
			const dir = dirs.get(binding);
			if (dir === undefined) {
				throw new Error("the binding was not created by this harness");
			}
			return createSqliteEngine({ path: file(dir), clock: () => NOW });
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
		const leftovers = await leftoverCaptureObjects(pool);
		await pool.end();
		assert.deepEqual(leftovers, []);
	});

	test("SQLite → PostgreSQL: an embedded store moves onto a server", async () => {
		const report = await runEngineConformance({
			engine: sqliteHarness(),
			peer: postgresHarness(pool),
			now: NOW,
			onFailure: conformanceFailureSink(),
		});
		assert.equal(report.outcome, "pass", failures(report.results));
		assert.equal(report.engine, "sqlite");
		assert.deepEqual(report.skipped, [
			SIZE_CASE_ID,
			...NATIVE_CONFORMANCE_CASE_IDS,
		]);
		assert.equal(
			report.results.length + report.skipped.length,
			ENGINE_CONFORMANCE_CASE_IDS.length,
		);
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
			onFailure: conformanceFailureSink(),
		});
		assert.equal(report.outcome, "pass", failures(report.results));
		assert.equal(report.engine, "postgres");
		assert.deepEqual(report.skipped, [
			SIZE_CASE_ID,
			...NATIVE_CONFORMANCE_CASE_IDS,
		]);
	}, 300_000);
});
