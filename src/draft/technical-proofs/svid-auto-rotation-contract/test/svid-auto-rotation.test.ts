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
  createSvidRotationService,
  isSvidAcceptedDuringRotation,
} from "../src/svid-rotation.js";

const ISSUER_URL = "https://identity.prod-yard.example";
const NOW = "2026-06-25T19:50:00.000Z";
const IMAGE_DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CODE_DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CURRENT_SCOPE = [
  { port: "database/main", resource: "shop.db", actions: ["read", "write"] },
  { port: "queue/main", resource: "orders", actions: ["enqueue"] },
];

describe("SVID auto-rotation contract", () => {
  it("rotates an expiring SVID before TTL expiry with continuous validity and identity.Rotated audit", async () => {
    const { issuer, service } = createFixtureRotationService();
    const currentSvid = createCurrentSvid({
      expiresAt: "2026-06-25T19:51:00.000Z",
      scope: CURRENT_SCOPE,
    });

    const result = await service.rotateIfDue({
      requestId: "rotate-before-expiry",
      agentName: "release-agent",
      audience: "acme-cloud",
      currentSvid,
      attestationVerdict: createAttestedVerdict(),
      inferredGrant: CURRENT_SCOPE,
    });

    assert.equal(result.ok, true);
    assert.equal(result.rotated, true);
    assert.equal(result.previousIdentityId, "svid-current");
    assert.equal(result.identityId, "rotated-svid-1");
    assert.equal(result.validity.gapFree, true);
    assert.deepEqual(result.scope, CURRENT_SCOPE);

    const verified = await verifyJwtWithJwks(result.token, issuer.jwks(), {
      issuer: ISSUER_URL,
      audience: "acme-cloud",
      now: Date.parse(NOW) / 1000,
    });
    assert.equal(verified.claims.sub, "spiffe://yard/tenant-a/agent/release-agent");
    assert.equal(verified.claims.tenant, "tenant-a");
    assert.deepEqual(verified.claims.scope, [
      { port: "database/main", resource: "shop.db", verbs: ["read", "write"] },
      { port: "queue/main", resource: "orders", verbs: ["enqueue"] },
    ]);

    const parsed = parseJwtSvidCompact(result.token, {
      expectedTenant: "tenant-a",
      now: Date.parse(NOW) / 1000,
    });
    assert.equal(parsed.identity.agent, "release-agent");

    assert.deepEqual(result.events.map((event) => event.type), ["identity.Rotated"]);
    assert.equal(result.events[0].data.previousIdentityId, "svid-current");
    assert.equal(result.events[0].data.svidRef, "identity://svid/rotated-svid-1");
    assert.equal(JSON.stringify(result.events).includes(result.token), false);

    assert.equal(isSvidAcceptedDuringRotation(result, currentSvid.svidRef, NOW), true);
    assert.equal(
      isSvidAcceptedDuringRotation(result, currentSvid.svidRef, "2026-06-25T19:50:36.000Z"),
      false,
    );
    assert.equal(
      isSvidAcceptedDuringRotation(result, result.svidRef, "2026-06-25T19:50:36.000Z"),
      true,
    );
  });

  it("caps rotated scope to the current SVID and inferred grant instead of widening", async () => {
    const { service } = createFixtureRotationService();

    const result = await service.rotateIfDue({
      requestId: "rotate-no-escalation",
      agentName: "release-agent",
      audience: "acme-cloud",
      currentSvid: createCurrentSvid({
        expiresAt: "2026-06-25T19:51:00.000Z",
        scope: [{ port: "database/main", resource: "shop.db", actions: ["read"] }],
      }),
      attestationVerdict: createAttestedVerdict(),
      requestedScope: [
        { port: "database/main", resource: "shop.db", actions: ["read", "write", "admin"] },
      ],
      inferredGrant: [
        { port: "database/main", resource: "shop.db", actions: ["read", "write", "admin"] },
      ],
    });

    assert.equal(result.ok, true);
    assert.deepEqual(result.scope, [
      { port: "database/main", resource: "shop.db", actions: ["read"] },
    ]);
  });

  it("refuses rotation when the workload lost attestation", async () => {
    const { service } = createFixtureRotationService();

    const result = await service.rotateIfDue({
      requestId: "rotate-lost-attestation",
      agentName: "release-agent",
      audience: "acme-cloud",
      currentSvid: createCurrentSvid({ expiresAt: "2026-06-25T19:51:00.000Z" }),
      attestationVerdict: {
        state: "unattested",
        reason: "host-signature-missing",
        policy: { isolationFloor: "firecracker-microvm", nonOverridable: true },
      },
      inferredGrant: CURRENT_SCOPE,
    });

    assert.deepEqual(result, {
      ok: false,
      rotated: false,
      requestId: "rotate-lost-attestation",
      reason: "workload-not-attested",
      events: [],
    });
  });

  it("fails closed instead of silently rotating across a changed code version", async () => {
    const { service } = createFixtureRotationService();

    const result = await service.rotateIfDue({
      requestId: "rotate-code-changed",
      agentName: "release-agent",
      audience: "acme-cloud",
      currentSvid: createCurrentSvid({
        expiresAt: "2026-06-25T19:51:00.000Z",
        codeVersion: { digest: CODE_DIGEST, version: "git:hobo-90" },
      }),
      attestationVerdict: createAttestedVerdict({
        codeVersion: {
          digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
          version: "git:hobo-99-new",
        },
      }),
      inferredGrant: CURRENT_SCOPE,
    });

    assert.equal(result.ok, false);
    assert.equal(result.rotated, false);
    assert.equal(result.reason, "attestation-code-version-changed");
    assert.equal(result.requiresReevaluation, true);
    assert.deepEqual(result.events, []);
  });

  it("fails before issuing a new SVID when the overlap window would contain a validity gap", async () => {
    const { service } = createFixtureRotationService({ overlapSeconds: 45 });

    const result = await service.rotateIfDue({
      requestId: "rotate-window-missed",
      agentName: "release-agent",
      audience: "acme-cloud",
      currentSvid: createCurrentSvid({ expiresAt: "2026-06-25T19:50:20.000Z" }),
      attestationVerdict: createAttestedVerdict(),
      inferredGrant: CURRENT_SCOPE,
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "rotation-overlap-window-missed");
    assert.deepEqual(result.events, []);
  });
});

function createFixtureRotationService(overrides = {}) {
  const kms = createInMemoryKms();
  const issuer = bootstrapIdentityIssuer({
    issuerUrl: ISSUER_URL,
    kms,
    genesisKeyId: "yard-genesis-2026-06",
    seedCredential: { canGenerateGenesisKey: true },
  });
  const service = createSvidRotationService({
    issuer,
    now: () => new Date(NOW),
    ttlSeconds: 300,
    rotateBeforeSeconds: 120,
    overlapSeconds: 30,
    skewToleranceSeconds: 5,
    idFactory: deterministicIds("rotated-svid"),
    ...overrides,
  });

  return { issuer, service };
}

function createCurrentSvid(overrides = {}) {
  const iat = Math.floor(Date.parse("2026-06-25T19:45:00.000Z") / 1000);
  const exp = Math.floor(Date.parse(overrides.expiresAt ?? "2026-06-25T19:55:00.000Z") / 1000);
  const scope = overrides.scope ?? CURRENT_SCOPE;
  const codeVersion = overrides.codeVersion ?? { digest: CODE_DIGEST, version: "git:hobo-90" };

  return {
    identityId: "svid-current",
    svidRef: "identity://svid/svid-current",
    scope,
    claims: {
      iss: ISSUER_URL,
      sub: "spiffe://yard/tenant-a/agent/release-agent",
      aud: "acme-cloud",
      tenant: "tenant-a",
      parentPrincipal: { kind: "user", id: "platform-admin" },
      codeVersion,
      scope: scope.map((grant) => ({
        port: grant.port,
        resource: grant.resource,
        verbs: [...grant.actions],
      })),
      iat,
      nbf: iat,
      exp,
    },
    issuedAt: new Date(iat * 1000).toISOString(),
    expiresAt: new Date(exp * 1000).toISOString(),
  };
}

function createAttestedVerdict(overrides = {}) {
  const attestor = createFixtureHostAttestor({ hostId: "host-firecracker-1" });
  const measurement = {
    runId: "run-20260625-identity-99",
    tenant: "tenant-a",
    parentPrincipal: { kind: "user", id: "user:platform-admin" },
    codeVersion: overrides.codeVersion ?? { digest: CODE_DIGEST, version: "git:hobo-90" },
    componentImageDigest: IMAGE_DIGEST,
    hostId: "host-firecracker-1",
    issuedAt: "2026-06-25T19:49:30.000Z",
    expiresAt: "2026-06-25T19:51:30.000Z",
    nonce: "nonce-hoBO-99",
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
