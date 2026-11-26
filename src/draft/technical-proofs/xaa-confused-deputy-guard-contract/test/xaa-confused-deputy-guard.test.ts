import assert from "node:assert/strict";
import { test } from "vitest";

import { parseJwtBearerGrantRequest } from "../../id-jag-token-exchange-contract/src/id-jag-token-exchange.js";
import { createXaaConfusedDeputyGuard } from "../src/xaa-confused-deputy-guard.js";

const FIXED_NOW = new Date("2026-06-28T05:00:00.000Z");
const FIXED_EPOCH = Math.floor(FIXED_NOW.getTime() / 1000);
const SUBJECT_TOKEN = {
  tokenRef: "identity://id-token/user-priya",
  tokenType: "urn:ietf:params:oauth:token-type:id_token",
};
const AGENT = { kind: "agent", id: "agent:triage" };
const PRIYA = { kind: "user", id: "user:priya" };
const MALLORY = { kind: "user", id: "user:mallory" };
const ASANA_TARGET = {
  id: "asana",
  audience: "https://api.asana.test",
  resource: "https://api.asana.test/tasks",
  allowedScopes: ["tasks:read", "tasks:write"],
  authFlow: { type: "oauth2-xaa", targetAuthorizationServer: "asana" },
};
const SLACK_TARGET = {
  id: "slack",
  audience: "https://api.slack.test",
  resource: "https://api.slack.test/chat",
  allowedScopes: ["chat:write"],
  authFlow: { type: "oauth2-xaa", targetAuthorizationServer: "slack" },
};

test("mints only for the verified delegated user and records pre-mint policy evidence", async () => {
  const asanaAs = createTargetAuthorizationServer(ASANA_TARGET);
  const guard = createGuard({ targetAuthorizationServers: { asana: asanaAs } });

  const result = await guard.exchangeOutboundXaa({
    requestId: "req-verified-priya",
    subject: AGENT,
    verifiedDelegatedBy: PRIYA,
    subjectToken: SUBJECT_TOKEN,
    target: ASANA_TARGET,
    requestedScopes: ["tasks:read"],
  });

  assert.equal(result.ok, true);
  assert.equal(result.idJag.subject.delegatedBy.id, "user:priya");
  assert.equal(asanaAs.calls[0].claims.subject.delegatedBy.id, "user:priya");
  assert.deepEqual(
    result.events.map((event) => event.type),
    ["policy.Decided", "token.Granted", "token.Used"],
  );
  assert.equal(result.events[0].data.effect, "allow");
  assert.equal(result.events[0].subject.delegatedBy.id, "user:priya");
});

test("rejects a forged delegatedBy before minting an ID-JAG", async () => {
  const asanaAs = createTargetAuthorizationServer(ASANA_TARGET);
  const guard = createGuard({ targetAuthorizationServers: { asana: asanaAs } });

  const result = await guard.exchangeOutboundXaa({
    requestId: "req-forged-user",
    subject: { ...AGENT, delegatedBy: MALLORY },
    verifiedDelegatedBy: PRIYA,
    subjectToken: SUBJECT_TOKEN,
    target: ASANA_TARGET,
    requestedScopes: ["tasks:read"],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /verified delegated user/);
  assert.equal(asanaAs.calls.length, 0);
  assert.deepEqual(result.events.map((event) => event.type), ["policy.Decided", "token.Denied"]);
  assert.equal(result.events[0].data.effect, "deny");
  assert.equal(result.events[1].data.subject.delegatedBy.id, "user:priya");
});

test("denies a target audience without a pre-mint delegation grant", async () => {
  const slackAs = createTargetAuthorizationServer(SLACK_TARGET);
  const guard = createGuard({ targetAuthorizationServers: { slack: slackAs } });

  const result = await guard.exchangeOutboundXaa({
    requestId: "req-target-denied",
    subject: AGENT,
    verifiedDelegatedBy: PRIYA,
    subjectToken: SUBJECT_TOKEN,
    target: SLACK_TARGET,
    requestedScopes: ["chat:write"],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /no delegated grant/);
  assert.equal(slackAs.calls.length, 0);
  assert.deepEqual(result.events.map((event) => event.type), ["policy.Decided", "token.Denied"]);
  assert.equal(result.events[0].resource.id, "slack");
});

test("cannot reuse a valid Asana delegation to mint for Slack", async () => {
  const slackAs = createTargetAuthorizationServer(SLACK_TARGET);
  const guard = createGuard({ targetAuthorizationServers: { slack: slackAs } });

  const result = await guard.exchangeOutboundXaa({
    requestId: "req-cross-target-reuse",
    subject: AGENT,
    verifiedDelegatedBy: PRIYA,
    subjectToken: SUBJECT_TOKEN,
    target: SLACK_TARGET,
    requestedScopes: ["chat:write"],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /agent:triage.*user:priya.*slack/);
  assert.equal(slackAs.calls.length, 0);
  assert.equal(result.events[0].data.effect, "deny");
  assert.equal(result.events.some((event) => event.type === "token.Granted"), false);
});

test("refuses minting when no verified delegation principal is present", async () => {
  const asanaAs = createTargetAuthorizationServer(ASANA_TARGET);
  const guard = createGuard({ targetAuthorizationServers: { asana: asanaAs } });

  const result = await guard.exchangeOutboundXaa({
    requestId: "req-no-verified-delegation",
    subject: AGENT,
    subjectToken: SUBJECT_TOKEN,
    target: ASANA_TARGET,
    requestedScopes: ["tasks:read"],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /verifiedDelegatedBy/);
  assert.equal(asanaAs.calls.length, 0);
  assert.deepEqual(result.events.map((event) => event.type), ["policy.Decided", "token.Denied"]);
});

test("refuses a non-user verified delegation principal before minting", async () => {
  const asanaAs = createTargetAuthorizationServer(ASANA_TARGET);
  const guard = createGuard({ targetAuthorizationServers: { asana: asanaAs } });

  const result = await guard.exchangeOutboundXaa({
    requestId: "req-service-delegation",
    subject: AGENT,
    verifiedDelegatedBy: { kind: "service", id: "svc:yard" },
    subjectToken: SUBJECT_TOKEN,
    target: ASANA_TARGET,
    requestedScopes: ["tasks:read"],
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /verifiedDelegatedBy.kind must be user/);
  assert.equal(asanaAs.calls.length, 0);
  assert.deepEqual(result.events.map((event) => event.type), ["policy.Decided", "token.Denied"]);
  assert.equal(result.events[1].data.subject.delegatedBy, undefined);
});

function createGuard(overrides = {}) {
  return createXaaConfusedDeputyGuard({
    issuer: "https://identity.hobo.test",
    now: () => FIXED_NOW,
    idFactory: sequenceIds(),
    grants: [
      {
        agentId: "agent:triage",
        userId: "user:priya",
        targetId: "asana",
        scopes: ["tasks:read"],
      },
    ],
    ...overrides,
  });
}

function createTargetAuthorizationServer(target) {
  const calls = [];
  return {
    calls,
    async redeemJwtBearer(request) {
      const call = { request };
      calls.push(call);
      const parsed = parseJwtBearerGrantRequest(request, {
        expectedAudience: target.audience,
        expectedResource: target.resource,
        allowedScopes: target.allowedScopes,
        consumedNonces: new Set(),
        maxLifetimeSec: 300,
        now: FIXED_EPOCH,
      });
      call.claims = parsed.claims;
      return {
        tokenRef: `vault://tokens/${target.id}/grant-1`,
        audience: target.audience,
        expiresAt: new Date(FIXED_NOW.getTime() + 120_000).toISOString(),
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
