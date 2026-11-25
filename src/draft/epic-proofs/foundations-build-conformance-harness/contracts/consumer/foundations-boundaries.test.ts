import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";

import { runFoundationsBuildConformanceSimulation } from "../../services/foundations-reference-architecture.js";

const pactRoot = new URL("../pacts/", import.meta.url);

const expectedProviders = [
  "WorkspaceSkeletonBoundary",
  "CoreContractBoundary",
  "WitToolchainBoundary",
  "ComponentizeBuildBoundary",
  "CiFabricBoundary",
  "ArtifactTrustBoundary",
  "HardeningTraceabilityBoundary",
];

test("foundations simulation satisfies every declared Pact boundary", async () => {
  const result = await runFoundationsBuildConformanceSimulation();
  const pacts = await Promise.all([
    loadPact("workspace-skeleton-boundary.pact.json"),
    loadPact("core-contract-boundary.pact.json"),
    loadPact("wit-toolchain-boundary.pact.json"),
    loadPact("componentize-build-boundary.pact.json"),
    loadPact("ci-fabric-boundary.pact.json"),
    loadPact("artifact-trust-boundary.pact.json"),
    loadPact("hardening-traceability-boundary.pact.json"),
  ]);

  assert.deepEqual(result.contracts.covered.sort(), expectedProviders.sort());
  assert.equal(result.contracts.missing.length, 0);
  assert.deepEqual(
    pacts.map((pact) => pact.provider.name).sort(),
    expectedProviders.sort(),
  );
  assert.equal(pacts.every((pact) => pact.consumer.name === "FoundationsReferenceApp"), true);
  assert.equal(pacts.every((pact) => pact.interactions.length > 0), true);
});

async function loadPact(name) {
  return JSON.parse(await readFile(new URL(path.posix.join("./", name), pactRoot), "utf8"));
}
