import {
  selectPreferredAuthFlow,
  verifySignedAuthManifestEnvelope,
} from "../../hobo-auth-json-contract/src/auth-json.js";
import {
  createIdentityEvent,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";
import { isJsonString, isJsonObject } from "./json.js";

const DEFAULT_TOKEN_TTL_MS = 5 * 60 * 1000;
const DEFAULT_EVENT_ACTOR = { kind: "service", id: "yard/identity" };

export function createTokenBroker(options = {}) {
  const registry = requireRegistry(options.registry);
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? defaultIdFactory();
  const flowHandlers = { ...defaultFlowHandlers(now), ...options.flowHandlers };
  const eventSink = options.eventSink ?? (() => {});

  return Object.freeze({
    async requestToken(input) {
      const request = normalizeRequest(input);
      const target = { kind: "provider", id: request.provider };

      if (!svidAllows(request.svidScope, request.scope)) {
        return denied({
          request,
          target,
          reason: "requested scope is outside caller SVID scope",
          now,
          eventSink,
        });
      }

      const envelope = await registry.resolveAuthManifest(request.provider);
      if (!envelope) {
        return denied({
          request,
          target,
          reason: "unknown provider",
          now,
          eventSink,
        });
      }

      const { auth } = verifySignedAuthManifestEnvelope(envelope);
      const selected = selectPreferredAuthFlow(auth);
      const grantId = idFactory("grant");
      const usageId = idFactory("use");
      const dispatch = {
        provider: request.provider,
        subject: request.subject,
        scope: request.scope,
        flow: selected.flow,
        auth,
        grantId,
      };
      const handler = flowHandlers[selected.flow.type];
      if (!handler) {
        return denied({
          request,
          target,
          reason: `unsupported auth flow ${selected.flow.type}`,
          now,
          eventSink,
        });
      }

      const credential = normalizeCredential(
        await handler(dispatch),
        request.provider,
        grantId,
        now,
      );
      const granted = buildIdentityEvent(
        "token.Granted",
        {
          grantId,
          subject: request.subject,
          target,
          audience: firstAudience(auth),
          scopes: [scopeKey(request.scope)],
          tokenRef: credential.tokenRef,
          expiresAt: credential.expiresAt,
        },
        {
          id: `evt-${grantId}-granted`,
          actor: DEFAULT_EVENT_ACTOR,
          time: now().toISOString(),
          seq: 1,
          correlationId: request.requestId,
          causationId: request.requestId,
        },
      );
      const used = buildIdentityEvent(
        "token.Used",
        {
          grantId,
          usageId,
          operation: "request_token",
          resource: `${request.provider}:${request.scope.port}:${request.scope.resource}`,
        },
        {
          id: `evt-${usageId}-used`,
          actor: DEFAULT_EVENT_ACTOR,
          time: now().toISOString(),
          seq: 2,
          correlationId: request.requestId,
          causationId: granted.id,
        },
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
        events: [granted, used],
      };
    },
  });
}

export function createRequestTokenTool(broker) {
  if (!broker || !(broker.requestToken instanceof Function)) {
    throw new Error("request_token tool requires a broker with requestToken(input)");
  }

  return Object.freeze({
    name: "request_token",
    async invoke(input) {
      return broker.requestToken(input);
    },
  });
}

export function createTokenContext(broker, options = {}) {
  if (!broker || !(broker.requestToken instanceof Function)) {
    throw new Error("ctx.token requires a broker with requestToken(input)");
  }

  const subject = normalizePrincipal(options.subject, "subject");
  const svidScope = normalizeSvidScope(options.svidScope);
  const requestIdFactory = options.requestIdFactory ?? defaultIdFactory();

  return Object.freeze({
    async token(provider, scope, overrides = {}) {
      return broker.requestToken({
        requestId: overrides.requestId ?? requestIdFactory("ctx-token-request"),
        subject,
        provider,
        scope,
        svidScope,
      });
    },
  });
}

function denied({ request, target, reason, now, eventSink }) {
  const event = buildIdentityEvent(
    "token.Denied",
    {
      requestId: request.requestId,
      subject: request.subject,
      target,
      reason,
    },
    {
      id: `evt-${request.requestId}-denied`,
      actor: DEFAULT_EVENT_ACTOR,
      time: now().toISOString(),
      seq: 1,
      correlationId: request.requestId,
      causationId: request.requestId,
    },
  );
  emitEvents(eventSink, [event]);

  return {
    ok: false,
    requestId: request.requestId,
    provider: request.provider,
    reason,
    scope: clone(request.scope),
    events: [event],
  };
}

function normalizeRequest(input) {
  if (!isPlainObject(input)) {
    throw new Error("token request must be an object");
  }

  const requestId = requireString(input.requestId, "requestId");
  const provider = requireString(input.provider, "provider");
  const subject = normalizePrincipal(input.subject, "subject");
  const scope = normalizeRequestedScope(input.scope, "scope");
  const svidScope = normalizeSvidScope(input.svidScope);

  return {
    requestId,
    provider,
    subject,
    scope,
    svidScope,
  };
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
    throw new Error("svidScope must be an array");
  }

  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`svidScope[${index}] must be an object`);
    }
    if (!Array.isArray(entry.actions) || entry.actions.length === 0) {
      throw new Error(`svidScope[${index}].actions must be a non-empty array`);
    }
    return {
      port: requireString(entry.port, `svidScope[${index}].port`),
      resource: requireString(entry.resource, `svidScope[${index}].resource`),
      actions: entry.actions.map((action, actionIndex) =>
        requireString(action, `svidScope[${index}].actions[${actionIndex}]`),
      ),
    };
  });
}

function svidAllows(svidScope, requested) {
  return svidScope.some((entry) =>
    entry.port === requested.port &&
    entry.resource === requested.resource &&
    entry.actions.includes(requested.action),
  );
}

function normalizeCredential(rawCredential, provider, grantId, now) {
  const credential = isPlainObject(rawCredential) ? rawCredential : {};
  return {
    tokenRef: credential.tokenRef ?? `stub://tokens/${provider}/${grantId}`,
    expiresAt: credential.expiresAt ?? new Date(now().getTime() + DEFAULT_TOKEN_TTL_MS).toISOString(),
    stub: credential.stub ?? true,
  };
}

function firstAudience(auth) {
  const selectedFlow = selectPreferredAuthFlow(auth).flow;
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

function emitEvents(eventSink, events) {
  for (const event of events) {
    eventSink(event);
  }
}

function defaultFlowHandlers(now) {
  const handler = async ({ provider, grantId }) => ({
    tokenRef: `stub://tokens/${provider}/${grantId}`,
    expiresAt: new Date(now().getTime() + DEFAULT_TOKEN_TTL_MS).toISOString(),
    stub: true,
  });

  return Object.freeze({
    "oidc-federation": handler,
    "oauth2-xaa": handler,
    "oauth2-obo": handler,
    "device-code": handler,
    "api-key": handler,
  });
}

function requireRegistry(registry) {
  if (!registry || !(registry.resolveAuthManifest instanceof Function)) {
    throw new Error("token broker requires registry.resolveAuthManifest(provider)");
  }
  return registry;
}

function defaultIdFactory() {
  let next = 1;
  return (prefix) => `${prefix}-${next++}`;
}

function requireString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function isPlainObject(value) {
  return (
    value !== null &&
    isJsonObject(value) &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
