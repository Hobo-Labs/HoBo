// The engine conformance kit against the binding over the in-memory
// executor. Always on: no server, no clock, no network. The live lane in
// `live.test.ts` runs the same kit against a real replica set.
import assert from "node:assert/strict";
import {
	ENGINE_CONFORMANCE_CASE_IDS,
	referenceEngineHarness,
	runEngineConformance,
} from "@hobo/data-core";
import { describe, test } from "vitest";
import { failures, memoryHarness, NOW } from "./support/harness.js";

// Skipped, never passed: MongoDB declares no native migration profile and has
// no SQL surface, so it has neither a `nativeTransfer` nor a `schema` port.
const UNDECLARED_CASES = [
	"pattern.snapshot-and-tail.native.zero-loss-under-load",
	"pattern.snapshot-and-tail.native.resumes-at-every-boundary",
	"pattern.snapshot-and-tail.native.crash-windows.cutover",
	"pattern.in-place-evolve.gated-and-restorable",
	"pattern.in-place-evolve.failure-restores",
	"schema.snapshots-are-per-binding",
	"schema.multi-statement-entry-is-whole-or-refused",
	"schema.verify-refuses-a-trailing-statement",
];

// Run, and reported as a limit rather than a pass: MongoDB keeps no
// per-reader log, so an acknowledgement releases, records and checks nothing.
const DECLARED_LIMIT_CASE = "capture.acknowledged-positions-are-final";
const DECLARED_LIMIT = "MONGODB_CAPTURE_ACKNOWLEDGE_RELEASES_NOTHING";

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
		// 44 cases run: 43 pass, and one is a limit the declaration states.
		assert.deepEqual(
			report.results
				.filter((result) => result.status !== "pass")
				.map((result) => [result.caseId, result.status]),
			[[DECLARED_LIMIT_CASE, "declared-limit"]],
		);
		assert.equal(report.results.length, 44);
		assert.match(
			report.results.find((result) => result.caseId === DECLARED_LIMIT_CASE)
				?.detail ?? "",
			new RegExp(`^${DECLARED_LIMIT}: `, "u"),
		);
		// MongoDB states a record bound, so the size case runs — and passes.
		assert.equal(
			report.results.find(
				(result) =>
					result.caseId === "records.oversize-record-refuses-the-batch",
			)?.status,
			"pass",
		);
	});

	test("a limit is declared, not assumed: without the declaration the same case fails", async () => {
		const { declaredLimits: _limits, ...undeclared } = memoryHarness();
		const report = await runEngineConformance({
			engine: undeclared,
			now: NOW,
			only: [DECLARED_LIMIT_CASE],
		});
		assert.equal(report.outcome, "fail");
		assert.equal(report.results[0]?.status, "fail");
	});

	test("MongoDB → reference engine: cross-engine through the hub", async () => {
		const report = await runEngineConformance({
			engine: memoryHarness(),
			peer: referenceEngineHarness(),
			now: NOW,
		});
		assert.equal(report.outcome, "pass", failures(report));
	});

	test("reference engine → MongoDB: the other direction", async () => {
		const report = await runEngineConformance({
			engine: referenceEngineHarness(),
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
		// Every case it ran passed; a filtered run still never folds to pass.
		assert.equal(failures(sound), "");
		assert.equal(sound.results.length, RACE_CASES.length);
		assert.equal(sound.outcome, "unknown");
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
