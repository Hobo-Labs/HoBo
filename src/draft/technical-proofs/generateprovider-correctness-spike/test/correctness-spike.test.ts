import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "vitest";

import { contentDigest } from "../../slsa-provenance-certification-contract/src/provenance.js";
import {
  assertPinnedGenerationInputs,
  assessProviderSuiteCoverage,
  buildGenerateProviderRequest,
  DEFAULT_REPAIR_BUDGET,
  runGenerateProviderNonConvergenceProof,
  runReferenceDatabaseProviderGeneration
} from "../src/correctness-spike.js";

test("reference database-provider generation converges, certifies, and records reference coverage", async () => {
  const result = await runReferenceDatabaseProviderGeneration({
    signingKey: fixtureSigningKey(),
    validationScript: ["trace-mismatch", "pass"]
  });

  assert.equal(result.repair.outcome, "converged");
  assert.deepEqual(
    result.repair.events.map((event) => event.type),
    ["gen.ValidationFailed", "gen.Repaired", "gen.Validated"]
  );
  assert.equal(result.finalValidation.report.traceReplay.passed, true);
  assert.equal(result.coverage.ok, true, result.coverage.reasons.join("\n"));
  assert.equal(result.coverage.profile, "reference");
  assert.equal(result.productionCoverage.ok, false);
  assert.match(result.productionCoverage.reasons.join("\n"), /real Camp evidence/);
  assert.equal(result.certification.ok, true, result.certification.reasons.join("\n"));
  assert.deepEqual(
    result.registry.events().map((event) => event.type),
    ["gen.Certified", "gen.PluginCertified"]
  );
  assert.deepEqual(result.certification.record.payload.claimedPorts, [
    "hobo:database/postgres@0.1.0"
  ]);
  assert.deepEqual(
    result.certification.record.payload.validationReport.actualValidationReportRef,
    result.finalValidation.report.ref
  );
  assert.deepEqual(
    result.certification.record.payload.validationReport.traceReplay,
    result.finalValidation.report.traceReplay
  );
});

test("forced non-convergence escalates to gen.NeedsHuman within the default budget", async () => {
  const result = await runGenerateProviderNonConvergenceProof({
    signingKey: fixtureSigningKey()
  });

  assert.equal(result.repair.outcome, "needs-human");
  assert.equal(result.repair.repairAttempts, DEFAULT_REPAIR_BUDGET);
  assert.equal(result.repair.finalEvent.type, "gen.NeedsHuman");
  assert.equal(result.repair.finalEvent.data.reason, "repair-budget-exhausted");
  assert.equal(result.repair.events.filter((event) => event.type === "gen.NeedsHuman").length, 1);
  assert.equal(result.certification, null);
});

test("pinned model, prompt, seed, and inputs reproduce the same artifact digest", async () => {
  const signingKey = fixtureSigningKey();
  const first = await runReferenceDatabaseProviderGeneration({ signingKey });
  const second = await runReferenceDatabaseProviderGeneration({ signingKey });
  const differentSeed = await runReferenceDatabaseProviderGeneration({
    signingKey,
    seed: "seed-hobo-211-different"
  });
  const differentMaterial = await runReferenceDatabaseProviderGeneration({
    signingKey,
    requestOverrides: {
      materialRefs: [
        {
          kind: "provider-docs",
          ref: "https://example.invalid/postgres/provider-docs-v2",
          trusted: false,
          sanitized: true
        },
        {
          kind: "recorded-traces",
          ref: "oci://registry.example/hobo/traces/database-reference@sha256:3333",
          trusted: false,
          sanitized: true
        }
      ]
    }
  });
  const differentSuiteRef = await runReferenceDatabaseProviderGeneration({
    signingKey,
    requestOverrides: {
      authoritativeRefs: [
        {
          kind: "wit",
          ref: "wit://hobo/database@0.1.0"
        },
        {
          kind: "conformance-suite",
          suiteId: "conformance.provider.database@0.1.0",
          ref: "oci://registry.example/hobo/conformance/database@sha256:3333"
        }
      ]
    }
  });

  assert.equal(first.finalCandidateRef.digest, second.finalCandidateRef.digest);
  assert.equal(
    contentDigest(first.certification.record.payload),
    contentDigest(second.certification.record.payload)
  );
  assert.notEqual(first.finalCandidateRef.digest, differentSeed.finalCandidateRef.digest);
  assert.notEqual(first.finalCandidateRef.digest, differentMaterial.finalCandidateRef.digest);
  assert.notEqual(first.finalCandidateRef.digest, differentSuiteRef.finalCandidateRef.digest);
});

test("unpinned model aliases or sampling cannot claim reproducible certification", () => {
  const pinnedPrompt = {
    id: "generate-provider-database-v1",
    frozenPromptDigest: contentDigest({ prompt: "frozen" })
  };
  const pinnedModel = {
    provider: "self-hosted",
    id: "self-hosted/qwen3-coder",
    digest: contentDigest({ model: "qwen3-coder", version: "pinned" })
  };

  assert.equal(
    assertPinnedGenerationInputs({
      model: pinnedModel,
      prompt: pinnedPrompt,
      generationConfig: { temperature: 0, topP: 1 },
      seed: "seed-hobo-211"
    }),
    true
  );
  assert.throws(
    () =>
      assertPinnedGenerationInputs({
        model: { ...pinnedModel, id: "hosted/latest" },
        prompt: pinnedPrompt,
        generationConfig: { temperature: 0, topP: 1 },
        seed: "seed-hobo-211"
      }),
    /generation\.model_not_pinned/
  );
  assert.throws(
    () =>
      assertPinnedGenerationInputs({
        model: pinnedModel,
        prompt: pinnedPrompt,
        generationConfig: { temperature: 0.2, topP: 1 },
        seed: "seed-hobo-211"
      }),
    /generation\.sampling_not_deterministic/
  );
});

test("minimum production suite coverage rejects reference-only and thin conformance reports", async () => {
  const referenceOnly = await runReferenceDatabaseProviderGeneration({
    signingKey: fixtureSigningKey()
  });

  assert.equal(referenceOnly.coverage.ok, true);
  assert.equal(referenceOnly.productionCoverage.ok, false);
  assert.match(referenceOnly.productionCoverage.reasons.join("\n"), /database\.camp\.real-provider-drift/);
  assert.match(referenceOnly.productionCoverage.reasons.join("\n"), /real Camp evidence/);
  assert.equal(referenceOnly.certification.ok, true);

  const thin = assessProviderSuiteCoverage({
    capability: "database",
    suiteRun: {
      status: "pass",
      checks: [
        {
          capability: "database",
          tag: "local",
          checkId: "database.local.provision-connects",
          status: "pass"
        }
      ],
      failures: []
    }
  });

  assert.equal(thin.ok, false);
  assert.match(thin.reasons.join("\n"), /database\.local\.destroy-cleans-state/);
});

test("contradictory cold-start material cannot override the authoritative WIT target", () => {
  const request = buildGenerateProviderRequest({
    materialRefs: [
      {
        kind: "provider-docs",
        ref: "https://example.invalid/docs-that-claim-cache",
        trusted: false,
        sanitized: true,
        suggestedWitPort: "hobo:cache/redis@0.1.0"
      }
    ]
  });

  assert.equal(request.target.witPort, "hobo:database/postgres@0.1.0");
  assert.equal(request.authoritativeRefs.at(-1).suiteId, "conformance.provider.database@0.1.0");
});

function fixtureSigningKey() {
  const keys = generateKeyPairSync("ed25519");
  return {
    keyId: "hobo-generateprovider-correctness",
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" })
  };
}
