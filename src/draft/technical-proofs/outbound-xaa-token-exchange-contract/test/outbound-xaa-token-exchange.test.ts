import assert from "node:assert/strict";
import { test } from "vitest";

import { parseJwtBearerGrantRequest } from "../../id-jag-token-exchange-contract/src/id-jag-token-exchange.js";
import { foldCredentialAudit } from "../../identity-event-contract/src/identity-event-contract.js";
import { createOutboundXaaTokenBroker } from "../src/outbound-xaa-token-exchange.js";

const FIXED_NOW = new Date("2026-06-26T15:00:00.000Z");
const FIXED_EPOCH = Math.floor(FIXED_NOW.getTime() / 1000);
const SUBJECT = {
  kind: "agent",
  id: "agent:triage",
  delegatedBy: { kind: "user", id: "user:priya" },
};
const SUBJECT_TOKEN = {
  tokenRef: "identity://id-token/user-priya",
  tokenType: "urn:ietf:params:oauth:token-type:id_token",
};

test("mints an audience-bound ID-JAG, redeems it, and emits a reconstructable audit chain", async () => {
  const policyCalls = [];
  const asanaAs = createTargetAuthorizationServer({
    targetId: "asana",
    audience: "https://api.asana.test",
    resource: "https://api.asana.test/tasks",
    allowedScopes: ["tasks:read", "tasks:write"],
  });
  const broker = createBroker({
    preMintPolicy: async (context) => {
      policyCalls.push(context);
      return { ok: true };
    },
    targetAuthorizationServers: { asana: asanaAs },
  });

  const result = await broker.exchangeToken({
    requestId: "req-asana",
    subject: SUBJECT,
    subjectToken: SUBJECT_TOKEN,
    target: {
      id: "asana",
      audience: "https://api.asana.test",
      resource: "https://api.asana.test/tasks",
      allowedScopes: ["tasks:read", "tasks:write"],
      authFlow: { type: "oauth2-xaa", targetAuthorizationServer: "asana" },
    },
    requestedScopes: ["tasks:read"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.flow.type, "oauth2-xaa");
  assert.equal(result.idJag.audience, "https://api.asana.test");
  assert.equal(result.idJag.resource, "https://api.asana.test/tasks");
  assert.deepEqual(result.idJag.scopes, ["tasks:read"]);
  assert.equal(result.idJag.subject.delegatedBy.id, "user:priya");
  assert.equal(result.credential.tokenRef, "vault://tokens/asana/grant-1");
  assert.deepEqual(result.credential.scopes, ["tasks:read"]);

  assert.equal(policyCalls.length, 1);
  assert.equal(policyCalls[0].subject.delegatedBy.id, "user:priya");
  assert.deepEqual(policyCalls[0].requestedScopes, ["tasks:read"]);
  assert.equal(asanaAs.calls.length, 1);
  assert.equal(asanaAs.calls[0].claims.aud, "https://api.asana.test");
  assert.equal(asanaAs.calls[0].claims.subject.delegatedBy.id, "user:priya");

  const audit = foldCredentialAudit(result.events);
  assert.deepEqual(audit.chains, [
    {
      user: "user:priya",
      agent: "agent:triage",
      target: "external-app:asana",
      audience: "https://api.asana.test",
      scopes: ["tasks:read"],
      grants: ["grant-1"],
      uses: ["use-1"],
      secretRefs: [],
      revoked: false,
    },
  ]);
});

test("refuses an outbound XAA exchange without subject.delegatedBy before minting", async () => {
  const policyCalls = [];
  const asanaAs = createTargetAuthorizationServer({
    targetId: "asana",
    audience: "https://api.asana.test",
    resource: "https://api.asana.test/tasks",
    allowedScopes: ["tasks:read"],
  });
  const broker = createBroker({
    preMintPolicy: async (context) => {
      policyCalls.push(context);
      return { ok: true };
    },
    targetAuthorizationServers: { asana: asanaAs },
  });

  const result = await broker.exchangeToken({
    requestId: "req-no-delegator",
    subject: { kind: "agent", id: "agent:triage" },
    subjectToken: SUBJECT_TOKEN,
    target: {
      id: "asana",
      audience: "https://api.asana.test",
      resource: "https://api.asana.test/tasks",
      allowedScopes: ["tasks:read"],
      authFlow: { type: "oauth2-xaa", targetAuthorizationServer: "asana" },
    },
    requestedScopes: ["tasks:read"],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /subject\.delegatedBy/);
  assert.equal(policyCalls.length, 0);
  assert.equal(asanaAs.calls.length, 0);
  assert.deepEqual(result.events.map((event) => event.type), ["token.Denied"]);
});

test("refuses unsupported source token types before policy or minting", async () => {
  const policyCalls = [];
  const asanaAs = createTargetAuthorizationServer({
    targetId: "asana",
    audience: "https://api.asana.test",
    resource: "https://api.asana.test/tasks",
    allowedScopes: ["tasks:read"],
  });
  const broker = createBroker({
    preMintPolicy: async (context) => {
      policyCalls.push(context);
      return { ok: true };
    },
    targetAuthorizationServers: { asana: asanaAs },
  });

  await assert.rejects(
    () =>
      broker.exchangeToken({
        requestId: "req-api-key-source",
        subject: SUBJECT,
        subjectToken: {
          tokenRef: "identity://legacy/api-key",
          tokenType: "urn:ietf:params:oauth:token-type:access_token",
        },
        target: {
          id: "asana",
          audience: "https://api.asana.test",
          resource: "https://api.asana.test/tasks",
          allowedScopes: ["tasks:read"],
          authFlow: { type: "oauth2-xaa", targetAuthorizationServer: "asana" },
        },
        requestedScopes: ["tasks:read"],
      }),
    /subjectToken\.tokenType must be id_token or jwt/,
  );
  assert.equal(policyCalls.length, 0);
  assert.equal(asanaAs.calls.length, 0);
});

test("does not redeem a target A ID-JAG at target B authorization server", async () => {
  const slackAs = createTargetAuthorizationServer({
    targetId: "slack",
    audience: "https://api.slack.test",
    resource: "https://api.slack.test/chat",
    allowedScopes: ["chat:write"],
  });
  const broker = createBroker({
    targetAuthorizationServers: { slack: slackAs },
  });

  const result = await broker.exchangeToken({
    requestId: "req-cross-target",
    subject: SUBJECT,
    subjectToken: SUBJECT_TOKEN,
    target: {
      id: "asana",
      audience: "https://api.asana.test",
      resource: "https://api.asana.test/tasks",
      allowedScopes: ["tasks:read"],
      authFlow: { type: "oauth2-xaa", targetAuthorizationServer: "slack" },
    },
    requestedScopes: ["tasks:read"],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /audience mismatch/);
  assert.equal(slackAs.calls.length, 1);
  assert.deepEqual(result.events.map((event) => event.type), ["token.Denied"]);
});

test("falls back to oauth2-obo for a non-XAA target without minting ID-JAG", async () => {
  const fallbackCalls = [];
  const asanaAs = createTargetAuthorizationServer({
    targetId: "asana",
    audience: "https://api.asana.test",
    resource: "https://api.asana.test/tasks",
    allowedScopes: ["tasks:read"],
  });
  const broker = createBroker({
    targetAuthorizationServers: { asana: asanaAs },
    fallbackExchanger: async (request) => {
      fallbackCalls.push(request);
      return {
        tokenRef: "vault://tokens/legacy-crm/grant-1",
        audience: request.target.audience,
        expiresAt: new Date(FIXED_NOW.getTime() + 120_000).toISOString(),
        scopes: request.requestedScopes,
      };
    },
  });

  const result = await broker.exchangeToken({
    requestId: "req-legacy",
    subject: SUBJECT,
    subjectToken: SUBJECT_TOKEN,
    target: {
      id: "legacy-crm",
      audience: "https://legacy-crm.test",
      resource: "https://legacy-crm.test/contacts",
      allowedScopes: ["contacts:read"],
      authFlow: { type: "oauth2-obo" },
    },
    requestedScopes: ["contacts:read"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.flow.type, "oauth2-obo");
  assert.equal(result.idJag, undefined);
  assert.equal(asanaAs.calls.length, 0);
  assert.equal(fallbackCalls.length, 1);
  assert.equal(result.credential.tokenRef, "vault://tokens/legacy-crm/grant-1");
  assert.deepEqual(result.events.map((event) => event.type), ["token.Granted", "token.Used"]);
});

test("rejects target access tokens that are not short-lived", async () => {
  const asanaAs = createTargetAuthorizationServer({
    targetId: "asana",
    audience: "https://api.asana.test",
    resource: "https://api.asana.test/tasks",
    allowedScopes: ["tasks:read"],
    accessTokenTtlMs: 30 * 60 * 1000,
  });
  const broker = createBroker({
    targetAuthorizationServers: { asana: asanaAs },
  });

  const result = await broker.exchangeToken({
    requestId: "req-long-lived-access",
    subject: SUBJECT,
    subjectToken: SUBJECT_TOKEN,
    target: {
      id: "asana",
      audience: "https://api.asana.test",
      resource: "https://api.asana.test/tasks",
      allowedScopes: ["tasks:read"],
      authFlow: { type: "oauth2-xaa", targetAuthorizationServer: "asana" },
    },
    requestedScopes: ["tasks:read"],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /access token exceeds short-lived maxLifetimeMs/);
  assert.equal(asanaAs.calls.length, 1);
  assert.deepEqual(result.events.map((event) => event.type), ["token.Denied"]);
});

test("rejects target access tokens without the expected audience", async () => {
  const missingAudienceAs = createTargetAuthorizationServer({
    targetId: "asana",
    audience: "https://api.asana.test",
    resource: "https://api.asana.test/tasks",
    allowedScopes: ["tasks:read"],
    credentialAudience: undefined,
  });
  const broker = createBroker({
    targetAuthorizationServers: { asana: missingAudienceAs },
  });

  const missingAudience = await broker.exchangeToken({
    requestId: "req-missing-audience",
    subject: SUBJECT,
    subjectToken: SUBJECT_TOKEN,
    target: {
      id: "asana",
      audience: "https://api.asana.test",
      resource: "https://api.asana.test/tasks",
      allowedScopes: ["tasks:read"],
      authFlow: { type: "oauth2-xaa", targetAuthorizationServer: "asana" },
    },
    requestedScopes: ["tasks:read"],
  });

  assert.equal(missingAudience.ok, false);
  assert.match(missingAudience.reason, /credential\.audience/);

  const wrongAudienceAs = createTargetAuthorizationServer({
    targetId: "asana",
    audience: "https://api.asana.test",
    resource: "https://api.asana.test/tasks",
    allowedScopes: ["tasks:read"],
    credentialAudience: "https://api.slack.test",
  });
  const mismatchBroker = createBroker({
    targetAuthorizationServers: { asana: wrongAudienceAs },
  });

  const wrongAudience = await mismatchBroker.exchangeToken({
    requestId: "req-wrong-audience",
    subject: SUBJECT,
    subjectToken: SUBJECT_TOKEN,
    target: {
      id: "asana",
      audience: "https://api.asana.test",
      resource: "https://api.asana.test/tasks",
      allowedScopes: ["tasks:read"],
      authFlow: { type: "oauth2-xaa", targetAuthorizationServer: "asana" },
    },
    requestedScopes: ["tasks:read"],
  });

  assert.equal(wrongAudience.ok, false);
  assert.match(wrongAudience.reason, /access token audience must match target audience/);
});

function createBroker(overrides = {}) {
  return createOutboundXaaTokenBroker({
    issuer: "https://identity.hobo.test",
    now: () => FIXED_NOW,
    idFactory: sequenceIds(),
    preMintPolicy: async () => ({ ok: true }),
    fallbackExchanger: async (request) => ({
      tokenRef: `vault://tokens/${request.target.id}/grant-1`,
      audience: request.target.audience,
      expiresAt: new Date(FIXED_NOW.getTime() + 120_000).toISOString(),
      scopes: request.requestedScopes,
    }),
    ...overrides,
  });
}

function createTargetAuthorizationServer(options) {
  const calls = [];
  const consumedNonces = new Set();
  const accessTokenTtlMs = options.accessTokenTtlMs ?? 120_000;

  return {
    calls,
    async redeemJwtBearer(request) {
      const call = { request };
      calls.push(call);
      const parsed = parseJwtBearerGrantRequest(request, {
        expectedAudience: options.audience,
        expectedResource: options.resource,
        allowedScopes: options.allowedScopes,
        consumedNonces,
        maxLifetimeSec: 300,
        now: FIXED_EPOCH,
      });
      call.claims = parsed.claims;
      return {
        tokenRef: `vault://tokens/${options.targetId}/grant-1`,
        ...(Object.hasOwn(options, "credentialAudience")
          ? options.credentialAudience === undefined
            ? {}
            : { audience: options.credentialAudience }
          : { audience: options.audience }),
        expiresAt: new Date(FIXED_NOW.getTime() + accessTokenTtlMs).toISOString(),
        scopes: parsed.claims.scope,
      };
    },
  };
}

function sequenceIds() {
  const nextByPrefix = new Map();
  return (prefix) => {
    const next = (nextByPrefix.get(prefix) ?? 0) + 1;
    nextByPrefix.set(prefix, next);
    return `${prefix}-${next}`;
  };
}
