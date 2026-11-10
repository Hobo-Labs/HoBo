// The kit run against the reference engine. Two things are proven here: the
// reference engine meets its own contract, and the kit itself fails closed —
// an engine missing a port is not rated `pass` on the cases it could not run.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	createReferenceEngine,
	ENGINE_CONFORMANCE_CASE_IDS,
	type EngineBinding,
	type EngineConformanceResult,
	foldConformance,
	runEngineConformance,
	withoutPorts,
} from "../src/index.js";

const NOW = "2026-11-10T00:00:00.000Z";

function failures(results: readonly EngineConformanceResult[]): string {
	return results
		.filter((result) => result.status !== "pass")
		.map((result) => `${result.caseId}: ${result.status} — ${result.detail}`)
		.join("\n");
}

describe("engine conformance kit", () => {
	test("the reference engine passes every case it declares ports for", async () => {
		const report = await runEngineConformance({
			engine: { create: () => createReferenceEngine() },
			now: NOW,
		});
		assert.equal(report.outcome, "pass", failures(report.results));
		assert.equal(report.engine, "reference");
		// The reference engine has no SQL surface; its schema cases are skipped,
		// not passed.
		assert.deepEqual(report.skipped, [
			"pattern.in-place-evolve.gated-and-restorable",
			"pattern.in-place-evolve.failure-restores",
		]);
		assert.equal(
			report.results.length + report.skipped.length,
			ENGINE_CONFORMANCE_CASE_IDS.length,
		);
	});

	test("a cross-engine run moves data between two differently-named engines", async () => {
		const report = await runEngineConformance({
			engine: { create: () => createReferenceEngine({ engine: "alpha" }) },
			peer: { create: () => createReferenceEngine({ engine: "beta" }) },
			now: NOW,
		});
		assert.equal(report.outcome, "pass", failures(report.results));
	});

	test("an engine without capture is skipped on capture cases, never passed on them", async () => {
		const report = await runEngineConformance({
			engine: { create: () => createReferenceEngine({ omit: ["capture"] }) },
			now: NOW,
		});
		assert.ok(report.skipped.includes("capture.ordered-and-resumable"));
		assert.ok(
			report.skipped.includes("pattern.snapshot-and-tail.zero-loss-under-load"),
		);
		// Offline copy needs no capture, so it still runs and passes.
		assert.ok(
			report.results.some(
				(result) =>
					result.caseId === "pattern.offline-copy.exact" &&
					result.status === "pass",
			),
			failures(report.results),
		);
	});

	test("a peer that cannot be a target makes pattern cases not-run, and the outcome unknown", async () => {
		const report = await runEngineConformance({
			engine: { create: () => createReferenceEngine() },
			peer: {
				create: () =>
					createReferenceEngine({ engine: "sink", omit: ["apply"] }),
			},
			now: NOW,
		});
		assert.equal(report.outcome, "unknown");
		const moved = report.results.find(
			(result) =>
				result.caseId === "pattern.snapshot-and-tail.zero-loss-under-load",
		);
		assert.equal(moved?.status, "not-run");
	});

	test("a broken engine fails, and cases that depend on the broken port are blocked", async () => {
		// An apply port that drops deletes: silently wrong, the worst kind.
		const broken = (): EngineBinding => {
			const real = createReferenceEngine({ engine: "broken" });
			const apply = real.apply;
			assert.ok(apply);
			return {
				...real,
				apply: {
					apply: (request) =>
						apply.apply({
							...request,
							changes: request.changes.filter(
								(change) => change.op !== "delete",
							),
						}),
					watermark: (request) => apply.watermark(request),
				},
			};
		};
		const report = await runEngineConformance({
			engine: { create: broken },
			now: NOW,
		});
		assert.equal(report.outcome, "fail");
		const applied = report.results.find(
			(result) => result.caseId === "apply.idempotent-with-watermark",
		);
		assert.equal(applied?.status, "fail");
		const dependent = report.results.find(
			(result) =>
				result.caseId === "pattern.snapshot-and-tail.zero-loss-under-load",
		);
		assert.equal(dependent?.status, "blocked");
	});

	test("the fold is pessimistic", () => {
		const pass = { caseId: "a", status: "pass", detail: "" } as const;
		assert.equal(foldConformance([pass]), "pass");
		assert.equal(
			foldConformance([pass, { caseId: "b", status: "not-run", detail: "" }]),
			"unknown",
		);
		assert.equal(
			foldConformance([
				pass,
				{ caseId: "b", status: "not-run", detail: "" },
				{ caseId: "c", status: "blocked", detail: "" },
			]),
			"fail",
		);
	});

	test("withoutPorts hides the port and the declaration agrees", () => {
		const view = withoutPorts(createReferenceEngine(), ["capture", "fence"]);
		assert.equal(view.capture, undefined);
		assert.equal(view.fence, undefined);
		assert.equal(view.declaration.captureOrdering, "none");
		assert.equal(view.declaration.fenceEnforcement, "none");
		assert.ok(!view.declaration.ports.includes("capture"));
	});

	test("an unknown case id is refused rather than silently running nothing", async () => {
		await assert.rejects(
			runEngineConformance({
				engine: { create: () => createReferenceEngine() },
				now: NOW,
				only: ["no.such.case"],
			}),
			/unknown case/u,
		);
	});
});
