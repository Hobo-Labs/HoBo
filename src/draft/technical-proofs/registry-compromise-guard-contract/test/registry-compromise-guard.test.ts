import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  createArtifactPayload,
  createFixtureSigningKey,
  createTrustBoundary,
  publishSignedArtifact,
} from "../../signed-artifact-publish-install-contract/src/publish-install-contract.js";
import {
  createFixtureMirror,
  sha256Digest,
} from "../../registry-dependency-confusion-guard-contract/src/registry-dependency-confusion-guard.js";

import {
  reverifyCapabilitySpecAndYankOnRegression,
  verifyPinnedRegistryFetch,
  verifyRegistryInstallAgainstCompromise,
} from "../src/registry-compromise-guard.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const builderKey = createFixtureSigningKey({
  keyId: "registry-compromise-builder",
  builderId: "spiffe://yard/builders/hobo-componentize",
});
const trustBoundary = createTrustBoundary({
  trustedKeyIds: [builderKey.keyId],
  trustedBuilderIds: [builderKey.builderId],
  requiredConformanceSuites: ["@hobo/conformance/registry-provider@1.0.0"],
  allowedCoordinateScopes: ["oci://registry.example/hobo/"],
  minimumProvenanceTier: "slsa-build-l3",
});

test("bit-flipped signed artifacts are refused before catalog registration", () => {
  const candidate = signedProviderListing();
  const listing = descriptorFor(candidate);
  const tampered = {
    ...candidate,
    artifact: {
      ...candidate.artifact,
      bytes: `${candidate.artifact.bytes}:admin-backdoor`,
    },
  };

  const result = verifyRegistryInstallAgainstCompromise({
    listing,
    candidate: tampered,
    trustBoundary,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, "install-verification");
  assert.match(result.reasons.join("\n"), /artifact.digest_mismatch/);
  assert.deepEqual(result.catalogEntries, []);
});

test("forged conformance reports signed by the right key but for another artifact are rejected", () => {
  const candidate = signedProviderListing({
    conformanceReport: {
      suiteId: "@hobo/conformance/registry-provider@1.0.0",
      passed: true,
      artifactDigest: digest("different-artifact"),
      assertions: ["provider exports blobstore"],
    },
  });
  const listing = descriptorFor(candidate);

  const result = verifyRegistryInstallAgainstCompromise({
    listing,
    candidate,
    trustBoundary,
  });

  assert.equal(result.ok, false);
  assert.equal(result.stage, "conformance-binding");
  assert.match(result.reasons.join("\n"), /conformance.artifact_digest_mismatch/);
  assert.deepEqual(result.catalogEntries, []);
});

test("descriptor conformance report digest must match the certified report digest", () => {
  const candidate = signedProviderListing();
  const listing = descriptorFor(candidate);
  listing.evidence.conformanceReportRefs[0].ref = artifactRef({
    digest: digest("forged-report"),
    mediaType: "application/vnd.hobo.conformance.report.v1+json",
    name: "forged-report",
  });

  const result = verifyRegistryInstallAgainstCompromise({
    listing,
    candidate,
    trustBoundary,
  });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /descriptor.conformance_report_digest_mismatch/);
});

test("post-publish Capability Spec regression uses fresh verification and follows the yank path", () => {
  const result = reverifyCapabilitySpecAndYankOnRegression({
    certifiedListing: certifiedListing(),
    runningSet: {
      setId: "set-prod-payments",
      status: "Running",
      pinnedListings: [{ listingId: "listing-acme-provider-v1", role: "provider" }],
    },
    expectedExports: [
      "wasi:blobstore/blobstore@0.2.0@stable",
      "hobo:queue/queue@1.0.0@stable",
    ],
    observedExports: ["wasi:blobstore/blobstore@0.2.0@stable"],
    actor: yardSecurityAdmin(),
    occurredAt: "2026-06-28T18:40:00.000Z",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "capability_spec.regressed");
  assert.equal(result.authorTimeSnapshotTrusted, false);
  assert.equal(result.evidenceSource, "fresh-reverification");
  assert.deepEqual(result.missingExports, ["hobo:queue/queue@1.0.0@stable"]);
  assert.equal(result.yank.event.type, "listing.Yanked");
  assert.equal(result.canDeploy.ok, false);
  assert.equal(result.canDeploy.reason, "listing.yanked");
  assert.deepEqual(result.doctor.findings.map((finding) => finding.type), ["listing.yanked.pinned-set"]);
  assert.deepEqual(result.obligations.map((obligation) => obligation.type), ["policy.ObligationCreated"]);
});

test("compromised registry byte substitution for a known digest is caught at the consumer", async () => {
  const pinnedBytes = Buffer.from("provider shell v1\n");
  const pin = {
    name: "@acme/provider-shell",
    version: "1.0.0",
    digest: sha256Digest(pinnedBytes),
  };

  const result = await verifyPinnedRegistryFetch({
    pin,
    mirrors: [
      createFixtureMirror({
        mirrorId: "compromised-registry",
        listings: [{
          name: pin.name,
          version: pin.version,
          artifactBytes: pinnedBytes,
          fetchBytes: Buffer.from("provider shell v1 with substituted bytes\n"),
        }],
      }),
    ],
    selectedMirrorId: "compromised-registry",
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "artifact.fetch_digest_mismatch");
  assert.equal(result.consumerDigestCheck, "required");
  assert.match(result.reasons.join("\n"), /fetched sha256:/);
});

test("valid signatures document residual risk instead of proving benignity", async () => {
  const candidate = signedProviderListing();
  const listing = descriptorFor(candidate);

  const result = verifyRegistryInstallAgainstCompromise({
    listing,
    candidate,
    trustBoundary,
  });
  const readme = await readFile(path.join(packageRoot, "README.md"), "utf8");

  assert.equal(result.ok, true, result.reasons.join("\n"));
  assert.equal(result.assurance, "integrity-and-conformance-verified-not-benignity-proof");
  assert.ok(result.residualRisks.includes("validly-signed-but-malicious"));
  assert.ok(result.residualRisks.includes("forged-report-from-compromised-pipeline"));
  assert.match(readme, /validly-signed-but-malicious artifact/);
  assert.match(readme, /Offline revocation, anti-rollback, and transparency-inclusion/);
});

function signedProviderListing({
  coordinate = "oci://registry.example/hobo/provider-shell",
  version = "1.0.0",
  conformanceReport,
} = {}) {
  const artifact = createArtifactPayload({
    coordinate,
    version,
    mediaType: "application/vnd.hobo.provider.layer.v1+json",
    bytes: `provider-shell:${coordinate}:${version}`,
  });

  return publishSignedArtifact({
    artifact,
    signingKey: builderKey,
    conformanceReport: conformanceReport ?? {
      suiteId: "@hobo/conformance/registry-provider@1.0.0",
      passed: true,
      artifactDigest: artifact.digest,
      assertions: [
        "provider exports blobstore",
        "provider exports queue",
      ],
    },
    issuedAt: "2026-06-28T18:40:00.000Z",
    provenanceTier: "slsa-build-l3",
  });
}

function descriptorFor(candidate) {
  const conformanceRef = artifactRef({
    digest: candidate.conformance.digest,
    mediaType: "application/vnd.hobo.conformance.report.v1+json",
    name: "provider-shell-conformance",
  });

  return {
    schema: "registry.descriptor/v1",
    kind: "provider",
    name: "@acme/provider-shell",
    version: candidate.artifact.version,
    artifact: artifactRef({
      digest: candidate.artifact.digest,
      mediaType: candidate.artifact.mediaType,
      name: "provider-shell",
    }),
    publisher: {
      type: "organization",
      id: "acme",
      trustDomain: "spiffe://acme.example",
    },
    evidence: {
      slsaProvenanceRef: artifactRef({
        digest: digest(candidate.provenance),
        mediaType: "application/vnd.in-toto+json",
        name: "provider-shell-provenance",
      }),
      conformanceReportRefs: [
        {
          suite: "@hobo/conformance/registry-provider@1.0.0",
          suiteVersion: "1.0.0",
          ref: conformanceRef,
        },
      ],
    },
    interfaces: {
      exports: [
        {
          ref: "wasi:blobstore/blobstore@0.2.0@stable",
          conformanceSuite: "@hobo/conformance/registry-provider@1.0.0",
          conformanceSuiteVersion: "1.0.0",
          conformanceReportRef: conformanceRef,
        },
      ],
      imports: [],
    },
  };
}

function certifiedListing() {
  return {
    listingId: "listing-acme-provider-v1",
    status: "Certified",
    kind: "provider",
    name: "@acme/provider-shell",
    version: "1.0.0",
    artifact: {
      mediaType: "application/vnd.hobo.provider.layer.v1+json",
      uri: "oci://registry.example/hobo/provider-shell@sha256:1111111111111111111111111111111111111111111111111111111111111111",
      digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    },
    publisher: {
      type: "organization",
      id: "acme",
      trustDomain: "spiffe://acme.example",
    },
    certification: {
      status: "passed",
      reportRefs: ["oci://registry.example/reports/provider-shell@sha256:2222"],
    },
  };
}

function yardSecurityAdmin() {
  return {
    subject: "user:security-admin",
    roles: ["yard-security-policy-admin"],
  };
}

function artifactRef({ digest: refDigest, mediaType, name }) {
  return {
    mediaType,
    uri: `oci://registry.example/hobo/${name}@${refDigest}`,
    digest: refDigest,
  };
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
