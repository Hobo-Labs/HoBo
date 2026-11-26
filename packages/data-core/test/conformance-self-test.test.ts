// The kit, turned on itself. Every engine in `support/broken-engines.ts` is a
// reference engine with one defect; the kit must fail each of them, and the
// first case to fail must be the one written to catch that defect. A variant
// that passes here is a hole in the kit.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	createReferenceEngine,
	ENGINE_CONFORMANCE_CASE_IDS,
	type EngineBinding,
	type EngineConformanceReport,
	foldConformance,
	referenceEngineHarness,
	referencePositionPastHead,
	requirePort,
	runEngineConformance,
} from "../src/index.js";
import {
	BROKEN_VARIANTS,
	bounded,
	nativeStopNotRepeatable,
} from "./support/broken-engines.js";

const NOW = "2026-11-10T00:00:00.000Z";

function firstFailure(report: EngineConformanceReport): string {
	const failed = report.results.find((result) => result.status === "fail");
	return failed === undefined
		? "(no case failed)"
		: `${failed.caseId} — ${failed.detail}`;
}

describe("the kit fails every deliberately broken engine", () => {
	const variants = [...BROKEN_VARIANTS, nativeStopNotRepeatable()];

	test("every variant names a case the kit has", () => {
		for (const variant of variants) {
			assert.ok(
				ENGINE_CONFORMANCE_CASE_IDS.includes(variant.caughtBy),
				`${variant.name} expects ${variant.caughtBy}`,
			);
		}
		assert.equal(
			new Set(variants.map((variant) => variant.name)).size,
			variants.length,
		);
	});

	for (const variant of variants) {
		test(`${variant.name}: ${variant.defect} — caught by ${variant.caughtBy}`, async () => {
			const report = await runEngineConformance({
				engine: variant.harness,
				now: NOW,
			});
			assert.equal(report.outcome, "fail", `${variant.name} was not failed`);
			assert.equal(
				firstFailure(report).split(" — ")[0],
				variant.caughtBy,
				`${variant.name} was first caught by: ${firstFailure(report)}`,
			);
			// Everything that fails or is blocked is the defect or downstream
			// of it: a case with no path to the broken port still passes.
			assert.equal(
				report.results.find(
					(result) => result.caseId === "declaration.matches-binding",
				)?.status,
				"pass",
			);
		});
	}

	test("the properties the review found unguarded each have a variant", () => {
		const covered = new Set(variants.map((variant) => variant.caughtBy));
		for (const id of [
			"fence.dataset-wide-covers-tenants",
			"fence.wrong-token-is-refused",
			"fence.apply-honours-the-fence",
			"retire.foreign-token-is-refused",
			"records.null-and-empty-are-distinct",
			"pattern.snapshot-and-tail.crash-windows.cutover",
		]) {
			assert.ok(covered.has(id), `no broken variant is caught by ${id}`);
		}
	});
});

describe("what the variants are measured against", () => {
	test("the same engine without a defect passes", async () => {
		const report = await runEngineConformance({
			engine: referenceEngineHarness(),
			now: NOW,
		});
		assert.equal(report.outcome, "pass", firstFailure(report));
	});

	test("an engine that declares a record bound and enforces it passes the size case; one that states no bound is skipped", async () => {
		const id = "records.oversize-record-refuses-the-batch";
		const enforced = await runEngineConformance({
			engine: {
				create: () => bounded(createReferenceEngine(), true),
				positionPastHead: referencePositionPastHead,
			},
			now: NOW,
		});
		assert.equal(enforced.outcome, "pass", firstFailure(enforced));
		assert.equal(
			enforced.results.find((result) => result.caseId === id)?.status,
			"pass",
		);
		const unbounded = await runEngineConformance({
			engine: referenceEngineHarness(),
			now: NOW,
		});
		assert.ok(unbounded.skipped.includes(id));
		assert.ok(unbounded.results.every((result) => result.caseId !== id));
	});
});

describe("a declared limit is reported as one, and only where the kit allows it", () => {
	const CASE = "capture.acknowledged-positions-are-final";
	const CODE = "TEST_ACKNOWLEDGE_RELEASES_NOTHING";
	/** A reference engine that declares `CODE`; with `real`, it also has the limit. */
	const declaring = (real: boolean): EngineBinding => {
		const inner = createReferenceEngine();
		const capture = requirePort(inner, "capture");
		return {
			...inner,
			declaration: { ...inner.declaration, impedance: [CODE] },
			...(real ? { capture: { ...capture, acknowledge() {} } } : undefined),
		};
	};
	const harness = (
		real: boolean,
		limits: Readonly<Record<string, string>>,
	) => ({
		...referenceEngineHarness(),
		create: () => declaring(real),
		declaredLimits: limits,
	});

	test("an engine that declares the limit and has it: the case is declared-limit, never pass, and the outcome is not made worse", async () => {
		const report = await runEngineConformance({
			engine: harness(true, { [CASE]: CODE }),
			now: NOW,
		});
		const result = report.results.find((entry) => entry.caseId === CASE);
		assert.equal(result?.status, "declared-limit");
		assert.match(result?.detail ?? "", new RegExp(`^${CODE}: `, "u"));
		assert.equal(report.outcome, "pass", firstFailure(report));
		// The same engine without the declaration is simply broken.
		const undeclared = await runEngineConformance({
			engine: harness(true, {}),
			now: NOW,
		});
		assert.equal(undeclared.outcome, "fail");
		assert.equal(firstFailure(undeclared).split(" — ")[0], CASE);
	});

	test("a declared limit the engine does not have is a failure: a declaration has to be true", async () => {
		const report = await runEngineConformance({
			engine: harness(false, { [CASE]: CODE }),
			now: NOW,
		});
		assert.equal(report.outcome, "fail");
		assert.match(firstFailure(report), /holds the property/u);
	});

	test("a limit on a property a migration's safety rests on is refused before anything runs", async () => {
		await assert.rejects(
			runEngineConformance({
				engine: harness(true, { "fence.wrong-token-is-refused": CODE }),
				now: NOW,
			}),
			/not a property an engine may declare a limit on/u,
		);
		await assert.rejects(
			runEngineConformance({
				engine: harness(true, { "no.such.case": CODE }),
				now: NOW,
			}),
			/not a property an engine may declare a limit on/u,
		);
	});

	test("a limit has to be in the declaration: a harness cannot state one the engine does not", async () => {
		await assert.rejects(
			runEngineConformance({
				engine: harness(true, { [CASE]: "NOT_DECLARED_ANYWHERE" }),
				now: NOW,
			}),
			/not an impedance code reference declares/u,
		);
	});
});

describe("a filtered run is not conformance", () => {
	test("one case run on its own folds to unknown, and the report records the filter", async () => {
		const only = ["declaration.matches-binding"];
		const report = await runEngineConformance({
			engine: referenceEngineHarness(),
			now: NOW,
			only,
		});
		assert.deepEqual(
			report.results.map((result) => `${result.caseId}:${result.status}`),
			["declaration.matches-binding:pass"],
		);
		assert.equal(report.outcome, "unknown");
		assert.deepEqual(report.only, only);
	});

	test("naming every case is still a filter", async () => {
		const report = await runEngineConformance({
			engine: referenceEngineHarness(),
			now: NOW,
			only: ENGINE_CONFORMANCE_CASE_IDS,
		});
		assert.ok(report.results.every((result) => result.status === "pass"));
		assert.equal(report.outcome, "unknown");
	});

	test("a filtered run can still fail", async () => {
		const broken = BROKEN_VARIANTS.find(
			(variant) => variant.name === "any-token",
		);
		assert.ok(broken);
		const report = await runEngineConformance({
			engine: broken.harness,
			now: NOW,
			only: ["fence.wrong-token-is-refused"],
		});
		assert.equal(report.outcome, "fail");
	});

	test("an unfiltered run records no filter", async () => {
		const report = await runEngineConformance({
			engine: referenceEngineHarness(),
			now: NOW,
		});
		assert.deepEqual(report.only, []);
		assert.equal(report.outcome, "pass");
	});

	test("an empty filter is refused: it would run nothing and fail nothing", async () => {
		await assert.rejects(
			runEngineConformance({
				engine: referenceEngineHarness(),
				now: NOW,
				only: [],
			}),
			/at least one case/u,
		);
	});

	test("the fold never answers pass for a filtered run", () => {
		const pass = { caseId: "a", status: "pass", detail: "" } as const;
		assert.equal(foldConformance([pass]), "pass");
		assert.equal(foldConformance([pass], ["a"]), "unknown");
		assert.equal(
			foldConformance([{ caseId: "a", status: "fail", detail: "" }], ["a"]),
			"fail",
		);
	});
});
