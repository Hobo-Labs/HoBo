import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  bootstrapIdentityIssuer,
  createInMemoryKms,
  verifyJwtWithJwks,
} from "../../../../technical-proofs/yard-identity-issuer-contract/src/issuer.js";
import {
  createFixtureHostAttestor,
} from "../../../../technical-proofs/workload-attestation-intake-contract/src/workload-attestation.js";
import {
  evaluateSvidCrossTenantGuard,
} from "../src/svid-cross-tenant-guard.js";

const NOW = "2026-06-28T03:30:00.000Z";
const ISSUER_URL = "https://identity.prod-yard.example";
const TENANT_A_IMAGE = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TENANT_A_CODE = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const TAMPERED_IMAGE = "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";

const inferredGrant = [
  { port: "database/main", resource: "tenant-a.orders", actions: ["read", "write"] },
];

describe("HOBO-247 SVID cross-tenant issuance guard", () => {
  it("never mints a tenant-B SVID when a tenant-A workload self-asserts tenant B", async () => {
    const fixture = createFixture();
    const document = fixture.attestor.createDocument({
      launchMeasurement: launchMeasurement({
        tenant: "tenant-a",
        parentPrincipal: { kind: "user", id: "user:tenant-a-admin" },
      }),
      claimed: {
        tenant: "tenant-b",
        parentPrincipal: { kind: "user", id: "user:tenant-b-admin" },
        codeVersion: { digest: TAMPERED_IMAGE, version: "git:attacker-fork" },
      },
    });

    const result = await evaluateSvidCrossTenantGuard({
      requestId: "hobo-247-cross-tenant-assertion",
      agentName: "generated-provider",
      audience: "acme-cloud",
      document,
      hostPublicKeys: fixture.attestor.publicKeys(),
      knownImageDigests: [TENANT_A_IMAGE],
      now: NOW,
      issuer: fixture.issuer,
      requestedTenant: "tenant-b",
      requestedParentPrincipal: { kind: "user", id: "user:tenant-b-admin" },
      requestedCodeVersion: { digest: TAMPERED_IMAGE, version: "git:attacker-fork" },
      requestedScope: [
        { port: "database/main", resource: "tenant-a.orders", actions: ["read", "write", "admin"] },
      ],
      inferredGrant,
    });

    assert.equal(result.ok, true);
    assert.equal(result.tokenTenant, "tenant-a");
    assert.equal(result.issued?.claims.tenant, "tenant-a");
    assert.equal(result.issued?.claims.sub, "spiffe://yard/tenant-a/agent/generated-provider");
    assert.notEqual(result.issued?.claims.tenant, "tenant-b");
    assert.deepEqual(result.issued?.claims.parentPrincipal, { kind: "user", id: "tenant-a-admin" });
    assert.deepEqual(result.issued?.scope, inferredGrant);
    assert.deepEqual(result.deniedEvents, []);
    assert.deepEqual(result.anomalies.map((entry) => entry.code), [
      "self-asserted-claims-overridden",
      "requested-scope-clamped",
    ]);

    const verified = await verifyJwtWithJwks(result.issued.token, fixture.issuer.jwks(), {
      issuer: ISSUER_URL,
      audience: "acme-cloud",
      now: Date.parse(NOW) / 1000,
    });
    assert.equal(verified.claims.tenant, "tenant-a");
    assert.equal(verified.claims.sub, "spiffe://yard/tenant-a/agent/generated-provider");
  });

  it("forces a tampered digest to the non-overridable microVM floor and emits token.Denied", async () => {
    const fixture = createFixture();
    const signed = fixture.attestor.createDocument({
      launchMeasurement: launchMeasurement({ componentImageDigest: TENANT_A_IMAGE }),
    });
    const tampered = {
      ...signed,
      launchMeasurement: {
        ...signed.launchMeasurement,
        componentImageDigest: TAMPERED_IMAGE,
      },
    };

    const result = await evaluateSvidCrossTenantGuard({
      requestId: "hobo-247-tampered-digest",
      agentName: "generated-provider",
      audience: "acme-cloud",
      document: tampered,
      hostPublicKeys: fixture.attestor.publicKeys(),
      knownImageDigests: [TENANT_A_IMAGE],
      now: NOW,
      issuer: fixture.issuer,
      requestedIsolationTier: "container",
      requestedScope: inferredGrant,
      inferredGrant,
    });

    assert.equal(result.ok, false);
    assert.equal(result.attestation.state, "unattested");
    assert.equal(result.attestation.reason, "host-signature-invalid");
    assert.deepEqual(result.attestation.policy, {
      attestationState: "unattested",
      isolationFloor: "firecracker-microvm",
      nonOverridable: true,
    });
    assert.equal(result.issued, undefined);
    assert.equal(result.deniedEvents.length, 1);
    assert.equal(result.deniedEvents[0].type, "token.Denied");
    assert.equal(result.deniedEvents[0].data.reason, "workload-not-attested: host-signature-invalid");
    assert.equal(JSON.stringify(result.deniedEvents).includes("privileged"), false);
  });

  it("rejects replayed attestation documents and records the denial", async () => {
    const fixture = createFixture();
    const replayed = fixture.attestor.createDocument({
      launchMeasurement: launchMeasurement({
        issuedAt: "2026-06-28T02:00:00.000Z",
        expiresAt: "2026-06-28T02:01:00.000Z",
      }),
    });

    const result = await evaluateSvidCrossTenantGuard({
      requestId: "hobo-247-replayed-attestation",
      agentName: "generated-provider",
      audience: "acme-cloud",
      document: replayed,
      hostPublicKeys: fixture.attestor.publicKeys(),
      knownImageDigests: [TENANT_A_IMAGE],
      now: NOW,
      issuer: fixture.issuer,
      requestedScope: inferredGrant,
      inferredGrant,
    });

    assert.equal(result.ok, false);
    assert.equal(result.attestation.reason, "launch-measurement-expired");
    assert.deepEqual(result.deniedEvents.map((event) => event.type), ["token.Denied"]);
  });

  it("denies a fork that drops attestation instead of falling through to a weaker shared tier", async () => {
    const fixture = createFixture();

    const result = await evaluateSvidCrossTenantGuard({
      requestId: "hobo-247-missing-attestation",
      agentName: "generated-provider",
      audience: "acme-cloud",
      document: undefined,
      hostPublicKeys: fixture.attestor.publicKeys(),
      knownImageDigests: [TENANT_A_IMAGE],
      now: NOW,
      issuer: fixture.issuer,
      requestedIsolationTier: "container",
      requestedScope: inferredGrant,
      inferredGrant,
    });

    assert.equal(result.ok, false);
    assert.equal(result.attestation.state, "unattested");
    assert.equal(result.attestation.policy.isolationFloor, "firecracker-microvm");
    assert.equal(result.attestation.policy.nonOverridable, true);
    assert.equal(result.isolationDecision.allowedTier, "firecracker-microvm");
    assert.equal(result.isolationDecision.requestedTierAccepted, false);
    assert.equal(result.issued, undefined);
    assert.equal(result.deniedEvents[0].data.reason, "workload-not-attested: attestation-document-invalid");
  });
});

function createFixture() {
  const kms = createInMemoryKms();
  const issuer = bootstrapIdentityIssuer({
    issuerUrl: ISSUER_URL,
    kms,
    genesisKeyId: "yard-genesis-2026-06",
    seedCredential: { canGenerateGenesisKey: true },
  });
  const attestor = createFixtureHostAttestor({ hostId: "host-firecracker-1" });
  return { issuer, attestor };
}

function launchMeasurement(overrides = {}) {
  return {
    runId: "run-hobo-247",
    tenant: "tenant-a",
    parentPrincipal: { kind: "user", id: "user:tenant-a-admin" },
    codeVersion: { digest: TENANT_A_CODE, version: "git:hobo-247" },
    componentImageDigest: TENANT_A_IMAGE,
    hostId: "host-firecracker-1",
    issuedAt: "2026-06-28T03:29:30.000Z",
    expiresAt: "2026-06-28T03:31:00.000Z",
    nonce: "nonce-hobo-247",
    isolationTier: "firecracker-microvm",
    ...overrides,
  };
}
