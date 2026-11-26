import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";

import {
  parseLoweringCorpus,
  parseSemanticsAnnexVectors,
  runSdkIdiomConformance,
  serializeReportForPact,
} from "../src/sdk/index.js";
import pact from "../contracts/pacts/sdk_conformance_report.pact.json";
import { createDriftAdapter, createReferenceAdapter } from "./fixtures/drift-adapters.js";

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const corpus = parseLoweringCorpus(
  JSON.parse(readFileSync(join(rootDir, "src/sdk/corpus/lowering-corpus.json"), "utf8")),
);
const annexVectors = parseSemanticsAnnexVectors(
  JSON.parse(readFileSync(join(rootDir, "src/sdk/vectors/semantics-annex.vectors.json"), "utf8")),
);

describe("sdk conformance report pact", () => {
  it("provider emits passing report matching pact envelope", async () => {
    const report = await runSdkIdiomConformance({
      corpus,
      annexVectors,
      adapter: createReferenceAdapter(),
    });
    const body = serializeReportForPact(report);
    const interaction = pact.interactions[0];

    assert.equal(body.suite, interaction.response.body.suite);
    assert.equal(body.contract, interaction.response.body.contract);
    assert.equal(body.status, interaction.response.body.status);
    assert.equal(
      body.lanes.some((lane) => lane.lane === "golden-ir-lowering-equivalence"),
      true,
    );
    assert.equal(body.lanes.some((lane) => lane.lane === "semantics-annex"), true);
  });

  it("provider emits failing semantics report with vector diff", async () => {
    const report = await runSdkIdiomConformance({
      corpus: [corpus[0]!],
      annexVectors,
      adapter: createDriftAdapter({ hideCancellationAsRetry: true }),
    });
    const semantics = report.lanes.find((lane) => lane.lane === "semantics-annex");
    const cancellation = semantics?.cases.find((entry) => entry.name === "caller-cancellation");

    assert.equal(report.status, "failed");
    assert.ok((cancellation?.diffPaths?.length ?? 0) > 0);
  });

  it("consumer expects TypeError envelope for empty corpus", async () => {
    const interaction = pact.interactions[2];
    try {
      await runSdkIdiomConformance({
        corpus: [],
        annexVectors,
        adapter: createReferenceAdapter(),
      });
      assert.fail("expected TypeError for empty corpus");
    } catch (error) {
      assert.ok(error instanceof TypeError);
      assert.equal(error.message, interaction.response.body.message);
    }
  });
});
