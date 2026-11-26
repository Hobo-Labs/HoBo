import {
  createIdentityEvent,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


const DEFAULT_PROPAGATION_BUDGET_MS = 250;

export function createEventSourcedSessionAuthority(options = {}) {
  const now = options.now instanceof Function ? options.now : () => new Date();
  const propagationBudgetMs = options.propagationBudgetMs ?? DEFAULT_PROPAGATION_BUDGET_MS;
  const events = [];
  const liveQueries = {};

  function appendSessionEvent(type, data, requestId) {
    const event = createIdentityEvent(type, data, {
      id: `evt-${requestId}-${type.toLowerCase().replaceAll(".", "-")}`,
      actor: data.principal ?? { kind: "service", id: "yard/auth-session" },
      correlationId: requestId,
      causationId: requestId,
      seq: events.length + 1,
      time: now().toISOString(),
    });
    const validation = validateIdentityEvent(event);
    if (!validation.ok) {
      throw new Error(`invalid ${type}: ${validation.errors.join("; ")}`);
    }
    events.push(event);
    return event;
  }

  function startSession({ sessionId, principal, expiresAt, requestId }) {
    const event = appendSessionEvent(
      "session.Started",
      { sessionId, principal: normalizePrincipal(principal), expiresAt },
      requestId,
    );
    return { ok: true, event };
  }

  function refreshSession({ previousSessionId, sessionId, principal, expiresAt, requestId }) {
    const state = replaySessionState(events);
    const previous = state.sessions[previousSessionId];
    if (!previous) {
      return {
        ok: false,
        error: { code: "session-refresh-unknown-previous", previousSessionId },
      };
    }
    if (previous.status === "revoked") {
      return {
        ok: false,
        error: { code: "session-refresh-after-revoke-denied", previousSessionId },
      };
    }

    const event = appendSessionEvent(
      "session.Refreshed",
      {
        sessionId,
        previousSessionId,
        principal: normalizePrincipal(principal),
        expiresAt,
      },
      requestId,
    );
    return { ok: true, event };
  }

  function revokeSession({ sessionId, reason, requestId, observedAt }) {
    const revokedAt = now().toISOString();
    const propagationMs = calculatePropagationMs(revokedAt, observedAt ?? revokedAt);
    if (propagationMs > propagationBudgetMs) {
      throw new Error(`revocation propagation exceeded ${propagationBudgetMs}ms`);
    }

    const state = replaySessionState(events);
    const principal = state.sessions[sessionId]?.principal;
    const event = appendSessionEvent(
      "session.Revoked",
      {
        sessionId,
        reason,
        revokedAt,
        ...(principal ? { principal } : undefined),
      },
      requestId,
    );

    const reactiveDecisions = closeAffectedLiveQueries(liveQueries, sessionId, propagationMs);
    return { ok: true, event, reactiveDecisions };
  }

  function signOutEverywhere({ principal, reason, requestId }) {
    const state = replaySessionState(events);
    const key = principalKey(normalizePrincipal(principal));
    const revokedSessionIds = (state.principalSessions[key] ?? [])
      .filter((sessionId) => state.sessions[sessionId]?.status !== "revoked")
      .sort();
    const reactiveDecisions = [];

    for (const sessionId of revokedSessionIds) {
      const result = revokeSession({
        sessionId,
        reason,
        requestId: `${requestId}-${sessionId}`,
      });
      reactiveDecisions.push(...result.reactiveDecisions);
    }

    return { ok: true, revokedSessionIds, reactiveDecisions };
  }

  function attachLiveQuery({ queryId, sessionId, principal, openedAt }) {
    liveQueries[queryId] = {
      queryId,
      sessionId,
      principal: normalizePrincipal(principal),
      openedAt,
      status: "open",
    };
    return liveQueries[queryId];
  }

  return {
    events,
    liveQueries,
    startSession,
    refreshSession,
    revokeSession,
    signOutEverywhere,
    attachLiveQuery,
  };
}

export function verifyRequestWithSessionState({
  verification,
  sessionId,
  sessionEvents,
  requestId,
  now = new Date(),
}) {
  if (!verification?.ok) {
    return verification;
  }

  const state = replaySessionState(sessionEvents);
  const session = state.sessions[sessionId];
  if (!session) {
    return deny("session-unknown", requestId, { sessionId });
  }
  if (session.status === "revoked") {
    return deny("session-revoked", requestId, {
      sessionId,
      reason: session.reason,
      revokedAt: session.revokedAt,
    });
  }
  if (session.status !== "active") {
    return deny("session-not-active", requestId, { sessionId, status: session.status });
  }
  if (Date.parse(session.expiresAt) <= now.getTime()) {
    return deny("session-expired", requestId, { sessionId, expiresAt: session.expiresAt });
  }

  const userPrincipal = { kind: "user", id: verification.ctx.user.id };
  if (principalKey(session.principal) !== principalKey(userPrincipal)) {
    return deny("session-principal-mismatch", requestId, {
      sessionId,
      expected: principalKey(session.principal),
      actual: principalKey(userPrincipal),
    });
  }

  return {
    ...verification,
    ctx: {
      ...verification.ctx,
      auth: {
        ...verification.ctx.auth,
        session: {
          id: sessionId,
          status: session.status,
          verifiedAt: now.toISOString(),
        },
      },
    },
  };
}

export function replaySessionState(events) {
  const sessions = {};
  const principalSessions = {};

  for (const event of events) {
    const validation = validateIdentityEvent(event);
    if (!validation.ok) {
      throw new Error(validation.errors.join("; "));
    }

    if (event.type === "session.Started") {
      const principal = normalizePrincipal(event.data.principal);
      sessions[event.data.sessionId] = {
        sessionId: event.data.sessionId,
        principal,
        expiresAt: event.data.expiresAt,
        status: "active",
        startedAt: event.time,
        eventIds: [event.id],
      };
      appendPrincipalSession(principalSessions, principal, event.data.sessionId);
      continue;
    }

    if (event.type === "session.Refreshed") {
      const previous = sessions[event.data.previousSessionId];
      if (previous && previous.status !== "revoked") {
        previous.status = "refreshed";
        previous.refreshedBy = event.data.sessionId;
        previous.eventIds.push(event.id);
      }
      const principal = normalizePrincipal(event.data.principal);
      sessions[event.data.sessionId] = {
        sessionId: event.data.sessionId,
        previousSessionId: event.data.previousSessionId,
        principal,
        expiresAt: event.data.expiresAt,
        status: "active",
        startedAt: event.time,
        eventIds: [event.id],
      };
      appendPrincipalSession(principalSessions, principal, event.data.sessionId);
      continue;
    }

    if (event.type === "session.Revoked") {
      const current = sessions[event.data.sessionId] ?? {
        sessionId: event.data.sessionId,
        principal: event.data.principal ? normalizePrincipal(event.data.principal) : undefined,
        eventIds: [],
      };
      current.status = "revoked";
      current.reason = event.data.reason;
      current.revokedAt = event.data.revokedAt ?? event.time;
      current.eventIds.push(event.id);
      sessions[event.data.sessionId] = current;
    }
  }

  for (const sessionIds of Object.values(principalSessions)) {
    sessionIds.sort();
  }

  return deepFreeze({
    sessions,
    principalSessions: Object.fromEntries(Object.entries(principalSessions).sort()),
  });
}

function closeAffectedLiveQueries(liveQueries, sessionId, propagationMs) {
  return Object.values(liveQueries)
    .filter((query) => query.sessionId === sessionId && query.status === "open")
    .sort((left, right) => left.queryId.localeCompare(right.queryId))
    .map((query) => {
      query.status = "closed";
      query.closedReason = "session-revoked";
      return {
        queryId: query.queryId,
        action: "close",
        reason: "session-revoked",
        sessionId,
        propagationMs,
      };
    });
}

function calculatePropagationMs(revokedAt, observedAt) {
  return Math.max(0, Date.parse(observedAt) - Date.parse(revokedAt));
}

function appendPrincipalSession(principalSessions, principal, sessionId) {
  const key = principalKey(principal);
  const current = principalSessions[key] ?? [];
  if (!current.includes(sessionId)) {
    current.push(sessionId);
  }
  principalSessions[key] = current;
}

function deny(code, requestId, extra) {
  return {
    ok: false,
    error: {
      code,
      requestId,
      ...extra,
    },
  };
}

function normalizePrincipal(principal) {
  if (
    !principal ||
    !isJsonObject(principal) ||
    !isJsonString(principal.kind) ||
    principal.kind.length === 0 ||
    !isJsonString(principal.id) ||
    principal.id.length === 0
  ) {
    throw new Error("principal is required");
  }
  return {
    kind: principal.kind,
    id: principal.id,
  };
}

function principalKey(principal) {
  return `${principal.kind}:${principal.id.replace(/^(user|agent|service):/, "")}`;
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
