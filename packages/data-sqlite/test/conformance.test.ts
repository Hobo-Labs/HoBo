// The engine conformance kit against real SQLite files. No simulation: every
// case opens stores on disk, and the cross-engine runs move real records
// between SQLite and the in-memory reference engine in both directions.
import assert from "node:assert/strict";
import {
	assertBindingMatchesDeclaration,
	ENGINE_CONFORMANCE_CASE_IDS,
	NATIVE_CONFORMANCE_CASE_IDS,
	referenceEngineHarness,
	runEngineConformance,
} from "@hobo/data-core";
import { describe, test } from "vitest";
import { createSqliteEngine } from "../src/index.js";
import { failures, NOW, sqliteHarness } from "./support.js";

describe("SQLite engine conformance", () => {
	test("SQLite passes every case, including in-place-evolve over real DDL", async () => {
		const report = await runEngineConformance({
			engine: sqliteHarness(),
			now: NOW,
		});
		assert.equal(report.outcome, "pass", failures(report.results));
		assert.equal(report.engine, "sqlite");
		// SQLite declares every port, so no case is skipped for a missing one.
		// It states no record bound, so the size case has nothing to probe,
		// and it declares no native fast path, so a case that proves one does
		// not apply — and nothing else may hide behind either.
		assert.deepEqual(report.skipped, [
			"records.oversize-record-refuses-the-batch",
			...NATIVE_CONFORMANCE_CASE_IDS,
		]);
		assert.equal(report.results.length, 48);
		assert.equal(
			report.results.length + report.skipped.length,
			ENGINE_CONFORMANCE_CASE_IDS.length,
		);
		assert.deepEqual(report.only, []);
	}, 120_000);

	test("SQLite → reference engine: cross-engine through the hub", async () => {
		const report = await runEngineConformance({
			engine: sqliteHarness(),
			peer: referenceEngineHarness(),
			now: NOW,
		});
		assert.equal(report.outcome, "pass", failures(report.results));
	}, 120_000);

	test("reference engine → SQLite: the other direction", async () => {
		const report = await runEngineConformance({
			engine: referenceEngineHarness(),
			peer: sqliteHarness(),
			now: NOW,
		});
		assert.equal(report.outcome, "pass", failures(report.results));
	}, 120_000);

	test("an in-memory store declares no schema port, and the binding agrees", () => {
		const engine = createSqliteEngine({ path: ":memory:" });
		assertBindingMatchesDeclaration(engine);
		assert.ok(!engine.declaration.ports.includes("schema"));
		assert.equal(engine.schema, undefined);
		assert.equal(engine.declaration.fenceEnforcement, "entry-point");
		engine.close();
	});
});
