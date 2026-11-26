import assert from "node:assert/strict";
import { test } from "vitest";

import {
  artifactDigest,
  createArtifactPayload,
  createFixtureSigningKey,
  createTrustBoundary,
  publishSignedArtifact,
  verifyInstallCandidate,
} from "../src/publish-install-contract.js";

const builderKey = createFixtureSigningKey({
  keyId: "builder-key-1",
  builderId: "spiffe://yard/builders/hobo-componentize",
});

const trustBoundary = createTrustBoundary({
  trustedKeyIds: [builderKey.keyId],
  trustedBuilderIds: [builderKey.builderId],
  requiredConformanceSuites: ["@hobo/conformance/componentize@1.0.0"],
  allowedCoordinateScopes: ["oci://registry.example/hobo/"],
  minimumProvenanceTier: "slsa-build-l3",
});

const conformanceReport = Object.freeze({
  suiteId: "@hobo/conformance/componentize@1.0.0",
  passed: true,
  assertions: ["wasm-tools validate", "oci-digest-stability", "wasmtime-smoke"],
});

test("publish attaches a verifiable signature, SLSA provenance, and conformance report", () => {
  const artifact = createArtifactPayload({
    coordinate: "oci://registry.example/hobo/hello-bindle",
    version: "1.0.0",
    mediaType: "application/vnd.module.wasm.content.layer.v1+wasm",
    bytes: "hello-bindle-wasm-component-v1",
  });

  const published = publishSignedArtifact({
    artifact,
    signingKey: builderKey,
    conformanceReport,
    issuedAt: "2026-06-25T20:00:00.000Z",
    provenanceTier: "slsa-build-l3",
  });

  assert.equal(published.artifact.digest, artifactDigest(artifact));
  assert.equal(published.signature.alg, "Ed25519");
  assert.equal(published.signature.keyId, builderKey.keyId);
  assert.equal(published.signature.payloadDigest, published.artifact.digest);
  assert.equal(published.provenance.slsa.builder.id, builderKey.builderId);
  assert.equal(published.provenance.slsa.subject.digest, published.artifact.digest);
  assert.equal(published.provenance.slsa.provenanceTier, "slsa-build-l3");
  assert.deepEqual(published.conformance.report, conformanceReport);

  const install = verifyInstallCandidate({ candidate: published, trustBoundary });
  assert.equal(install.ok, true, install.reasons.join("\n"));
  assert.equal(install.availableToMatching, true);
  assert.equal(install.selectedByMatching, false);
  assert.equal(install.trust.provenanceTier, "slsa-build-l3");
  assert.equal(install.trust.policyMinimum, "slsa-build-l3");
  assert.equal(install.ref.digest, published.artifact.digest);
});

test("install refuses tampered or unsigned artifacts and leaves the catalog unchanged", () => {
  const published = publishSignedArtifact({
    artifact: createArtifactPayload({
      coordinate: "oci://registry.example/hobo/worker",
      version: "2.0.0",
      mediaType: "application/vnd.module.wasm.content.layer.v1+wasm",
      bytes: "worker-wasm-component-v1",
    }),
    signingKey: builderKey,
    conformanceReport,
    issuedAt: "2026-06-25T20:00:00.000Z",
    provenanceTier: "slsa-build-l3",
  });

  const tampered = {
    ...published,
    artifact: { ...published.artifact, bytes: "worker-wasm-component-with-extra-admin-route" },
  };
  const unsigned = {
    ...published,
    signature: null,
  };

  const tamperedInstall = verifyInstallCandidate({ candidate: tampered, trustBoundary });
  const unsignedInstall = verifyInstallCandidate({ candidate: unsigned, trustBoundary });

  assert.equal(tamperedInstall.ok, false);
  assert.match(tamperedInstall.reasons.join("\n"), /artifact.digest_mismatch/);
  assert.equal(tamperedInstall.availableToMatching, false);

  assert.equal(unsignedInstall.ok, false);
  assert.match(unsignedInstall.reasons.join("\n"), /signature.required/);
  assert.equal(unsignedInstall.availableToMatching, false);
});

test("digest-pinned install is reproducible for the same artifact and provenance input", () => {
  const artifact = createArtifactPayload({
    coordinate: "oci://registry.example/hobo/reproducible-service",
    version: "1.0.0",
    mediaType: "application/vnd.module.wasm.content.layer.v1+wasm",
    bytes: "reproducible-wasm-component",
  });

  const first = publishSignedArtifact({
    artifact,
    signingKey: builderKey,
    conformanceReport,
    issuedAt: "2026-06-25T20:00:00.000Z",
    provenanceTier: "slsa-build-l3",
  });
  const second = publishSignedArtifact({
    artifact,
    signingKey: builderKey,
    conformanceReport,
    issuedAt: "2026-06-25T20:00:00.000Z",
    provenanceTier: "slsa-build-l3",
  });

  assert.equal(first.artifact.digest, second.artifact.digest);
  assert.equal(first.artifact.uri, second.artifact.uri);
  assert.equal(first.signature.payloadDigest, second.signature.payloadDigest);
  assert.equal(first.signature.value, second.signature.value);
  assert.deepEqual(
    verifyInstallCandidate({ candidate: first, trustBoundary }).ref,
    verifyInstallCandidate({ candidate: second, trustBoundary }).ref,
  );
});

test("provenance is tied to the trusted sandbox builder identity and passing conformance", () => {
  const untrustedKey = createFixtureSigningKey({
    keyId: "builder-key-2",
    builderId: "spiffe://yard/builders/untrusted-fork",
  });
  const signedByWrongBuilder = publishSignedArtifact({
    artifact: createArtifactPayload({
      coordinate: "oci://registry.example/hobo/provider",
      version: "1.0.0",
      mediaType: "application/vnd.hobo.provider.layer.v1+json",
      bytes: "provider-bytes",
    }),
    signingKey: untrustedKey,
    conformanceReport,
    issuedAt: "2026-06-25T20:00:00.000Z",
    provenanceTier: "slsa-build-l3",
  });
  const failingConformance = publishSignedArtifact({
    artifact: createArtifactPayload({
      coordinate: "oci://registry.example/hobo/provider",
      version: "1.0.0",
      mediaType: "application/vnd.hobo.provider.layer.v1+json",
      bytes: "provider-bytes",
    }),
    signingKey: builderKey,
    conformanceReport: { ...conformanceReport, passed: false },
    issuedAt: "2026-06-25T20:00:00.000Z",
    provenanceTier: "slsa-build-l3",
  });
  const weakProvenance = publishSignedArtifact({
    artifact: createArtifactPayload({
      coordinate: "oci://registry.example/hobo/provider",
      version: "1.0.0",
      mediaType: "application/vnd.hobo.provider.layer.v1+json",
      bytes: "provider-bytes",
    }),
    signingKey: builderKey,
    conformanceReport,
    issuedAt: "2026-06-25T20:00:00.000Z",
    provenanceTier: "builder-observed",
  });

  const wrongBuilderInstall = verifyInstallCandidate({
    candidate: signedByWrongBuilder,
    trustBoundary,
  });
  const failingConformanceInstall = verifyInstallCandidate({
    candidate: failingConformance,
    trustBoundary,
  });
  const weakProvenanceInstall = verifyInstallCandidate({
    candidate: weakProvenance,
    trustBoundary,
  });

  assert.equal(wrongBuilderInstall.ok, false);
  assert.match(wrongBuilderInstall.reasons.join("\n"), /signature.key_untrusted/);
  assert.match(wrongBuilderInstall.reasons.join("\n"), /provenance.builder_untrusted/);

  assert.equal(failingConformanceInstall.ok, false);
  assert.match(failingConformanceInstall.reasons.join("\n"), /conformance.failed/);

  assert.equal(weakProvenanceInstall.ok, false);
  assert.match(weakProvenanceInstall.reasons.join("\n"), /provenance.tier_below_policy_minimum/);
});

test("dependency-confusion attempts fail closed by digest and coordinate scope", () => {
  const shadowed = publishSignedArtifact({
    artifact: createArtifactPayload({
      coordinate: "oci://attacker.example/hobo/hello-bindle",
      version: "99.0.0",
      mediaType: "application/vnd.module.wasm.content.layer.v1+wasm",
      bytes: "typosquat-wasm-component",
    }),
    signingKey: builderKey,
    conformanceReport,
    issuedAt: "2026-06-25T20:00:00.000Z",
    provenanceTier: "slsa-build-l3",
  });
  const digestConfusion = {
    ...shadowed,
    artifact: {
      ...shadowed.artifact,
      uri: "oci://registry.example/hobo/hello-bindle@sha256:0000000000000000000000000000000000000000000000000000000000000000",
    },
  };

  const shadowedInstall = verifyInstallCandidate({ candidate: shadowed, trustBoundary });
  const digestConfusionInstall = verifyInstallCandidate({
    candidate: digestConfusion,
    trustBoundary,
  });

  assert.equal(shadowedInstall.ok, false);
  assert.match(shadowedInstall.reasons.join("\n"), /artifact.coordinate_scope/);

  assert.equal(digestConfusionInstall.ok, false);
  assert.match(digestConfusionInstall.reasons.join("\n"), /artifact.uri_digest_mismatch/);
});

test("valid signature is reported as integrity verification, not proof of benignity", () => {
  const published = publishSignedArtifact({
    artifact: createArtifactPayload({
      coordinate: "oci://registry.example/hobo/generated-provider",
      version: "1.0.0",
      mediaType: "application/vnd.hobo.provider.layer.v1+json",
      bytes: "validly-signed-provider-with-unknown-business-intent",
    }),
    signingKey: builderKey,
    conformanceReport,
    issuedAt: "2026-06-25T20:00:00.000Z",
    provenanceTier: "slsa-build-l3",
  });

  const install = verifyInstallCandidate({ candidate: published, trustBoundary });

  assert.equal(install.ok, true, install.reasons.join("\n"));
  assert.equal(install.assurance, "integrity-and-conformance-verified");
  assert.ok(install.residualRisks.includes("validly-signed-but-malicious"));
  assert.ok(install.residualRisks.includes("compromised-builder-or-key"));
});
