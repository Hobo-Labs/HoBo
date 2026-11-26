import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  createArtifactPayload,
  createFixtureSigningKey,
  createTrustBoundary,
  publishSignedArtifact,
} from "../../signed-artifact-publish-install-contract/src/publish-install-contract.js";
import { canonicalJson as descriptorCanonicalJson } from "../../registry-artifact-descriptor-contract/src/registry-descriptor.js";
import { canonicalJson } from "../../signed-offline-bundle-contract/src/bundle-contract.js";

import {
  OFFLINE_IMPORT_INTEGRITY_CONTRACT,
  createOfflineIntegrityImporter,
} from "../src/offline-import-integrity.js";
import { isJsonObject } from "../src/json.js";


const builderKey = createFixtureSigningKey({
  keyId: "airgap-builder-key",
  builderId: "spiffe://yard.airgap/builders/registry",
});

const trustBoundary = createTrustBoundary({
  trustedKeyIds: [builderKey.keyId],
  trustedBuilderIds: [builderKey.builderId],
  requiredConformanceSuites: ["@hobo/conformance/componentize@1.0.0"],
  allowedCoordinateScopes: ["oci://registry.example/hobo/"],
  minimumProvenanceTier: "slsa-build-l3",
});

test("imports when offline revocation, anti-rollback, and transparency gates pass without egress", () => {
  const fixture = createImportFixture();
  const importer = createOfflineIntegrityImporter({ now: () => "2026-06-27T00:00:00.000Z" });
  let egressCalls = 0;

  const result = importer.importBundle({
    bundle: fixture.bundle,
    payloads: fixture.payloads,
    trustBoundary,
    offlineTrust: fixture.offlineTrust,
    installedState: {
      artifacts: [
        {
          name: "@acme/provider-airgap",
          version: "1.0.0",
          digest: fixture.candidates[0].artifact.digest,
          buildTimestamp: "2026-06-24T00:00:00.000Z",
        },
      ],
    },
    onEgressAttempt: () => {
      egressCalls += 1;
    },
  });

  assert.equal(result.ok, true, result.reasons.join("\n"));
  assert.equal(result.contract, OFFLINE_IMPORT_INTEGRITY_CONTRACT);
  assert.equal(egressCalls, 0);
  assert.equal(result.event.type, "registry.BundleImported");
  assert.equal(result.event.verification.revocation, "passed");
  assert.equal(result.event.verification.antiRollback, "passed");
  assert.equal(result.event.verification.transparency, "passed");
  assert.deepEqual(result.event.artifacts.map((artifact) => artifact.status), ["imported", "imported", "accepted"]);
  assert.equal(result.event.artifacts.find((artifact) => artifact.kind === "base-image").digest, fixture.bundle.contents.baseImages[0].artifact.digest);
  assert.equal(result.mirror.discover({ name: "@acme/provider-airgap", version: "1.0.0" }).availableOffline, true);
});

test("refuses a bundle signed by a key in the imported offline revocation list", () => {
  const fixture = createImportFixture({
    revokedKeyIds: [builderKey.keyId],
  });
  const importer = createOfflineIntegrityImporter({ now: () => "2026-06-27T00:00:00.000Z" });

  const result = importer.importBundle({
    bundle: fixture.bundle,
    payloads: fixture.payloads,
    trustBoundary,
    offlineTrust: fixture.offlineTrust,
  });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /revocation.revoked_key:airgap-builder-key/);
  assert.equal(result.mirror.discover({ name: "@acme/provider-airgap", version: "1.0.0" }), null);
  assert.equal(result.event.verification.revocation, "failed");
  assert.deepEqual(result.event.artifacts.map((artifact) => artifact.status), ["refused", "refused", "refused"]);
});

test("blocks an older bundle timestamp/version unless an explicit audited force-downgrade is supplied", () => {
  const fixture = createImportFixture();
  const installedState = {
    artifacts: [
      {
        name: "@acme/provider-airgap",
        version: "1.0.0",
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        buildTimestamp: "2026-06-28T00:00:00.000Z",
      },
    ],
  };

  const refused = createOfflineIntegrityImporter({ now: () => "2026-06-29T00:00:00.000Z" }).importBundle({
    bundle: fixture.bundle,
    payloads: fixture.payloads,
    trustBoundary,
    offlineTrust: fixture.offlineTrust,
    installedState,
  });

  assert.equal(refused.ok, false);
  assert.match(refused.reasons.join("\n"), /antiRollback.older_than_installed:@acme\/provider-airgap@1.0.0/);
  assert.match(refused.reasons.join("\n"), /buildTimestamp/);
  assert.equal(refused.event.verification.antiRollback, "failed");

  const versionRefused = createOfflineIntegrityImporter({ now: () => "2026-06-29T00:00:00.000Z" }).importBundle({
    bundle: fixture.bundle,
    payloads: fixture.payloads,
    trustBoundary,
    offlineTrust: fixture.offlineTrust,
    installedState: {
      artifacts: [
        {
          name: "@acme/provider-airgap",
          version: "2.0.0",
          digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          buildTimestamp: "2026-06-25T00:00:00.000Z",
        },
      ],
    },
  });

  assert.equal(versionRefused.ok, false);
  assert.match(versionRefused.reasons.join("\n"), /antiRollback.older_than_installed:@acme\/provider-airgap@1.0.0:version/);
  assert.equal(versionRefused.event.verification.antiRollback, "failed");

  const forced = createOfflineIntegrityImporter({ now: () => "2026-06-29T00:00:00.000Z" }).importBundle({
    bundle: fixture.bundle,
    payloads: fixture.payloads,
    trustBoundary,
    offlineTrust: fixture.offlineTrust,
    installedState,
    forceDowngrade: {
      approvedBy: "operator:secops",
      reason: "rollback to last certified air-gap bundle",
      ticket: "INC-397",
    },
  });

  assert.equal(forced.ok, true, forced.reasons.join("\n"));
  assert.equal(forced.event.verification.antiRollback, "passed-with-force-downgrade");
  assert.deepEqual(forced.event.forceDowngrade, {
    approvedBy: "operator:secops",
    reason: "rollback to last certified air-gap bundle",
    ticket: "INC-397",
  });
});

test("refuses missing or bad transparency inclusion proofs against the pinned root", () => {
  const fixture = createImportFixture({
    transparencyProofOverrides: {
      omitFirst: true,
      corruptSecondRoot: true,
    },
  });
  const importer = createOfflineIntegrityImporter({ now: () => "2026-06-27T00:00:00.000Z" });
  let egressCalls = 0;

  const result = importer.importBundle({
    bundle: fixture.bundle,
    payloads: fixture.payloads,
    trustBoundary,
    offlineTrust: fixture.offlineTrust,
    onEgressAttempt: () => {
      egressCalls += 1;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(egressCalls, 0);
  assert.match(result.reasons.join("\n"), /transparency.inclusion_proof_missing/);
  assert.match(result.reasons.join("\n"), /transparency.root_mismatch/);
  assert.equal(result.event.verification.transparency, "failed");
});

test("fails closed on missing offline trust material without live repair egress", () => {
  const fixture = createImportFixture({
    transparencyProofOverrides: {
      omitFirst: true,
    },
  });
  const importer = createOfflineIntegrityImporter({ now: () => "2026-06-27T00:00:00.000Z" });
  let egressCalls = 0;

  const result = importer.importBundle({
    bundle: fixture.bundle,
    payloads: fixture.payloads,
    trustBoundary,
    offlineTrust: {
      transparencyProofs: fixture.offlineTrust.transparencyProofs,
    },
    onEgressAttempt: () => {
      egressCalls += 1;
    },
  });

  assert.equal(result.ok, false);
  assert.equal(egressCalls, 0);
  assert.match(result.reasons.join("\n"), /revocation.missing/);
  assert.match(result.reasons.join("\n"), /transparency.inclusion_proof_missing/);
  assert.equal(result.event.verification.revocation, "failed");
});

test("applies transparency and anti-rollback gates to base images", () => {
  const missingProofFixture = createImportFixture({
    transparencyProofOverrides: {
      omitBaseImage: true,
    },
  });
  const missingProof = createOfflineIntegrityImporter({ now: () => "2026-06-27T00:00:00.000Z" }).importBundle({
    bundle: missingProofFixture.bundle,
    payloads: missingProofFixture.payloads,
    trustBoundary,
    offlineTrust: missingProofFixture.offlineTrust,
  });

  assert.equal(missingProof.ok, false);
  assert.match(missingProof.reasons.join("\n"), /artifact wasmcloud-host@unversioned refused: transparency.inclusion_proof_missing/);
  assert.equal(missingProof.event.artifacts.find((artifact) => artifact.name === "wasmcloud-host").status, "refused");
  assert.deepEqual(missingProof.mirror.entries(), []);

  const rollbackFixture = createImportFixture();
  const rollback = createOfflineIntegrityImporter({ now: () => "2026-06-27T00:00:00.000Z" }).importBundle({
    bundle: rollbackFixture.bundle,
    payloads: rollbackFixture.payloads,
    trustBoundary,
    offlineTrust: rollbackFixture.offlineTrust,
    installedState: {
      artifacts: [
        {
          name: "wasmcloud-host",
          digest: rollbackFixture.bundle.contents.baseImages[0].artifact.digest,
          buildTimestamp: "2026-06-28T00:00:00.000Z",
        },
      ],
    },
  });

  assert.equal(rollback.ok, false);
  assert.match(rollback.reasons.join("\n"), /antiRollback.older_than_installed:wasmcloud-host@unversioned:buildTimestamp/);
  assert.equal(rollback.event.verification.antiRollback, "failed");
});

test("offline importer source exposes no network egress sinks", () => {
  const source = readFileSync(new URL("../src/offline-import-integrity.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /from\s+["']node:(?:http|https|net|dns)["']/);
  assert.doesNotMatch(source, /from\s+["'](?:http|https|net|dns)["']/);
});

function createImportFixture({
  revokedKeyIds = [],
  transparencyProofOverrides = {},
} = {}) {
  const provider = signedListing({
    name: "@acme/provider-airgap",
    coordinate: "oci://registry.example/hobo/provider-airgap",
    bytes: "provider-airgap-wasm",
    kind: "provider",
  });
  const pack = signedListing({
    name: "@acme/postgres-pack",
    coordinate: "oci://registry.example/hobo/postgres-pack",
    bytes: "postgres-pack-resource-definitions",
    kind: "resource-pack",
  });
  const baseImage = signedBaseImage();
  const descriptors = [provider.descriptor, pack.descriptor];
  const candidates = [provider.candidate, pack.candidate];
  const bundle = bundleFor({ descriptors, baseImageCandidate: baseImage.candidate });
  const payloads = new Map(descriptors.map((descriptor, index) => [
    descriptorDigest(descriptor),
    {
      descriptor,
      candidate: candidates[index],
    },
  ]));
  payloads.set(bundle.contents.baseImages[0].artifact.digest, {
    candidate: baseImage.candidate,
  });
  const transparencyEntries = [
    ...bundle.contents.listings.map((listing) => ({
      artifactDigest: listing.descriptor.digest,
      proof: listing.transparency,
    })),
    ...bundle.contents.baseImages.map((image) => ({
      artifactDigest: image.artifact.digest,
      proof: image.transparency,
    })),
  ];
  const transparencyProofs = new Map(transparencyEntries.map((entry, index) => {
    const proof = {
      artifactDigest: entry.artifactDigest,
      logId: entry.proof.logId,
      logRoot: entry.proof.logRoot,
      verified: true,
    };
    if (index === 1 && transparencyProofOverrides.corruptSecondRoot) {
      proof.logRoot = digest("wrong-rekor-root");
    }
    return [entry.proof.inclusionProof.digest, proof];
  }));
  if (transparencyProofOverrides.omitFirst) {
    transparencyProofs.delete(bundle.contents.listings[0].transparency.inclusionProof.digest);
  }
  if (transparencyProofOverrides.omitBaseImage) {
    transparencyProofs.delete(bundle.contents.baseImages[0].transparency.inclusionProof.digest);
  }

  const offlineTrust = {
    revocationList: {
      refDigest: bundle.trust.revocationList.ref.digest,
      signedBy: bundle.trust.revocationList.signingKeyId,
      signatureVerified: true,
      issuedAt: bundle.trust.revocationList.issuedAt,
      expiresAt: bundle.trust.revocationList.expiresAt,
      revokedKeyIds,
    },
    transparencyProofs,
  };

  return { bundle, payloads, candidates, offlineTrust };
}

function signedListing({ name, coordinate, bytes, kind }) {
  const candidate = publishSignedArtifact({
    artifact: createArtifactPayload({
      coordinate,
      version: "1.0.0",
      mediaType: "application/vnd.hobo.registry.listing.layer.v1+json",
      bytes,
    }),
    signingKey: builderKey,
    conformanceReport: {
      suiteId: "@hobo/conformance/componentize@1.0.0",
      passed: true,
      assertions: ["signature", "provenance", "conformance"],
    },
    issuedAt: "2026-06-25T20:00:00.000Z",
    provenanceTier: "slsa-build-l3",
  });
  const conformanceRef = artifactRef("conformance", candidate.conformance.digest);
  const descriptor = {
    schema: "registry.descriptor/v1",
    kind,
    name,
    version: candidate.artifact.version,
    artifact: {
      mediaType: candidate.artifact.mediaType,
      uri: candidate.artifact.uri,
      digest: candidate.artifact.digest,
    },
    publisher: {
      type: "organization",
      id: "acme",
      trustDomain: "spiffe://yard.airgap/builders",
    },
    evidence: {
      slsaProvenanceRef: artifactRef("provenance", digest(candidate.provenance)),
      conformanceReportRefs: [
        {
          suite: "@hobo/conformance/componentize@1.0.0",
          suiteVersion: "1.0.0",
          ref: conformanceRef,
        },
      ],
    },
    interfaces: {
      exports: [
        {
          ref: "hobo:provider/contract@1.0.0@stable",
          conformanceSuite: "@hobo/conformance/componentize@1.0.0",
          conformanceSuiteVersion: "1.0.0",
          conformanceReportRef: conformanceRef,
        },
      ],
      imports: [],
    },
  };

  return { descriptor, candidate };
}

function signedBaseImage() {
  const candidate = publishSignedArtifact({
    artifact: createArtifactPayload({
      coordinate: "oci://registry.example/hobo/base/wasmcloud-host",
      version: "1.0.0",
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      bytes: "wasmcloud-host-image",
    }),
    signingKey: builderKey,
    conformanceReport: {
      suiteId: "@hobo/conformance/componentize@1.0.0",
      passed: true,
      assertions: ["signature", "provenance", "conformance"],
    },
    issuedAt: "2026-06-25T20:00:00.000Z",
    provenanceTier: "slsa-build-l3",
  });

  return { candidate };
}

function bundleFor({ descriptors, baseImageCandidate }) {
  const logRoot = digest("rekor-root-2026-06-25");
  const bundle = {
    schema: "registry.bundle/v1",
    bundleId: "bundle.airgap.acme.hobo-397",
    version: "1.0.0",
    createdAt: "2026-06-25T07:55:00.000Z",
    curator: {
      id: "acme-platform",
      trustDomain: "spiffe://acme.example",
    },
    contents: {
      listings: descriptors.map((descriptor, index) => ({
        kind: descriptor.kind,
        name: descriptor.name,
        version: descriptor.version,
        descriptor: artifactRef("descriptor", descriptorDigest(descriptor)),
        buildTimestamp: "2026-06-25T00:00:00.000Z",
        provenance: descriptor.evidence.slsaProvenanceRef,
        conformanceReports: descriptor.evidence.conformanceReportRefs.map((report) => report.ref),
        transparency: transparencyProof(logRoot, `inclusion-proof-${index}`),
      })),
      baseImages: [
        {
          name: "wasmcloud-host",
          artifact: artifactRef("base-image", baseImageCandidate.artifact.digest, "application/vnd.oci.image.manifest.v1+json"),
          buildTimestamp: "2026-06-25T00:00:00.000Z",
          provenance: artifactRef("base-provenance", digest("base-provenance")),
          transparency: transparencyProof(logRoot, "inclusion-proof-base-image"),
        },
      ],
    },
    trust: {
      revocationList: {
        issuedAt: "2026-06-24T00:00:00.000Z",
        expiresAt: "2026-07-24T00:00:00.000Z",
        signingKeyId: "fulcio-root-2026",
        ref: artifactRef("revocation", digest("revocation")),
      },
      transparencyLog: {
        logId: "rekor-prod",
        pinnedRoot: logRoot,
      },
      antiRollback: {
        yardId: "yard.airgap.acme",
        stateEpoch: "2026-06-25T00:00:00.000Z",
      },
    },
  };
  bundle.bundleDigest = bundleDigest(bundle);
  return bundle;
}

function transparencyProof(logRoot, proofSeed) {
  return {
    logId: "rekor-prod",
    logRoot,
    inclusionProof: artifactRef(proofSeed, digest(proofSeed)),
  };
}

function artifactRef(name, digestValue, mediaType = "application/vnd.hobo.registry.descriptor.v1+json") {
  return {
    mediaType,
    uri: `oci://registry.example/hobo/${name}@${digestValue}`,
    digest: digestValue,
  };
}

function digest(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function descriptorDigest(value) {
  return `sha256:${createHash("sha256").update(descriptorCanonicalJson(value)).digest("hex")}`;
}

function bundleDigest(value) {
  const { bundleDigest: _ignored, ...content } = value;
  return `sha256:${createHash("sha256").update(canonicalJson(content)).digest("hex")}`;
}

function stableStringify(value) {
  if (value === null || !isJsonObject(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}
