/**
 * Runnable example for s1-24-conformance-sdk (HOBO-614). The draft-artifact gate EXECUTES
 * this with `node --import tsx` and diffs stdout against usage.expected.txt — keep both honest.
 *
 * Demonstrates the real @hobo/conformance/sdk draft contract: the committed golden-IR
 * lowering corpus and semantics-annex vectors are parsed from src/sdk/, a reference
 * adapter passes all five lanes, a seeded drift adapter passes golden-IR but is caught
 * by the semantics annex with a JSON path diff, and unbacked helper claims fail the
 * coverage lane. Reports canonicalize deterministically for pact exchange.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";

import {
	canonicalizeReportJson,
	parseLoweringCorpus,
	parseSdkConformanceReport,
	parseSemanticsAnnexVectors,
	runSdkIdiomConformance,
	sdkConformanceGateSpec,
} from "../src/sdk/index.ts";
import { createDriftAdapter, createReferenceAdapter } from "../test/fixtures/drift-adapters.ts";
import { type JsonValue } from "../src/json.js";


const fixture = (name: string): JsonValue =>
	JSON.parse(readFileSync(new URL(`../src/sdk/${name}`, import.meta.url), "utf8"));

// 1) The committed corpus and annex vectors parse into typed fixtures.
const corpus = parseLoweringCorpus(fixture("corpus/lowering-corpus.json"));
const annexVectors = parseSemanticsAnnexVectors(fixture("vectors/semantics-annex.vectors.json"));
console.log(`corpus fixtures: ${corpus.map((entry) => entry.name).join(",")}`);
console.log(`annex vectors: ${annexVectors.map((vector) => `${vector.category}/${vector.name}`).join(",")}`);
console.log(`gate lanes: ${sdkConformanceGateSpec.lanes.join(",")}`);

// 2) The reference adapter passes every lane; the report parses and is bounded by the corpus.
const passing = await runSdkIdiomConformance({
	corpus,
	corpusPath: "src/sdk/corpus/lowering-corpus.json",
	annexVectors,
	annexPath: "src/sdk/vectors/semantics-annex.vectors.json",
	adapter: createReferenceAdapter(),
	sourceFiles: [{ path: "src/reference.ts", source: "export const ok = true;" }],
});
for (const lane of passing.lanes) {
	console.log(`lane ${lane.lane}: ${lane.status}`);
}
assert.equal(passing.status, "passed");
assert.equal(passing.suite, "@hobo/conformance/sdk");
assert.equal(passing.contract, "hobo:sdk@0.1.0");
const goldenIr = passing.lanes.find((lane) => lane.lane === "golden-ir-lowering-equivalence");
assert.equal(goldenIr?.boundedByCorpus, true, "golden-IR claims are bounded by the corpus");
const reparsed = parseSdkConformanceReport(passing);
assert.equal(reparsed.status, "passed");
console.log(`report status=${passing.status} boundedByCorpus=${goldenIr?.boundedByCorpus}`);

// 3) Canonical report JSON is deterministic — same report, same bytes.
assert.equal(canonicalizeReportJson(passing), canonicalizeReportJson(parseSdkConformanceReport(passing)));
console.log("canonical report json deterministic: true");

// 4) Seeded drift: hiding cancellation as a retry sneaks past golden-IR lowering but the
//    semantics annex catches it and reports the exact JSON paths that diverge.
const drifted = await runSdkIdiomConformance({
	corpus,
	annexVectors,
	adapter: createDriftAdapter({ hideCancellationAsRetry: true }),
});
const driftGoldenIr = drifted.lanes.find((lane) => lane.lane === "golden-ir-lowering-equivalence");
const driftSemantics = drifted.lanes.find((lane) => lane.lane === "semantics-annex");
assert.equal(drifted.status, "failed");
assert.equal(driftGoldenIr?.status, "passed", "drift is invisible to golden-IR lowering");
assert.equal(driftSemantics?.status, "failed", "semantics annex catches the drift");
const cancellation = driftSemantics?.cases.find((entry) => entry.name === "caller-cancellation");
assert.equal(cancellation?.status, "failed");
assert.ok((cancellation?.diffPaths?.length ?? 0) > 0);
console.log(
	`seeded drift: golden-ir=${driftGoldenIr?.status} semantics-annex=${driftSemantics?.status} case=${cancellation?.name} diffPaths=${cancellation?.diffPaths?.join("|")}`,
);

// 5) Coverage-claim lane: a helper claim without a backing vector fails the report.
const uncovered = await runSdkIdiomConformance({
	corpus,
	annexVectors,
	adapter: createReferenceAdapter(),
	helperClaims: ["sdk.retry.jitter"],
});
const coverage = uncovered.lanes.find((lane) => lane.lane === "coverage-claim");
assert.equal(uncovered.status, "failed");
assert.equal(coverage?.cases[0]?.reason, "helper claim has no golden-IR or semantics-annex vector");
console.log(`unbacked helper claim: report=${uncovered.status} reason="${coverage?.cases[0]?.reason}"`);

// 6) Empty corpus/vectors are contract violations, not empty passes.
await runSdkIdiomConformance({ corpus: [], annexVectors, adapter: createReferenceAdapter() }).then(
	() => {
		throw new Error("expected TypeError");
	},
	(error: JsonValue) => assert.ok(error instanceof TypeError),
);
console.log("empty corpus rejected: TypeError");

console.log("CONTRACT HELD: sdk conformance is corpus-bounded, drift-detecting, and coverage-honest");
