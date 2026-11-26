import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  parseJwtSvidCompact,
} from "../../hobo-jwt-svid-contract/src/jwt-svid.js";
import {
  bootstrapIdentityIssuer,
  createInMemoryKms,
  verifyJwtWithJwks,
} from "../../yard-identity-issuer-contract/src/issuer.js";
import {
  createFixtureHostAttestor,
  verifyWorkloadAttestation,
} from "../../workload-attestation-intake-contract/src/workload-attestation.js";
import {
  createJwtSvidIssuer,
} from "../src/jwt-svid-issuer.js";

const NOW = "2026-06-25T17:45:00.000Z";
const IMAGE_DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CODE_DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const ISSUER_URL = "https://identity.prod-yard.example";

const inferredGrant = [
  { port: "database/main", resource: "shop.db", actions: ["read", "write"] },
  { port: "queue/main", resource: "orders", actions: ["enqueue"] },
];

describe("JWT-SVID issuance for attested workloads", () => {
  it("mints a JWKS-verifiable JWT-SVID from attestation binding and records identity.Issued", async () => {
    const { service, issuer } = createFixtureIssuanceService();
    const attestationVerdict = createAttestedVerdict({
      tenant: "tenant-a",
      parentPrincipal: { kind: "user", id: "user:platform-admin" },
    });

    const result = await service.issue({
      requestId: "issue-attested",
      agentName: "release-agent",
      audience: "acme-cloud",
      attestationVerdict,
      requestedTenant: "tenant-b",
      requestedScope: [
        { port: "database/main", resource: "shop.db", actions: ["read", "write", "admin"] },
        { port: "queue/main", resource: "orders", actions: ["enqueue", "purge"] },
      ],
      inferredGrant,
    });

    assert.equal(result.ok, true);
    assert.equal(result.claims.tenant, "tenant-a");
    assert.equal(result.claims.sub, "spiffe://yard/tenant-a/agent/release-agent");
    assert.deepEqual(result.scope, inferredGrant);

    const verified = await verifyJwtWithJwks(result.token, issuer.jwks(), {
      issuer: ISSUER_URL,
      audience: "acme-cloud",
      now: Date.parse(NOW) / 1000,
    });
    assert.equal(verified.claims.sub, result.claims.sub);
    assert.equal(verified.claims.tenant, "tenant-a");
    assert.deepEqual(verified.claims.scope, [
      { port: "database/main", resource: "shop.db", verbs: ["read", "write"] },
      { port: "queue/main", resource: "orders", verbs: ["enqueue"] },
    ]);

    const parsed = parseJwtSvidCompact(result.token, {
      expectedTenant: "tenant-a",
      now: Date.parse(NOW) / 1000,
    });
    assert.equal(parsed.identity.kind, "agent");
    assert.equal(parsed.identity.agent, "release-agent");
    assert.deepEqual(parsed.claims.parentPrincipal, { kind: "user", id: "platform-admin" });

    assert.deepEqual(result.events.map((event) => event.type), ["identity.Issued"]);
    assert.equal(result.events[0].data.identityId, "svid-1");
    assert.equal(result.events[0].data.svidRef, "identity://svid/svid-1");
    assert.equal(result.events[0].data.subject.id, "agent:release-agent");
    assert.deepEqual(result.events[0].data.scope, inferredGrant);
    assert.equal(JSON.stringify(result.events).includes(result.token), false);
  });

  it("refuses issuance for unattested workloads without emitting identity.Issued", async () => {
    const { service } = createFixtureIssuanceService();
    const result = await service.issue({
      requestId: "issue-unattested",
      agentName: "release-agent",
      audience: "acme-cloud",
      attestationVerdict: {
        state: "unattested",
        reason: "host-signature-missing",
        policy: {
          attestationState: "unattested",
          isolationFloor: "firecracker-microvm",
          nonOverridable: true,
        },
      },
      requestedScope: inferredGrant,
      inferredGrant,
    });

    assert.deepEqual(result, {
      ok: false,
      requestId: "issue-unattested",
      reason: "workload-not-attested",
      policy: {
        attestationState: "unattested",
        isolationFloor: "firecracker-microvm",
        nonOverridable: true,
      },
      events: [],
    });
  });

  it("fails closed when a requested scope has no inferred grant overlap", async () => {
    const { service } = createFixtureIssuanceService();
    const result = await service.issue({
      requestId: "issue-no-overlap",
      agentName: "release-agent",
      audience: "acme-cloud",
      attestationVerdict: createAttestedVerdict(),
      requestedScope: [
        { port: "compute/main", resource: "prod-admin", actions: ["destroy"] },
      ],
      inferredGrant,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "requested-scope-outside-inferred-grant");
    assert.deepEqual(result.events, []);
  });
});

function createFixtureIssuanceService() {
  const kms = createInMemoryKms();
  const issuer = bootstrapIdentityIssuer({
    issuerUrl: ISSUER_URL,
    kms,
    genesisKeyId: "yard-genesis-2026-06",
    seedCredential: { canGenerateGenesisKey: true },
  });
  const service = createJwtSvidIssuer({
    issuer,
    now: () => new Date(NOW),
    ttlSeconds: 300,
    idFactory: deterministicIds("svid"),
  });

  return { issuer, service };
}

function createAttestedVerdict(overrides = {}) {
  const attestor = createFixtureHostAttestor({ hostId: "host-firecracker-1" });
  const measurement = {
    runId: "run-20260625-identity-90",
    tenant: overrides.tenant ?? "tenant-a",
    parentPrincipal: overrides.parentPrincipal ?? { kind: "user", id: "user:platform-admin" },
    codeVersion: { digest: CODE_DIGEST, version: "git:hobo-90" },
    componentImageDigest: IMAGE_DIGEST,
    hostId: "host-firecracker-1",
    issuedAt: "2026-06-25T17:44:30.000Z",
    expiresAt: "2026-06-25T17:46:00.000Z",
    nonce: "nonce-hoBO-90",
    isolationTier: "firecracker-microvm",
  };
  const document = attestor.createDocument({
    launchMeasurement: measurement,
    claimed: {
      tenant: "tenant-b",
      parentPrincipal: { kind: "user", id: "user:tenant-b-admin" },
    },
  });

  return verifyWorkloadAttestation(document, {
    knownImageDigests: [IMAGE_DIGEST],
    hostPublicKeys: attestor.publicKeys(),
    now: NOW,
  });
}

function deterministicIds(prefix) {
  let next = 1;
  return () => `${prefix}-${next++}`;
}
