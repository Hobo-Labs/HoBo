import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "vitest";

import { contentDigest } from "../../slsa-provenance-certification-contract/src/provenance.js";
import {
  GENERATION_REFERENCE_REPAIR_BUDGET,
  buildColdStartDatabaseProviderRequest,
  runColdStartDatabaseProviderReference,
  runColdStartDocsOnlyReference,
  runNonConvergingDatabaseProviderReference
} from "../src/generation-reference-run.js";

test("cold-start database provider run composes scaffold, fill, validation, repair, and certification", async () => {
  const result = await runColdStartDatabaseProviderReference({
    signingKey: fixtureSigningKey(),
    validationScript: ["trace-mismatch", "pass"]
  });

  assert.equal(result.outcome, "certified");
  assert.deepEqual(result.stageResults.map((stage) => stage.stage), [
    "request",
    "scaffold",
    "fill",
    "repair",
    "certify"
  ]);
  assert.deepEqual(
    result.repair.events.map((event) => event.type),
    ["gen.ValidationFailed", "gen.Repaired", "gen.Validated"]
  );
  assert.equal(result.finalValidation.report.traceReplay.passed, true);
  assert.equal(result.coverage.reference.ok, true, result.coverage.reference.reasons.join("\n"));
  assert.equal(result.coverage.production.ok, true, result.coverage.production.reasons.join("\n"));
  assert.equal(result.certification.ok, true, result.certification.reasons.join("\n"));
  assert.deepEqual(
    result.registry.events().map((event) => event.type),
    ["gen.Certified", "gen.PluginCertified"]
  );
  assert.equal(result.certification.record.payload.name, "@acme/provider-postgres");
  assert.equal(
    result.certification.record.payload.validationReport.actualValidationReportRef.digest,
    result.finalValidation.report.ref.digest
  );
  assert.equal(
    result.certification.record.payload.provenance.payload.artifact.digest,
    result.finalCandidateRef.digest
  );
});

test("bounded non-convergence emits one NeedsHuman event and never certifies", async () => {
  const result = await runNonConvergingDatabaseProviderReference({
    signingKey: fixtureSigningKey()
  });

  assert.equal(result.outcome, "needs-human");
  assert.equal(result.repair.repairAttempts, GENERATION_REFERENCE_REPAIR_BUDGET);
  assert.equal(result.repair.finalEvent.type, "gen.NeedsHuman");
  assert.equal(result.repair.finalEvent.data.reason, "repair-budget-exhausted");
  assert.equal(result.repair.events.filter((event) => event.type === "gen.NeedsHuman").length, 1);
  assert.deepEqual(result.finalCandidateRef, result.finalValidation.report.candidateRef);
  assert.equal(result.certification, null);
  assert.deepEqual(result.registry.events(), []);
});

test("docs-only cold-start path either certifies through conformance or escalates without bypass", async () => {
  const certified = await runColdStartDocsOnlyReference({
    signingKey: fixtureSigningKey(),
    validationScript: ["pass"]
  });
  const escalated = await runColdStartDocsOnlyReference({
    signingKey: fixtureSigningKey(),
    validationScript: ["trace-mismatch", "conformance-mismatch", "trace-mismatch"]
  });

  assert.equal(certified.outcome, "certified");
  assert.equal(certified.materialProfile, "docs-only-no-manifest");
  assert.equal(certified.fill.candidate.authoritativeInputs.witPort, "hobo:database/postgres@0.1.0");
  assert.equal(certified.fill.candidate.materialEvidence.trusted, false);
  assert.match(certified.fill.candidate.provenance.frozenPrompt, /BEGIN_UNTRUSTED_MATERIAL/);

  assert.equal(escalated.outcome, "needs-human");
  assert.equal(escalated.certification, null);
  assert.match(
    escalated.repair.finalEvent.data.failingAssertions.join("\n"),
    /conformance:contract\.require-miss|trace:trace:database-happy-path/
  );
});

test("wrong synthesis guesses and contradictory material cannot certify a different port", async () => {
  const result = await runColdStartDatabaseProviderReference({
    signingKey: fixtureSigningKey(),
    requestOverrides: {
      materialRefs: [
        {
          kind: "provider-docs",
          ref: "https://example.invalid/docs-that-claim-cache",
          trusted: false,
          sanitized: true,
          suggestedWitPort: "hobo:cache/redis@0.1.0"
        }
      ]
    },
    validationScript: ["wrong-port", "wrong-port", "wrong-port"]
  });
  const request = buildColdStartDatabaseProviderRequest({
    materialRefs: [
      {
        kind: "openapi",
        ref: "https://example.invalid/cache-api",
        trusted: false,
        sanitized: true,
        suggestedWitPort: "hobo:cache/redis@0.1.0"
      }
    ]
  });

  assert.equal(request.target.witPort, "hobo:database/postgres@0.1.0");
  assert.equal(request.authoritativeRefs.at(-1).suiteId, "conformance.provider.database@0.1.0");
  assert.equal(result.outcome, "needs-human");
  assert.equal(result.certification, null);
  assert.match(result.repair.finalEvent.data.failingAssertions.join("\n"), /contract\.target-port/);
});

test("pinned inputs reproduce artifact and certification payload digests", async () => {
  const signingKey = fixtureSigningKey();
  const first = await runColdStartDatabaseProviderReference({ signingKey });
  const second = await runColdStartDatabaseProviderReference({ signingKey });
  const differentSeed = await runColdStartDatabaseProviderReference({
    signingKey,
    seed: "seed-hobo-348-different"
  });

  assert.equal(first.finalCandidateRef.digest, second.finalCandidateRef.digest);
  assert.equal(
    contentDigest(first.certification.record.payload),
    contentDigest(second.certification.record.payload)
  );
  assert.notEqual(first.finalCandidateRef.digest, differentSeed.finalCandidateRef.digest);
});

function fixtureSigningKey() {
  const keys = generateKeyPairSync("ed25519");
  return {
    keyId: "hobo-generation-reference-run",
    publicKeyPem: keys.publicKey.export({ type: "spki", format: "pem" }),
    privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" })
  };
}
