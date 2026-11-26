import { isJsonObject } from "../src/json.js";
import { createHash } from "node:crypto";

import {
  createFixtureCertifiedListing as createDiscoveryListing,
  createCapabilityDiscoveryIndex,
} from "../../../technical-proofs/capability-indexed-discovery-contract/src/capability-indexed-discovery.js";
import {
  createCuratedCatalog,
  createFixtureBindle,
  createFixtureCertifiedListing as createCatalogListing,
  createPreApprovedOnlyProdPolicy,
  evaluateCatalogSelection,
} from "../../../technical-proofs/curated-catalog-policy-contract/src/curated-catalog-policy.js";
import { resolveDistributedArtifacts } from "../../../technical-proofs/distributed-artifact-resolver-contract/src/distributed-artifact-resolver.js";
import {
  createHoboAddCatalog,
  hoboAdd,
} from "../../../technical-proofs/hobo-add-install-verification-contract/src/hobo-add-install-verification.js";
import {
  createListingLifecycle,
} from "../../../technical-proofs/listing-lifecycle-yank-contract/src/listing-lifecycle-yank.js";
import {
  createFixtureMirror as createDigestMirror,
  selectDigestPinnedMirror,
  sha256Digest as digestMirrorBytes,
} from "../../../technical-proofs/mirror-digest-selection-contract/src/mirror-digest-selection.js";
import {
  createOfflineIntegrityImporter,
} from "../../../technical-proofs/offline-import-integrity-contract/src/offline-import-integrity.js";
import {
  createFixtureMirror as createRegistryMirror,
  resolvePinnedRegistryArtifact,
  sha256Digest as digestRegistryBytes,
} from "../../../technical-proofs/registry-dependency-confusion-guard-contract/src/registry-dependency-confusion-guard.js";
import { canonicalJson as descriptorCanonicalJson } from "../../../technical-proofs/registry-artifact-descriptor-contract/src/registry-descriptor.js";
import {
  canonicalJson as bundleCanonicalJson,
} from "../../../technical-proofs/signed-offline-bundle-contract/src/bundle-contract.js";
import {
  createArtifactPayload,
  createFixtureSigningKey,
  createTrustBoundary,
  publishSignedArtifact,
} from "../../../technical-proofs/signed-artifact-publish-install-contract/src/publish-install-contract.js";
import {
  createTrustPolicyProfile,
  evaluateTrustTierPolicy,
} from "../../../technical-proofs/trust-tier-policy-contract/src/trust-tier-policy.js";

const EPIC = Object.freeze({
  id: "fd338892-6949-42ea-aca4-e1e71e3c3b05",
  title: "Portability, Registry & Distribution",
  slug: "portability-registry-distribution",
});

const NOW = "2026-06-29T01:34:22.000Z";
const CONFORMANCE_SUITE = "@hobo/conformance/componentize@1.0.0";

export async function runPortabilityRegistrySimulation() {
  const signedPack = signedListing({
    name: "@hobo/aws-defaults",
    coordinate: "oci://registry.example/hobo/resource-packs/aws-defaults",
    bytes: "aws-defaults-resource-pack-v1",
    kind: "resource-pack",
    publisherTrustDomain: "spiffe://acme.example",
  });
  const trustBoundary = createInstallTrustBoundary(signedPack.signingKey);
  const install = runInstallSlice({ signedPack, trustBoundary });
  const catalog = runCatalogSlice({ signedPack });
  const trust = runTrustSlice();
  const discovery = runDiscoverySlice({ signedPack });
  const resolution = resolveDistributedArtifacts({
    mode: "install",
    requests: [{ name: "@hobo/aws-defaults", range: "^1.0.0" }],
    catalog: [{
      name: "@hobo/aws-defaults",
      version: signedPack.candidate.artifact.version,
      tier: "stable",
      digest: signedPack.candidate.artifact.digest,
      dependencies: [],
    }],
    now: NOW,
  });
  const mirrorSelection = await runMirrorSelection({ signedPack });
  const dependencyConfusion = await runDependencyConfusionGuard();
  const yankSlice = runYankSlice({ signedPack });
  const offline = runOfflineImportSlice();

  return {
    epic: EPIC,
    install,
    catalog,
    trust,
    discovery,
    resolution,
    mirrorSelection,
    dependencyConfusion,
    ...yankSlice,
    ...offline,
    contracts: {
      covered: [
        "ArtifactRepositoryMirror",
        "CapabilityDiscoveryIndex",
        "OfflineBundleImporter",
        "RegistryTrustPolicyGate",
      ],
      missing: [],
    },
  };
}

function runInstallSlice({ signedPack, trustBoundary }) {
  const catalog = createHoboAddCatalog();
  const result = hoboAdd({
    catalog,
    listing: signedPack.descriptor,
    candidate: signedPack.candidate,
    trustBoundary,
  });

  return {
    ...result,
    availableToMatching: result.entry?.availableToMatching ?? false,
    selectedByMatching: result.entry?.selectedByMatching ?? false,
  };
}

function runCatalogSlice({ signedPack }) {
  const policy = createPreApprovedOnlyProdPolicy({
    id: "policy:prod/catalog-only",
    catalogId: "catalog:hosted/default",
  });
  const listing = createCatalogListing({
    listingId: "listing-aws-resource-pack",
    name: signedPack.descriptor.name,
    version: signedPack.descriptor.version,
    digest: signedPack.candidate.artifact.digest,
    kind: "resource-pack",
  });
  const hostedCatalog = createCuratedCatalog({
    id: "catalog:hosted/default",
    tier: "slsa-build-l3",
    policyPin: policy.pin,
    listings: [listing],
  });

  return evaluateCatalogSelection({
    catalog: hostedCatalog,
    policy,
    environment: "prod",
    bindle: createFixtureBindle({ listingId: listing.listingId }),
    requestedListing: listing,
  });
}

function runTrustSlice() {
  const profile = createTrustPolicyProfile({ profile: "prod" });

  return evaluateTrustTierPolicy({
    listing: {
      id: "listing:aws-defaults",
      version: "1.0.0",
      kind: "resource-pack",
      status: "Certified",
      provenance: { slsaLevel: 3, source: "github-actions", verified: true },
      publisher: { id: "publisher:acme", verified: true },
      ratings: { score: 4.8, sampleSize: 24 },
    },
    policy: profile.policies[0],
  });
}

function runDiscoverySlice({ signedPack }) {
  const index = createCapabilityDiscoveryIndex();
  index.apply({
    type: "listing.Certified",
    occurredAt: NOW,
    listingId: "listing-aws-resource-pack",
    descriptor: createDiscoveryListing({
      listingId: "listing-aws-resource-pack",
      name: signedPack.descriptor.name,
      version: signedPack.descriptor.version,
      kind: "resource-pack",
      providerId: "acme-aws-defaults",
      matching: { regions: ["us-east-1"], classifications: ["public"] },
      interfaces: [{
        interface: "wasi:blobstore/blobstore",
        semver: "1.0.0",
        stability: "stable",
      }],
    }),
    certification: {
      status: "passed",
      reportRef: "oci://registry.example/reports/aws-defaults@sha256:1111",
    },
  });

  return index.find({
    port: "wasi:blobstore/blobstore@1.0.0",
    criteria: { region: "us-east-1", classification: "public" },
  });
}

async function runMirrorSelection({ signedPack }) {
  const artifactBytes = Buffer.from("aws-defaults-resource-pack-v1\n");
  const resolvedDigest = digestMirrorBytes(artifactBytes);
  const result = await selectDigestPinnedMirror({
    coordinate: {
      name: signedPack.descriptor.name,
      version: signedPack.descriptor.version,
    },
    resolvedDigest,
    mirrors: [
      createDigestMirror({ mirrorId: "mirror-cheap", artifactBytes, costMicros: 10, latencyMs: 40 }),
      createDigestMirror({ mirrorId: "mirror-fast", artifactBytes, costMicros: 20, latencyMs: 5 }),
    ],
  });

  return {
    ...result,
    costEligibleMirrorIds: result.costEligibleMirrorIds ?? [],
  };
}

async function runDependencyConfusionGuard() {
  const pin = {
    name: "@hobo/aws-defaults",
    version: "1.0.0",
    digest: digestRegistryBytes(Buffer.from("signed aws defaults resource pack\n")),
  };

  return resolvePinnedRegistryArtifact({
    pin,
    mirrors: [
      createRegistryMirror({
        mirrorId: "public-registry",
        costMicros: 1,
        listings: [
          { name: "hobo-aws-defaults", version: "1.0.0", artifactBytes: Buffer.from("typosquat\n") },
          { name: "@evil/aws-defaults", version: "1.0.0", artifactBytes: Buffer.from("namespace-shadow\n") },
          { name: "@hobo/aws-defaults", version: "9.0.0", artifactBytes: Buffer.from("version-shadow\n") },
        ],
      }),
    ],
  });
}

function runYankSlice({ signedPack }) {
  const lifecycle = createListingLifecycle();
  lifecycle.certify({
    listingId: "listing-aws-resource-pack",
    status: "Certified",
    kind: "resource-pack",
    name: signedPack.descriptor.name,
    version: signedPack.descriptor.version,
    artifact: signedPack.descriptor.artifact,
    publisher: {
      type: "organization",
      id: "acme",
      trustDomain: "spiffe://acme.example",
    },
    certification: {
      status: "passed",
      reportRefs: ["oci://registry.example/reports/aws-defaults@sha256:2222"],
    },
  });
  lifecycle.registerRunningSet({
    setId: "set-prod-checkout",
    status: "Running",
    pinnedListings: [{ listingId: "listing-aws-resource-pack", role: "resource-pack" }],
    deploymentRevision: "deploy-17",
  });
  const yank = lifecycle.yank({
    listingId: "listing-aws-resource-pack",
    actor: {
      subject: "publisher:acme",
      trustDomain: "spiffe://acme.example",
      roles: ["publisher"],
    },
    reason: "capability spec regression",
    severity: "critical",
    occurredAt: NOW,
  });

  return {
    yank,
    yankedCanDeploy: lifecycle.canDeploy({
      selection: { listingId: "listing-aws-resource-pack" },
      operation: "new-deploy",
    }),
    yankDoctor: lifecycle.doctor(),
    yankObligations: lifecycle.obligations(),
  };
}

function runOfflineImportSlice() {
  const fixture = createImportFixture();
  const importer = createOfflineIntegrityImporter({ now: () => "2026-06-27T00:00:00.000Z" });
  let egressAttempts = 0;
  const importResult = importer.importBundle({
    bundle: fixture.bundle,
    payloads: fixture.payloads,
    trustBoundary: fixture.trustBoundary,
    offlineTrust: fixture.offlineTrust,
    installedState: {
      artifacts: [{
        name: "@acme/provider-airgap",
        version: "1.0.0",
        digest: fixture.candidates[0].artifact.digest,
        buildTimestamp: "2026-06-24T00:00:00.000Z",
      }],
    },
    onEgressAttempt: () => {
      egressAttempts += 1;
    },
  });

  const refusalFixture = createImportFixture({
    revokedKeyIds: [fixture.signingKey.keyId],
    transparencyProofOverrides: { corruptSecondRoot: true },
  });
  const offlineRefusal = createOfflineIntegrityImporter({ now: () => "2026-06-29T00:00:00.000Z" }).importBundle({
    bundle: refusalFixture.bundle,
    payloads: refusalFixture.payloads,
    trustBoundary: refusalFixture.trustBoundary,
    offlineTrust: refusalFixture.offlineTrust,
    installedState: {
      artifacts: [{
        name: "@acme/provider-airgap",
        version: "2.0.0",
        digest: digest("installed-newer"),
        buildTimestamp: "2026-06-28T00:00:00.000Z",
      }],
    },
  });

  return {
    offlineImport: {
      ...importResult,
      egressAttempts,
    },
    offlineRefusal,
  };
}

function signedListing({
  name,
  coordinate,
  bytes,
  kind,
  publisherTrustDomain,
}) {
  const signingKey = createFixtureSigningKey({
    keyId: "key:hosted-hobo-builder",
    builderId: "spiffe://yard/builders/hobo-componentize",
  });
  const candidate = publishSignedArtifact({
    artifact: createArtifactPayload({
      coordinate,
      version: "1.0.0",
      mediaType: "application/vnd.hobo.registry.listing.layer.v1+json",
      bytes,
    }),
    signingKey,
    conformanceReport: {
      suiteId: CONFORMANCE_SUITE,
      passed: true,
      assertions: ["signature", "provenance", "conformance"],
    },
    issuedAt: "2026-06-25T20:00:00.000Z",
    provenanceTier: "slsa-build-l3",
  });
  const conformanceRef = artifactRef("conformance", candidate.conformance.digest);

  return {
    candidate,
    signingKey,
    descriptor: {
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
        trustDomain: publisherTrustDomain,
      },
      evidence: {
        slsaProvenanceRef: artifactRef("provenance", digest(candidate.provenance)),
        conformanceReportRefs: [{
          suite: CONFORMANCE_SUITE,
          suiteVersion: "1.0.0",
          ref: conformanceRef,
        }],
      },
      interfaces: {
        exports: [{
          ref: "hobo:resource-pack/contract@1.0.0@stable",
          conformanceSuite: CONFORMANCE_SUITE,
          conformanceSuiteVersion: "1.0.0",
          conformanceReportRef: conformanceRef,
        }],
        imports: [],
      },
    },
  };
}

function createInstallTrustBoundary(signingKey) {
  return createTrustBoundary({
    trustedKeyIds: [signingKey.keyId],
    trustedBuilderIds: [signingKey.builderId],
    requiredConformanceSuites: [CONFORMANCE_SUITE],
    allowedCoordinateScopes: ["oci://registry.example/hobo/"],
    minimumProvenanceTier: "slsa-build-l3",
  });
}

function createImportFixture({
  revokedKeyIds = [],
  transparencyProofOverrides = {},
} = {}) {
  const signingKey = createFixtureSigningKey({
    keyId: "airgap-builder-key",
    builderId: "spiffe://yard.airgap/builders/registry",
  });
  const trustBoundary = createTrustBoundary({
    trustedKeyIds: [signingKey.keyId],
    trustedBuilderIds: [signingKey.builderId],
    requiredConformanceSuites: [CONFORMANCE_SUITE],
    allowedCoordinateScopes: ["oci://registry.example/hobo/"],
    minimumProvenanceTier: "slsa-build-l3",
  });
  const provider = signedImportListing({
    name: "@acme/provider-airgap",
    coordinate: "oci://registry.example/hobo/provider-airgap",
    bytes: "provider-airgap-wasm",
    kind: "provider",
    signingKey,
  });
  const pack = signedImportListing({
    name: "@acme/postgres-pack",
    coordinate: "oci://registry.example/hobo/postgres-pack",
    bytes: "postgres-pack-resource-definitions",
    kind: "resource-pack",
    signingKey,
  });
  const baseImage = signedBaseImage({ signingKey });
  const descriptors = [provider.descriptor, pack.descriptor];
  const candidates = [provider.candidate, pack.candidate];
  const bundle = bundleFor({ descriptors, baseImageCandidate: baseImage.candidate });
  const payloads = new Map(descriptors.map((descriptor, index) => [
    descriptorDigest(descriptor),
    { descriptor, candidate: candidates[index] },
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

  return {
    bundle,
    payloads,
    candidates,
    offlineTrust: {
      revocationList: {
        refDigest: bundle.trust.revocationList.ref.digest,
        signedBy: bundle.trust.revocationList.signingKeyId,
        signatureVerified: true,
        issuedAt: bundle.trust.revocationList.issuedAt,
        expiresAt: bundle.trust.revocationList.expiresAt,
        revokedKeyIds,
      },
      transparencyProofs,
    },
    signingKey,
    trustBoundary,
  };
}

function signedImportListing({ name, coordinate, bytes, kind, signingKey }) {
  const candidate = publishSignedArtifact({
    artifact: createArtifactPayload({
      coordinate,
      version: "1.0.0",
      mediaType: "application/vnd.hobo.registry.listing.layer.v1+json",
      bytes,
    }),
    signingKey,
    conformanceReport: {
      suiteId: CONFORMANCE_SUITE,
      passed: true,
      assertions: ["signature", "provenance", "conformance"],
    },
    issuedAt: "2026-06-25T20:00:00.000Z",
    provenanceTier: "slsa-build-l3",
  });
  const conformanceRef = artifactRef("conformance", candidate.conformance.digest);

  return {
    candidate,
    descriptor: {
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
        conformanceReportRefs: [{
          suite: CONFORMANCE_SUITE,
          suiteVersion: "1.0.0",
          ref: conformanceRef,
        }],
      },
      interfaces: {
        exports: [{
          ref: "hobo:provider/contract@1.0.0@stable",
          conformanceSuite: CONFORMANCE_SUITE,
          conformanceSuiteVersion: "1.0.0",
          conformanceReportRef: conformanceRef,
        }],
        imports: [],
      },
    },
  };
}

function signedBaseImage({ signingKey }) {
  return {
    candidate: publishSignedArtifact({
      artifact: createArtifactPayload({
        coordinate: "oci://registry.example/hobo/base/wasmcloud-host",
        version: "1.0.0",
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        bytes: "wasmcloud-host-image",
      }),
      signingKey,
      conformanceReport: {
        suiteId: CONFORMANCE_SUITE,
        passed: true,
        assertions: ["signature", "provenance", "conformance"],
      },
      issuedAt: "2026-06-25T20:00:00.000Z",
      provenanceTier: "slsa-build-l3",
    }),
  };
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
      baseImages: [{
        name: "wasmcloud-host",
        artifact: artifactRef("base-image", baseImageCandidate.artifact.digest, "application/vnd.oci.image.manifest.v1+json"),
        buildTimestamp: "2026-06-25T00:00:00.000Z",
        provenance: artifactRef("base-provenance", digest("base-provenance")),
        transparency: transparencyProof(logRoot, "inclusion-proof-base-image"),
      }],
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

function descriptorDigest(value) {
  return `sha256:${createHash("sha256").update(descriptorCanonicalJson(value)).digest("hex")}`;
}

function bundleDigest(value) {
  const { bundleDigest: _ignored, ...content } = value;
  return `sha256:${createHash("sha256").update(bundleCanonicalJson(content)).digest("hex")}`;
}

function digest(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value === null || !isJsonObject(value)) {
    return JSON.stringify(value);
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}
