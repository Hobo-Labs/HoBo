import assert from "node:assert/strict";
import { test } from "vitest";

import { contentDigest } from "../../slsa-provenance-certification-contract/src/provenance.js";
import {
  createFixtureSigningKey,
  createTrustBoundary,
} from "../../signed-artifact-publish-install-contract/src/publish-install-contract.js";
import {
  createForgeSigningRegistry,
  ForgeSigningRegistryError,
} from "../src/forge-signing-registry.js";

const artifactDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const signingKey = createFixtureSigningKey({
  keyId: "hobo-forge-certifier",
  builderId: "spiffe://hobo.example/forge/certifier",
});

const trustBoundary = createTrustBoundary({
  trustedKeyIds: [signingKey.keyId],
  trustedBuilderIds: [signingKey.builderId],
  requiredConformanceSuites: ["@hobo/conformance/postgres-provider"],
  allowedCoordinateScopes: ["oci://registry.example/hobo/"],
  minimumProvenanceTier: "slsa-build-l3",
});

test("Given certification pass When publish Then signed record with gen.PluginCertified events", () => {
  const forge = createForgeSigningRegistry({ signingKey, trustBoundary });
  const result = forge.certifyAndPublish(forgeCertificationPass());

  assert.equal(result.ok, true);
  assert.equal(result.record.payload.status, "Certified");
  assert.equal(result.record.payload.provenance.kind, "generation-provenance");
  assert.equal(result.installCandidate.provenance.schema, "slsa.dev/provenance/v1");
  assert.equal(result.installCandidate.conformance.report.suiteId, "@hobo/conformance/postgres-provider");
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["gen.Certified", "gen.PluginCertified"],
  );
});

test("Given certified fixture When install from Registry Then available to Matching not auto-selected", () => {
  const forge = createForgeSigningRegistry({ signingKey, trustBoundary });
  const published = forge.certifyAndPublish(forgeCertificationPass());

  const installed = forge.installFromRegistry({
    registryCoordinate: published.registryCoordinate,
    installCandidate: published.installCandidate,
  });

  assert.equal(installed.ok, true);
  assert.equal(installed.availableToMatching, true);
  assert.equal(installed.selectedByMatching, false);
  assert.equal(forge.catalog.entries().length, 1);
  assert.equal(forge.catalog.selectedEntries().length, 0);
});

test("Given tampered artifact When install Then typed signature verification error", () => {
  const forge = createForgeSigningRegistry({ signingKey, trustBoundary });
  const published = forge.certifyAndPublish(forgeCertificationPass());
  const tampered = {
    ...published.installCandidate,
    signature: {
      ...published.installCandidate.signature,
      value: "tampered-signature-value",
    },
  };

  assert.throws(
    () => forge.install({ installCandidate: tampered }),
    (error) =>
      error instanceof ForgeSigningRegistryError &&
      error.code === "forge.signature_verification_failed",
  );
  assert.equal(forge.catalog.entries().length, 0);
});

test("Given unsigned candidate When install Then refused and stays unlisted", () => {
  const forge = createForgeSigningRegistry({ signingKey, trustBoundary });
  const published = forge.certifyAndPublish(forgeCertificationPass());
  const unsigned = { ...published.installCandidate, signature: undefined };

  assert.throws(
    () => forge.install({ installCandidate: unsigned }),
    (error) =>
      error instanceof ForgeSigningRegistryError &&
      error.code === "forge.unsigned_refused_at_install",
  );
  assert.equal(forge.catalog.entries().length, 0);
});

test("Given uncertified coordinate When installFromRegistry Then refused not listed", () => {
  const forge = createForgeSigningRegistry({ signingKey, trustBoundary });
  const published = forge.certifyAndPublish(forgeCertificationPass());

  assert.throws(
    () =>
      forge.installFromRegistry({
        registryCoordinate: "@fake/uncertified@9.9.9",
        installCandidate: published.installCandidate,
      }),
    (error) =>
      error instanceof ForgeSigningRegistryError &&
      error.code === "forge.uncertified_not_listed",
  );
  assert.equal(forge.catalog.entries().length, 0);
});

test("Given failed validation When certifyAndPublish Then rejected before listing", () => {
  const forge = createForgeSigningRegistry({ signingKey, trustBoundary });

  assert.throws(
    () =>
      forge.certifyAndPublish(
        forgeCertificationPass({
          validationReport: {
            ...validationReport(),
            passed: false,
          },
        }),
      ),
    (error) =>
      error instanceof ForgeSigningRegistryError &&
      error.code === "forge.validation_not_green",
  );
  assert.deepEqual(forge.registry.certified(), []);
});

test("Given failed conformance When certifyAndPublish Then rejected before listing", () => {
  const forge = createForgeSigningRegistry({ signingKey, trustBoundary });

  assert.throws(
    () =>
      forge.certifyAndPublish(
        forgeCertificationPass({
          conformanceReport: {
            ...conformanceReport(),
            passed: false,
          },
        }),
      ),
    (error) =>
      error instanceof ForgeSigningRegistryError &&
      error.code === "forge.conformance_not_green",
  );
  assert.deepEqual(forge.registry.certified(), []);
});

test("Given tampered artifact bytes When install Then digest verification fails typed", () => {
  const forge = createForgeSigningRegistry({ signingKey, trustBoundary });
  const published = forge.certifyAndPublish(forgeCertificationPass());
  const tampered = {
    ...published.installCandidate,
    artifact: {
      ...published.installCandidate.artifact,
      bytes: "forge-generated-postgres-provider-with-backdoor",
    },
  };

  assert.throws(
    () => forge.install({ installCandidate: tampered }),
    (error) =>
      error instanceof ForgeSigningRegistryError &&
      error.code === "forge.install_verification_failed",
  );
  assert.equal(forge.catalog.entries().length, 0);
});

function forgeCertificationPass(overrides = {}) {
  return {
    requestId: "forge-hobo-650",
    candidate: candidate(),
    validationReport: validationReport(),
    conformanceReport: conformanceReport(),
    certifiedAt: "2026-07-02T00:00:00.000Z",
    ...overrides,
  };
}

function candidate() {
  return {
    artifactKind: "provider-plugin",
    name: "@acme/provider-postgres",
    version: "1.0.0",
    bytes: "forge-generated-postgres-provider-v1",
    artifactRef: {
      mediaType: "application/vnd.hobo.provider.layer.v1+json",
      uri: "oci://registry.example/hobo/provider-postgres@sha256:aaa",
      digest: artifactDigest,
    },
    claimedPorts: ["hobo:database/postgres@0.1.0"],
  };
}

function validationReport() {
  const payload = {
    schema: "hobo.gen.validation-report/v1",
    requestId: "forge-hobo-650",
    candidateRef: candidate().artifactRef,
    targetWitPort: "hobo:database/postgres@0.1.0",
    coveredPorts: [
      {
        witPort: "hobo:database/postgres@0.1.0",
        suiteId: "@hobo/conformance/postgres-provider",
        passed: true,
      },
    ],
    conformance: {
      suiteId: "@hobo/conformance/postgres-provider",
      targetPort: "hobo:database/postgres@0.1.0",
      passed: true,
      assertions: [{ id: "contract.connects", passed: true }],
    },
    traceReplay: { passed: true, diffs: [] },
    passed: true,
  };
  return {
    ...payload,
    ref: {
      uri: "oci://registry.example/hobo/reports/forge-hobo-650",
      digest: contentDigest(payload),
    },
  };
}

function conformanceReport() {
  return {
    schema: "hobo.conformance.report/v1",
    suiteId: "@hobo/conformance/postgres-provider",
    targetPort: "hobo:database/postgres@0.1.0",
    runId: "forge-hobo-650",
    passed: true,
    assertions: ["contract.connects", "contract.destroy.clean"],
  };
}
