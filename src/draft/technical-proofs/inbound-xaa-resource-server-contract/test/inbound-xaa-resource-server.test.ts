import assert from "node:assert/strict";
import { test } from "vitest";

import { createHoboMcpServer } from "../../hobo-mcp-server-contract/src/mcp-server-contract.js";
import {
  createFixtureIdJagIssuer,
  createInboundXaaMcpBridge,
  createInboundXaaResourceServer,
} from "../src/inbound-xaa-resource-server.js";

const NOW = 1_799_999_000;
const APP_AUDIENCE = "hobo-app://shop";
const APP_RESOURCE = "urn:hobo:app:shop";
const ISSUER = "https://external-idp.example.test";

function createServer(overrides = {}) {
  return createInboundXaaResourceServer({
    app: {
      id: "shop",
      audience: APP_AUDIENCE,
      resource: APP_RESOURCE,
      allowedScopes: ["orders:read", "orders:write", "mcp:call"],
    },
    trustedIssuers: {
      [ISSUER]: overrides.jwks,
    },
    now: () => NOW,
    idFactory: deterministicIds(),
    eventSink: overrides.eventSink,
    policyGate: overrides.policyGate,
  });
}

function validAssertion(issuer, overrides = {}) {
  return issuer.signIdJag({
    issuer: ISSUER,
    subjectId: "external-agent:claude",
    subject: {
      kind: "agent",
      id: "external-agent:claude",
      delegatedBy: { kind: "user", id: "user:pat" },
    },
    audience: APP_AUDIENCE,
    resource: APP_RESOURCE,
    clientId: "external-agent:claude",
    scopes: ["orders:read"],
    nonce: "nonce-1",
    issuedAt: NOW - 30,
    expiresAt: NOW + 300,
    extraClaims: {
      appTenant: "tenant-acme",
      email: "pat@example.com",
    },
    ...overrides,
  });
}

test("verifies inbound ID-JAG against trusted JWKS and issues a scoped HoBo token", async () => {
  const idp = createFixtureIdJagIssuer({ issuer: ISSUER, keyId: "kid-xaa-1" });
  const events = [];

  const result = await createServer({
    jwks: idp.jwks(),
    eventSink: (event) => events.push(event),
  }).acceptIdJag({
    requestId: "req-inbound-1",
    assertion: await validAssertion(idp),
    requiredScopes: ["orders:read"],
  });

  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(result.ctx.user, {
    kind: "user",
    id: "user:pat",
    delegatedFrom: { kind: "agent", id: "external-agent:claude" },
    tenant: { app: "tenant-acme" },
  });
  assert.deepEqual(result.ctx.identity, {
    kind: "agent",
    id: "external-agent:claude",
    delegatedBy: { kind: "user", id: "user:pat" },
  });
  assert.deepEqual(result.credential, {
    tokenRef: "vault://tokens/inbound-xaa/grant-1",
    audience: APP_AUDIENCE,
    resource: APP_RESOURCE,
    scopes: ["orders:read"],
    subject: {
      kind: "agent",
      id: "external-agent:claude",
      delegatedBy: { kind: "user", id: "user:pat" },
    },
    expiresAt: new Date((NOW + 300) * 1000).toISOString(),
  });
  assert.deepEqual(events.map((event) => event.type), ["token.Granted", "token.Used"]);
  assert.equal(events[0].data.tokenRef, result.credential.tokenRef);
  assert.equal(events[0].data.target.id, "shop");
  assert.equal(events[1].data.operation, "inbound-xaa.accept");
});

test("rejects wrong audience, untrusted issuer, and wrong resource", async () => {
  const idp = createFixtureIdJagIssuer({ issuer: ISSUER, keyId: "kid-xaa-1" });
  const server = createServer({ jwks: idp.jwks() });

  assertDenied(
    await server.acceptIdJag({
      requestId: "req-wrong-audience",
      assertion: await validAssertion(idp, { audience: "hobo-app://other" }),
    }),
    "invalid-id-jag",
    /audience/i,
  );
  assertDenied(
    await server.acceptIdJag({
      requestId: "req-wrong-issuer",
      assertion: await validAssertion(idp, { issuer: "https://evil.example.test" }),
    }),
    "untrusted-issuer",
    /untrusted issuer/i,
  );
  assertDenied(
    await server.acceptIdJag({
      requestId: "req-wrong-resource",
      assertion: await validAssertion(idp, { resource: "urn:hobo:app:other" }),
    }),
    "invalid-id-jag",
    /resource/i,
  );
  assertDenied(
    await server.acceptIdJag({
      requestId: "req-tampered",
      assertion: tamperClaim(await validAssertion(idp), "client_id", "external-agent:mallory"),
    }),
    "invalid-id-jag",
    /signature/i,
  );
});

test("fails closed for expired, replayed, and anonymous-delegation assertions", async () => {
  const idp = createFixtureIdJagIssuer({ issuer: ISSUER, keyId: "kid-xaa-1" });
  const server = createServer({ jwks: idp.jwks() });

  assertDenied(
    await server.acceptIdJag({
      requestId: "req-expired",
      assertion: await validAssertion(idp, { expiresAt: NOW - 1 }),
    }),
    "invalid-id-jag",
    /expired/i,
  );

  const replayable = await validAssertion(idp, { nonce: "nonce-replay" });
  assert.equal((await server.acceptIdJag({ requestId: "req-replay-1", assertion: replayable })).ok, true);
  assertDenied(
    await server.acceptIdJag({ requestId: "req-replay-2", assertion: replayable }),
    "invalid-id-jag",
    /nonce replay/i,
  );

  assertDenied(
    await server.acceptIdJag({
      requestId: "req-no-user",
      assertion: await validAssertion(idp, {
        subject: { kind: "agent", id: "external-agent:claude" },
      }),
    }),
    "invalid-id-jag",
    /delegatedBy/i,
  );
});

test("policy gate can deny inbound XAA before issuing a standing token", async () => {
  const idp = createFixtureIdJagIssuer({ issuer: ISSUER, keyId: "kid-xaa-1" });
  const events = [];
  const result = await createServer({
    jwks: idp.jwks(),
    eventSink: (event) => events.push(event),
    policyGate: async () => ({ ok: false, reason: "allow rule denied orders:write" }),
  }).acceptIdJag({
    requestId: "req-policy-deny",
    assertion: await validAssertion(idp, { scopes: ["orders:write"] }),
    requiredScopes: ["orders:write"],
  });

  assertDenied(result, "policy-denied", /allow rule denied/);
  assert.equal(result.credential, undefined);
  assert.deepEqual(events.map((event) => event.type), ["token.Denied"]);
});

test("policy gate exceptions fail closed before issuing a credential", async () => {
  const idp = createFixtureIdJagIssuer({ issuer: ISSUER, keyId: "kid-xaa-1" });
  const result = await createServer({
    jwks: idp.jwks(),
    policyGate: async () => {
      throw new Error("policy store unavailable");
    },
  }).acceptIdJag({
    requestId: "req-policy-error",
    assertion: await validAssertion(idp),
  });

  assertDenied(result, "policy-denied", /policy store unavailable/);
  assert.equal(result.credential, undefined);
});

test("@hobo/mcp can accept inbound XAA and run as the delegated external agent", async () => {
  const idp = createFixtureIdJagIssuer({ issuer: ISSUER, keyId: "kid-xaa-1" });
  const server = createServer({ jwks: idp.jwks() });
  const bridge = createInboundXaaMcpBridge({
    resourceServer: server,
    makeMcpServer: ({ identity }) =>
      createHoboMcpServer({
        identity,
        handlers: {
          list_bindles: async (_input, context) => ({
            principal: context.identity.id,
            delegatedBy: context.identity.delegatedBy.id,
          }),
        },
      }),
  });

  const ok = await bridge.callTool("list_bindles", {}, {
    requestId: "req-mcp-ok",
    assertion: await validAssertion(idp, { scopes: ["mcp:call"], nonce: "nonce-mcp" }),
    requiredScopes: ["mcp:call"],
  });

  assert.equal(ok.ok, true);
  assert.deepEqual(ok.data, {
    principal: "external-agent:claude",
    delegatedBy: "user:pat",
  });

  const denied = await bridge.callTool("list_bindles", {}, {
    requestId: "req-mcp-denied",
    assertion: await validAssertion(idp, {
      audience: "hobo-app://other",
      nonce: "nonce-mcp-denied",
    }),
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.error.code, "inbound-xaa-denied");
});

function assertDenied(result, code, messagePattern) {
  assert.equal(result.ok, false);
  assert.equal(result.code, code);
  assert.match(result.reason, messagePattern);
}

function tamperClaim(assertion, claimName, value) {
  const parts = assertion.split(".");
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  claims[claimName] = value;
  parts[1] = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return parts.join(".");
}

function deterministicIds() {
  const next = {
    grant: 1,
    use: 1,
  };
  return (prefix) => `${prefix}-${next[prefix]++}`;
}
