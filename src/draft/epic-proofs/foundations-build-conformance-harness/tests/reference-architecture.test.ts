import assert from "node:assert/strict";
import { test } from "vitest";

import { runFoundationsBuildConformanceSimulation } from "../services/foundations-reference-architecture.js";

test("foundations reference architecture proves the bootstrap path with mocked boundaries", async () => {
  const result = await runFoundationsBuildConformanceSimulation();

  assert.equal(result.epic.id, "648882d1-6039-4ed5-b771-6df8fd1a96d4");
  assert.equal(result.epic.slug, "foundations-build-conformance-harness");
  assert.deepEqual(
    result.verticalSlices.map((slice) => slice.id),
    [
      "workspace-contract",
      "contract-surface",
      "artifact-build",
      "trust-gate",
      "ci-conformance",
      "hardening-traceability",
    ],
  );

  assert.equal(result.workspace.status, "valid");
  assert.equal(result.workspace.packageManager, "pnpm");
  assert.equal(result.workspace.boundaryViolation.effect, "deny");

  assert.equal(result.core.schemaVersion, "hobo.core/v1");
  assert.equal(result.core.manifestIssuer, "https://acme-cloud.example.com");
  assert.equal(result.core.eventMappings.cloudEventSpecversion, "1.0");
  assert.equal(result.core.publicSurface.ok, true);

  assert.equal(result.wit.package, "hobo:sdk");
  assert.equal(result.wit.version, "0.1.0");
  assert.equal(result.wit.lock.canonicalGenerator, "@bytecodealliance/jco@1.24.3");

  assert.equal(result.componentize.validation.passed, true);
  assert.equal(result.componentize.smoke.exitCode, 0);
  assert.equal(result.componentize.oci.mediaType, "application/vnd.oci.image.manifest.v1+json");

  assert.equal(result.ci.contract.passed, true);
  assert.equal(result.ci.e2e.status, "passed");
  assert.equal(result.ci.e2e.token.expiresInSeconds, 900);

  assert.equal(result.artifactTrust.install.ok, true);
  assert.equal(result.artifactTrust.install.availableToMatching, true);
  assert.equal(result.artifactTrust.install.selectedByMatching, false);

  assert.equal(result.hardening.traceability.plan10.includes("HOBO-1"), true);
  assert.equal(result.contracts.missing.length, 0);
});

test("foundations reference architecture keeps negative cases fail-closed", async () => {
  const result = await runFoundationsBuildConformanceSimulation();

  assert.equal(result.negative.adapterImport.effect, "deny");
  assert.match(result.negative.adapterImport.reason, /adapters may import only core ports/);
  assert.equal(result.negative.providerSpecificCoreSurface.ok, false);
  assert.equal(result.negative.ciMissingOidc.passed, false);
  assert.deepEqual(result.negative.unsignedArtifact.reasons, ["signature.required"]);
});
