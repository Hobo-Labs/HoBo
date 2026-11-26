import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";

import { runPortabilityRegistrySimulation } from "../../services/portability-registry-reference.js";

const pactRoot = new URL("../pacts/", import.meta.url);

test("registry reference simulation satisfies every declared Pact boundary", async () => {
  const result = await runPortabilityRegistrySimulation();
  const pacts = await Promise.all([
    loadPact("registry-artifact-repository.pact.json"),
    loadPact("registry-capability-discovery.pact.json"),
    loadPact("registry-trust-policy.pact.json"),
    loadPact("registry-offline-import.pact.json"),
  ]);

  assert.deepEqual(
    result.contracts.covered.sort(),
    [
      "ArtifactRepositoryMirror",
      "CapabilityDiscoveryIndex",
      "OfflineBundleImporter",
      "RegistryTrustPolicyGate",
    ].sort(),
  );
  assert.equal(result.contracts.missing.length, 0);

  const providers = pacts.map((pact) => pact.provider.name).sort();
  assert.deepEqual(providers, result.contracts.covered.sort());
});

async function loadPact(name) {
  return JSON.parse(await readFile(new URL(path.posix.join("./", name), pactRoot), "utf8"));
}
