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
  createHoboAddCatalog,
  hoboAdd,
} from "../src/hobo-add-install-verification.js";

const builderKey = createFixtureSigningKey({
  keyId: "builder-key-hobo-add",
  builderId: "spiffe://yard/builders/hobo-componentize",
});

const trustBoundary = createTrustBoundary({
  trustedKeyIds: [builderKey.keyId],
  trustedBuilderIds: [builderKey.builderId],
  requiredConformanceSuites: ["@hobo/conformance/componentize@1.0.0"],
  allowedCoordinateScopes: ["oci://registry.example/hobo/"],
  minimumProvenanceTier: "slsa-build-l3",
});

test("hobo add registers a signed and certified listing as Matching-available without selecting it", () => {
  const catalog = createHoboAddCatalog();
  const candidate = signedListing();
  const listing = descriptorFor(candidate);

  const result = hoboAdd({ catalog, listing, candidate, trustBoundary });

  assert.equal(result.ok, true, result.reasons.join("\n"));
  assert.equal(result.entry.availableToMatching, true);
  assert.equal(result.entry.selectedByMatching, false);
  assert.equal(result.entry.digest, candidate.artifact.digest);
  assert.equal(catalog.entries().length, 1);
  assert.equal(catalog.entries()[0].availableToMatching, true);
  assert.deepEqual(catalog.selectedEntries(), []);
});

test("broken signature, absent provenance, and missing conformance are refused with no catalog mutation", () => {
  const cases = [
    {
      name: "broken signature",
      candidate: () => ({ ...signedListing(), signature: null }),
      reason: "signature.required",
    },
    {
      name: "absent provenance",
      candidate: () => ({ ...signedListing(), provenance: null }),
      reason: "provenance.required",
    },
    {
      name: "missing conformance report",
      candidate: () => ({ ...signedListing(), conformance: null }),
      reason: "conformance.required",
    },
  ];

  for (const refusal of cases) {
    const catalog = createHoboAddCatalog();
    const candidate = refusal.candidate();
    const listing = descriptorFor(candidate);

    const result = hoboAdd({ catalog, listing, candidate, trustBoundary });

    assert.equal(result.ok, false, refusal.name);
    assert.match(result.reasons.join("\n"), new RegExp(refusal.reason), refusal.name);
    assert.deepEqual(catalog.entries(), [], refusal.name);
  }
});

test("integrity verification runs before any cost or mirror consideration", () => {
  const catalog = createHoboAddCatalog();
  const candidate = { ...signedListing(), signature: null };
  const listing = descriptorFor(candidate);
  let costConsiderations = 0;
  let mirrorConsiderations = 0;

  const result = hoboAdd({
    catalog,
    listing,
    candidate,
    trustBoundary,
    considerCost: () => {
      costConsiderations += 1;
    },
    considerMirrors: () => {
      mirrorConsiderations += 1;
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /signature.required/);
  assert.equal(costConsiderations, 0);
  assert.equal(mirrorConsiderations, 0);
  assert.deepEqual(catalog.entries(), []);
});

test("digest mismatch between descriptor and signed artifact is refused", () => {
  const catalog = createHoboAddCatalog();
  const candidate = signedListing();
  const listing = descriptorFor(candidate);
  listing.artifact = artifactRef({
    digest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
    mediaType: candidate.artifact.mediaType,
    name: "tampered-provider",
  });

  const result = hoboAdd({ catalog, listing, candidate, trustBoundary });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /descriptor.artifact_digest_mismatch/);
  assert.deepEqual(catalog.entries(), []);
});

test("validly signed but conformance-failing artifacts are refused", () => {
  const catalog = createHoboAddCatalog();
  const candidate = signedListing({
    conformanceReport: {
      suiteId: "@hobo/conformance/componentize@1.0.0",
      passed: false,
      assertions: ["wasm-tools validate", "wasmtime-smoke"],
    },
  });
  const listing = descriptorFor(candidate);

  const result = hoboAdd({ catalog, listing, candidate, trustBoundary });

  assert.equal(result.ok, false);
  assert.match(result.reasons.join("\n"), /conformance.failed/);
  assert.deepEqual(catalog.entries(), []);
});

function signedListing({
  coordinate = "oci://registry.example/hobo/provider-shell",
  version = "1.0.0",
  conformanceReport = {
    suiteId: "@hobo/conformance/componentize@1.0.0",
    passed: true,
    assertions: ["wasm-tools validate", "oci-digest-stability", "wasmtime-smoke"],
  },
} = {}) {
  return publishSignedArtifact({
    artifact: createArtifactPayload({
      coordinate,
      version,
      mediaType: "application/vnd.hobo.provider.layer.v1+json",
      bytes: `provider-shell:${coordinate}:${version}`,
    }),
    signingKey: builderKey,
    conformanceReport,
    issuedAt: "2026-06-25T20:00:00.000Z",
    provenanceTier: "slsa-build-l3",
  });
}

function descriptorFor(candidate) {
  const conformanceRef = artifactRef({
    digest: candidate.conformance?.digest ?? digest("missing-conformance"),
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
        digest: digest(candidate.provenance ?? "missing-provenance"),
        mediaType: "application/vnd.in-toto+json",
        name: "provider-shell-provenance",
      }),
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
}

function artifactRef({ digest, mediaType, name }) {
  return {
    mediaType,
    uri: `oci://registry.example/hobo/${name}@${digest}`,
    digest,
  };
}

function digest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}
