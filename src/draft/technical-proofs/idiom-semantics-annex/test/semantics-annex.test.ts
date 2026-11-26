import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";
import {
  createTypescriptIdiomAdapter,
  runGoldenIrEquivalence,
  runSemanticsAnnex,
  semanticsAnnexSpec,
} from "../src/semantics-annex.js";

const vectors = JSON.parse(
  await readFile(new URL("../fixtures/annex-vectors.json", import.meta.url), "utf8"),
);

test("annex declares categories that golden-IR equivalence does not prove", () => {
  assert.deepEqual(semanticsAnnexSpec.categories, [
    "error-mapping",
    "cancellation",
    "async-ordering",
    "ifc-side-effects",
  ]);
  assert.match(semanticsAnnexSpec.goldenIrBoundary, /WIT calls plus manifest IR only/);
});

test("golden-IR equivalence passes even when the TS idiom layer swallows WIT errors", () => {
  const correctAdapter = createTypescriptIdiomAdapter();
  const badErrorAdapter = createTypescriptIdiomAdapter({ swallowResultErrors: true });

  assert.deepEqual(runGoldenIrEquivalence(vectors.goldenIr, correctAdapter), {
    lane: "golden-ir",
    fixture: "orders-handler",
    status: "passed",
  });
  assert.deepEqual(runGoldenIrEquivalence(vectors.goldenIr, badErrorAdapter), {
    lane: "golden-ir",
    fixture: "orders-handler",
    status: "passed",
  });
});

test("semantics annex fails a wrong TS error mapping that golden-IR cannot catch", async () => {
  const report = await runSemanticsAnnex(
    vectors.semantics,
    createTypescriptIdiomAdapter({ swallowResultErrors: true }),
  );

  assert.equal(report.status, "failed");
  assert.deepEqual(report.cases.find((entry) => entry.name === "result-error-mapping"), {
    name: "result-error-mapping",
    category: "error-mapping",
    status: "failed",
    reason: "WIT err result returned instead of throwing a typed idiom-layer error",
  });
});

test("semantics annex rejects hidden retry behavior for caller cancellation", async () => {
  const report = await runSemanticsAnnex(
    vectors.semantics,
    createTypescriptIdiomAdapter({ hideCancellationAsRetry: true }),
  );

  assert.equal(report.status, "failed");
  assert.deepEqual(report.cases.find((entry) => entry.name === "caller-cancellation"), {
    name: "caller-cancellation",
    category: "cancellation",
    status: "failed",
    reason: "cancellation did not lower to caller-owned cancelled result",
  });
});

test("semantics annex passes correct error, cancellation, async, and IfC vectors", async () => {
  const report = await runSemanticsAnnex(vectors.semantics, createTypescriptIdiomAdapter());

  assert.equal(report.status, "passed");
  assert.deepEqual(
    report.cases.map(({ name, status }) => ({ name, status })),
    [
      { name: "result-error-mapping", status: "passed" },
      { name: "caller-cancellation", status: "passed" },
      { name: "awaited-ifc-order", status: "passed" },
      { name: "missing-resource-before-handler", status: "passed" },
    ],
  );
});
