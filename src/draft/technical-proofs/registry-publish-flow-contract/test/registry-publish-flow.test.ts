import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  createArtifactPayload,
  createFixtureSigningKey,
  createTrustBoundary,
  publishSignedArtifact
} from "../../signed-artifact-publish-install-contract/src/publish-install-contract.js";
import { createFixtureDescriptor } from "../../registry-artifact-descriptor-contract/src/registry-descriptor.js";
import {
  REGISTRY_PUBLISH_FLOW_CONTRACT,
  createRegistryPublishFlow
} from "../src/registry-publish-flow.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("publish with a passing conformance report certifies and indexes a listing", () => {
  const flow = createRegistryPublishFlow();
  const fixture = createPublishFixture();

  const result = flow.publish(fixture);

  assert.equal(result.ok, true, result.reasons.join("\n"));
  assert.equal(result.contract, REGISTRY_PUBLISH_FLOW_CONTRACT);
  assert.equal(result.status, "Certified");
  assert.deepEqual(flow.events().map((event) => event.type), [
    "listing.Published",
    "listing.Certified"
  ]);

  assert.equal(result.listing.signature.keyId, fixture.signingKey.keyId);
  assert.deepEqual(result.listing.provenanceRef, fixture.descriptor.evidence.slsaProvenanceRef);
  assert.deepEqual(result.listing.publisher, fixture.descriptor.publisher);
  assert.equal(result.listing.certification.status, "passed");
  assert.equal(
    flow.ociStore().resolve({ name: fixture.descriptor.name, version: fixture.descriptor.version }),
    result.listing.storageRef.digest
  );

  const catalog = flow.catalog();
  assert.deepEqual(catalog.certified().map((entry) => entry.listingId), [result.listing.listingId]);
  assert.equal(
    catalog.current({ name: fixture.descriptor.name, version: fixture.descriptor.version }).listingId,
    result.listing.listingId
  );
});

test("publish without a passing conformance report remains published but unlisted", () => {
  const flow = createRegistryPublishFlow();
  const fixture = createPublishFixture({
    conformanceReport: {
      status: "failed",
      stability: "stable"
    }
  });

  const result = flow.publish(fixture);

  assert.equal(result.ok, false);
  assert.equal(result.status, "Published");
  assert.match(result.reasons.join("\n"), /conformance\.report_failed/);
  assert.deepEqual(flow.events().map((event) => event.type), ["listing.Published"]);
  assert.equal(
    flow.ociStore().resolve({ name: fixture.descriptor.name, version: fixture.descriptor.version }),
    result.listing.storageRef.digest
  );
  assert.deepEqual(flow.catalog().certified(), []);
  assert.deepEqual(flow.catalog().publishedOnly().map((entry) => entry.listingId), [
    result.listing.listingId
  ]);
});

test("stable interface claims refuse an experimental-only conformance pass", () => {
  const flow = createRegistryPublishFlow();
  const fixture = createPublishFixture({
    conformanceReport: {
      status: "passed",
      stability: "experimental"
    }
  });

  const result = flow.publish(fixture);

  assert.equal(result.ok, false);
  assert.equal(result.status, "Published");
  assert.match(result.reasons.join("\n"), /conformance\.stability_mismatch/);
  assert.deepEqual(flow.catalog().certified(), []);
});

test("publisher identity must match the signed provenance builder identity", () => {
  const flow = createRegistryPublishFlow();
  const fixture = createPublishFixture({
    publisherTrustDomain: "spiffe://acme.example",
    builderTrustDomain: "spiffe://evil.example"
  });

  const result = flow.publish(fixture);

  assert.equal(result.ok, false);
  assert.equal(result.status, "Rejected");
  assert.match(result.reasons.join("\n"), /publisher\.identity_mismatch/);
  assert.deepEqual(flow.events(), []);
  assert.deepEqual(flow.catalog().certified(), []);
});

test("republishing an already-certified name and version appends immutable history", () => {
  const flow = createRegistryPublishFlow();
  const first = createPublishFixture({ artifactBytes: "provider component v1" });
  const second = createPublishFixture({ artifactBytes: "provider component v2" });

  const firstResult = flow.publish(first);
  const secondResult = flow.publish(second);

  assert.equal(firstResult.ok, true, firstResult.reasons.join("\n"));
  assert.equal(secondResult.ok, true, secondResult.reasons.join("\n"));
  assert.notEqual(secondResult.listing.listingId, firstResult.listing.listingId);
  assert.equal(secondResult.listing.previousListingId, firstResult.listing.listingId);

  const history = flow.catalog().history({
    name: first.descriptor.name,
    version: first.descriptor.version
  });
  assert.deepEqual(history.map((entry) => entry.listingId), [
    firstResult.listing.listingId,
    secondResult.listing.listingId
  ]);
  assert.deepEqual(
    flow.ociStore().entriesFor({ name: first.descriptor.name, version: first.descriptor.version }).map((entry) => entry.digest),
    [firstResult.listing.storageRef.digest, secondResult.listing.storageRef.digest]
  );
  assert.equal(
    flow.catalog().current({ name: first.descriptor.name, version: first.descriptor.version }).listingId,
    secondResult.listing.listingId
  );
  assert.equal(flow.catalog().get(firstResult.listing.listingId).artifact.digest, firstResult.listing.artifact.digest);
});

test("schema-free type declarations publish the registry publish-flow surface", async () => {
  const declarations = await readFile(
    path.join(packageRoot, "src", "registry-publish-flow.d.ts"),
    "utf8"
  );

  assert.match(declarations, /export interface RegistryPublishFlow/);
  assert.match(declarations, /listing\.Published/);
  assert.match(declarations, /listing\.Certified/);
});

function createPublishFixture({
  artifactBytes = "provider component bytes",
  publisherTrustDomain = "spiffe://acme.example",
  builderTrustDomain = publisherTrustDomain,
  conformanceReport = {
    status: "passed",
    stability: "stable"
  }
} = {}) {
  const descriptor = createFixtureDescriptor({ kind: "provider" });
  descriptor.name = "@acme/registry-provider";
  descriptor.version = "1.0.0";
  descriptor.publisher = {
    type: "organization",
    id: "acme",
    trustDomain: publisherTrustDomain
  };
  descriptor.interfaces.exports[0] = {
    ref: "hobo:provider/contract@1.0.0@stable",
    conformanceSuite: "@hobo/conformance/registry-listing",
    conformanceSuiteVersion: "1.0.0",
    conformanceReportRef: descriptor.evidence.conformanceReportRefs[0].ref
  };

  const signingKey = createFixtureSigningKey({
    keyId: "acme-registry-builder",
    builderId: `${builderTrustDomain}/builders/registry-publisher`
  });
  const artifact = createArtifactPayload({
    coordinate: "oci://registry.example/hobo/acme-registry-provider",
    version: descriptor.version,
    mediaType: "application/vnd.hobo.provider.layer.v1+json",
    bytes: artifactBytes
  });
  descriptor.artifact = {
    mediaType: artifact.mediaType,
    uri: artifact.uri,
    digest: artifact.digest
  };

  const signedArtifact = publishSignedArtifact({
    artifact,
    signingKey,
    conformanceReport: {
      suiteId: "@hobo/conformance/registry-listing",
      passed: true,
      assertions: ["descriptor-valid", "provider-contract"]
    },
    issuedAt: "2026-06-26T00:00:00.000Z",
    provenanceTier: "slsa-build-l3"
  });
  const trustBoundary = createTrustBoundary({
    trustedKeyIds: [signingKey.keyId],
    trustedBuilderIds: [signingKey.builderId],
    requiredConformanceSuites: ["@hobo/conformance/registry-listing"],
    allowedCoordinateScopes: ["oci://registry.example/hobo/"],
    minimumProvenanceTier: "slsa-build-l3"
  });

  return {
    descriptor,
    signedArtifact,
    trustBoundary,
    conformanceReports: [
      {
        suite: "@hobo/conformance/registry-listing",
        suiteVersion: "1.0.0",
        status: conformanceReport.status,
        stability: conformanceReport.stability,
        ref: descriptor.evidence.conformanceReportRefs[0].ref
      }
    ],
    occurredAt: "2026-06-26T00:00:00.000Z",
    signingKey
  };
}
