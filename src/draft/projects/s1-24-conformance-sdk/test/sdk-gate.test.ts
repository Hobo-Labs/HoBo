import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";

import {
  parseLoweringCorpus,
  parseSdkConformanceReport,
  parseSemanticsAnnexVectors,
  runSdkIdiomConformance,
  sdkConformanceGateSpec,
} from "../src/sdk/index.js";
import { createReferenceAdapter } from "./fixtures/drift-adapters.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = parseLoweringCorpus(
  JSON.parse(readFileSync(join(rootDir, "src/sdk/corpus/lowering-corpus.json"), "utf8")),
);
const annexVectors = parseSemanticsAnnexVectors(
  JSON.parse(readFileSync(join(rootDir, "src/sdk/vectors/semantics-annex.vectors.json"), "utf8")),
);

describe("sdk conformance gate", () => {
  it("declares the required SDK conformance lanes without resilience-semantics", () => {
    assert.deepEqual(sdkConformanceGateSpec.lanes, [
      "golden-ir-lowering-equivalence",
      "semantics-annex",
      "thin-idiom-layer",
      "authorship-neutral-gate",
      "coverage-claim",
    ]);
    assert.equal(sdkConformanceGateSpec.contract, "hobo:sdk@0.1.0");
    assert.match(sdkConformanceGateSpec.corpusClaim, /bounded by the checked corpus/);
  });

  it("passing adapter passes all lanes and report parses", async () => {
    const report = await runSdkIdiomConformance({
      corpus,
      corpusPath: "src/sdk/corpus/lowering-corpus.json",
      annexVectors,
      annexPath: "src/sdk/vectors/semantics-annex.vectors.json",
      adapter: createReferenceAdapter(),
      sourceFiles: [{ path: "src/reference.ts", source: "export const ok = true;" }],
    });

    assert.equal(report.status, "passed");
    assert.equal(report.suite, "@hobo/conformance/sdk");
    assert.equal(report.contract, "hobo:sdk@0.1.0");
    assert.deepEqual(
      report.lanes.map((lane) => lane.lane),
      sdkConformanceGateSpec.lanes,
    );

    const goldenIr = report.lanes.find((lane) => lane.lane === "golden-ir-lowering-equivalence");
    const semantics = report.lanes.find((lane) => lane.lane === "semantics-annex");
    assert.equal(goldenIr?.status, "passed");
    assert.equal(goldenIr?.boundedByCorpus, true);
    assert.equal(semantics?.status, "passed");

    const parsed = parseSdkConformanceReport(report);
    assert.equal(parsed.status, "passed");
  });

  it("throws TypeError for empty corpus, empty annex vectors, or missing adapter", async () => {
    await assert.rejects(
      () =>
        runSdkIdiomConformance({
          corpus: [],
          annexVectors,
          adapter: createReferenceAdapter(),
        }),
      TypeError,
    );

    await assert.rejects(
      () =>
        runSdkIdiomConformance({
          corpus,
          annexVectors: [],
          adapter: createReferenceAdapter(),
        }),
      TypeError,
    );

    await assert.rejects(
      () =>
        runSdkIdiomConformance({
          corpus,
          annexVectors,
          // SAFETY: `adapter: undefined as never,` is required at this I/O or test boundary.
          adapter: undefined as never,
        }),
      TypeError,
    );
  });

  it("fails coverage lane when helper claim has no matching vector", async () => {
    const report = await runSdkIdiomConformance({
      corpus,
      annexVectors,
      adapter: createReferenceAdapter(),
      helperClaims: ["sdk.retry.jitter"],
    });

    assert.equal(report.status, "failed");
    const coverage = report.lanes.find((lane) => lane.lane === "coverage-claim");
    assert.equal(coverage?.status, "failed");
    assert.equal(
      coverage?.cases[0]?.reason,
      "helper claim has no golden-IR or semantics-annex vector",
    );
  });
});
