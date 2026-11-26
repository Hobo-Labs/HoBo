import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { buildSignedAuthManifestEnvelope } from "../../hobo-auth-json-contract/src/auth-json.js";
import {
  createRequestTokenTool,
  createTokenContext,
  createTokenBroker,
} from "../src/token-broker-skeleton.js";
import { isJsonObject } from "../src/json.js";

const fixedNow = () => new Date("2026-06-25T10:00:00.000Z");

const actor = {
  kind: "agent",
  id: "agent:release",
  delegatedBy: { kind: "user", id: "user:priya" },
};

const allowedSvidScope = [
  { port: "database", resource: "shop.db", actions: ["read", "write"] },
];

const databaseWriteRequest = {
  requestId: "req-db-write",
  subject: actor,
  provider: "acme-cloud",
  scope: { port: "database", resource: "shop.db", action: "write" },
  svidScope: allowedSvidScope,
};

describe("token broker skeleton request_token path", () => {
  it("resolves fixture auth.json, dispatches the selected flow, and emits token.Granted + token.Used", async () => {
    const flowCalls = [];
    const broker = createTokenBroker({
      registry: fixtureRegistry({
        "acme-cloud": signedAuthJson({
          issuer: "https://identity.acme.test",
          flows: [
            {
              type: "api-key",
              header: "X-Api-Key",
              rotation: "manual",
            },
            {
              type: "oidc-federation",
              audience: "urn:acme:database",
              exchange: "https://sts.acme.test/token",
              trust: { oidcDiscovery: "https://identity.acme.test/.well-known/openid-configuration" },
            },
          ],
          resourceIndicators: ["urn:acme:database"],
        }),
      }),
      now: fixedNow,
      idFactory: deterministicIds(),
      flowHandlers: {
        "oidc-federation": async (dispatch) => {
          flowCalls.push(dispatch);
          return {
            tokenRef: `stub://tokens/${dispatch.provider}/${dispatch.grantId}`,
            expiresAt: "2026-06-25T10:05:00.000Z",
            stub: true,
          };
        },
      },
    });

    const result = await broker.requestToken(databaseWriteRequest);

    assert.equal(result.ok, true);
    assert.equal(result.provider, "acme-cloud");
    assert.equal(result.flow.type, "oidc-federation");
    assert.deepEqual(result.scope, databaseWriteRequest.scope);
    assert.deepEqual(result.credential, {
      tokenRef: "stub://tokens/acme-cloud/grant-1",
      expiresAt: "2026-06-25T10:05:00.000Z",
      stub: true,
    });
    assert.deepEqual(result.events.map((event) => event.type), ["token.Granted", "token.Used"]);
    assert.equal(result.events[0].data.tokenRef, "stub://tokens/acme-cloud/grant-1");
    assert.deepEqual(result.events[0].data.scopes, ["database:shop.db:write"]);
    assert.equal(result.events[1].data.operation, "request_token");
    assert.equal(result.events[1].data.resource, "acme-cloud:database:shop.db");
    assert.equal(flowCalls.length, 1);
    assert.deepEqual(flowCalls[0].scope, databaseWriteRequest.scope);
  });

  it("denies unknown providers with token.Denied and no grant/use events", async () => {
    const broker = createTokenBroker({
      registry: fixtureRegistry({}),
      now: fixedNow,
      idFactory: deterministicIds(),
    });

    const result = await broker.requestToken({
      ...databaseWriteRequest,
      requestId: "req-unknown-provider",
      provider: "missing-cloud",
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "unknown provider");
    assert.deepEqual(result.scope, databaseWriteRequest.scope);
    assert.deepEqual(result.events.map((event) => event.type), ["token.Denied"]);
    assert.equal(result.events[0].data.requestId, "req-unknown-provider");
    assert.equal(result.events[0].data.target.id, "missing-cloud");
  });

  it("denies out-of-SVID-scope requests before manifest lookup or flow dispatch", async () => {
    const calls = { registry: 0, flow: 0 };
    const broker = createTokenBroker({
      registry: {
        async resolveAuthManifest() {
          calls.registry += 1;
          return signedAuthJson({
            flows: [
              {
                type: "oidc-federation",
                audience: "urn:acme:database",
                exchange: "https://sts.acme.test/token",
                trust: { oidcDiscovery: "https://identity.fixture.test/.well-known/openid-configuration" },
              },
            ],
            resourceIndicators: ["urn:acme:database"],
          });
        },
      },
      now: fixedNow,
      idFactory: deterministicIds(),
      flowHandlers: {
        "oidc-federation": async () => {
          calls.flow += 1;
          return { tokenRef: "stub://tokens/should-not-exist", stub: true };
        },
      },
    });

    const result = await broker.requestToken({
      ...databaseWriteRequest,
      requestId: "req-out-of-scope",
      scope: { port: "database", resource: "shop.db", action: "admin" },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, "requested scope is outside caller SVID scope");
    assert.deepEqual(result.events.map((event) => event.type), ["token.Denied"]);
    assert.deepEqual(calls, { registry: 0, flow: 0 });
  });

  it("marks an api-key-only manifest as a last-resort static-secret path", async () => {
    const broker = createTokenBroker({
      registry: fixtureRegistry({
        "legacy-cloud": signedAuthJson({
          flows: [
            {
              type: "api-key",
              header: "X-Legacy-Key",
              rotation: "manual",
            },
          ],
          resourceIndicators: ["urn:legacy:database"],
        }),
      }),
      now: fixedNow,
      idFactory: deterministicIds(),
    });

    const result = await broker.requestToken({
      ...databaseWriteRequest,
      requestId: "req-legacy",
      provider: "legacy-cloud",
    });

    assert.equal(result.ok, true);
    assert.equal(result.flow.type, "api-key");
    assert.deepEqual(result.flow.warnings, ["last-resort-static-secret"]);
    assert.equal(result.credential.stub, true);
  });

  it("keeps token plaintext out of audit events even if a stub handler returns one", async () => {
    const broker = createTokenBroker({
      registry: fixtureRegistry({
        "acme-cloud": signedAuthJson({
          flows: [
            {
              type: "oidc-federation",
              audience: "urn:acme:database",
              exchange: "https://sts.acme.test/token",
              trust: { oidcDiscovery: "https://identity.acme.test/.well-known/openid-configuration" },
            },
          ],
          resourceIndicators: ["urn:acme:database"],
        }),
      }),
      now: fixedNow,
      idFactory: deterministicIds(),
      flowHandlers: {
        "oidc-federation": async () => ({
          token: "do-not-audit-this",
          tokenRef: "stub://tokens/acme-cloud/grant-1",
          expiresAt: "2026-06-25T10:05:00.000Z",
          stub: true,
        }),
      },
    });

    const result = await broker.requestToken(databaseWriteRequest);

    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result.events).includes("do-not-audit-this"), false);
    assert.equal(hasForbiddenAuditKey(result.events, "token"), false);
    assert.equal(hasForbiddenAuditKey(result.events, "value"), false);
    assert.equal(result.events[0].data.tokenRef, "stub://tokens/acme-cloud/grant-1");
  });

  it("binds MCP request_token to the same broker request path", async () => {
    const emitted = [];
    const broker = createTokenBroker({
      registry: fixtureRegistry({
        "acme-cloud": signedAuthJson({
          flows: [
            {
              type: "oidc-federation",
              audience: "urn:acme:database",
              exchange: "https://sts.acme.test/token",
              trust: { oidcDiscovery: "https://identity.acme.test/.well-known/openid-configuration" },
            },
          ],
          resourceIndicators: ["urn:acme:database"],
        }),
      }),
      now: fixedNow,
      idFactory: deterministicIds(),
      eventSink: (event) => emitted.push(event),
    });
    const tool = createRequestTokenTool(broker);

    const result = await tool.invoke(databaseWriteRequest);

    assert.equal(tool.name, "request_token");
    assert.equal(result.ok, true);
    assert.deepEqual(result.scope, databaseWriteRequest.scope);
    assert.deepEqual(emitted.map((event) => event.type), ["token.Granted", "token.Used"]);
    assert.deepEqual(result.events, emitted);
  });

  it("binds ctx.token to the same broker request path", async () => {
    const emitted = [];
    const broker = createTokenBroker({
      registry: fixtureRegistry({
        "acme-cloud": signedAuthJson({
          flows: [
            {
              type: "oidc-federation",
              audience: "urn:acme:database",
              exchange: "https://sts.acme.test/token",
              trust: { oidcDiscovery: "https://identity.acme.test/.well-known/openid-configuration" },
            },
          ],
          resourceIndicators: ["urn:acme:database"],
        }),
      }),
      now: fixedNow,
      idFactory: deterministicIds(),
      eventSink: (event) => emitted.push(event),
    });
    const ctx = createTokenContext(broker, {
      subject: actor,
      svidScope: allowedSvidScope,
      requestIdFactory: deterministicIds(),
    });

    const result = await ctx.token("acme-cloud", databaseWriteRequest.scope, {
      requestId: "ctx-db-write",
    });

    assert.equal(result.ok, true);
    assert.equal(result.requestId, "ctx-db-write");
    assert.deepEqual(result.scope, databaseWriteRequest.scope);
    assert.deepEqual(emitted.map((event) => event.type), ["token.Granted", "token.Used"]);
    assert.equal(result.events[0].data.scopes[0], "database:shop.db:write");
  });
});

function signedAuthJson(overrides = {}) {
  return buildSignedAuthManifestEnvelope(
    {
      issuer: overrides.issuer ?? "https://identity.fixture.test",
      flows: overrides.flows,
      scopeModel: "least-privilege-per-resource",
      resourceIndicators: overrides.resourceIndicators ?? ["urn:fixture:resource"],
      tokenLifetimeSec: 300,
      audit: { events: ["token.Granted", "token.Used", "token.Denied"] },
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

function hasForbiddenAuditKey(value, forbiddenKey) {
  if (Array.isArray(value)) {
    return value.some((entry) => hasForbiddenAuditKey(entry, forbiddenKey));
  }
  if (!value || !isJsonObject(value)) {
    return false;
  }
  return Object.entries(value).some(([key, nested]) =>
    key === forbiddenKey || hasForbiddenAuditKey(nested, forbiddenKey),
  );
}
