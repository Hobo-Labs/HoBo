import assert from "node:assert/strict";
import { describe, expect, it } from "vitest";

import {
  ArtifactVerificationRefusedError,
  assertVerifiedInstall,
  artifactDigest,
  artifactInstallRefusedEvent,
  artifactPublishedEvent,
  createArtifactPayload,
  createFixtureSigningKey,
  createTrustBoundary,
  publishSignedArtifact,
  verifiedArtifactCatalog,
  verifyInstallCandidate,
} from "../src/index.ts";

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

describe("publish attaches a verifiable signature, SLSA provenance, and conformance report", () => {
  it("signs digest-pinned artifacts with provenance and conformance", () => {
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

    expect(published.artifact.digest).toBe(artifactDigest(artifact));
    expect(published.signature.alg).toBe("Ed25519");
    expect(published.signature.keyId).toBe(builderKey.keyId);
    expect(published.signature.payloadDigest).toBe(published.artifact.digest);
    expect(published.provenance.slsa.builder.id).toBe(builderKey.builderId);
    expect(published.provenance.slsa.subject.digest).toBe(published.artifact.digest);
    expect(published.provenance.slsa.provenanceTier).toBe("slsa-build-l3");
    expect(published.conformance.report).toEqual(conformanceReport);

    const install = verifyInstallCandidate({ candidate: published, trustBoundary });
    expect(install.ok, install.ok ? "" : install.reasons.join("\n")).toBe(true);
    if (install.ok) {
      expect(install.availableToMatching).toBe(true);
      expect(install.selectedByMatching).toBe(false);
      expect(install.trust.provenanceTier).toBe("slsa-build-l3");
      expect(install.trust.policyMinimum).toBe("slsa-build-l3");
      expect(install.ref.digest).toBe(published.artifact.digest);
    }
  });
});

describe("install refuses tampered or unsigned artifacts and leaves the catalog unchanged", () => {
  it("rejects tampered and unsigned candidates", () => {
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
    const unsigned = { ...published, signature: null };

    const tamperedInstall = verifyInstallCandidate({ candidate: tampered, trustBoundary });
    const unsignedInstall = verifyInstallCandidate({ candidate: unsigned, trustBoundary });

    expect(tamperedInstall.ok).toBe(false);
    expect(tamperedInstall.reasons.join("\n")).toMatch(/artifact.digest_mismatch/);
    expect(tamperedInstall.availableToMatching).toBe(false);

    expect(unsignedInstall.ok).toBe(false);
    expect(unsignedInstall.reasons.join("\n")).toMatch(/signature.required/);
    expect(unsignedInstall.availableToMatching).toBe(false);
  });
});

describe("digest-pinned install is reproducible for the same artifact and provenance input", () => {
  it("yields identical digests and install refs", () => {
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

    expect(first.artifact.digest).toBe(second.artifact.digest);
    expect(first.artifact.uri).toBe(second.artifact.uri);
    expect(first.signature.payloadDigest).toBe(second.signature.payloadDigest);
    expect(first.signature.value).toBe(second.signature.value);

    const firstInstall = verifyInstallCandidate({ candidate: first, trustBoundary });
    const secondInstall = verifyInstallCandidate({ candidate: second, trustBoundary });
    if (firstInstall.ok && secondInstall.ok) {
      expect(firstInstall.ref).toEqual(secondInstall.ref);
    } else {
      assert.fail("expected both installs to verify");
    }
  });
});

describe("provenance is tied to the trusted sandbox builder identity and passing conformance", () => {
  it("rejects wrong builder, failing conformance, and weak provenance", () => {
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

    expect(wrongBuilderInstall.ok).toBe(false);
    expect(wrongBuilderInstall.reasons.join("\n")).toMatch(/signature.key_untrusted/);
    expect(wrongBuilderInstall.reasons.join("\n")).toMatch(/provenance.builder_untrusted/);

    expect(failingConformanceInstall.ok).toBe(false);
    expect(failingConformanceInstall.reasons.join("\n")).toMatch(/conformance.failed/);

    expect(weakProvenanceInstall.ok).toBe(false);
    expect(weakProvenanceInstall.reasons.join("\n")).toMatch(/provenance.tier_below_policy_minimum/);
  });
});

describe("dependency-confusion attempts fail closed by digest and coordinate scope", () => {
  it("rejects typosquat coordinates and digest URI confusion", () => {
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

    expect(shadowedInstall.ok).toBe(false);
    expect(shadowedInstall.reasons.join("\n")).toMatch(/artifact.coordinate_scope/);

    expect(digestConfusionInstall.ok).toBe(false);
    expect(digestConfusionInstall.reasons.join("\n")).toMatch(/artifact.uri_digest_mismatch/);
  });
});

describe("valid signature is reported as integrity verification, not proof of benignity", () => {
  it("surfaces residual risks on passing verdicts", () => {
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

    expect(install.ok, install.ok ? "" : install.reasons.join("\n")).toBe(true);
    if (install.ok) {
      expect(install.assurance).toBe("integrity-and-conformance-verified");
      expect(install.residualRisks).toContain("validly-signed-but-malicious");
      expect(install.residualRisks).toContain("compromised-builder-or-key");
    }
  });
});

describe("hello-bindle OCI artifact CI gate", () => {
  it("verifies signed hello-bindle and refuses stripped signature with typed error", () => {
    const artifact = createArtifactPayload({
      coordinate: "oci://registry.example/hobo/hello-bindle",
      version: "1.0.0",
      mediaType: "application/vnd.module.wasm.content.layer.v1+wasm",
      bytes: "hello-bindle-wasm-component-v1",
    });
    const runKey = createFixtureSigningKey({
      keyId: `ci-run-key-${Date.now()}`,
      builderId: builderKey.builderId,
    });
    const boundary = createTrustBoundary({
      trustedKeyIds: [runKey.keyId],
      trustedBuilderIds: [runKey.builderId],
      requiredConformanceSuites: ["@hobo/conformance/componentize@1.0.0"],
      allowedCoordinateScopes: ["oci://registry.example/hobo/"],
      minimumProvenanceTier: "slsa-build-l3",
    });
    const published = publishSignedArtifact({
      artifact,
      signingKey: runKey,
      conformanceReport,
      issuedAt: "2026-06-25T20:00:00.000Z",
      provenanceTier: "slsa-build-l3",
    });

    const verified = verifyInstallCandidate({ candidate: published, trustBoundary: boundary });
    expect(verified.ok).toBe(true);
    if (verified.ok) {
      expect(verified.availableToMatching).toBe(true);
      expect(verified.selectedByMatching).toBe(false);
      expect(verified.assurance).toBe("integrity-and-conformance-verified");
    }
    assertVerifiedInstall(verified);

    const stripped = { ...published, signature: undefined };
    const refused = verifyInstallCandidate({ candidate: stripped, trustBoundary: boundary });
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reasons).toContain("signature.required");
    }
    expect(() => assertVerifiedInstall(refused)).toThrow(ArtifactVerificationRefusedError);
    try {
      assertVerifiedInstall(refused);
    } catch (error) {
      expect(error).toBeInstanceOf(ArtifactVerificationRefusedError);
      if (error instanceof ArtifactVerificationRefusedError) {
        expect(error.code).toBe("artifact.verification_refused");
        expect(error.reasons).toContain("signature.required");
      }
    }
  });

  it("is deterministic across repeated verification", () => {
    const published = publishSignedArtifact({
      artifact: createArtifactPayload({
        coordinate: "oci://registry.example/hobo/hello-bindle",
        version: "1.0.0",
        mediaType: "application/vnd.module.wasm.content.layer.v1+wasm",
        bytes: "hello-bindle-wasm-component-v1",
      }),
      signingKey: builderKey,
      conformanceReport,
      issuedAt: "2026-06-25T20:00:00.000Z",
      provenanceTier: "slsa-build-l3",
    });
    const first = verifyInstallCandidate({ candidate: published, trustBoundary });
    const second = verifyInstallCandidate({ candidate: published, trustBoundary });
    expect(first).toEqual(second);
  });

  it("rejects tampered bytes with digest mismatch", () => {
    const published = publishSignedArtifact({
      artifact: createArtifactPayload({
        coordinate: "oci://registry.example/hobo/hello-bindle",
        version: "1.0.0",
        mediaType: "application/vnd.module.wasm.content.layer.v1+wasm",
        bytes: "hello-bindle-wasm-component-v1",
      }),
      signingKey: builderKey,
      conformanceReport,
      issuedAt: "2026-06-25T20:00:00.000Z",
      provenanceTier: "slsa-build-l3",
    });
    const tampered = {
      ...published,
      artifact: { ...published.artifact, bytes: "tampered-bindle-bytes" },
    };
    const verdict = verifyInstallCandidate({ candidate: tampered, trustBoundary });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reasons).toContain("artifact.digest_mismatch");
    }
  });
});

describe("artifact trust events and catalog projection", () => {
  it("emits InstallRefused without mutating the verified catalog", () => {
    const published = publishSignedArtifact({
      artifact: createArtifactPayload({
        coordinate: "oci://registry.example/hobo/hello-bindle",
        version: "1.0.0",
        mediaType: "application/vnd.module.wasm.content.layer.v1+wasm",
        bytes: "hello-bindle-wasm-component-v1",
      }),
      signingKey: builderKey,
      conformanceReport,
      issuedAt: "2026-06-25T20:00:00.000Z",
      provenanceTier: "slsa-build-l3",
    });
    const events = [
      artifactPublishedEvent({ candidate: published }),
      artifactInstallRefusedEvent({
        ref: published.artifact,
        reasons: ["signature.required"],
      }),
    ];
    expect(verifiedArtifactCatalog(events)).toEqual([]);
  });
});
