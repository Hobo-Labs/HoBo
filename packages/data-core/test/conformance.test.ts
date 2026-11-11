// The kit run against the reference engine. Two things are proven here: the
// reference engine meets its own contract, and the kit itself fails closed —
// an engine missing a port is not rated `pass` on the cases it could not run.
import assert from "node:assert/strict";
import { describe, test } from "vitest";
import {
	assertBindingMatchesDeclaration,
	createReferenceEngine,
	createReferenceNativeLink,
	ENGINE_CONFORMANCE_CASE_IDS,
	type EngineBinding,
	type EngineConformanceResult,
	type EngineHarness,
	foldConformance,
	NATIVE_CONFORMANCE_CASE_IDS,
	REFERENCE_NATIVE_PROFILE,
	referenceEngineHarness,
	runEngineConformance,
	withoutPorts,
} from "../src/index.js";

const NOW = "2026-11-10T00:00:00.000Z";

/** Skipped by an engine with no `schema` port. */
const SCHEMA_CASE_IDS = [
	"pattern.in-place-evolve.gated-and-restorable",
	"pattern.in-place-evolve.failure-restores",
	"schema.snapshots-are-per-binding",
	"schema.multi-statement-entry-is-whole-or-refused",
	"schema.verify-refuses-a-trailing-statement",
];

/** Skipped by an engine whose declaration states no record bound. */
const SIZE_CASE_ID = "records.oversize-record-refuses-the-batch";

function failures(results: readonly EngineConformanceResult[]): string {
	return results
		.filter((result) => result.status !== "pass")
		.map((result) => `${result.caseId}: ${result.status} — ${result.detail}`)
		.join("\n");
}

describe("engine conformance kit", () => {
	test("the reference engine passes every case it declares ports for", async () => {
		const report = await runEngineConformance({
			engine: referenceEngineHarness(),
			now: NOW,
		});
		assert.equal(report.outcome, "pass", failures(report.results));
		assert.equal(report.engine, "reference");
		assert.equal(ENGINE_CONFORMANCE_CASE_IDS.length, 52);
		assert.equal(report.results.length, 43);
		// The reference engine states no record bound, so the size case has
		// nothing to probe. It has no SQL surface; its schema cases are skipped,
		// not passed. And without the opt-in native profile there is no native
		// realization to prove, so those cases are skipped too.
		assert.deepEqual(report.skipped, [
			SIZE_CASE_ID,
			...NATIVE_CONFORMANCE_CASE_IDS,
			...SCHEMA_CASE_IDS,
		]);
		assert.equal(
			report.results.length + report.skipped.length,
			ENGINE_CONFORMANCE_CASE_IDS.length,
		);
	});

	test("with a shared native profile the native cases run, and pass", async () => {
		assert.deepEqual(NATIVE_CONFORMANCE_CASE_IDS, [
			"pattern.snapshot-and-tail.native.zero-loss-under-load",
			"pattern.snapshot-and-tail.native.resumes-at-every-boundary",
			"pattern.snapshot-and-tail.native.crash-windows.cutover",
		]);
		// One link per pair, as a real engine would be given one connection.
		const links: ReturnType<typeof createReferenceNativeLink>[] = [];
		const shared = createReferenceNativeLink();
		const harness: EngineHarness = {
			...referenceEngineHarness({ native: shared }),
			createNativePair() {
				const link = createReferenceNativeLink();
				links.push(link);
				return {
					source: createReferenceEngine({ native: link }),
					target: createReferenceEngine({ native: link }),
				};
			},
		};
		const report = await runEngineConformance({ engine: harness, now: NOW });
		assert.equal(report.outcome, "pass", failures(report.results));
		assert.deepEqual(report.skipped, [SIZE_CASE_ID, ...SCHEMA_CASE_IDS]);
		for (const id of NATIVE_CONFORMANCE_CASE_IDS) {
			assert.equal(
				report.results.find((result) => result.caseId === id)?.status,
				"pass",
				id,
			);
		}
		// One pair for the load case, one per phase boundary for the resume
		// case, and one per crash window (a crash-free run, then a crash before
		// and after each of eight side effects) — and every transfer was closed
		// by the run that opened it.
		assert.equal(links.length, 1 + 8 + 17);
		for (const link of links) assert.deepEqual(link.open(), []);
	});

	test("without a staged pair the native cases run between two bindings from create", async () => {
		const link = createReferenceNativeLink();
		const report = await runEngineConformance({
			engine: referenceEngineHarness({ native: link }),
			now: NOW,
			only: NATIVE_CONFORMANCE_CASE_IDS,
		});
		// A filtered run proves what it ran, and never folds to pass.
		assert.equal(report.outcome, "unknown");
		assert.deepEqual(report.only, NATIVE_CONFORMANCE_CASE_IDS);
		assert.equal(failures(report.results), "");
		assert.equal(report.results.length, 3);
		assert.deepEqual(link.open(), []);
	});

	test("a native profile on one side only is no shared fast path: the cases are skipped", async () => {
		const link = createReferenceNativeLink();
		const report = await runEngineConformance({
			engine: referenceEngineHarness({ native: link }),
			peer: referenceEngineHarness(),
			now: NOW,
			only: NATIVE_CONFORMANCE_CASE_IDS,
		});
		assert.deepEqual(report.skipped, NATIVE_CONFORMANCE_CASE_IDS);
		assert.deepEqual(report.results, []);
	});

	test("a declared native profile needs the port behind it, and the port a declaration", () => {
		const native = createReferenceEngine({
			native: createReferenceNativeLink(),
		});
		assertBindingMatchesDeclaration(native);
		assert.deepEqual(native.nativeTransfer?.profiles, [
			REFERENCE_NATIVE_PROFILE,
		]);
		const plain = createReferenceEngine();
		assertBindingMatchesDeclaration(plain);
		assert.equal(plain.nativeTransfer, undefined);
		assert.deepEqual(plain.declaration.nativeProfiles, []);

		// Declared, no port: the selector would offer what nothing can run.
		const { nativeTransfer: _port, ...withoutPort } = native;
		assert.throws(
			() => assertBindingMatchesDeclaration(withoutPort),
			/declares the native profile migration\.reference\.direct\/v1 but its nativeTransfer port does not run it/u,
		);
		// A port, nothing declared: a capability nobody proved.
		assert.throws(
			() =>
				assertBindingMatchesDeclaration({
					...plain,
					...(native.nativeTransfer === undefined
						? undefined
						: { nativeTransfer: native.nativeTransfer }),
				}),
			/runs migration\.reference\.direct\/v1 but does not declare that profile/u,
		);
		// A port that runs something other than what is declared.
		assert.throws(
			() =>
				assertBindingMatchesDeclaration({
					...native,
					...(native.nativeTransfer === undefined
						? undefined
						: {
								nativeTransfer: {
									...native.nativeTransfer,
									profiles: ["migration.reference.other/v1"],
								},
							}),
				}),
			/does not run it/u,
		);
	});

	test("a cross-engine run moves data between two differently-named engines", async () => {
		const report = await runEngineConformance({
			engine: referenceEngineHarness({ engine: "alpha" }),
			peer: referenceEngineHarness({ engine: "beta" }),
			now: NOW,
		});
		assert.equal(report.outcome, "pass", failures(report.results));
	});

	test("an engine without capture is skipped on capture cases, never passed on them", async () => {
		const report = await runEngineConformance({
			engine: referenceEngineHarness({ omit: ["capture"] }),
			now: NOW,
		});
		assert.equal(report.outcome, "pass", failures(report.results));
		assert.ok(report.skipped.includes("capture.ordered-and-resumable"));
		assert.ok(
			report.skipped.includes(
				"pattern.snapshot-and-tail.crash-windows.cutover",
			),
		);
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
			engine: referenceEngineHarness(),
			peer: referenceEngineHarness({ engine: "sink", omit: ["apply"] }),
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
			engine: { ...referenceEngineHarness(), create: broken },
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

	test("a harness that cannot make a position past the head leaves that case unproven, and the outcome unknown", async () => {
		const report = await runEngineConformance({
			engine: { create: () => createReferenceEngine() },
			now: NOW,
		});
		assert.equal(report.outcome, "unknown");
		assert.deepEqual(
			report.results
				.filter((result) => result.status !== "pass")
				.map((result) => `${result.caseId}:${result.status}`),
			["capture.acknowledged-positions-are-final:not-run"],
		);
	});

	test("the raw error of a failing case goes to the harness's own sink, never into the report", async () => {
		const seen: string[] = [];
		const report = await runEngineConformance({
			engine: {
				...referenceEngineHarness(),
				create: () => {
					const real = createReferenceEngine();
					return {
						...real,
						records: {
							write: () => {
								throw new Error("postgres://user:secret@host/db refused");
							},
							read: (request) => real.records.read(request),
						},
					};
				},
			},
			now: NOW,
			only: ["records.round-trip-canonical"],
			onFailure: (caseId, error) => seen.push(`${caseId}: ${error.message}`),
		});
		assert.deepEqual(seen, [
			"records.round-trip-canonical: postgres://user:secret@host/db refused",
		]);
		assert.equal(report.outcome, "fail");
		assert.ok(!JSON.stringify(report).includes("secret"));
		assert.equal(report.results[0]?.detail, "threw Error");
	});

	test("an unknown case id is refused rather than silently running nothing", async () => {
		await assert.rejects(
			runEngineConformance({
				engine: referenceEngineHarness(),
				now: NOW,
				only: ["no.such.case"],
			}),
			/unknown case/u,
		);
	});
});
