import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "vitest";

import {
  createArtifactPayload,
  createFixtureSigningKey,
  createTrustBoundary,
  publishSignedArtifact,
} from "../../signed-artifact-publish-install-contract/src/publish-install-contract.js";

import {
  createFederatedYard,
  createJunctionRegistryFederation,
} from "../src/junction-registry-federation.js";
import { isJsonObject } from "../src/json.js";


const builderKey = createFixtureSigningKey({
  keyId: "junction-builder-key",
  builderId: "spiffe://yard-a.example/builders/registry",
});

const trustBoundary = createTrustBoundary({
  trustedKeyIds: [builderKey.keyId],
  trustedBuilderIds: [builderKey.builderId],
  requiredConformanceSuites: ["@hobo/conformance/componentize@1.0.0"],
  allowedCoordinateScopes: ["oci://registry.example/hobo/"],
  minimumProvenanceTier: "slsa-build-l3",
});

const fixedNow = () => "2026-06-26T08:30:00.000Z";

test("shares a certified listing from one Yard to another through a signed bundle without shared registry state", () => {
  const source = createFederatedYard({ yardId: "yard-a", trustBoundary, now: fixedNow });
  const target = createFederatedYard({ yardId: "yard-b", trustBoundary, now: fixedNow });
  const listing = certifiedListing({ name: "@acme/provider-junction", kind: "provider" });
  const coordinate = { name: listing.descriptor.name, version: listing.descriptor.version };

  assert.equal(source.certifyListing(listing).ok, true);

  const federation = createJunctionRegistryFederation({ yards: [source, target], now: fixedNow });
  const result = federation.shareArtifact({
    sourceYardId: "yard-a",
    targetYardId: "yard-b",
    coordinate,
  });

  assert.equal(result.ok, true, result.reasons.join("\n"));
  assert.equal(result.event.type, "junction.ArtifactShared");
  assert.equal(result.event.sourceYardId, "yard-a");
  assert.equal(result.event.targetYardId, "yard-b");
  assert.deepEqual(result.event.coordinate, coordinate);
  assert.deepEqual(result.event.artifactDigests, [listing.candidate.artifact.digest]);

  const imported = target.discover(coordinate);
  assert.equal(imported.digest, listing.candidate.artifact.digest);
  assert.equal(imported.availableOffline, true);
  assert.equal(target.install(coordinate).digest, listing.candidate.artifact.digest);

  assert.deepEqual(source.registryLog().map((entry) => entry.action), [
    "listing.certified",
    "bundle.exported",
  ]);
  assert.deepEqual(target.registryLog().map((entry) => entry.action), ["bundle.imported"]);
  assert.equal(source.registryLog()[1].bundleDigest, result.event.bundleDigest);
  assert.equal(target.registryLog()[0].bundleDigest, result.event.bundleDigest);
  assert.notStrictEqual(source.registryLog(), target.registryLog());
});

test("refuses a peer bundle that does not satisfy the target Yard trust boundary", () => {
  const source = createFederatedYard({ yardId: "yard-a", trustBoundary, now: fixedNow });
  const target = createFederatedYard({
    yardId: "yard-b",
    trustBoundary: createTrustBoundary({
      trustedKeyIds: ["different-key"],
      trustedBuilderIds: [builderKey.builderId],
      requiredConformanceSuites: ["@hobo/conformance/componentize@1.0.0"],
      allowedCoordinateScopes: ["oci://registry.example/hobo/"],
      minimumProvenanceTier: "slsa-build-l3",
    }),
    now: fixedNow,
  });
  const listing = certifiedListing({ name: "@acme/provider-untrusted-at-b", kind: "provider" });
  const coordinate = { name: listing.descriptor.name, version: listing.descriptor.version };
  source.certifyListing(listing);

  const federation = createJunctionRegistryFederation({ yards: [source, target], now: fixedNow });
  const result = federation.shareArtifact({ sourceYardId: "yard-a", targetYardId: "yard-b", coordinate });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /signature\.key_untrusted/);
  assert.equal(target.discover(coordinate), null);
  assert.deepEqual(federation.events(), []);
  assert.equal(target.registryLog()[0].status, "refused");
});

test("applies source Yard yanks as target-local registry state instead of leaving the import silently live", () => {
  const source = createFederatedYard({ yardId: "yard-a", trustBoundary, now: fixedNow });
  const target = createFederatedYard({ yardId: "yard-b", trustBoundary, now: fixedNow });
  const listing = certifiedListing({ name: "@acme/provider-yanked", kind: "provider" });
  const coordinate = { name: listing.descriptor.name, version: listing.descriptor.version };
  source.certifyListing(listing);

  const federation = createJunctionRegistryFederation({ yards: [source, target], now: fixedNow });
  assert.equal(federation.shareArtifact({ sourceYardId: "yard-a", targetYardId: "yard-b", coordinate }).ok, true);

  assert.equal(source.yankListing(coordinate, { reason: "source signing key compromised" }).ok, true);
  const yank = federation.applyPeerYank({ sourceYardId: "yard-a", targetYardId: "yard-b", coordinate });

  assert.equal(yank.ok, true, yank.reasons.join("\n"));
  assert.equal(target.discover(coordinate), null);
  assert.deepEqual(target.getListingState(coordinate), {
    coordinate,
    status: "yanked",
    reason: "source signing key compromised",
    sourceYardId: "yard-a",
  });
  assert.throws(
    () => target.install(coordinate),
    /listing @acme\/provider-yanked@1\.0\.0 is locally yanked/,
  );
  assert.deepEqual(target.registryLog().map((entry) => entry.action), [
    "bundle.imported",
    "peer-yank.applied",
  ]);
});

function certifiedListing({ name, kind }) {
  const candidate = publishSignedArtifact({
    artifact: createArtifactPayload({
      coordinate: `oci://registry.example/hobo/${name.slice(name.lastIndexOf("/") + 1)}`,
      version: "1.0.0",
      mediaType: "application/vnd.hobo.registry.listing.layer.v1+json",
      bytes: `${name}-bytes`,
    }),
    signingKey: builderKey,
    conformanceReport: {
      suiteId: "@hobo/conformance/componentize@1.0.0",
      passed: true,
      assertions: ["signature", "provenance", "conformance"],
    },
    issuedAt: "2026-06-26T08:00:00.000Z",
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
      trustDomain: "spiffe://yard-a.example/builders",
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

function artifactRef(name, digestValue) {
  return {
    mediaType: "application/vnd.hobo.registry.descriptor.v1+json",
    uri: `oci://registry.example/hobo/${name}@${digestValue}`,
    digest: digestValue,
  };
}

function digest(value) {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
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
