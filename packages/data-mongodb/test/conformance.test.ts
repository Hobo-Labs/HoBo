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

// Skipped, never passed: MongoDB declares no native migration profile and has
// no SQL surface, so it has neither a `nativeTransfer` nor a `schema` port.
const UNDECLARED_CASES = [
	"pattern.snapshot-and-tail.native.zero-loss-under-load",
	"pattern.snapshot-and-tail.native.resumes-at-every-boundary",
	"pattern.in-place-evolve.gated-and-restorable",
	"pattern.in-place-evolve.failure-restores",
];

const RACE_CASE = "fence.raise-waits-for-in-flight-writes";

/** The race case and the cases it depends on, and nothing else. */
const RACE_CASES = [
	"declaration.matches-binding",
	"datasets.ensure-idempotent",
	"records.round-trip-canonical",
	"fence.single-write-authority",
	RACE_CASE,
];

describe("MongoDB engine conformance (in-memory executor)", () => {
	test("the binding passes every case it declares ports for", async () => {
		const report = await runEngineConformance({
			engine: memoryHarness(),
			now: NOW,
		});
		assert.equal(report.outcome, "pass", failures(report));
		assert.equal(report.engine, "mongodb");
		assert.deepEqual(report.skipped, UNDECLARED_CASES);
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

	test("the race case is not vacuous offline: a fence that does not wait fails it, every time", async () => {
		// The in-memory executor interleaves transactions and its commits take
		// a turn of the event loop, so a writer that read "not fenced" is still
		// in flight when a `raise` that skips the wait returns.
		for (let round = 0; round < 5; round += 1) {
			const broken = await runEngineConformance({
				engine: memoryHarness({
					wrap: (executor) => ({
						...executor,
						awaitTransactions: async () => undefined,
					}),
				}),
				now: NOW,
				only: RACE_CASES,
			});
			const result = broken.results.find((entry) => entry.caseId === RACE_CASE);
			assert.equal(result?.status, "fail", `round ${round}`);
			assert.match(result?.detail ?? "", /no write may land after raise/u);
			assert.equal(broken.outcome, "fail");
		}
		const sound = await runEngineConformance({
			engine: memoryHarness(),
			now: NOW,
			only: RACE_CASES,
		});
		assert.equal(sound.outcome, "pass", failures(sound));
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
