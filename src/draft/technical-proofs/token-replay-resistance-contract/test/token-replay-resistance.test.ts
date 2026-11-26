import assert from "node:assert/strict";
import { test } from "vitest";

import {
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";
import {
  createFixtureReplayCredentials,
  createTokenReplayResistanceHarness,
} from "../src/token-replay-resistance.js";

const NOW = "2026-06-28T12:00:00.000Z";
const SVID_AUDIENCE = "yard-token-broker";
const SUBJECT = {
  kind: "agent",
  id: "agent:triage",
  delegatedBy: { kind: "user", id: "user:priya" },
};
const ASANA = {
  id: "asana",
  audience: "https://authorization.asana.test",
  resource: "https://api.asana.test/tasks",
  allowedScopes: ["tasks:read", "tasks:write"],
};
const SLACK = {
  id: "slack",
  audience: "https://authorization.slack.test",
  resource: "https://api.slack.test/chat",
  allowedScopes: ["chat:write"],
};
const HOBO_APP = {
  id: "orders",
  audience: "hobo-app://orders",
  resource: "urn:hobo:app:orders",
  allowedScopes: ["orders:read"],
};

test("accepts first-use credentials that are inside their validity window", () => {
  const credentials = createFixtureReplayCredentials({ now: NOW });
  const harness = createHarness();

  const results = [
    harness.useJwtSvid({
      requestId: "req-svid-fresh",
      token: credentials.jwtSvid.current,
      expectedAudience: SVID_AUDIENCE,
      target: { kind: "service", id: "yard/token-broker" },
      operation: "jwt-svid.authorize",
      resource: "identity://svid/agent-triage",
    }),
    harness.redeemOutboundIdJag({
      requestId: "req-outbound-id-jag-fresh",
      assertion: credentials.idJag.outbound,
      target: ASANA,
    }),
    harness.useProviderAccessToken({
      requestId: "req-provider-token-fresh",
      credential: credentials.providerAccessToken.current,
      subject: SUBJECT,
      target: ASANA,
      operation: "external-app.call",
      resource: ASANA.resource,
    }),
    harness.redeemInboundIdJag({
      requestId: "req-inbound-id-jag-fresh",
      assertion: credentials.idJag.inbound,
      app: HOBO_APP,
    }),
  ];

  assert.deepEqual(results.map((result) => result.ok), [true, true, true, true]);
  assert.equal(harness.events().some((event) => event.type === "token.Denied"), false);
  assertAuditEvents(results.flatMap((result) => result.events));
});

test("rejects captured replay attempts with reason-specific token.Denied audits", () => {
  const credentials = createFixtureReplayCredentials({ now: NOW });
  const harness = createHarness();

  assert.equal(
    harness.redeemOutboundIdJag({
      requestId: "req-outbound-prime",
      assertion: credentials.idJag.outbound,
      target: ASANA,
    }).ok,
    true,
  );
  assert.equal(
    harness.redeemInboundIdJag({
      requestId: "req-inbound-prime",
      assertion: credentials.idJag.inbound,
      app: HOBO_APP,
    }).ok,
    true,
  );

  const denials = [
    harness.useJwtSvid({
      requestId: "replay-expired-svid",
      token: credentials.jwtSvid.expired,
      expectedAudience: SVID_AUDIENCE,
      target: { kind: "service", id: "yard/token-broker" },
      operation: "jwt-svid.authorize",
      resource: "identity://svid/agent-triage",
      at: "2026-06-28T12:06:00.000Z",
    }),
    harness.redeemOutboundIdJag({
      requestId: "replay-wrong-target",
      assertion: credentials.idJag.outbound,
      target: SLACK,
    }),
    harness.redeemOutboundIdJag({
      requestId: "replay-consumed-outbound-nonce",
      assertion: credentials.idJag.outbound,
      target: ASANA,
    }),
    harness.useProviderAccessToken({
      requestId: "replay-expired-provider-token",
      credential: credentials.providerAccessToken.expired,
      subject: SUBJECT,
      target: ASANA,
      operation: "external-app.call",
      resource: ASANA.resource,
      at: "2026-06-28T12:10:01.000Z",
    }),
    harness.redeemInboundIdJag({
      requestId: "replay-consumed-inbound-nonce",
      assertion: credentials.idJag.inbound,
      app: HOBO_APP,
    }),
  ];

  assert.deepEqual(denials.map((result) => result.reasonCode), [
    "jwt-svid-expired",
    "id-jag-audience-mismatch",
    "id-jag-nonce-replay",
    "provider-access-token-expired",
    "inbound-id-jag-nonce-replay",
  ]);
  assertEveryDeniedIsAuditable(denials);
});

test("rejects TTL-boundary replays and retired kids after rollover", () => {
  const credentials = createFixtureReplayCredentials({ now: NOW });
  const harness = createHarness();

  const boundaryDenials = [
    harness.useJwtSvid({
      requestId: "ttl-boundary-svid",
      token: credentials.jwtSvid.expiresAtNow,
      expectedAudience: SVID_AUDIENCE,
      target: { kind: "service", id: "yard/token-broker" },
      operation: "jwt-svid.authorize",
      resource: "identity://svid/agent-triage",
      at: NOW,
    }),
    harness.redeemOutboundIdJag({
      requestId: "ttl-boundary-id-jag",
      assertion: credentials.idJag.expiresAtNow,
      target: ASANA,
      at: NOW,
    }),
    harness.useProviderAccessToken({
      requestId: "ttl-boundary-provider-token",
      credential: credentials.providerAccessToken.expiresAtNow,
      subject: SUBJECT,
      target: ASANA,
      operation: "external-app.call",
      resource: ASANA.resource,
      at: NOW,
    }),
  ];

  const insideRollover = harness.useJwtSvid({
    requestId: "retired-kid-inside-rollover",
    token: credentials.jwtSvid.previousKid,
    expectedAudience: SVID_AUDIENCE,
    target: { kind: "service", id: "yard/token-broker" },
    operation: "jwt-svid.authorize",
    resource: "identity://svid/agent-triage",
    at: "2026-06-28T12:01:00.000Z",
  });
  const afterRollover = harness.useJwtSvid({
    requestId: "retired-kid-after-rollover",
    token: credentials.jwtSvid.previousKid,
    expectedAudience: SVID_AUDIENCE,
    target: { kind: "service", id: "yard/token-broker" },
    operation: "jwt-svid.authorize",
    resource: "identity://svid/agent-triage",
    at: "2026-06-28T12:03:00.000Z",
  });

  assert.deepEqual(boundaryDenials.map((result) => result.reasonCode), [
    "jwt-svid-expired",
    "id-jag-expired",
    "provider-access-token-expired",
  ]);
  assert.equal(insideRollover.ok, true);
  assert.equal(afterRollover.reasonCode, "kid-retired-after-rollover");
  assertEveryDeniedIsAuditable([...boundaryDenials, afterRollover]);
});

test("admits only the first concurrent ID-JAG nonce redemption", () => {
  const credentials = createFixtureReplayCredentials({ now: NOW });
  const harness = createHarness();
  const attempts = Array.from({ length: 4 }, (_, index) => ({
    requestId: `concurrent-nonce-${index + 1}`,
    assertion: credentials.idJag.concurrent,
    target: ASANA,
  }));

  const results = harness.redeemOutboundIdJagBatch(attempts);

  assert.deepEqual(results.map((result) => result.ok), [true, false, false, false]);
  assert.deepEqual(results.slice(1).map((result) => result.reasonCode), [
    "id-jag-nonce-replay",
    "id-jag-nonce-replay",
    "id-jag-nonce-replay",
  ]);
  assertEveryDeniedIsAuditable(results.slice(1));
  assert.equal(results[0].events.map((event) => event.type).join(","), "token.Granted,token.Used");
});

function createHarness() {
  return createTokenReplayResistanceHarness({
    now: () => new Date(NOW),
    idFactory: deterministicIds(),
    retiredKeyAcceptUntilByKid: {
      "kid-previous": "2026-06-28T12:02:00.000Z",
    },
  });
}

function assertEveryDeniedIsAuditable(results) {
  for (const result of results) {
    assert.equal(result.ok, false);
    assert.deepEqual(result.events.map((event) => event.type), ["token.Denied"]);
    assert.equal(result.events[0].data.reason, result.reason);
    assert.equal(result.events[0].data.requestId, result.requestId);
  }
  assertAuditEvents(results.flatMap((result) => result.events));
}

function assertAuditEvents(events) {
  assert.ok(events.length > 0);
  for (const event of events) {
    const validation = validateIdentityEvent(event);
    assert.equal(validation.ok, true, validation.errors.join("\n"));
    assert.equal(JSON.stringify(event).includes("fixture-signature"), false);
  }
}

function deterministicIds() {
  const next = new Map();
  return (prefix) => {
    const value = (next.get(prefix) ?? 0) + 1;
    next.set(prefix, value);
    return `${prefix}-${value}`;
  };
}
