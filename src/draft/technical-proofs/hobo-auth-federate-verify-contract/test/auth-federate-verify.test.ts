import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  createFixtureIdentityProvider,
  createHoboAuthVerifier,
  requireTenantAccess,
} from "../src/auth-federate-verify.js";

const NOW = 1_767_156_100;
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function createVerifier(overrides = {}) {
  return createHoboAuthVerifier({
    authPort: {
      issuer: "https://idp.example.test",
      audience: "hobo-app://shop",
      algorithms: ["RS256"],
      jwks: overrides.jwks,
      tenantClaim: "app_tenant",
      subjectClaim: "sub",
      roleClaim: "roles",
      scopeClaim: "scp",
      providers: ["workos", "customJwt"],
    },
    now: () => NOW,
    eventSink: overrides.eventSink,
  });
}

test("verifies a fixture IdP JWT through JWKS into ctx.user and user.Authenticated", async () => {
  const idp = createFixtureIdentityProvider({
    issuer: "https://idp.example.test",
    keyId: "kid-2026-06",
  });
  const events = [];
  const token = await idp.signJwt({
    sub: "user_123",
    aud: "hobo-app://shop",
    app_tenant: "tenant-acme",
    roles: ["buyer"],
    scp: ["orders:read"],
    exp: NOW + 300,
    nbf: NOW - 30,
    iat: NOW - 30,
  });

  const result = await createVerifier({
    jwks: idp.jwks(),
    eventSink: (event) => events.push(event),
  }).verifyRequest({
    token,
    provider: "workos",
    sessionId: "session-user-123",
    requestId: "req-auth-1",
  });

  assert.equal(result.ok, true, result.error);
  assert.deepEqual(result.ctx.user, {
    kind: "user",
    id: "user_123",
    provider: "workos",
    roles: ["buyer"],
    scopes: ["orders:read"],
    tenant: { app: "tenant-acme" },
    claims: {
      aud: "hobo-app://shop",
      app_tenant: "tenant-acme",
      exp: NOW + 300,
      iat: NOW - 30,
      iss: "https://idp.example.test",
      nbf: NOW - 30,
      roles: ["buyer"],
      scp: ["orders:read"],
      sub: "user_123",
    },
  });
  assert.deepEqual(result.ctx.tenant, {
    kind: "resolved",
    value: "tenant-acme",
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "user.Authenticated");
  assert.equal(events[0].data.provider, "workos");
  assert.deepEqual(events[0].data.principal, { kind: "user", id: "user_123" });
  assert.equal(events[0].actor.id, "user_123");
});

test("rejects expired, wrong issuer, wrong audience, tampered, alg none, and HS tokens", async () => {
  const idp = createFixtureIdentityProvider({
    issuer: "https://idp.example.test",
    keyId: "kid-2026-06",
  });
  const verifier = createVerifier({ jwks: idp.jwks() });
  const validClaims = {
    sub: "user_123",
    aud: "hobo-app://shop",
    app_tenant: "tenant-acme",
    exp: NOW + 300,
    nbf: NOW - 30,
    iat: NOW - 30,
  };
  const valid = await idp.signJwt(validClaims);

  await assertRejectsCode(
    verifier.verifyRequest({ token: await idp.signJwt({ ...validClaims, exp: NOW - 1 }) }),
    "token-expired",
  );
  await assertRejectsCode(
    verifier.verifyRequest({
      token: await idp.signJwt({ ...validClaims, iss: "https://evil.example.test" }),
    }),
    "issuer-mismatch",
  );
  await assertRejectsCode(
    verifier.verifyRequest({
      token: await idp.signJwt({ ...validClaims, aud: "hobo-app://other" }),
    }),
    "audience-mismatch",
  );
  await assertRejectsCode(verifier.verifyRequest({ token: tamperSignature(valid) }), "bad-signature");
  await assertRejectsCode(
    verifier.verifyRequest({ token: idp.makeUnsignedJwt(validClaims) }),
    "unsupported-alg",
  );
  await assertRejectsCode(
    verifier.verifyRequest({ token: idp.signHmacJwt(validClaims, "shared-secret") }),
    "unsupported-alg",
  );
  await assertRejectsCode(
    verifier.verifyRequest({ token: valid, provider: "unconfigured-idp" }),
    "provider-unconfigured",
  );
});

test("fails closed when tenancy claim is missing and never grants all tenants", async () => {
  const idp = createFixtureIdentityProvider({
    issuer: "https://idp.example.test",
    keyId: "kid-2026-06",
  });
  const verifier = createVerifier({ jwks: idp.jwks() });
  const token = await idp.signJwt({
    sub: "user_123",
    aud: "hobo-app://shop",
    exp: NOW + 300,
    nbf: NOW - 30,
    iat: NOW - 30,
  });

  const result = await verifier.verifyRequest({ token });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, "tenant-claim-missing");
  assert.deepEqual(result.ctx?.tenant, undefined);
});

test("keeps key rotation overlap valid for any published kid", async () => {
  const idp = createFixtureIdentityProvider({
    issuer: "https://idp.example.test",
    keyId: "kid-old",
  });
  const oldToken = await idp.signJwt({
    sub: "user_123",
    aud: "hobo-app://shop",
    app_tenant: "tenant-acme",
    exp: NOW + 300,
    nbf: NOW - 30,
    iat: NOW - 30,
  });
  const rotated = idp.rotate("kid-new");
  const newToken = await rotated.signJwt({
    sub: "user_456",
    aud: "hobo-app://shop",
    app_tenant: "tenant-acme",
    exp: NOW + 300,
    nbf: NOW - 30,
    iat: NOW - 30,
  });
  const verifier = createVerifier({ jwks: rotated.jwks() });

  assert.equal((await verifier.verifyRequest({ token: oldToken })).ctx.user.id, "user_123");
  assert.equal((await verifier.verifyRequest({ token: newToken })).ctx.user.id, "user_456");
});

test("tenant access is limited to the verified ctx.tenant", async () => {
  const idp = createFixtureIdentityProvider({
    issuer: "https://idp.example.test",
    keyId: "kid-2026-06",
  });
  const token = await idp.signJwt({
    sub: "user_123",
    aud: "hobo-app://shop",
    app_tenant: "tenant-acme",
    exp: NOW + 300,
    nbf: NOW - 30,
    iat: NOW - 30,
  });
  const { ctx } = await createVerifier({ jwks: idp.jwks() }).verifyRequest({ token });

  assert.equal(requireTenantAccess(ctx, "tenant-acme"), true);
  assert.throws(() => requireTenantAccess(ctx, "tenant-globex"), /tenant access denied/);
  assert.throws(() => requireTenantAccess({ user: ctx.user }, "tenant-acme"), /tenant unresolved/);
});

test("publishes the typed ctx.user and verifier declaration surface", async () => {
  const declaration = await readFile(
    path.join(packageRoot, "src", "auth-federate-verify.d.ts"),
    "utf8",
  );

  assert.match(declaration, /export interface HoboAuthContext/);
  assert.match(declaration, /readonly user: HoboAuthUser/);
  assert.match(declaration, /readonly tenant: ResolvedTenantContext/);
  assert.match(declaration, /verifyRequest/);
  assert.match(declaration, /requireTenantAccess/);
});

async function assertRejectsCode(promise, code) {
  const result = await promise;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, code);
}

function tamperSignature(token) {
  const parts = token.split(".");
  const signature = parts[2];
  const replacement = signature.startsWith("A") ? "B" : "A";
  parts[2] = `${replacement}${signature.slice(1)}`;
  return parts.join(".");
}
