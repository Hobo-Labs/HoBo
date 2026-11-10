// The engine conformance kit against the binding over the in-memory
// executor. Always on: no server, no clock, no network. The live lane in
// `live.test.ts` runs the same kit against a real replica set.
import assert from "node:assert/strict";
import {
	createReferenceEngine,
	ENGINE_CONFORMANCE_CASE_IDS,
	runEngineConformance,
} from "@hobo/data-core";
import { describe, test } from "vitest";
import { failures, memoryHarness, NOW } from "./support/harness.js";

const SCHEMA_CASES = [
	"pattern.in-place-evolve.gated-and-restorable",
	"pattern.in-place-evolve.failure-restores",
];

describe("MongoDB engine conformance (in-memory executor)", () => {
	test("the binding passes every case it declares ports for", async () => {
		const report = await runEngineConformance({
			engine: memoryHarness(),
			now: NOW,
		});
		assert.equal(report.outcome, "pass", failures(report));
		assert.equal(report.engine, "mongodb");
		// No SQL surface: the schema cases are skipped, never passed.
		assert.deepEqual(report.skipped, SCHEMA_CASES);
		assert.equal(
			report.results.length + report.skipped.length,
			ENGINE_CONFORMANCE_CASE_IDS.length,
		);
	});

	test("MongoDB → reference engine: cross-engine through the hub", async () => {
		const report = await runEngineConformance({
			engine: memoryHarness(),
			peer: { create: () => createReferenceEngine() },
			now: NOW,
		});
		assert.equal(report.outcome, "pass", failures(report));
	});

	test("reference engine → MongoDB: the other direction", async () => {
		const report = await runEngineConformance({
			engine: { create: () => createReferenceEngine() },
			peer: memoryHarness(),
			now: NOW,
		});
		assert.equal(report.outcome, "pass", failures(report));
	});

	test("without capture the tail cases are skipped, and offline copy still passes", async () => {
		const report = await runEngineConformance({
			engine: memoryHarness({ capture: false }),
			now: NOW,
		});
		assert.ok(report.skipped.includes("capture.ordered-and-resumable"));
		assert.ok(
			report.skipped.includes("pattern.snapshot-and-tail.zero-loss-under-load"),
		);
		assert.equal(report.outcome, "pass", failures(report));
		assert.ok(
			report.results.some(
				(result) =>
					result.caseId === "pattern.offline-copy.exact" &&
					result.status === "pass",
			),
		);
	});
});
