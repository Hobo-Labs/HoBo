import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";

import { runGenerationPipelineTrainingSafetySimulation } from "../../services/generation-reference-architecture.js";

const pactRoot = new URL("../pacts/", import.meta.url);

test("generation reference simulation satisfies every declared Pact boundary", async () => {
  const result = await runGenerationPipelineTrainingSafetySimulation();
  const pacts = await Promise.all([
    loadPact("generation-sandbox-validation.pact.json"),
    loadPact("generation-certification-registry.pact.json"),
    loadPact("training-trajectory-store.pact.json"),
    loadPact("training-promotion-policy-gate.pact.json"),
    loadPact("human-approval-safety-gate.pact.json"),
  ]);

  assert.deepEqual(
    result.contracts.covered.sort(),
    [
      "GenerationSandboxValidation",
      "GenerationCertificationRegistry",
      "TrainingTrajectoryStore",
      "TrainingPromotionPolicyGate",
      "HumanApprovalSafetyGate",
    ].sort(),
  );
  assert.equal(result.contracts.missing.length, 0);

  const providers = pacts.map((pact) => pact.provider.name).sort();
  assert.deepEqual(providers, result.contracts.covered.sort());
});

async function loadPact(name) {
  return JSON.parse(await readFile(new URL(path.posix.join("./", name), pactRoot), "utf8"));
}
