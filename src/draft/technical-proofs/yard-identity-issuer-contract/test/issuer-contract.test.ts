import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  bootstrapIdentityIssuer,
  createInMemoryKms,
  verifyJwtWithJwks
} from "../src/issuer.js";

const issuerUrl = "https://identity.prod-yard.example";

function baseClaims(overrides = {}) {
  return {
    sub: "spiffe://yard/acme/agent/deployer",
    aud: "acme-cloud",
    tenant: "acme",
    parentPrincipal: "user:platform-admin",
    codeVersion: "sha256:1234",
    scope: [{ port: "database", resource: "shop.db", verbs: ["write"] }],
    exp: 1_893_456_000,
    nbf: 1_767_156_000,
    iat: 1_767_156_000,
    ...overrides
  };
}

describe("Yard Identity issuer/JWKS contract", () => {
  it("serves OIDC discovery and JWKS that verify a genesis-key JWT-SVID", async () => {
    const kms = createInMemoryKms();
    const issuer = bootstrapIdentityIssuer({
      issuerUrl,
      kms,
      genesisKeyId: "yard-genesis-2026-06",
      seedCredential: { canGenerateGenesisKey: true }
    });

    assert.deepEqual(issuer.discovery(), {
      issuer: issuerUrl,
      jwks_uri: `${issuerUrl}/.well-known/jwks.json`,
      id_token_signing_alg_values_supported: ["RS256"],
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"]
    });

    const token = await issuer.signJwtSvid(baseClaims());
    const verified = await verifyJwtWithJwks(token, issuer.jwks(), {
      issuer: issuerUrl,
      audience: "acme-cloud",
      now: 1_767_156_100
    });

    assert.equal(verified.header.kid, "yard-genesis-2026-06");
    assert.equal(verified.claims.iss, issuerUrl);
    assert.equal(verified.claims.sub, "spiffe://yard/acme/agent/deployer");
    assert.equal(verified.claims.tenant, "acme");
  });

  it("keeps issuer URL and genesis key stable across seed to self-deploy handoff", async () => {
    const kms = createInMemoryKms();
    const seedIssuer = bootstrapIdentityIssuer({
      issuerUrl,
      kms,
      genesisKeyId: "yard-genesis-2026-06",
      seedCredential: { canGenerateGenesisKey: true }
    });

    const seedToken = await seedIssuer.signJwtSvid(baseClaims());
    const selfDeployed = seedIssuer.selfDeploy({
      issuerUrl,
      genesisKeyId: "yard-genesis-2026-06"
    });

    assert.equal(selfDeployed.discovery().issuer, issuerUrl);
    await assert.doesNotReject(() =>
      verifyJwtWithJwks(seedToken, selfDeployed.jwks(), {
        issuer: issuerUrl,
        audience: "acme-cloud",
        now: 1_767_156_100
      })
    );

    assert.throws(
      () => seedIssuer.selfDeploy({ issuerUrl: "https://identity.rebuilt.example", genesisKeyId: "yard-genesis-2026-06" }),
      /issuer continuity/i
    );
    assert.throws(
      () => seedIssuer.selfDeploy({ issuerUrl, genesisKeyId: "fresh-root" }),
      /genesis key continuity/i
    );
  });

  it("keeps old and new kids in JWKS during signing-key rollover", async () => {
    const kms = createInMemoryKms();
    const issuer = bootstrapIdentityIssuer({
      issuerUrl,
      kms,
      genesisKeyId: "yard-genesis-2026-06",
      seedCredential: { canGenerateGenesisKey: true }
    });

    const oldToken = await issuer.signJwtSvid(baseClaims({ aud: "registry" }));
    const rolled = issuer.rotateSigningKey("yard-rollover-2026-07");
    const newToken = await rolled.signJwtSvid(baseClaims({ aud: "registry" }));
    const overlapJwks = rolled.jwks();

    assert.deepEqual(
      overlapJwks.keys.map((key) => key.kid).sort(),
      ["yard-genesis-2026-06", "yard-rollover-2026-07"]
    );

    const oldVerified = await verifyJwtWithJwks(oldToken, overlapJwks, {
      issuer: issuerUrl,
      audience: "registry",
      now: 1_767_156_100
    });
    const newVerified = await verifyJwtWithJwks(newToken, overlapJwks, {
      issuer: issuerUrl,
      audience: "registry",
      now: 1_767_156_100
    });

    assert.equal(oldVerified.header.kid, "yard-genesis-2026-06");
    assert.equal(newVerified.header.kid, "yard-rollover-2026-07");
  });

  it("serves air-gapped keys without phone-home and keeps durable signing key non-exportable", async () => {
    let phoneHomeAttempts = 0;
    const kms = createInMemoryKms();
    const issuer = bootstrapIdentityIssuer({
      issuerUrl,
      kms,
      genesisKeyId: "yard-genesis-2026-06",
      mode: "airgap",
      network: {
        fetch: async () => {
          phoneHomeAttempts += 1;
          throw new Error("egress forbidden");
        }
      },
      seedCredential: { canGenerateGenesisKey: true }
    });

    assert.deepEqual(issuer.profile(), { mode: "airgap", egress: "disabled" });
    assert.equal(issuer.discovery().jwks_uri, `${issuerUrl}/.well-known/jwks.json`);
    assert.equal(issuer.jwks().keys.length, 1);
    await issuer.signJwtSvid(baseClaims());

    assert.equal(phoneHomeAttempts, 0);
    assert.throws(() => kms.exportPrivateKey("yard-genesis-2026-06"), /non-exportable/i);
  });
});
