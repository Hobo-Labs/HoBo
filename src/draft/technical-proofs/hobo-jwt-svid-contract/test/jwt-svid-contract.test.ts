import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "vitest";

import {
  parseJwtSvidClaims,
  parseJwtSvidCompact,
  parseSpiffeId,
} from "../src/jwt-svid.js";

const FIXTURE_TIME = 1_799_999_000;

function base64url(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function compactJwt(header, claims, signature = "fixture-signature") {
  return `${base64url(header)}.${base64url(claims)}.${Buffer.from(signature).toString("base64url")}`;
}

function sampleClaims(overrides = {}) {
  return {
    iss: "https://identity.prod-yard.example",
    sub: "spiffe://yard/acme/agent/deployer",
    aud: ["hobo-token-broker"],
    iat: FIXTURE_TIME - 60,
    nbf: FIXTURE_TIME - 30,
    exp: FIXTURE_TIME + 300,
    tenant: "acme",
    parentPrincipal: { kind: "user", id: "user_123" },
    codeVersion: {
      digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      version: "git:a1b2c3d",
    },
    scope: [
      {
        port: "wasi:blobstore/blobstore",
        resource: "profiles",
        verbs: ["read", "write"],
      },
      {
        port: "hobo:queue/queue",
        resource: "email-jobs",
        verbs: ["enqueue"],
      },
    ],
    ...overrides,
  };
}

describe("JWT-SVID contract", () => {
  it("publishes a versioned schema that includes the required claim set", async () => {
    const schemaPath = join(
      import.meta.dirname,
      "..",
      "schema",
      "jwt-svid.v1.schema.json",
    );
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));

    assert.equal(schema.$id, "https://hobo.dev/schemas/identity/jwt-svid.v1.json");
    assert.deepEqual(schema.required, [
      "iss",
      "sub",
      "aud",
      "exp",
      "nbf",
      "iat",
      "tenant",
      "parentPrincipal",
      "codeVersion",
      "scope",
    ]);
  });

  it("round-trips a signed compact JWT-SVID and exposes the SPIFFE identity", () => {
    const token = compactJwt({ alg: "ES256", kid: "yard-key-1" }, sampleClaims());

    const parsed = parseJwtSvidCompact(token, {
      expectedTenant: "acme",
      now: FIXTURE_TIME,
    });

    assert.equal(parsed.header.alg, "ES256");
    assert.equal(parsed.claims.tenant, "acme");
    assert.deepEqual(parsed.identity, {
      kind: "agent",
      trustDomain: "yard",
      tenant: "acme",
      agent: "deployer",
    });
    assert.deepEqual(parsed.claims.scope[0], {
      port: "wasi:blobstore/blobstore",
      resource: "profiles",
      verbs: ["read", "write"],
    });
  });

  it("parses workload and agent SPIFFE namespaces under the Yard trust domain", () => {
    assert.deepEqual(parseSpiffeId("spiffe://yard/acme/shop-api/web"), {
      kind: "workload",
      trustDomain: "yard",
      tenant: "acme",
      bindle: "shop-api",
      resource: "web",
    });

    assert.deepEqual(parseSpiffeId("spiffe://yard/acme/agent/deployer"), {
      kind: "agent",
      trustDomain: "yard",
      tenant: "acme",
      agent: "deployer",
    });
  });

  it("rejects tenant-confused or malformed SPIFFE identities", () => {
    assert.throws(
      () => parseSpiffeId("spiffe://yard/tenant-b/agent/deployer", { expectedTenant: "tenant-a" }),
      /tenant mismatch/i,
    );
    assert.throws(() => parseSpiffeId("spiffe://yard/acme/agent/"), /empty segment/i);
    assert.throws(() => parseSpiffeId("https://yard/acme/agent/deployer"), /spiffe/i);
    assert.throws(
      () => parseSpiffeId(`spiffe://yard/acme/${"a".repeat(129)}/web`),
      /too long/i,
    );
  });

  it("rejects alg:none, unsigned compact tokens, and expired claim windows", () => {
    assert.throws(
      () =>
        parseJwtSvidCompact(compactJwt({ alg: "none" }, sampleClaims()), {
          now: FIXTURE_TIME,
        }),
      /alg none/i,
    );

    assert.throws(
      () => parseJwtSvidCompact(`${base64url({ alg: "ES256" })}.${base64url(sampleClaims())}.`),
      /unsigned/i,
    );

    assert.throws(
      () =>
        parseJwtSvidClaims(sampleClaims({ exp: FIXTURE_TIME - 1 }), {
          expectedTenant: "acme",
          now: FIXTURE_TIME,
        }),
      /expired/i,
    );
  });

  it("enforces scoped claim shape and denies ambient admin grants", () => {
    assert.throws(
      () =>
        parseJwtSvidClaims(sampleClaims({ scope: [{ resource: "profiles", verbs: ["read"] }] }), {
          now: FIXTURE_TIME,
        }),
      /port/i,
    );

    assert.throws(
      () =>
        parseJwtSvidClaims(
          sampleClaims({
            scope: [{ port: "wasi:blobstore/blobstore", resource: "profiles", verbs: ["admin"] }],
          }),
          { now: FIXTURE_TIME },
        ),
      /admin/i,
    );

    assert.throws(
      () =>
        parseJwtSvidClaims(
          sampleClaims({
            scope: [
              {
                port: "wasi:blobstore/blobstore",
                resource: "profiles",
                verbs: ["read", "read"],
              },
            ],
          }),
          { now: FIXTURE_TIME },
        ),
      /duplicate/i,
    );
  });
});
