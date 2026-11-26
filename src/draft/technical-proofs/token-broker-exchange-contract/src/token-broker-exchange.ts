/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: these checks are the parser boundary for erased exchange input and internal capability values. */
import {
  selectPreferredAuthFlow,
  verifySignedAuthManifestEnvelope,
} from "../../hobo-auth-json-contract/src/auth-json.js";
import {
  createIdentityEvent,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";
import { recommendedBrokerCacheBounds } from "../../token-broker-ha-cache-contract/src/token-broker-ha-cache.js";

export const BROKER_EXCHANGE_ERROR = Object.freeze({
  SVID_EXPIRED: "svid-expired",
  SVID_INVALID: "svid-invalid",
  SCOPE_OUTSIDE_SVID: "scope-outside-svid",
  RENEWAL_GRACE_EXPIRED: "renewal-grace-expired",
  SCOPE_WIDENING: "scope-widening-requires-live-identity",
  GRANT_REVOKED: "grant-revoked",
  GRANT_NOT_FOUND: "grant-not-found",
  UNKNOWN_PROVIDER: "unknown-provider",
  UNSUPPORTED_FLOW: "unsupported-auth-flow",
});

const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;
const DEFAULT_EVENT_ACTOR = { kind: "service", id: "yard/identity/broker" };

export function parseSvid(input) {
  if (!isPlainObject(input)) {
    throw new Error("svid must be an object");
  }

  const subject = normalizePrincipal(input.subject, "svid.subject");
  const expiresAt = requireIsoDate(input.expiresAt, "svid.expiresAt");
  const svidRef = requireString(input.svidRef, "svid.svidRef");
  const audience = normalizeAudience(input.audience);
  const scope = normalizeSvidScope(input.scope);

  return deepFreeze({
    subject,
    expiresAt,
    svidRef,
    audience,
    scope,
  });
}

export function createTokenBrokerExchange(options = {}) {
  const registry = requireRegistry(options.registry);
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? defaultIdFactory();
  const flowHandlers = { ...defaultFlowHandlers(now), ...options.flowHandlers };
  const eventSink = options.eventSink ?? (() => {});
  const bounds = recommendedBrokerCacheBounds({
    ttlMs: options.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS,
  });
  const grants = new Map();
  const revokedGrantIds = new Set();

  return Object.freeze({
    async exchange(input) {
      const request = normalizeExchangeRequest(input);
      const svid = parseSvid(request.svid);
      const nowMs = now().getTime();

      if (nowMs >= Date.parse(svid.expiresAt)) {
        return denied({
          request,
          code: BROKER_EXCHANGE_ERROR.SVID_EXPIRED,
          reason: "SVID is expired",
          now,
          eventSink,
        });
      }

      if (!svidAllows(svid.scope, request.scope)) {
        return denied({
          request,
          code: BROKER_EXCHANGE_ERROR.SCOPE_OUTSIDE_SVID,
          reason: "requested scope is outside caller SVID scope",
          now,
          eventSink,
        });
      }

      const envelope = await registry.resolveAuthManifest(request.provider);
      if (!envelope) {
        return denied({
          request,
          code: BROKER_EXCHANGE_ERROR.UNKNOWN_PROVIDER,
          reason: "unknown provider",
          now,
          eventSink,
        });
      }

      const { auth } = verifySignedAuthManifestEnvelope(envelope);
      const selected = selectPreferredAuthFlow(auth);
      const handler = flowHandlers[selected.flow.type];
      if (!handler) {
        return denied({
          request,
          code: BROKER_EXCHANGE_ERROR.UNSUPPORTED_FLOW,
          reason: `unsupported auth flow ${selected.flow.type}`,
          now,
          eventSink,
        });
      }

      const grantId = idFactory("grant");
      const usageId = idFactory("use");
      const target = { kind: "provider", id: request.provider };
      const dispatch = {
        provider: request.provider,
        subject: svid.subject,
        scope: request.scope,
        flow: selected.flow,
        auth,
        grantId,
        svidRef: svid.svidRef,
      };
      const credential = normalizeCredential(
        await handler(dispatch),
        request.provider,
        grantId,
        now,
      );
      const rotateAtMs = nowMs + Math.floor(bounds.ttlMs * bounds.rotateAtFraction);
      const renewalGraceUntilMs = Math.min(
        rotateAtMs + bounds.maxRenewalGraceMs,
        Date.parse(credential.expiresAt),
      );
      const grantRecord = deepFreeze({
        grantId,
        provider: request.provider,
        subject: svid.subject,
        scope: clone(request.scope),
        svidScope: clone(svid.scope),
        credential,
        rotateAt: new Date(rotateAtMs).toISOString(),
        renewalGraceUntil: new Date(renewalGraceUntilMs).toISOString(),
        expiresAt: credential.expiresAt,
      });
      grants.set(grantId, grantRecord);

      const granted = buildIdentityEvent(
        "token.Granted",
        {
          grantId,
          subject: svid.subject,
          target,
          audience: firstAudience(auth, selected.flow),
          scopes: [scopeKey(request.scope)],
          tokenRef: credential.tokenRef,
          expiresAt: credential.expiresAt,
        },
        eventMeta(request.requestId, grantId, "granted", now, 1),
      );
      const used = buildIdentityEvent(
        "token.Used",
        {
          grantId,
          usageId,
          operation: "exchange",
          resource: `${request.provider}:${request.scope.port}:${request.scope.resource}`,
        },
        eventMeta(request.requestId, usageId, "used", now, 2, granted.id),
      );
      emitEvents(eventSink, [granted, used]);

      return {
        ok: true,
        requestId: request.requestId,
        provider: request.provider,
        flow: {
          type: selected.flow.type,
          preference: selected.preference,
          warnings: selected.warnings,
        },
        scope: clone(request.scope),
        credential,
        grantId,
        events: [granted, used],
      };
    },

    async renew(input) {
      const request = normalizeRenewRequest(input);
      const grant = grants.get(request.grantId);
      const nowMs = now().getTime();

      if (!grant) {
        return denied({
          request: { requestId: request.requestId, provider: request.provider ?? "unknown", scope: request.scope },
          code: BROKER_EXCHANGE_ERROR.GRANT_NOT_FOUND,
          reason: "grant not found",
          now,
          eventSink,
        });
      }

      if (revokedGrantIds.has(request.grantId)) {
        return denied({
          request: { requestId: request.requestId, provider: grant.provider, scope: request.scope },
          code: BROKER_EXCHANGE_ERROR.GRANT_REVOKED,
          reason: "grant revoked",
          now,
          eventSink,
        });
      }

      if (!isSameOrNarrowerScope(request.scope, grant.scope)) {
        return denied({
          request: { requestId: request.requestId, provider: grant.provider, scope: request.scope },
          code: BROKER_EXCHANGE_ERROR.SCOPE_WIDENING,
          reason: "scope-widening-requires-live-identity",
          now,
          eventSink,
        });
      }

      if (nowMs < Date.parse(grant.rotateAt)) {
        return sameGrantRenewal(grant, request, now, eventSink);
      }

      if (nowMs <= Date.parse(grant.renewalGraceUntil)) {
        return sameGrantRenewal(grant, request, now, eventSink, "renewal-grace");
      }

      return denied({
        request: { requestId: request.requestId, provider: grant.provider, scope: request.scope },
        code: BROKER_EXCHANGE_ERROR.RENEWAL_GRACE_EXPIRED,
        reason: "renewal-grace-expired",
        now,
        eventSink,
      });
    },

    async revoke(grantId, reason = "operator-revoked") {
      const normalizedGrantId = requireString(grantId, "grantId");
      revokedGrantIds.add(normalizedGrantId);
      const grant = grants.get(normalizedGrantId);
      const event = buildIdentityEvent(
        "token.Revoked",
        {
          grantId: normalizedGrantId,
          reason,
        },
        {
          id: `evt-${normalizedGrantId}-revoked`,
          actor: DEFAULT_EVENT_ACTOR,
          time: now().toISOString(),
          seq: 1,
          correlationId: normalizedGrantId,
          causationId: normalizedGrantId,
        },
      );
      emitEvents(eventSink, [event]);
      return {
        ok: true,
        grantId: normalizedGrantId,
        provider: grant?.provider ?? null,
        events: [event],
      };
    },
  });
}

function sameGrantRenewal(grant, request, now, eventSink, mode = "cache-renewal") {
  const usageId = `use-${grant.grantId}-renewal`;
  const used = buildIdentityEvent(
    "token.Used",
    {
      grantId: grant.grantId,
      usageId,
      operation: "renew",
      resource: `${grant.provider}:${request.scope.port}:${request.scope.resource}`,
    },
    eventMeta(request.requestId, usageId, "renew-used", now, 1),
  );
  emitEvents(eventSink, [used]);
  return {
    ok: true,
    requestId: request.requestId,
    provider: grant.provider,
    mode,
    scope: clone(request.scope),
    credential: grant.credential,
    grantId: grant.grantId,
    events: [used],
  };
}

function denied({ request, code, reason, now, eventSink }) {
  const event = buildIdentityEvent(
    "token.Denied",
    {
      requestId: request.requestId,
      subject: request.subject ?? { kind: "service", id: "unknown" },
      target: { kind: "provider", id: request.provider },
      reason: `${code}: ${reason}`,
    },
    eventMeta(request.requestId, request.requestId, "denied", now, 1),
  );
  emitEvents(eventSink, [event]);

  return {
    ok: false,
    requestId: request.requestId,
    provider: request.provider,
    code,
    reason,
    scope: clone(request.scope),
    events: [event],
  };
}

function normalizeExchangeRequest(input) {
  if (!isPlainObject(input)) {
    throw new Error("exchange request must be an object");
  }

  return {
    requestId: requireString(input.requestId, "requestId"),
    provider: requireString(input.provider, "provider"),
    scope: normalizeRequestedScope(input.scope, "scope"),
    svid: input.svid,
  };
}

function normalizeRenewRequest(input) {
  if (!isPlainObject(input)) {
    throw new Error("renew request must be an object");
  }

  return {
    requestId: requireString(input.requestId, "requestId"),
    grantId: requireString(input.grantId, "grantId"),
    provider: input.provider,
    scope: normalizeRequestedScope(input.scope, "scope"),
  };
}

function normalizeRequestedScope(value, field) {
  if (!isPlainObject(value)) {
    throw new Error(`${field} must include port, resource, and action`);
  }

  return {
    port: requireString(value.port, `${field}.port`),
    resource: requireString(value.resource, `${field}.resource`),
    action: requireString(value.action, `${field}.action`),
  };
}

function normalizeSvidScope(value) {
  if (!Array.isArray(value)) {
    throw new Error("svid.scope must be an array");
  }

  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`svid.scope[${index}] must be an object`);
    }
    if (!Array.isArray(entry.actions) || entry.actions.length === 0) {
      throw new Error(`svid.scope[${index}].actions must be a non-empty array`);
    }
    return {
      port: requireString(entry.port, `svid.scope[${index}].port`),
      resource: requireString(entry.resource, `svid.scope[${index}].resource`),
      actions: entry.actions.map((action, actionIndex) =>
        requireString(action, `svid.scope[${index}].actions[${actionIndex}]`),
      ),
    };
  });
}

function normalizePrincipal(value, field) {
  if (!isPlainObject(value)) {
    throw new Error(`${field} must be a PrincipalRef`);
  }

  const normalized = {
    kind: requireString(value.kind, `${field}.kind`),
    id: requireString(value.id, `${field}.id`),
  };
  if (value.delegatedBy !== undefined) {
    normalized.delegatedBy = normalizePrincipal(value.delegatedBy, `${field}.delegatedBy`);
  }
  return normalized;
}

function normalizeAudience(value) {
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("svid.audience must be a non-empty string or array");
  }
  return value.map((entry, index) => requireString(entry, `svid.audience[${index}]`));
}

function svidAllows(svidScope, requested) {
  return svidScope.some(
    (entry) =>
      entry.port === requested.port &&
      entry.resource === requested.resource &&
      entry.actions.includes(requested.action),
  );
}

function isSameOrNarrowerScope(requested, allowed) {
  return (
    requested.port === allowed.port &&
    requested.resource === allowed.resource &&
    requested.action === allowed.action
  );
}

function normalizeCredential(rawCredential, provider, grantId, now) {
  const credential = isPlainObject(rawCredential) ? rawCredential : {};
  return {
    tokenRef: credential.tokenRef ?? `tokenref://provider/${provider}/${grantId}`,
    expiresAt:
      credential.expiresAt ??
      new Date(now().getTime() + DEFAULT_TOKEN_TTL_MS).toISOString(),
    brokered: credential.brokered ?? true,
    stub: credential.stub ?? false,
  };
}

function firstAudience(auth, selectedFlow) {
  return selectedFlow.audience ?? auth.resourceIndicators[0];
}

function scopeKey(scope) {
  return `${scope.port}:${scope.resource}:${scope.action}`;
}

function buildIdentityEvent(type, data, overrides) {
  const event = createIdentityEvent(type, data, overrides);
  const validation = validateIdentityEvent(event);
  if (!validation.ok) {
    throw new Error(`invalid ${type} event: ${validation.errors.join("; ")}`);
  }
  return event;
}

function eventMeta(requestId, suffix, label, now, seq, causationId = requestId) {
  return {
    id: `evt-${suffix}-${label}`,
    actor: DEFAULT_EVENT_ACTOR,
    time: now().toISOString(),
    seq,
    correlationId: requestId,
    causationId,
  };
}

function emitEvents(eventSink, events) {
  for (const event of events) {
    eventSink(event);
  }
}

function defaultFlowHandlers(now) {
  const handler = async ({ provider, grantId, flow }) => ({
    tokenRef: `tokenref://provider/${provider}/${grantId}`,
    expiresAt: new Date(now().getTime() + DEFAULT_TOKEN_TTL_MS).toISOString(),
    brokered: true,
    stub: false,
    exchange: flow.exchange ?? "oidc-federation",
  });

  return Object.freeze({
    "oidc-federation": handler,
    "oauth2-obo": handler,
    "oauth2-xaa": handler,
  });
}

function requireRegistry(registry) {
  if (!registry || typeof registry.resolveAuthManifest !== "function") {
    throw new Error("token broker exchange requires registry.resolveAuthManifest(provider)");
  }
  return registry;
}

function defaultIdFactory() {
  let next = 1;
  return (prefix) => `${prefix}-${next++}`;
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function requireIsoDate(value, field) {
  const ms = Date.parse(requireString(value, field));
  if (!Number.isFinite(ms)) {
    throw new Error(`${field} must be an ISO-8601 date`);
  }
  return value;
}

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
