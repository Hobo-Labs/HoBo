import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import { createTypescriptIdiomAdapter } from "../../idiom-semantics-annex/src/semantics-annex.js";
import { lowerFluentBindle } from "../../idiom-layer-lowering-contract/src/lowering-contract.js";
import {
  badResilienceFixtures,
  canonicalResilienceFixtures,
  runResilienceSemanticsAnnex,
} from "../../resilience-semantics-annex/src/resilience-semantics-annex.mjs";
import {
  buildTypescriptSdkLowerers,
  runSdkIdiomConformance,
  sdkConformanceGateSpec,
} from "../src/sdk-conformance-gate.js";

const corpusPath = "src/draft/technical-proofs/idiom-layer-lowering-contract/fixtures/lowering-corpus.json";
const annexPath = "src/draft/technical-proofs/idiom-semantics-annex/fixtures/annex-vectors.json";
const corpus = JSON.parse(
  await readFile(
    new URL("../../idiom-layer-lowering-contract/fixtures/lowering-corpus.json", import.meta.url),
    "utf8",
  ),
);
const annex = JSON.parse(
  await readFile(
    new URL("../../idiom-semantics-annex/fixtures/annex-vectors.json", import.meta.url),
    "utf8",
  ),
);
const loweringSource = await readFile(
  new URL("../../idiom-layer-lowering-contract/src/lowering-contract.ts", import.meta.url),
  "utf8",
);
const resilienceReport = runResilienceSemanticsAnnex(canonicalResilienceFixtures);

test("gate declares the required SDK conformance lanes", () => {
  assert.deepEqual(sdkConformanceGateSpec.lanes, [
    "golden-ir-lowering-equivalence",
    "semantics-annex",
    "resilience-semantics-annex",
    "thin-idiom-layer",
    "authorship-neutral-gate",
  ]);
  assert.equal(sdkConformanceGateSpec.contract, "hobo:sdk@0.1.0");
  assert.match(sdkConformanceGateSpec.corpusClaim, /bounded by the checked corpus/);
});

test("TS @hobo/bindles gate passes lowering, annex, thin-layer, and corpus-boundary lanes", async () => {
  const report = await runSdkIdiomConformance({
    corpus,
    corpusPath,
    annexVectors: annex.semantics,
    annexPath,
    annexAdapter: createTypescriptIdiomAdapter(),
    resilienceReport,
    sourceFiles: [{ path: "src/lowering-contract.ts", source: loweringSource }],
  });

  assert.equal(report.status, "passed");
  assert.equal(report.lanes.lowering.status, "passed");
  assert.equal(report.lanes.semantics.status, "passed");
  assert.equal(report.lanes.resilience.status, "passed");
  assert.equal(
    report.lanes.resilience.cases.find((entry) => entry.name === "transient-retry-schedule").seed,
    "hobo-resilience-retry-v1",
  );
  assert.equal(report.lanes.thinLayer.status, "passed");
  assert.equal(report.lanes.authorship.trustedByConvention, false);
  assert.equal(report.lanes.coverage.claim, "bounded-by-corpus");
  assert.deepEqual(report.lanes.lowering.cases, [{ name: "orders-api", status: "passed" }]);
});

test("SDK resilience claims fail when the resilience annex report is omitted", async () => {
  const report = await runSdkIdiomConformance({
    corpus,
    corpusPath,
    annexVectors: annex.semantics,
    annexPath,
    annexAdapter: createTypescriptIdiomAdapter(),
    helperClaims: ["transient-retry-schedule"],
    sourceFiles: [{ path: "src/lowering-contract.ts", source: loweringSource }],
  });

  assert.equal(report.status, "failed");
  assert.equal(report.lanes.lowering.status, "passed");
  assert.equal(report.lanes.semantics.status, "passed");
  assert.equal(report.lanes.resilience.cases.length, 7);
  assert.deepEqual(report.lanes.resilience.cases.find((entry) => entry.name === "transient-retry-schedule"), {
    name: "transient-retry-schedule",
    status: "failed",
    reason: "missing resilience-semantics-annex report",
  });
  assert.deepEqual(report.lanes.coverage.helperClaims, [
    {
      name: "transient-retry-schedule",
      status: "failed",
      reason: "helper claim has no golden-IR, semantics-annex, or resilience vector",
    },
  ]);
});

test("generated idiom layers use the same gate as hand-authored layers", async () => {
  const report = await runSdkIdiomConformance({
    authorship: "generated",
    corpus,
    corpusPath,
    annexVectors: annex.semantics,
    annexPath,
    annexAdapter: createTypescriptIdiomAdapter(),
    resilienceReport,
    sourceFiles: [{ path: "src/generated-wrapper.ts", source: "export const wrapper = true;" }],
  });

  assert.equal(report.status, "passed");
  assert.deepEqual(report.lanes.authorship.sameGateFor, ["hand-authored", "generated"]);
  assert.equal(report.lanes.authorship.trustedByConvention, false);
});

test("a deliberately divergent idiom layer fixture fails golden-IR equivalence", async () => {
  const lowerers = buildTypescriptSdkLowerers({
    idiom: (fixture) => {
      const result = lowerFluentBindle(fixture.fluent);
      return {
        ...result,
        witCalls: result.witCalls.filter((call) => call.function !== "attach-handler"),
      };
    },
  });

  const report = await runSdkIdiomConformance({
    corpus,
    corpusPath,
    annexVectors: annex.semantics,
    annexPath,
    annexAdapter: createTypescriptIdiomAdapter(),
    resilienceReport,
    lowerers,
    sourceFiles: [{ path: "src/lowering-contract.ts", source: loweringSource }],
  });

  assert.equal(report.status, "failed");
  assert.equal(report.lanes.lowering.status, "failed");
  assert.deepEqual(report.lanes.lowering.cases, [{ name: "orders-api", status: "failed" }]);
});

test("a layer that lowers correctly but leaks off-corpus semantics fails the annex", async () => {
  const report = await runSdkIdiomConformance({
    corpus,
    corpusPath,
    annexVectors: annex.semantics,
    annexPath,
    annexAdapter: createTypescriptIdiomAdapter({ swallowResultErrors: true }),
    resilienceReport,
    sourceFiles: [{ path: "src/lowering-contract.ts", source: loweringSource }],
  });

  assert.equal(report.status, "failed");
  assert.equal(report.lanes.lowering.status, "passed");
  assert.equal(report.lanes.semantics.status, "failed");
  assert.deepEqual(report.lanes.semantics.cases.find((entry) => entry.name === "result-error-mapping"), {
    name: "result-error-mapping",
    category: "error-mapping",
    status: "failed",
    reason: "WIT err result returned instead of throwing a typed idiom-layer error",
  });
});

test("report separates golden IR, existing semantics, and resilience semantics failures", async () => {
  const lowerers = buildTypescriptSdkLowerers({
    idiom: (fixture) => {
      const result = lowerFluentBindle(fixture.fluent);
      return {
        ...result,
        witCalls: result.witCalls.filter((call) => call.function !== "attach-handler"),
      };
    },
  });
  const cancellationRetryReport = runResilienceSemanticsAnnex([
    ...canonicalResilienceFixtures,
    badResilienceFixtures.find((fixture) => fixture.name === "bad-hidden-cancellation-retry"),
  ]);

  const report = await runSdkIdiomConformance({
    corpus,
    corpusPath,
    annexVectors: annex.semantics,
    annexPath,
    annexAdapter: createTypescriptIdiomAdapter({ swallowResultErrors: true }),
    resilienceReport: cancellationRetryReport,
    lowerers,
    sourceFiles: [{ path: "src/lowering-contract.ts", source: loweringSource }],
  });

  assert.equal(report.status, "failed");
  assert.equal(report.lanes.lowering.status, "failed");
  assert.equal(report.lanes.existingSemantics.status, "failed");
  assert.equal(report.lanes.resilience.status, "failed");
  assert.deepEqual(report.lanes.resilience.cases.find((entry) => entry.name === "bad-hidden-cancellation-retry"), {
    name: "bad-hidden-cancellation-retry",
    status: "failed",
    code: "resilience.cancellation_retried",
    reason: "caller cancellation was hidden as retry work",
  });
});

test("off-corpus SDK helper claims fail until an annex vector exists", async () => {
  const report = await runSdkIdiomConformance({
    corpus,
    corpusPath,
    annexVectors: annex.semantics,
    annexPath,
    annexAdapter: createTypescriptIdiomAdapter(),
    resilienceReport,
    helperClaims: ["transient-retry-schedule", "sdk.retry.jitter"],
    sourceFiles: [{ path: "src/lowering-contract.ts", source: loweringSource }],
  });

  assert.equal(report.status, "failed");
  assert.equal(report.lanes.resilience.status, "passed");
  assert.equal(report.lanes.coverage.status, "failed");
  assert.deepEqual(report.lanes.coverage.helperClaims, [
    { name: "transient-retry-schedule", status: "passed" },
    {
      name: "sdk.retry.jitter",
      status: "failed",
      reason: "helper claim has no golden-IR, semantics-annex, or resilience vector",
    },
  ]);
});

test("existing semantics helper claims do not require a resilience vector", async () => {
  const report = await runSdkIdiomConformance({
    corpus,
    corpusPath,
    annexVectors: annex.semantics,
    annexPath,
    annexAdapter: createTypescriptIdiomAdapter(),
    resilienceReport,
    helperClaims: ["result-error-mapping"],
    sourceFiles: [{ path: "src/lowering-contract.ts", source: loweringSource }],
  });

  assert.equal(report.status, "passed");
  assert.equal(report.lanes.resilience.status, "passed");
  assert.deepEqual(report.lanes.coverage.helperClaims, [
    { name: "result-error-mapping", status: "passed" },
  ]);
});

test("cloud/provider behavior in the idiom layer fails the thin SDK lane", async () => {
  const report = await runSdkIdiomConformance({
    corpus,
    corpusPath,
    annexVectors: annex.semantics,
    annexPath,
    annexAdapter: createTypescriptIdiomAdapter(),
    resilienceReport,
    sourceFiles: [
      {
        path: "src/bad-generated-wrapper.ts",
        source: 'import { S3Client } from "@aws-sdk/client-s3";\nexport const hiddenDefault = "us-east-1";',
      },
    ],
  });

  assert.equal(report.status, "failed");
  assert.equal(report.lanes.thinLayer.status, "failed");
  assert.match(report.lanes.thinLayer.cases[0].reason, /cloud\/provider runtime import/);
  assert.match(report.lanes.thinLayer.cases[0].reason, /provider default\/credential logic/);
});
