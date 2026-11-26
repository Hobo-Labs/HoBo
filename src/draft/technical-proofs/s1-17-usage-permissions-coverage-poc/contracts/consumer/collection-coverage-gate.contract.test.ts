import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { evaluateCollectionCoverage } from "../../src/collection-coverage.js";

const pactPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "collection-coverage-gate.pact.json",
);

test("collection-coverage-gate pact satisfies the cannot-prove-resource-name fail-closed interaction", () => {
  const pact = JSON.parse(readFileSync(pactPath, "utf8"));
  const interaction = pact.interactions[0];

  assert.equal(pact.consumer.name, "CollectionCoverageGateConsumer");
  assert.equal(pact.provider.name, "CollectionCoverageGate");
  assert.equal(interaction.response.status, 422);
  assert.equal(
    interaction.response.body.reason,
    "collection.coverage.cannot-prove-resource-name",
  );

  const result = evaluateCollectionCoverage({
    sourceText: interaction.request.body.sourceText,
    observedResourceIds: interaction.request.body.observedResourceIds,
    fileName: "dynamic.ts",
  });

  assert.equal(result.ok, false);
  assert.equal(result.diagnostics[0]?.code, interaction.response.body.reason);
});
