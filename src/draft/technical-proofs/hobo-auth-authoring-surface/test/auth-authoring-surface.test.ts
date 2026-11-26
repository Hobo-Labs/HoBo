import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { beforeAll, describe, it } from "vitest";
import { fileURLToPath } from "node:url";

import {
  auth,
  buildAuthManifestEntry,
  emitAuthConsumerContract,
  evaluateAuthCanDeploy,
  generateAuthSurfaceDeclaration,
} from "../src/auth-authoring-surface.js";
import { generateDevPrincipalFixture } from "../../hobo-auth-consumer-contract/src/auth-consumer-contract.js";

/** Same contract as `packages/cli/test/support/slow.ts` — root draft shards ignore package vitest.config. */
function slow(ms: number): number {
  const floor = Number(process.env.HOBO_TEST_TIMEOUT);
  return Number.isFinite(floor) && floor > ms ? floor : ms;
}

const TYPECHECK_HOOK_MS = slow(60_000);

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tscPath = path.resolve(
  packageRoot,
  "..",
  "..",
  "..",
  "..",
  "node_modules",
  "typescript",
  "bin",
  "tsc",
);

type TypeDeclarationCheckResult = {
  status: number | null;
  stdout: string;
  stderr: string;
};

/** One `tsc --noEmit` per file — cold spawn under memory contention exceeded 10s (run 43207388098). */
let typeDeclarationCheck!: TypeDeclarationCheckResult;

beforeAll(() => {
  const result = spawnSync(
    process.execPath,
    [tscPath, "--noEmit", "--project", "tsconfig.types.json"],
    {
      cwd: packageRoot,
      encoding: "utf8",
      shell: false,
      timeout: TYPECHECK_HOOK_MS - 1_000,
      killSignal: "SIGTERM",
    },
  );
  typeDeclarationCheck = {
    status: result.status,
    stdout: `${result.stdout ?? ""}`,
    stderr: `${result.stderr ?? ""}`,
  };
}, TYPECHECK_HOOK_MS);

function declareAppAuth(overrides = {}) {
  return auth({
    providers: [
      auth.oidc({
        id: "google",
        issuer: "https://accounts.google.com",
      }),
      auth.customJwt({
        id: "shoo",
        issuer: "https://shoo.example",
        jwks: "https://shoo.example/.well-known/jwks.json",
        alg: "ES256",
      }),
      auth.builtin(),
    ],
    subject: {
      idClaim: "sub",
      claims: {
        sub: { type: "string" },
        email: { type: "string" },
        tenant: { type: "string" },
        plan: { enum: ["free", "pro"] },
      },
      roles: ["customer"],
      scopes: ["orders:read"],
      tenancy: {
        platformTenant: "platform-acme",
        appTenantClaim: "tenant",
        defaultAppTenant: "app-acme",
      },
    },
    sessionOverrides: {
      roles: ["customer", "support"],
      tenants: ["app-acme", "app-beta"],
      claims: {
        plan: ["free", "pro"],
      },
    },
    grantedCapabilities: [
      {
        port: "hobo:data",
        resource: "orders",
        actions: ["read"],
      },
    ],
    ...overrides,
  });
}

describe("hobo:auth authoring surface", { timeout: TYPECHECK_HOOK_MS }, () => {
  it("lowers oidc, customJwt, and builtin providers into a secret-free manifest auth entry", () => {
    const declaration = declareAppAuth();
    const manifestEntry = buildAuthManifestEntry(declaration);

    assert.equal(manifestEntry.type, "auth.v1");
    assert.equal(manifestEntry.port, "hobo:auth");
    assert.deepEqual(
      manifestEntry.providers.map((provider) => provider.id),
      ["google", "shoo", "builtin"],
    );
    assert.deepEqual(manifestEntry.providers[0].verification, {
      issuer: "https://accounts.google.com",
      jwks: "https://accounts.google.com/.well-known/jwks.json",
      alg: "RS256",
    });
    assert.deepEqual(manifestEntry.providers[1].verification, {
      issuer: "https://shoo.example",
      jwks: "https://shoo.example/.well-known/jwks.json",
      alg: "ES256",
    });
    assert.deepEqual(manifestEntry.providers[2], {
      id: "builtin",
      kind: "builtin",
      environment: ["air-gap", "dev"],
      productionEligible: false,
      verification: {
        issuer: "urn:hobo:dev-builtin",
        jwks: "urn:hobo:dev-builtin:jwks",
        alg: "HOBO-BUILTIN-FIXTURE",
      },
    });
    assert.doesNotMatch(JSON.stringify(manifestEntry), /secret|password|token/i);
  });

  it("emits the consumer-driven auth contract used by can-deploy and dev fixtures", () => {
    const declaration = declareAppAuth();
    const contract = emitAuthConsumerContract(declaration, {
      fixtureIdpSuite: "fixture-idp-jwks-can-deploy",
    });
    const fixture = generateDevPrincipalFixture(contract, {
      roles: ["support"],
      tenant: "app-beta",
      claims: {
        plan: "pro",
      },
    });

    assert.equal(contract.port, "hobo:auth");
    assert.equal(contract.subject.kind, "user");
    assert.equal(contract.subject.tenancy.appTenantClaim, "tenant");
    assert.equal(fixture.ctxUser.tenant.app, "app-beta");
    assert.equal(fixture.ctxUser.claims.plan, "pro");
    assert.equal(contract.verificationBoundary.requiredGate, "fixture-idp-jwks-can-deploy");
  });

  it("generates typed client and server auth surface declarations", () => {
    const declaration = generateAuthSurfaceDeclaration(declareAppAuth(), {
      interfaceName: "ShopAuthSurface",
    });

    assert.match(declaration, /type AuthProviderId = "google" \| "shoo" \| "builtin";/);
    assert.match(declaration, /useAuth\(\): AuthState/);
    assert.match(declaration, /signIn\(provider: AuthProviderId\): Promise<void>/);
    assert.match(declaration, /signOut\(\): Promise<void>/);
    assert.match(declaration, /readonly user: PrincipalRef/);
    assert.match(declaration, /readonly tenant: AppTenantContext/);
  });

  it("rejects unsafe customJwt declarations and builtin-only production deploys", () => {
    assert.throws(
      () =>
        auth.customJwt({
          id: "unsafe",
          issuer: "https://issuer.example",
          jwks: "https://issuer.example/jwks.json",
          alg: "none",
        }),
      /alg:none/i,
    );
    assert.throws(
      () =>
        auth.customJwt({
          id: "missing-jwks",
          issuer: "https://issuer.example",
          alg: "RS256",
        }),
      /jwks/i,
    );

    const builtinOnly = auth({
      providers: [auth.builtin()],
      subject: declareAppAuth().subject,
      grantedCapabilities: [],
    });

    assert.deepEqual(evaluateAuthCanDeploy(builtinOnly, { target: "dev" }), {
      ok: true,
      target: "dev",
      reason: "dev-or-air-gap-builtin-provider",
    });
    assert.deepEqual(evaluateAuthCanDeploy(builtinOnly, { target: "production" }), {
      ok: false,
      target: "production",
      reason: "builtin-auth-provider-is-not-production-eligible",
    });
  });

  it("marks unresolved tenancy as fail-closed for downstream tenant enforcement", () => {
    const manifestEntry = buildAuthManifestEntry(declareAppAuth());

    assert.deepEqual(manifestEntry.tenancy, {
      claim: "tenant",
      defaultTenant: "app-acme",
      unresolved: "fail-closed",
      enforcementMarker: "ctx.tenant.required",
    });
  });

  it("type declarations narrow providers and carry ctx.user claims", () => {
    assert.equal(
      typeDeclarationCheck.status,
      0,
      `${typeDeclarationCheck.stdout}\n${typeDeclarationCheck.stderr}`,
    );
  });
});
