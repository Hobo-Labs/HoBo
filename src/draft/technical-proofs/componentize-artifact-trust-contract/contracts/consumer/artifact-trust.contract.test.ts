import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

import {
  createArtifactPayload,
  createFixtureSigningKey,
  createTrustBoundary,
  publishSignedArtifact,
  verifyInstallCandidate,
} from "../../src/index.ts";

const pactRoot = new URL("../pacts/", import.meta.url);

test("ArtifactTrustBoundary pact interaction is satisfied by verifyInstallCandidate", async () => {
  const pact = JSON.parse(
    await readFile(new URL("./artifact-trust-boundary.pact.json", pactRoot), "utf8"),
  );
  const interaction = pact.interactions[0];
  assert.equal(pact.provider.name, "ArtifactTrustBoundary");
  assert.equal(interaction.request.method, "POST");
  assert.equal(interaction.request.path, "/artifact/verify-install");

  const signingKey = createFixtureSigningKey({
    keyId: "builder-key-pact",
    builderId: "spiffe://yard/builders/hobo-componentize",
  });
  const trustBoundary = createTrustBoundary({
    trustedKeyIds: [signingKey.keyId],
    trustedBuilderIds: [signingKey.builderId],
    requiredConformanceSuites: ["@hobo/conformance/componentize@1.0.0"],
    allowedCoordinateScopes: ["oci://registry.example/hobo/"],
    minimumProvenanceTier: "slsa-build-l3",
  });
  const published = publishSignedArtifact({
    artifact: createArtifactPayload({
      coordinate: "oci://registry.example/hobo/hello-bindle",
      version: "1.0.0",
      mediaType: "application/vnd.module.wasm.content.layer.v1+wasm",
      bytes: "hello-bindle-wasm-component-v1",
    }),
    signingKey,
    conformanceReport: {
      suiteId: "@hobo/conformance/componentize@1.0.0",
      passed: true,
    },
    issuedAt: "2026-06-25T20:00:00.000Z",
    provenanceTier: "slsa-build-l3",
  });

  const install = verifyInstallCandidate({ candidate: published, trustBoundary });
  const expected = interaction.response.body.install;

  assert.equal(install.ok, expected.ok);
  assert.equal(install.availableToMatching, expected.availableToMatching);
  assert.equal(install.selectedByMatching, expected.selectedByMatching);
});
