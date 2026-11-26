import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createFixtureIdentityProvider,
  createHoboAuthVerifier,
} from "../../hobo-auth-federate-verify-contract/src/auth-federate-verify.js";
import {
  createEventSourcedSessionAuthority,
  replaySessionState,
  verifyRequestWithSessionState,
} from "../src/session-revocation.js";

const NOW_SECONDS = 1_767_156_100;
const NOW_ISO = new Date(NOW_SECONDS * 1000).toISOString();
const EXPIRES_AT = new Date((NOW_SECONDS + 600) * 1000).toISOString();

describe("event-sourced session revocation contract", () => {
  it("blocks a subsequent request with an unexpired JWT after session.Revoked", async () => {
    const { verifier, token } = await createFixtureAuth();
    const sessions = createEventSourcedSessionAuthority({ now: () => new Date(NOW_ISO) });

    sessions.startSession({
      sessionId: "session-user-123",
      principal: { kind: "user", id: "user_123" },
      expiresAt: EXPIRES_AT,
      requestId: "req-start",
    });
    sessions.revokeSession({
      sessionId: "session-user-123",
      reason: "user-clicked-sign-out",
      requestId: "req-revoke",
    });

    const jwtResult = await verifier.verifyRequest({
      token,
      provider: "workos",
      sessionId: "session-user-123",
      requestId: "req-after-revoke",
    });
    const result = verifyRequestWithSessionState({
      verification: jwtResult,
      sessionId: "session-user-123",
      sessionEvents: sessions.events,
      requestId: "req-after-revoke",
      now: new Date(NOW_ISO),
    });

    assert.equal(jwtResult.ok, true, "JWT remains valid; denial must come from session state");
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "session-revoked");
    assert.equal(result.error.sessionId, "session-user-123");
    assert.equal(JSON.stringify(sessions.events).includes(token), false);
  });

  it("sign-out-everywhere revokes all sessions for one subject without touching another subject", () => {
    const sessions = createEventSourcedSessionAuthority({ now: () => new Date(NOW_ISO) });
    sessions.startSession({
      sessionId: "session-user-123-a",
      principal: { kind: "user", id: "user_123" },
      expiresAt: EXPIRES_AT,
      requestId: "req-start-a",
    });
    sessions.startSession({
      sessionId: "session-user-123-b",
      principal: { kind: "user", id: "user_123" },
      expiresAt: EXPIRES_AT,
      requestId: "req-start-b",
    });
    sessions.refreshSession({
      previousSessionId: "session-user-123-a",
      sessionId: "session-user-123-c",
      principal: { kind: "user", id: "user_123" },
      expiresAt: EXPIRES_AT,
      requestId: "req-refresh-a",
    });
    sessions.startSession({
      sessionId: "session-user-456",
      principal: { kind: "user", id: "user_456" },
      expiresAt: EXPIRES_AT,
      requestId: "req-start-other",
    });

    const result = sessions.signOutEverywhere({
      principal: { kind: "user", id: "user_123" },
      reason: "sign-out-everywhere",
      requestId: "req-global-signout",
    });

    assert.deepEqual(result.revokedSessionIds, [
      "session-user-123-a",
      "session-user-123-b",
      "session-user-123-c",
    ]);
    const replayed = replaySessionState(sessions.events);
    assert.equal(replayed.sessions["session-user-123-a"].status, "revoked");
    assert.equal(replayed.sessions["session-user-123-b"].status, "revoked");
    assert.equal(replayed.sessions["session-user-123-c"].status, "revoked");
    assert.equal(replayed.sessions["session-user-456"].status, "active");
  });

  it("denies affected live queries through a bounded session.Revoked propagation lane", () => {
    const sessions = createEventSourcedSessionAuthority({
      now: () => new Date(NOW_ISO),
      propagationBudgetMs: 250,
    });
    sessions.startSession({
      sessionId: "session-user-123",
      principal: { kind: "user", id: "user_123" },
      expiresAt: EXPIRES_AT,
      requestId: "req-start",
    });
    sessions.attachLiveQuery({
      queryId: "live-orders",
      sessionId: "session-user-123",
      principal: { kind: "user", id: "user_123" },
      openedAt: NOW_ISO,
    });

    const result = sessions.revokeSession({
      sessionId: "session-user-123",
      reason: "admin-revoked-session",
      requestId: "req-revoke",
      observedAt: new Date(Date.parse(NOW_ISO) + 200).toISOString(),
    });

    assert.deepEqual(result.reactiveDecisions, [
      {
        queryId: "live-orders",
        action: "close",
        reason: "session-revoked",
        sessionId: "session-user-123",
        propagationMs: 200,
      },
    ]);
    assert.equal(sessions.liveQueries["live-orders"].status, "closed");
  });

  it("refuses refresh after revoke and rejects unbounded revocation propagation", () => {
    const sessions = createEventSourcedSessionAuthority({
      now: () => new Date(NOW_ISO),
      propagationBudgetMs: 250,
    });
    sessions.startSession({
      sessionId: "session-user-123",
      principal: { kind: "user", id: "user_123" },
      expiresAt: EXPIRES_AT,
      requestId: "req-start",
    });
    sessions.attachLiveQuery({
      queryId: "live-orders",
      sessionId: "session-user-123",
      principal: { kind: "user", id: "user_123" },
      openedAt: NOW_ISO,
    });
    sessions.revokeSession({
      sessionId: "session-user-123",
      reason: "security-admin",
      requestId: "req-revoke",
    });

    const refresh = sessions.refreshSession({
      previousSessionId: "session-user-123",
      sessionId: "session-user-123-refresh",
      principal: { kind: "user", id: "user_123" },
      expiresAt: EXPIRES_AT,
      requestId: "req-refresh",
    });
    assert.equal(refresh.ok, false);
    assert.equal(refresh.error.code, "session-refresh-after-revoke-denied");

    assert.throws(
      () =>
        sessions.revokeSession({
          sessionId: "session-user-123",
          reason: "late-observer",
          requestId: "req-revoke-late",
          observedAt: new Date(Date.parse(NOW_ISO) + 251).toISOString(),
        }),
      /revocation propagation exceeded 250ms/,
    );
  });

  it("replays the session lifecycle from append-only events", () => {
    const sessions = createEventSourcedSessionAuthority({ now: () => new Date(NOW_ISO) });

    sessions.startSession({
      sessionId: "session-user-123-a",
      principal: { kind: "user", id: "user_123" },
      expiresAt: EXPIRES_AT,
      requestId: "req-start",
    });
    sessions.refreshSession({
      previousSessionId: "session-user-123-a",
      sessionId: "session-user-123-b",
      principal: { kind: "user", id: "user_123" },
      expiresAt: EXPIRES_AT,
      requestId: "req-refresh",
    });
    sessions.revokeSession({
      sessionId: "session-user-123-b",
      reason: "sign-out",
      requestId: "req-revoke",
    });

    assert.deepEqual(replaySessionState(sessions.events), replaySessionState([...sessions.events]));
    const oldSessionResult = verifyRequestWithSessionState({
      verification: { ok: true, ctx: { user: { id: "user_123" }, auth: {} } },
      sessionId: "session-user-123-a",
      sessionEvents: sessions.events,
      requestId: "req-old-session",
      now: new Date(NOW_ISO),
    });
    assert.equal(oldSessionResult.ok, false);
    assert.equal(oldSessionResult.error.code, "session-not-active");
    assert.deepEqual(replaySessionState(sessions.events).principalSessions["user:user_123"], [
      "session-user-123-a",
      "session-user-123-b",
    ]);
    assert.deepEqual(
      sessions.events.map((event) => event.type),
      ["session.Started", "session.Refreshed", "session.Revoked"],
    );
  });
});

async function createFixtureAuth() {
  const idp = createFixtureIdentityProvider({
    issuer: "https://idp.example.test",
    keyId: "kid-2026-06",
  });
  const token = await idp.signJwt({
    sub: "user_123",
    aud: "hobo-app://shop",
    app_tenant: "tenant-acme",
    roles: ["buyer"],
    scp: ["orders:read"],
    exp: NOW_SECONDS + 300,
    nbf: NOW_SECONDS - 30,
    iat: NOW_SECONDS - 30,
  });
  const verifier = createHoboAuthVerifier({
    authPort: {
      issuer: "https://idp.example.test",
      audience: "hobo-app://shop",
      algorithms: ["RS256"],
      jwks: idp.jwks(),
      tenantClaim: "app_tenant",
      subjectClaim: "sub",
      roleClaim: "roles",
      scopeClaim: "scp",
      providers: ["workos"],
    },
    now: () => NOW_SECONDS,
  });

  return { verifier, token };
}
