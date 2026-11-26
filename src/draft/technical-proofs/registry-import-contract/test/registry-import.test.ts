import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  createInBoundaryRegistryMirror,
  createRegistryImporter,
} from "../src/registry-import.js";
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

test("imports a signed offline bundle into an in-boundary mirror with no egress", () => {
  const fixture = createImportFixture();
  const mirror = createInBoundaryRegistryMirror();
  const importer = createRegistryImporter({ mirror, now: () => "2026-06-26T01:30:00.000Z" });
  let egressCalls = 0;

  const result = importer.importBundle({
    bundle: fixture.bundle,
    payloads: fixture.payloads,
    trustBoundary,
    onEgressAttempt: () => {
      egressCalls += 1;
    },
  });

  assert.equal(result.ok, true, result.reasons.join("\n"));
  assert.equal(egressCalls, 0);
  assert.deepEqual(result.artifacts.map((entry) => entry.status), ["imported", "imported"]);

  const provider = mirror.discover({ name: "@acme/provider-airgap", version: "1.0.0" });
  assert.equal(provider.digest, fixture.candidates[0].artifact.digest);
  assert.equal(provider.availableOffline, true);
  assert.equal(mirror.install({ name: "@acme/provider-airgap", version: "1.0.0" }).digest, provider.digest);
  assert.equal(mirror.serve(provider.digest).artifact.uri, fixture.candidates[0].artifact.uri);

  const events = mirror.events();
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "registry.BundleImported");
  assert.equal(events[0].bundleDigest, fixture.bundle.bundleDigest);
  assert.deepEqual(events[0].artifacts.map((artifact) => artifact.status), ["imported", "imported"]);
  assert.equal(events[0].deferredAirGapGates.includes("revocation"), true);
  assert.equal(events[0].deferredAirGapGates.includes("antiRollback"), true);
  assert.equal(events[0].deferredAirGapGates.includes("transparency"), true);
});

test("refuses failed listing verification without loading that artifact", () => {
  const fixture = createImportFixture();
  const brokenPayloads = new Map(fixture.payloads);
  const brokenDigest = fixture.bundle.contents.listings[1].descriptor.digest;
  const broken = brokenPayloads.get(brokenDigest);
  brokenPayloads.set(brokenDigest, {
    ...broken,
    candidate: publishSignedArtifact({
      artifact: broken.candidate.artifact,
      signingKey: builderKey,
      conformanceReport: {
        suiteId: "@hobo/conformance/componentize@1.0.0",
        passed: false,
        assertions: ["signature", "provenance", "conformance"],
      },
      issuedAt: "2026-06-25T20:00:00.000Z",
      provenanceTier: "slsa-build-l3",
    }),
  });

  const mirror = createInBoundaryRegistryMirror();
  const importer = createRegistryImporter({ mirror });
  const result = importer.importBundle({ bundle: fixture.bundle, payloads: brokenPayloads, trustBoundary });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /artifact @acme\/postgres-pack@1\.0\.0 refused: conformance.failed/);
  assert.equal(mirror.discover({ name: "@acme/provider-airgap", version: "1.0.0" }).digest, fixture.candidates[0].artifact.digest);
  assert.equal(mirror.discover({ name: "@acme/postgres-pack", version: "1.0.0" }), null);
  assert.deepEqual(mirror.events()[0].artifacts.map((artifact) => artifact.status), ["imported", "refused"]);
});

test("refuses descriptor payloads that do not match the bundle digest", () => {
  const fixture = createImportFixture();
  const tamperedPayloads = new Map(fixture.payloads);
  const tamperedDigest = fixture.bundle.contents.listings[0].descriptor.digest;
  const tampered = tamperedPayloads.get(tamperedDigest);
  tamperedPayloads.set(tamperedDigest, {
    ...tampered,
    descriptor: {
      ...tampered.descriptor,
      name: "@acme/provider-shadow",
    },
  });

  const mirror = createInBoundaryRegistryMirror();
  const importer = createRegistryImporter({ mirror });
  const result = importer.importBundle({ bundle: fixture.bundle, payloads: tamperedPayloads, trustBoundary });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /descriptor\.digest_mismatch/);
  assert.equal(mirror.discover({ name: "@acme/provider-airgap", version: "1.0.0" }), null);
  assert.equal(mirror.discover({ name: "@acme/provider-shadow", version: "1.0.0" }), null);
  assert.deepEqual(mirror.events()[0].artifacts.map((artifact) => artifact.status), ["refused", "imported"]);
});

test("bundle tag references fail before mirror mutation", () => {
  const fixture = createImportFixture();
  const badBundle = structuredClone(fixture.bundle);
  badBundle.contents.listings[0].descriptor = {
    mediaType: "application/vnd.hobo.registry.descriptor.v1+json",
    uri: "oci://registry.example/hobo/provider-airgap:latest",
    tag: "latest",
  };
  badBundle.bundleDigest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";

  const mirror = createInBoundaryRegistryMirror();
  const importer = createRegistryImporter({ mirror });
  const result = importer.importBundle({ bundle: badBundle, payloads: fixture.payloads, trustBoundary });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /bundle.invalid: contents\.listings\.0\.artifact\.tag is not allowed/);
  assert.deepEqual(mirror.entries(), []);
  assert.deepEqual(mirror.events(), []);
});

test("re-importing the same bundle is idempotent and does not overwrite history", () => {
  const fixture = createImportFixture();
  const mirror = createInBoundaryRegistryMirror();
  const importer = createRegistryImporter({ mirror });

  const first = importer.importBundle({ bundle: fixture.bundle, payloads: fixture.payloads, trustBoundary });
  const second = importer.importBundle({ bundle: fixture.bundle, payloads: fixture.payloads, trustBoundary });

  assert.equal(first.ok, true, first.reasons.join("\n"));
  assert.equal(second.ok, true, second.reasons.join("\n"));
  assert.deepEqual(second.artifacts.map((entry) => entry.status), ["already-imported", "already-imported"]);
  assert.equal(mirror.entries().length, 2);
  assert.equal(mirror.installCatalog.entries().length, 2);
  assert.equal(mirror.events().length, 2);
  assert.equal(mirror.history({ name: "@acme/provider-airgap", version: "1.0.0" }).length, 1);
});

test("mirror fails closed when an artifact is absent instead of live crawling", () => {
  const mirror = createInBoundaryRegistryMirror();
  let egressCalls = 0;

  assert.throws(
    () => mirror.serve("sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", {
      onEgressAttempt: () => {
        egressCalls += 1;
      },
    }),
    /mirror artifact sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa not found; live crawl disabled/,
  );
  assert.equal(egressCalls, 0);
});

function createImportFixture() {
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
  const descriptors = [provider.descriptor, pack.descriptor];
  const candidates = [provider.candidate, pack.candidate];
  const bundle = bundleFor({ descriptors });
  const payloads = new Map(descriptors.map((descriptor, index) => [
    descriptorDigest(descriptor),
    {
      descriptor,
      candidate: candidates[index],
    },
  ]));

  return { bundle, payloads, candidates };
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

function bundleFor({ descriptors }) {
  const logRoot = digest("rekor-root-2026-06-25");
  const bundle = {
    schema: "registry.bundle/v1",
    bundleId: "bundle.airgap.acme.hobo-383",
    version: "1.0.0",
    createdAt: "2026-06-25T07:55:00.000Z",
    curator: {
      id: "acme-platform",
      trustDomain: "spiffe://acme.example",
    },
    contents: {
      listings: descriptors.map((descriptor) => ({
        kind: descriptor.kind,
        name: descriptor.name,
        version: descriptor.version,
        descriptor: artifactRef("descriptor", descriptorDigest(descriptor)),
        buildTimestamp: "2026-06-25T00:00:00.000Z",
        provenance: descriptor.evidence.slsaProvenanceRef,
        conformanceReports: descriptor.evidence.conformanceReportRefs.map((report) => report.ref),
        transparency: transparencyProof(logRoot),
      })),
      baseImages: [
        {
          name: "wasmcloud-host",
          artifact: artifactRef("base-image", digest("base-image")),
          buildTimestamp: "2026-06-25T00:00:00.000Z",
          provenance: artifactRef("base-provenance", digest("base-provenance")),
          transparency: transparencyProof(logRoot),
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

function transparencyProof(logRoot) {
  return {
    logId: "rekor-prod",
    logRoot,
    inclusionProof: artifactRef("inclusion-proof", digest("inclusion-proof")),
  };
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
