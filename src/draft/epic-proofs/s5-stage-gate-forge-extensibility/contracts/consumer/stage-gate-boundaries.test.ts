import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";

import { runS5StageGateForgeDrill } from "../../services/s5-stage-gate-reference.js";

const pactRoot = new URL("../pacts/", import.meta.url);

test("S5 stage gate simulation satisfies every declared Pact boundary", async () => {
  const result = await runS5StageGateForgeDrill();
  const pacts = await Promise.all([
    loadPact("forge-registry-certification.pact.json"),
    loadPact("bindle-deploy-journey.pact.json"),
    loadPact("stub-impl-eval-promotion.pact.json"),
    loadPact("live-fix-auto-rollback.pact.json"),
  ]);

  assert.deepEqual(
    [...result.contracts.covered].sort(),
    [
      "BindleDeployOrchestrator",
      "ForgeRegistryCertification",
      "LiveFixAutoRollbackGate",
      "StubImplEvalPromotionGate",
    ].sort(),
  );
  assert.equal(result.contracts.missing.length, 0);

  const providers = pacts.map((pact) => pact.provider.name).sort();
  assert.deepEqual(providers, [...result.contracts.covered].sort());
});

test("pact expectations align with simulated stage gate drill outcomes", async () => {
  const result = await runS5StageGateForgeDrill();
  const forgePact = await loadPact("forge-registry-certification.pact.json");
  const bindlePact = await loadPact("bindle-deploy-journey.pact.json");
  const stubPact = await loadPact("stub-impl-eval-promotion.pact.json");
  const liveFixPact = await loadPact("live-fix-auto-rollback.pact.json");

  const forgeExpectation = forgePact.interactions[0].contents;
  assert.equal(result.forge.outcome, forgeExpectation.forgeOutcome);
  assert.equal(result.registry.eventType, forgeExpectation.registryEvent);
  assert.equal(result.registry.installOk, forgeExpectation.installVerified);
  assert.equal(result.registry.availableToMatching, forgeExpectation.availableToMatching);
  assert.equal(result.registry.selectedByMatching, forgeExpectation.selectedByMatching);

  const bindleExpectation = bindlePact.interactions[0].contents;
  assert.equal(result.bindleDeploy.outcome, bindleExpectation.deployOutcome);
  assert.equal(result.bindleDeploy.resourceStatus, bindleExpectation.resourceStatus);

  const stubExpectation = stubPact.interactions[0].contents;
  assert.equal(result.stubImpl.traceReplay, stubExpectation.traceReplay);
  assert.equal(result.stubImpl.promotionOutcome, stubExpectation.promotionOutcome);

  const liveFixExpectation = liveFixPact.interactions[0].contents;
  assert.equal(result.liveFix.status, liveFixExpectation.status);
  assert.equal(result.liveFix.autoRollback, liveFixExpectation.autoRollback);
  assert.equal(result.liveFix.regressionTestRetained, liveFixExpectation.regressionTestRetained);
});

async function loadPact(name) {
  return JSON.parse(await readFile(new URL(path.posix.join("./", name), pactRoot), "utf8"));
}
