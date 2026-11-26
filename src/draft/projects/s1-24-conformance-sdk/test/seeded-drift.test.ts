import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";

import {
  parseLoweringCorpus,
  parseSemanticsAnnexVectors,
  runSdkIdiomConformance,
} from "../src/sdk/index.js";
import { createDriftAdapter } from "./fixtures/drift-adapters.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = parseLoweringCorpus(
  JSON.parse(readFileSync(join(rootDir, "src/sdk/corpus/lowering-corpus.json"), "utf8")),
);
const annexVectors = parseSemanticsAnnexVectors(
  JSON.parse(readFileSync(join(rootDir, "src/sdk/vectors/semantics-annex.vectors.json"), "utf8")),
);

describe("seeded semantics drift", () => {
  it("hideCancellationAsRetry passes golden-IR but fails semantics-annex on caller-cancellation with vector diff", async () => {
    const report = await runSdkIdiomConformance({
      corpus: [corpus[0]!],
      annexVectors,
      adapter: createDriftAdapter({ hideCancellationAsRetry: true }),
    });

    const goldenIr = report.lanes.find((lane) => lane.lane === "golden-ir-lowering-equivalence");
    const semantics = report.lanes.find((lane) => lane.lane === "semantics-annex");

    assert.equal(report.status, "failed");
    assert.equal(goldenIr?.status, "passed");
    assert.equal(semantics?.status, "failed");

    const cancellationCase = semantics?.cases.find((entry) => entry.name === "caller-cancellation");
    assert.equal(cancellationCase?.status, "failed");
    assert.match(cancellationCase?.actualJson ?? "", /"retried":true/);
    assert.match(cancellationCase?.expectedJson ?? "", /"tag":"cancelled"/);
    assert.match(cancellationCase?.expectedJson ?? "", /"retry":"caller-owned"/);
    assert.ok((cancellationCase?.diffPaths?.length ?? 0) > 0);
  });

  it("swallowResultErrors fails result-error-mapping", async () => {
    const report = await runSdkIdiomConformance({
      corpus: [corpus[0]!],
      annexVectors,
      adapter: createDriftAdapter({ swallowResultErrors: true }),
    });

    const semantics = report.lanes.find((lane) => lane.lane === "semantics-annex");
    const errorCase = semantics?.cases.find((entry) => entry.name === "result-error-mapping");
    assert.equal(errorCase?.status, "failed");
  });

  it("useInputOrder fails awaited-ifc-order", async () => {
    const report = await runSdkIdiomConformance({
      corpus: [corpus[0]!],
      annexVectors,
      adapter: createDriftAdapter({ useInputOrder: true }),
    });

    const semantics = report.lanes.find((lane) => lane.lane === "semantics-annex");
    const orderCase = semantics?.cases.find((entry) => entry.name === "awaited-ifc-order");
    assert.equal(orderCase?.status, "failed");
    assert.ok((orderCase?.diffPaths?.length ?? 0) > 0);
  });
});
