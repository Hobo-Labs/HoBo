import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "vitest";

import {
  AUTH_CONSUMER_CONTRACT_SCHEMA_VERSION,
  JWT_VERIFICATION_GAP,
  assertAuthFixtureSatisfiesContract,
  canonicalCanDeployContractBytes,
  canonicalDevContractBytes,
  defineAuthConsumerContract,
  generateDevPrincipalFixture,
  requireGrantedCapability,
} from "../src/auth-consumer-contract.js";

function sampleContract(overrides = {}) {
  return {
    port: "hobo:auth",
    subject: {
      kind: "user",
      idClaim: "sub",
      requiredClaims: {
        sub: { type: "string" },
        email: { type: "string" },
        plan: { enum: ["free", "pro", "enterprise"] },
      },
      requiredRoles: ["deployer"],
      requiredScopes: ["orders:read"],
      tenancy: {
        platformTenant: "platform-acme",
        appTenantClaim: "tenant",
        defaultAppTenant: "app-acme",
      },
    },
    sessionOverrides: {
      roles: ["auditor", "deployer"],
      tenants: ["app-acme", "app-beta"],
      claims: {
        plan: ["free", "pro", "enterprise"],
      },
    },
    grantedCapabilities: [
      {
        port: "hobo:data",
        resource: "orders",
        actions: ["read"],
      },
    ],
    canDeployGate: {
      fixtureIdpSuite: "fixture-idp-jwks-can-deploy",
    },
    ...overrides,
  };
}

describe("hobo:auth consumer-driven contract", () => {
  it("generates an offline fixture principal that satisfies the auth port contract", () => {
    const contract = defineAuthConsumerContract(sampleContract());
    const fixture = generateDevPrincipalFixture(contract);

    assert.equal(contract.schemaVersion, AUTH_CONSUMER_CONTRACT_SCHEMA_VERSION);
    assert.equal(fixture.source, "contract-asserted-dev-principal");
    assert.equal(fixture.authPort, "hobo:auth");
    assert.equal(fixture.ctxUser.kind, "user");
    assert.equal(fixture.ctxUser.claims.email, "fixture@example.test");
    assert.equal(assertAuthFixtureSatisfiesContract(contract, fixture), true);
  });

  it("applies per-session role and tenant overrides while preserving a valid ctx.user", () => {
    const contract = defineAuthConsumerContract(sampleContract());
    const fixture = generateDevPrincipalFixture(contract, {
      roles: ["auditor"],
      tenant: "app-beta",
      claims: {
        plan: "enterprise",
      },
    });

    assert.deepEqual(fixture.ctxUser.roles, ["auditor", "deployer"]);
    assert.equal(fixture.ctxUser.tenant.platform, "platform-acme");
    assert.equal(fixture.ctxUser.tenant.app, "app-beta");
    assert.equal(fixture.ctxUser.claims.plan, "enterprise");
    assert.equal(assertAuthFixtureSatisfiesContract(contract, fixture), true);
  });

  it("rejects fixture shapes and overrides that violate the contract", () => {
    const contract = defineAuthConsumerContract(sampleContract());

    assert.throws(
      () => generateDevPrincipalFixture(contract, { roles: ["org-admin"] }),
      /role override 'org-admin' is outside the auth contract/,
    );

    assert.throws(
      () => generateDevPrincipalFixture(contract, { tenant: "app-evil" }),
      /tenant override 'app-evil' is outside the auth contract/,
    );

    const tampered = generateDevPrincipalFixture(contract);
    tampered.ctxUser.claims.email = undefined;

    assert.throws(
      () => assertAuthFixtureSatisfiesContract(contract, tampered),
      /claim 'email' must be a string/,
    );
  });

  it("uses byte-identical contract bytes for hobo dev and can-deploy", () => {
    const contract = defineAuthConsumerContract(sampleContract());

    assert.equal(canonicalDevContractBytes(contract), canonicalCanDeployContractBytes(contract));
  });

  it("does not let dev auth bypass grant unlinked capabilities", () => {
    const contract = defineAuthConsumerContract(sampleContract());
    const fixture = generateDevPrincipalFixture(contract);

    assert.equal(
      requireGrantedCapability(contract, fixture, {
        port: "hobo:data",
        resource: "orders",
        action: "read",
      }),
      true,
    );

    assert.throws(
      () =>
        requireGrantedCapability(contract, fixture, {
          port: "hobo:data",
          resource: "orders",
          action: "delete",
        }),
      /capability call denied by default/,
    );
  });

  it("documents the honest JWT verification gap instead of asserting it in the contract", () => {
    const contract = defineAuthConsumerContract(sampleContract());

    assert.deepEqual(contract.verificationBoundary.notAssertedByContract, JWT_VERIFICATION_GAP);
    assert.match(contract.verificationBoundary.requiredGate, /fixture-idp/);

    assert.throws(
      () =>
        defineAuthConsumerContract(
          sampleContract({
            jwtVerification: {
              issuer: "https://idp.example.test",
              jwksUrl: "https://idp.example.test/jwks.json",
              alg: "RS256",
            },
          }),
        ),
      /JWT verification fields belong to the fixture IdP gate/,
    );
  });

  it("publishes schema and typed declaration artifacts for the contract surface", async () => {
    const schemaPath = join(
      import.meta.dirname,
      "..",
      "schema",
      "auth-consumer-contract.v1.schema.json",
    );
    const schema = JSON.parse(await readFile(schemaPath, "utf8"));
    const declaration = await readFile(
      new URL("../src/auth-consumer-contract.d.ts", import.meta.url),
      "utf8",
    );

    assert.equal(schema.$id, "https://hobo.dev/schemas/auth/consumer-contract.v1.json");
    assert.equal(schema.properties.port.const, "hobo:auth");
    assert.match(declaration, /export interface AuthConsumerContract/);
    assert.match(declaration, /export function generateDevPrincipalFixture/);
  });
});
