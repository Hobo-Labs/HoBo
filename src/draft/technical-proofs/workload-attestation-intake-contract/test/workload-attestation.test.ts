import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "vitest";

import {
  createFixtureHostAttestor,
  verifyWorkloadAttestation,
} from "../src/workload-attestation.js";

const NOW = "2026-06-25T15:00:00.000Z";
const IMAGE_DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CODE_DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function baseMeasurement(overrides = {}) {
  return {
    runId: "run-20260625-identity-77",
    tenant: "tenant-a",
    parentPrincipal: { kind: "user", id: "user:platform-admin" },
    codeVersion: { digest: CODE_DIGEST, version: "git:77-attestation" },
    componentImageDigest: IMAGE_DIGEST,
    hostId: "host-firecracker-1",
    issuedAt: "2026-06-25T14:59:30.000Z",
    expiresAt: "2026-06-25T15:01:00.000Z",
    nonce: "nonce-hoBO-77",
    isolationTier: "firecracker-microvm",
    ...overrides,
  };
}

describe("workload attestation intake contract", () => {
  it("publishes a versioned attestation-document schema with launch measurement fields", async () => {
    const schema = JSON.parse(
      await readFile(
        new URL("../schema/workload-attestation.v1.schema.json", import.meta.url),
        "utf8",
      ),
    );

    assert.equal(schema.$id, "https://hobo.dev/schemas/identity/workload-attestation.v1.json");
    assert.deepEqual(schema.required, [
      "schemaVersion",
      "runId",
      "claimed",
      "launchMeasurement",
      "hostSignature",
    ]);
    assert.deepEqual(schema.properties.launchMeasurement.required, [
      "runId",
      "tenant",
      "parentPrincipal",
      "codeVersion",
      "componentImageDigest",
      "hostId",
      "issuedAt",
      "expiresAt",
      "nonce",
      "isolationTier",
    ]);
  });

  it("returns attested when a host-signed launch measurement matches a known image digest", () => {
    const attestor = createFixtureHostAttestor({ hostId: "host-firecracker-1" });
    const launchMeasurement = baseMeasurement();
    const document = attestor.createDocument({
      launchMeasurement,
      claimed: {
        tenant: "tenant-a",
        parentPrincipal: { kind: "user", id: "user:platform-admin" },
      },
    });

    const verdict = verifyWorkloadAttestation(document, {
      knownImageDigests: [IMAGE_DIGEST],
      hostPublicKeys: attestor.publicKeys(),
      now: NOW,
    });

    assert.deepEqual(verdict, {
      state: "attested",
      reason: "host-signature-valid",
      binding: {
        runId: "run-20260625-identity-77",
        tenant: "tenant-a",
        parentPrincipal: { kind: "user", id: "user:platform-admin" },
        codeVersion: { digest: CODE_DIGEST, version: "git:77-attestation" },
        componentImageDigest: IMAGE_DIGEST,
      },
      evidence: {
        hostId: "host-firecracker-1",
        launchMeasurementDigest: verdict.evidence.launchMeasurementDigest,
      },
      policy: {
        attestationState: "attested",
        isolationFloor: "workload-selected",
        nonOverridable: false,
      },
    });
    assert.match(verdict.evidence.launchMeasurementDigest, /^sha256:[a-f0-9]{64}$/);
  });

  it("returns unattested for tampered, forged, absent, or unknown-image attestations", () => {
    const attestor = createFixtureHostAttestor({ hostId: "host-firecracker-1" });
    const signed = attestor.createDocument({ launchMeasurement: baseMeasurement() });

    const cases = [
      {
        name: "tampered digest",
        document: {
          ...signed,
          launchMeasurement: {
            ...signed.launchMeasurement,
            componentImageDigest:
              "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          },
        },
        reason: "host-signature-invalid",
      },
      {
        name: "forged host signature",
        document: { ...signed, hostSignature: { ...signed.hostSignature, value: "not-a-signature" } },
        reason: "host-signature-invalid",
      },
      {
        name: "absent host signature",
        document: { ...signed, hostSignature: undefined },
        reason: "host-signature-missing",
      },
      {
        name: "unknown image digest",
        document: signed,
        knownImageDigests: [
          "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
        ],
        reason: "unknown-component-image",
      },
    ];

    for (const testCase of cases) {
      const verdict = verifyWorkloadAttestation(testCase.document, {
        knownImageDigests: testCase.knownImageDigests ?? [IMAGE_DIGEST],
        hostPublicKeys: attestor.publicKeys(),
        now: NOW,
      });

      assert.equal(verdict.state, "unattested", testCase.name);
      assert.equal(verdict.reason, testCase.reason, testCase.name);
      assert.deepEqual(verdict.policy, {
        attestationState: "unattested",
        isolationFloor: "firecracker-microvm",
        nonOverridable: true,
      });
    }
  });

  it("binds tenant, parent principal, and code version from the measured launch, not claims", () => {
    const attestor = createFixtureHostAttestor({ hostId: "host-firecracker-1" });
    const document = attestor.createDocument({
      launchMeasurement: baseMeasurement({
        tenant: "tenant-a",
        parentPrincipal: { kind: "user", id: "user:tenant-a-admin" },
      }),
      claimed: {
        tenant: "tenant-b",
        parentPrincipal: { kind: "user", id: "user:tenant-b-admin" },
      },
    });

    const verdict = verifyWorkloadAttestation(document, {
      knownImageDigests: [IMAGE_DIGEST],
      hostPublicKeys: attestor.publicKeys(),
      now: NOW,
    });

    assert.equal(verdict.state, "attested");
    assert.equal(verdict.binding.tenant, "tenant-a");
    assert.deepEqual(verdict.binding.parentPrincipal, {
      kind: "user",
      id: "user:tenant-a-admin",
    });
    assert.equal(verdict.binding.codeVersion.digest, CODE_DIGEST);
    assert.deepEqual(verdict.claimConflict, {
      tenant: { claimed: "tenant-b", measured: "tenant-a" },
      parentPrincipal: {
        claimed: { kind: "user", id: "user:tenant-b-admin" },
        measured: { kind: "user", id: "user:tenant-a-admin" },
      },
    });
  });

  it("rejects replayed or stale launch measurements", () => {
    const attestor = createFixtureHostAttestor({ hostId: "host-firecracker-1" });
    const document = attestor.createDocument({
      launchMeasurement: baseMeasurement({
        issuedAt: "2026-06-25T14:00:00.000Z",
        expiresAt: "2026-06-25T14:01:00.000Z",
      }),
    });

    const verdict = verifyWorkloadAttestation(document, {
      knownImageDigests: [IMAGE_DIGEST],
      hostPublicKeys: attestor.publicKeys(),
      now: NOW,
    });

    assert.equal(verdict.state, "unattested");
    assert.equal(verdict.reason, "launch-measurement-expired");
    assert.equal(verdict.policy.isolationFloor, "firecracker-microvm");
    assert.equal(verdict.policy.nonOverridable, true);
  });

  it("makes no-valid-attestation fallback non-overridable even when caller requests a weaker tier", () => {
    const verdict = verifyWorkloadAttestation(
      {
        schemaVersion: "hobo.workload-attestation/v1",
        runId: "run-unsigned",
        claimed: { tenant: "tenant-a" },
        launchMeasurement: baseMeasurement({ isolationTier: "container" }),
        hostSignature: undefined,
      },
      {
        knownImageDigests: [IMAGE_DIGEST],
        hostPublicKeys: [],
        now: NOW,
        requestedIsolationTier: "container",
      },
    );

    assert.equal(verdict.state, "unattested");
    assert.deepEqual(verdict.policy, {
      attestationState: "unattested",
      isolationFloor: "firecracker-microvm",
      nonOverridable: true,
    });
    assert.equal(verdict.requestedIsolationTier, "container");
  });
});
