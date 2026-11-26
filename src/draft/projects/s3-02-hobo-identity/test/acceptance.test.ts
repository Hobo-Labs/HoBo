import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  createFixtureHostAttestor,
  IdentityService,
} from "../src/index.js";
import { type JsonObject } from "../src/json.js";


const ISSUER_URL = "https://identity.yard.example";
const NOW = "2026-06-25T15:00:00.000Z";
const IMAGE_DIGEST = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CODE_DIGEST = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function launchMeasurement(overrides: JsonObject = {}) {
  return {
    runId: "run-20260625-identity-628",
    tenant: "tenant-a",
    parentPrincipal: { kind: "user", id: "user:platform-admin" },
    codeVersion: { digest: CODE_DIGEST, version: "git:628-identity" },
    componentImageDigest: IMAGE_DIGEST,
    hostId: "host-firecracker-1",
    issuedAt: "2026-06-25T14:59:30.000Z",
    expiresAt: "2026-06-25T15:01:00.000Z",
    nonce: "nonce-hobo-628",
    isolationTier: "firecracker-microvm",
    ...overrides,
  };
}

function attestedDocument(overrides: {
  measurement?: JsonObject;
  claimed?: JsonObject;
} = {}) {
  const attestor = createFixtureHostAttestor({ hostId: "host-firecracker-1" });
  return {
    document: attestor.createDocument({
      launchMeasurement: launchMeasurement(overrides.measurement),
      claimed: overrides.claimed ?? {
        tenant: "tenant-a",
        parentPrincipal: { kind: "user", id: "user:platform-admin" },
      },
    }),
    hostPublicKeys: attestor.publicKeys(),
  };
}

describe("S3-02 identity acceptance (BDD)", () => {
  it("Given attested workload When issue Then JWT-SVID + identity.Issued", async () => {
    const service = new IdentityService({
      issuerUrl: ISSUER_URL,
      genesisKeyId: "yard-genesis-2026-07",
    });
    const { document, hostPublicKeys } = attestedDocument();

    const result = await service.issueSvidFromAttestation({
      attestationDocument: document,
      requestedScope: { port: "database", resource: "shop.db", verbs: ["write"] },
      audience: "hobo-gateway",
      agentName: "deployer",
      hostPublicKeys,
      knownImageDigests: [IMAGE_DIGEST],
      now: NOW,
    });

    expect(result.status).toBe("issued");
    if (result.status !== "issued") return;

    expect(result.svid.subject).toBe("spiffe://yard/tenant-a/agent/deployer");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.type).toBe("identity.Issued");
    expect(result.events[0]?.data.svidRef).toMatch(/^tokenref:\/\/identity\/svid\//);

    const gateway = await service.authenticateAtGateway({
      token: result.token,
      audience: "hobo-gateway",
      now: NOW,
    });
    expect(gateway.status).toBe("authenticated");
  });

  it("Given issued SVID When rotate inside grace Then identity.Rotated and old token still verifies", async () => {
    const service = new IdentityService({
      issuerUrl: ISSUER_URL,
      genesisKeyId: "yard-genesis-2026-07",
      ttlSeconds: 900,
      renewalGraceSeconds: 300,
    });
    const { document, hostPublicKeys } = attestedDocument();
    const audience = "hobo-broker";
    const issued = await service.issueSvidFromAttestation({
      attestationDocument: document,
      requestedScope: { port: "database", resource: "shop.db", verbs: ["write"] },
      audience,
      agentName: "deployer",
      hostPublicKeys,
      knownImageDigests: [IMAGE_DIGEST],
      now: NOW,
    });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;

    const rotateAt = "2026-06-25T15:14:30.000Z";
    const rotated = await service.rotateSvid({
      identityId: issued.svid.identityId,
      now: rotateAt,
      nextKeyId: "yard-rollover-2026-07",
    });

    expect(rotated.status).toBe("rotated");
    if (rotated.status !== "rotated") return;
    expect(rotated.events[0]?.type).toBe("identity.Rotated");

    const oldStillValid = await service.authenticateAtGateway({
      token: issued.token,
      audience,
      now: rotateAt,
    });
    expect(oldStillValid.status).toBe("authenticated");

    const newValid = await service.authenticateAtGateway({
      token: rotated.token,
      audience,
      now: rotateAt,
    });
    expect(newValid.status).toBe("authenticated");
  });

  it("Given OIDC discovery When gateway verifies Then JWKS validates JWT-SVID", async () => {
    const service = new IdentityService({
      issuerUrl: ISSUER_URL,
      genesisKeyId: "yard-genesis-2026-07",
    });

    expect(service.discovery()).toEqual({
      issuer: ISSUER_URL,
      jwks_uri: `${ISSUER_URL}/.well-known/jwks.json`,
      id_token_signing_alg_values_supported: ["RS256"],
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
    });
    expect(service.jwks().keys.length).toBeGreaterThan(0);
  });
});

describe("S3-02 identity adversarial guards", () => {
  it("denies unattested workload without minting SVID or identity.Issued", async () => {
    const service = new IdentityService({
      issuerUrl: ISSUER_URL,
      genesisKeyId: "yard-genesis-2026-07",
    });
    const { document } = attestedDocument();
    const tampered = {
      ...document,
      hostSignature: { ...document.hostSignature, value: "00".repeat(32) },
    };

    const result = await service.issueSvidFromAttestation({
      attestationDocument: tampered,
      requestedScope: { port: "database", resource: "shop.db", verbs: ["write"] },
      audience: "hobo-gateway",
      agentName: "deployer",
      hostPublicKeys: attestedDocument().hostPublicKeys,
      knownImageDigests: [IMAGE_DIGEST],
      now: NOW,
    });

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("host-signature-invalid");
    expect(service.getAuditEvents()).toHaveLength(0);
  });

  it("binds tenant from measured launch when caller claims differ", async () => {
    const service = new IdentityService({
      issuerUrl: ISSUER_URL,
      genesisKeyId: "yard-genesis-2026-07",
    });
    const { document, hostPublicKeys } = attestedDocument({
      claimed: { tenant: "tenant-evil" },
    });

    const result = await service.issueSvidFromAttestation({
      attestationDocument: document,
      requestedScope: { port: "database", resource: "shop.db", verbs: ["write"] },
      audience: "hobo-gateway",
      agentName: "deployer",
      hostPublicKeys,
      knownImageDigests: [IMAGE_DIGEST],
      now: NOW,
    });

    expect(result.status).toBe("issued");
    if (result.status !== "issued") return;
    expect(result.svid.subject).toBe("spiffe://yard/tenant-a/agent/deployer");
  });

  it("denies scope widening during rotation", async () => {
    const service = new IdentityService({
      issuerUrl: ISSUER_URL,
      genesisKeyId: "yard-genesis-2026-07",
      ttlSeconds: 900,
      renewalGraceSeconds: 300,
    });
    const { document, hostPublicKeys } = attestedDocument();
    const issued = await service.issueSvidFromAttestation({
      attestationDocument: document,
      requestedScope: { port: "database", resource: "shop.db", verbs: ["write"] },
      audience: "hobo-gateway",
      agentName: "deployer",
      hostPublicKeys,
      knownImageDigests: [IMAGE_DIGEST],
      now: NOW,
    });
    expect(issued.status).toBe("issued");
    if (issued.status !== "issued") return;

    const denied = await service.rotateSvidWithScope({
      identityId: issued.svid.identityId,
      requestedScope: { port: "database", resource: "shop.db", verbs: ["write", "delete"] },
      now: "2026-06-25T15:14:30.000Z",
    });

    expect(denied.status).toBe("denied");
    expect(denied.reason).toBe("scope-widening-requires-live-identity");
  });

  it("denies expired attestation documents", async () => {
    const service = new IdentityService({
      issuerUrl: ISSUER_URL,
      genesisKeyId: "yard-genesis-2026-07",
    });
    const { document, hostPublicKeys } = attestedDocument({
      measurement: {
        issuedAt: "2026-06-25T14:50:00.000Z",
        expiresAt: "2026-06-25T14:59:00.000Z",
      },
    });

    const result = await service.issueSvidFromAttestation({
      attestationDocument: document,
      requestedScope: { port: "database", resource: "shop.db", verbs: ["write"] },
      audience: "hobo-gateway",
      agentName: "deployer",
      hostPublicKeys,
      knownImageDigests: [IMAGE_DIGEST],
      now: NOW,
    });

    expect(result.status).toBe("denied");
    expect(result.reason).toBe("launch-measurement-expired");
  });
});

describe("IdentityServiceBoundary pact", () => {
  it("loads consumer/provider names and contract evidence satisfies the boundary pact", () => {
    const pactPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "contracts",
      "identity-boundary.pact.json",
    );
    const pact = JSON.parse(readFileSync(pactPath, "utf8"));
    const service = new IdentityService({
      issuerUrl: ISSUER_URL,
      genesisKeyId: "yard-genesis-2026-07",
    });

    expect(pact.consumer.name).toBe("@hobo/gateway");
    expect(pact.provider.name).toBe("IdentityServiceBoundary");
    expect(pact.interactions[0]?.response.body).toEqual(service.contractEvidence());
  });
});
