import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { buildSignedAuthManifestEnvelope } from "../../hobo-auth-json-contract/src/auth-json.js";
import {
  BROKER_EXCHANGE_ERROR,
  createTokenBrokerExchange,
  parseSvid,
} from "../src/token-broker-exchange.js";

const fixedNow = () => new Date("2026-06-25T10:00:00.000Z");

const actor = {
  kind: "agent",
  id: "agent:deploy",
  delegatedBy: { kind: "user", id: "user:alice" },
};

const svidScope = [{ port: "database", resource: "shop.db", actions: ["read", "write"] }];

function buildSvid(overrides = {}) {
  return {
    subject: actor,
    svidRef: "tokenref://identity/svid/run-42/0",
    audience: ["hobo-broker", "provider-sts"],
    expiresAt: overrides.expiresAt ?? "2026-06-25T10:15:00.000Z",
    scope: overrides.scope ?? svidScope,
  };
}

describe("Feature: Exchange attested SVID for provider token via OIDC federation", () => {
  it("Given attested SVID + signed auth.json, When exchange runs, Then short-lived brokered token + token.Granted/Used", async () => {
    const emitted = [];
    const broker = createTokenBrokerExchange({
      registry: cloudflareRegistry(),
      now: fixedNow,
      idFactory: deterministicIds(),
      eventSink: (event) => emitted.push(event),
    });

    const result = await broker.exchange({
      requestId: "req-cf-deploy",
      provider: "cloudflare",
      scope: { port: "database", resource: "shop.db", action: "write" },
      svid: buildSvid(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.provider, "cloudflare");
    assert.equal(result.flow.type, "oidc-federation");
    assert.equal(result.credential.brokered, true);
    assert.equal(result.credential.stub, false);
    assert.match(result.credential.tokenRef, /^tokenref:\/\/provider\/cloudflare\//);
    assert.deepEqual(emitted.map((event) => event.type), ["token.Granted", "token.Used"]);
    assert.equal(emitted[0].data.scopes[0], "database:shop.db:write");
    assert.equal(JSON.stringify(emitted).includes("secret"), false);
  });

  it("Given expired SVID, When exchange runs, Then typed svid-expired denial", async () => {
    const broker = createTokenBrokerExchange({
      registry: cloudflareRegistry(),
      now: fixedNow,
      idFactory: deterministicIds(),
    });

    const result = await broker.exchange({
      requestId: "req-expired-svid",
      provider: "cloudflare",
      scope: { port: "database", resource: "shop.db", action: "write" },
      svid: buildSvid({ expiresAt: "2026-06-25T09:59:59.000Z" }),
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, BROKER_EXCHANGE_ERROR.SVID_EXPIRED);
    assert.deepEqual(result.events.map((event) => event.type), ["token.Denied"]);
    assert.match(result.events[0].data.reason, /svid-expired/);
  });

  it("Given over-scoped request, When exchange runs, Then typed scope-outside-svid denial before manifest lookup", async () => {
    const calls = { registry: 0 };
    const broker = createTokenBrokerExchange({
      registry: {
        async resolveAuthManifest() {
          calls.registry += 1;
          return signedAuthJson({});
        },
      },
      now: fixedNow,
      idFactory: deterministicIds(),
    });

    const result = await broker.exchange({
      requestId: "req-over-scope",
      provider: "cloudflare",
      scope: { port: "database", resource: "shop.db", action: "admin" },
      svid: buildSvid(),
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, BROKER_EXCHANGE_ERROR.SCOPE_OUTSIDE_SVID);
    assert.equal(calls.registry, 0);
  });
});

describe("Feature: Grace-window-only renewal and revocation", () => {
  it("Given active grant inside grace, When renew with same-or-narrower scope, Then token.Used only", async () => {
    const broker = createTokenBrokerExchange({
      registry: cloudflareRegistry(),
      now: () => new Date("2026-06-25T10:03:20.000Z"),
      idFactory: deterministicIds(),
      tokenTtlMs: 5 * 60 * 1000,
    });

    const issued = await broker.exchange({
      requestId: "req-issue",
      provider: "cloudflare",
      scope: { port: "database", resource: "shop.db", action: "write" },
      svid: buildSvid(),
    });

    const graceRenewal = await broker.renew({
      requestId: "req-grace",
      grantId: issued.grantId,
      scope: { port: "database", resource: "shop.db", action: "write" },
    });

    assert.equal(graceRenewal.ok, true);
    assert.equal(graceRenewal.mode, "cache-renewal");
    assert.deepEqual(graceRenewal.events.map((event) => event.type), ["token.Used"]);
  });

  it("Given grace window elapsed, When renew runs, Then typed renewal-grace-expired denial", async () => {
    let current = new Date("2026-06-25T10:00:00.000Z");
    const broker = createTokenBrokerExchange({
      registry: cloudflareRegistry(),
      now: () => current,
      idFactory: deterministicIds(),
      tokenTtlMs: 5 * 60 * 1000,
    });

    const issued = await broker.exchange({
      requestId: "req-issue-grace-expire",
      provider: "cloudflare",
      scope: { port: "database", resource: "shop.db", action: "write" },
      svid: buildSvid(),
    });

    current = new Date("2026-06-25T10:06:01.000Z");
    const denied = await broker.renew({
      requestId: "req-after-grace",
      grantId: issued.grantId,
      scope: { port: "database", resource: "shop.db", action: "write" },
    });

    assert.equal(denied.ok, false);
    assert.equal(denied.code, BROKER_EXCHANGE_ERROR.RENEWAL_GRACE_EXPIRED);
  });

  it("Given revoked grant, When renew runs, Then typed grant-revoked denial", async () => {
    const broker = createTokenBrokerExchange({
      registry: cloudflareRegistry(),
      now: fixedNow,
      idFactory: deterministicIds(),
    });

    const issued = await broker.exchange({
      requestId: "req-revoke",
      provider: "cloudflare",
      scope: { port: "database", resource: "shop.db", action: "write" },
      svid: buildSvid(),
    });

    const revoked = await broker.revoke(issued.grantId, "security-incident");
    assert.equal(revoked.ok, true);
    assert.deepEqual(revoked.events.map((event) => event.type), ["token.Revoked"]);

    const denied = await broker.renew({
      requestId: "req-after-revoke",
      grantId: issued.grantId,
      scope: { port: "database", resource: "shop.db", action: "write" },
    });

    assert.equal(denied.ok, false);
    assert.equal(denied.code, BROKER_EXCHANGE_ERROR.GRANT_REVOKED);
  });

  it("Given scope widening on renew, When renew runs, Then typed scope-widening denial", async () => {
    const broker = createTokenBrokerExchange({
      registry: cloudflareRegistry(),
      now: fixedNow,
      idFactory: deterministicIds(),
    });

    const issued = await broker.exchange({
      requestId: "req-narrow",
      provider: "cloudflare",
      scope: { port: "database", resource: "shop.db", action: "read" },
      svid: buildSvid({ scope: [{ port: "database", resource: "shop.db", actions: ["read", "write"] }] }),
    });

    const denied = await broker.renew({
      requestId: "req-widen",
      grantId: issued.grantId,
      scope: { port: "database", resource: "shop.db", action: "write" },
    });

    assert.equal(denied.ok, false);
    assert.equal(denied.code, BROKER_EXCHANGE_ERROR.SCOPE_WIDENING);
  });
});

describe("parseSvid boundary", () => {
  it("parses a valid SVID into a derived type", () => {
    const parsed = parseSvid(buildSvid());
    assert.equal(parsed.svidRef, "tokenref://identity/svid/run-42/0");
    assert.deepEqual(parsed.audience, ["hobo-broker", "provider-sts"]);
    assert.equal(parsed.scope[0].actions.includes("write"), true);
  });
});

function cloudflareRegistry() {
  return fixtureRegistry({
    cloudflare: signedAuthJson({
      issuer: "https://identity.cloudflare.test",
      flows: [
        {
          type: "oidc-federation",
          audience: "urn:cloudflare:workers",
          exchange: "https://sts.cloudflare.test/token",
          trust: {
            oidcDiscovery: "https://yard.example.com/.well-known/openid-configuration",
          },
        },
      ],
      resourceIndicators: ["urn:cloudflare:workers"],
    }),
  });
}

function signedAuthJson(overrides = {}) {
  return buildSignedAuthManifestEnvelope(
    {
      issuer: overrides.issuer ?? "https://identity.fixture.test",
      flows: overrides.flows,
      scopeModel: "least-privilege-per-resource",
      resourceIndicators: overrides.resourceIndicators ?? ["urn:fixture:resource"],
      tokenLifetimeSec: 300,
      audit: { events: ["token.Granted", "token.Used", "token.Revoked", "token.Denied"] },
    },
    { issuer: overrides.issuer ?? "https://identity.fixture.test", keyId: "fixture-key" },
  );
}

function fixtureRegistry(entries) {
  return {
    async resolveAuthManifest(provider) {
      return entries[provider] ?? null;
    },
  };
}

function deterministicIds() {
  let next = 1;
  return (prefix) => `${prefix}-${next++}`;
}
