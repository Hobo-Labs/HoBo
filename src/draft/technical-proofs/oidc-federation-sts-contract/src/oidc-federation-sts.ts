import { createHash } from "node:crypto";

import {
  createIdentityEvent,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";

const DEFAULT_ASSERTION_TTL_SECONDS = 5 * 60;
const DEFAULT_PROVIDER_TTL_SECONDS = 15 * 60;
const EVENT_ACTOR = { kind: "service", id: "yard/identity" };

export function createOidcFederationBroker(options = {}) {
  const providerSts = requireProviderSts(options.providerSts);
  const issuer = requireString(options.issuer, "issuer");
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? defaultIdFactory();
  const eventSink = options.eventSink ?? (() => {});
  const maxTtlSeconds = normalizePositiveInteger(
    options.maxTtlSeconds ?? DEFAULT_PROVIDER_TTL_SECONDS,
    "maxTtlSeconds",
  );
  const assertionTtlSeconds = normalizePositiveInteger(
    options.assertionTtlSeconds ?? DEFAULT_ASSERTION_TTL_SECONDS,
    "assertionTtlSeconds",
  );

  return Object.freeze({
    async requestToken(input) {
      const request = normalizeRequest(input);
      const issuedAt = now();
      const target = { kind: "provider", id: request.provider };

      if (Date.parse(request.svid.expiresAt) <= issuedAt.getTime()) {
        return denied({
          request,
          target,
          reason: "expired SVID cannot be exchanged",
          now: issuedAt,
          eventSink,
        });
      }

      if (!svidAllows(request.svid.scope, request.scope)) {
        return denied({
          request,
          target,
          reason: "requested scope is outside caller SVID scope",
          now: issuedAt,
          eventSink,
        });
      }

      if (request.flow.type !== "oidc-federation") {
        return denied({
          request,
          target,
          reason: `unsupported auth flow ${request.flow.type}`,
          now: issuedAt,
          eventSink,
        });
      }

      const trustConfigError = validateProviderTrustConfig(request.flow);
      if (trustConfigError) {
        return denied({
          request,
          target,
          reason: trustConfigError,
          now: issuedAt,
          eventSink,
        });
      }

      const grantId = idFactory("grant");
      const usageId = idFactory("use");
      const operation = providerOperation(request.flow);
      const assertion = mintOidcAssertion({
        assertionTtlSeconds,
        grantId,
        issuer,
        issuedAt,
        operation,
        request,
      });
      const rawCredential = await providerSts.exchange({
        provider: request.provider,
        grantId,
        operation,
        flow: clone(request.flow),
        scope: clone(request.scope),
        subject: clone(request.subject),
        svidRef: request.svid.svidRef,
        assertion: assertion.compact,
        assertionClaims: clone(assertion.claims),
        assertionRef: assertion.assertionRef,
      });
      const providerCredential = normalizeProviderCredential(rawCredential);
      const narrowed = narrowPermissions(providerCredential.permissions, request.scope);

      if (narrowed.permissions.length === 0) {
        return denied({
          request,
          target,
          reason: "provider STS token does not include requested scope",
          now: issuedAt,
          eventSink,
        });
      }

      const flags = narrowed.overbroad ? ["provider-token-overbroad"] : [];
      const credential = {
        credentialRef: providerCredential.credentialRef,
        expiresAt: boundedExpiresAt({
          issuedAt,
          maxTtlSeconds,
          providerExpiresAt: providerCredential.expiresAt,
          svidExpiresAt: request.svid.expiresAt,
        }),
        permissions: narrowed.permissions,
        flags,
      };
      credential.ttlSeconds = Math.floor((Date.parse(credential.expiresAt) - issuedAt.getTime()) / 1000);

      const granted = buildIdentityEvent(
        "token.Granted",
        {
          grantId,
          subject: request.subject,
          target,
          audience: request.flow.audience,
          scopes: [scopeKey(request.scope)],
          tokenRef: credential.credentialRef,
          expiresAt: credential.expiresAt,
          providerExchange: operation,
          assertionRef: assertion.assertionRef,
          permissionDigest: digest(narrowed.permissions),
          flags,
          staticCredentialReads: 0,
        },
        {
          id: `evt-${grantId}-granted`,
          time: issuedAt.toISOString(),
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
          time: issuedAt.toISOString(),
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
          type: "oidc-federation",
          operation,
          audience: request.flow.audience,
        },
        scope: clone(request.scope),
        assertion: {
          assertionRef: assertion.assertionRef,
          expiresAt: assertion.expiresAt,
        },
        credential,
        events: [granted, used],
      };
    },
  });
}

export function createFixtureProviderSts(options = {}) {
  const calls = [];

  return Object.freeze({
    calls,
    async exchange(input) {
      const request = clone(input);
      calls.push(request);
      return {
        credentialRef: options.credentialRef ?? `sts://${input.provider}/${input.grantId}`,
        expiresAt: options.expiresAt ?? "2026-06-25T12:05:00.000Z",
        permissions: clone(options.permissions ?? [
          {
            port: input.scope.port,
            resource: input.scope.resource,
            actions: [input.scope.action],
          },
        ]),
      };
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
      time: now.toISOString(),
      seq: 1,
      correlationId: request.requestId,
      causationId: request.requestId,
    },
  );
  eventSink(event);

  return {
    ok: false,
    requestId: request.requestId,
    provider: request.provider,
    reason,
    scope: clone(request.scope),
    events: [event],
  };
}

function mintOidcAssertion({
  assertionTtlSeconds,
  grantId,
  issuer,
  issuedAt,
  operation,
  request,
}) {
  const iat = Math.floor(issuedAt.getTime() / 1000);
  const expMs = Math.min(
    issuedAt.getTime() + assertionTtlSeconds * 1000,
    Date.parse(request.svid.expiresAt),
  );
  const claims = {
    iss: issuer,
    sub: request.svid.subject,
    aud: request.flow.audience,
    tenant: request.svid.tenant,
    svidRef: request.svid.svidRef,
    scope: [scopeGrant(request.scope)],
    provider: request.provider,
    providerExchange: operation,
    grantId,
    iat,
    nbf: iat,
    exp: Math.floor(expMs / 1000),
  };
  const header = { alg: "RS256", typ: "JWT", kid: "yard-identity-fixture" };
  const signingInput = `${base64UrlJson(header)}.${base64UrlJson(claims)}`;
  const signature = digest(signingInput);
  const compact = `${signingInput}.${signature}`;

  return {
    compact,
    claims,
    assertionRef: `oidc-assertion://${digest(compact).slice(0, 32)}`,
    expiresAt: new Date(expMs).toISOString(),
  };
}

function providerOperation(flow) {
  if (flow.operation) {
    return requireString(flow.operation, "flow.operation");
  }
  switch (flow.providerKind) {
    case "aws":
      return "aws:AssumeRoleWithWebIdentity";
    case "gcp":
      return "gcp:WorkloadIdentityFederation";
    case "azure":
      return "azure:FederatedCredential";
    default:
      break;
  }
  if (flow.exchange === "sts:AssumeRoleWithWebIdentity") {
    return "aws:AssumeRoleWithWebIdentity";
  }
  if (flow.exchange === "gcp:workload-identity-federation") {
    return "gcp:WorkloadIdentityFederation";
  }
  if (flow.exchange === "azure:federated-credential") {
    return "azure:FederatedCredential";
  }
  return requireString(flow.exchange, "flow.exchange");
}

function validateProviderTrustConfig(flow) {
  if (!isPlainObject(flow.trust)) {
    return "oidc-federation flow requires trust.oidcDiscovery";
  }
  if (!isString(flow.trust.oidcDiscovery) || flow.trust.oidcDiscovery.length === 0) {
    return "oidc-federation flow requires trust.oidcDiscovery";
  }

  const operation = providerOperation(flow);
  switch (operation) {
    case "aws:AssumeRoleWithWebIdentity":
      return requireTrustField(flow, "roleArn", "AWS AssumeRoleWithWebIdentity");
    case "gcp:WorkloadIdentityFederation":
      return requireTrustField(flow, "serviceAccount", "GCP Workload Identity Federation");
    case "azure:FederatedCredential":
      return requireTrustField(flow, "clientId", "Azure federated credential");
    default:
      return null;
  }
}

function requireTrustField(flow, field, providerName) {
  if (!isString(flow[field]) || flow[field].length === 0) {
    return `${providerName} flow requires ${field}`;
  }
  return null;
}

function narrowPermissions(permissions, requested) {
  let overbroad = false;
  let matched = false;

  for (const permission of permissions) {
    const exactTarget = permission.port === requested.port && permission.resource === requested.resource;
    const wildcardTarget = permission.port === requested.port && permission.resource === "*";
    const targetMatches = exactTarget || wildcardTarget;
    const actionMatches = permission.actions.includes(requested.action);

    if (targetMatches && actionMatches) {
      matched = true;
      if (!exactTarget || permission.actions.length !== 1) {
        overbroad = true;
      }
      continue;
    }
    overbroad = true;
  }

  return {
    permissions: matched ? [scopeGrant(requested)] : [],
    overbroad,
  };
}

function boundedExpiresAt({
  issuedAt,
  maxTtlSeconds,
  providerExpiresAt,
  svidExpiresAt,
}) {
  const providerMs = requireIsoMs(providerExpiresAt, "provider credential expiresAt");
  const svidMs = requireIsoMs(svidExpiresAt, "svid.expiresAt");
  const maxMs = issuedAt.getTime() + maxTtlSeconds * 1000;
  const boundedMs = Math.min(providerMs, svidMs, maxMs);

  if (boundedMs <= issuedAt.getTime()) {
    throw new Error("bounded credential expiry must be in the future");
  }
  return new Date(boundedMs).toISOString();
}

function normalizeRequest(input) {
  if (!isPlainObject(input)) {
    throw new Error("OIDC federation request must be an object");
  }
  return {
    requestId: requireString(input.requestId, "requestId"),
    provider: requireString(input.provider, "provider"),
    subject: normalizePrincipal(input.subject, "subject"),
    svid: normalizeSvid(input.svid),
    scope: normalizeScope(input.scope, "scope"),
    flow: normalizeFlow(input.flow),
  };
}

function normalizeFlow(flow) {
  if (!isPlainObject(flow)) {
    throw new Error("flow must be an object");
  }
  return {
    ...clone(flow),
    type: requireString(flow.type, "flow.type"),
    audience: requireString(flow.audience, "flow.audience"),
    exchange: requireString(flow.exchange, "flow.exchange"),
  };
}

function normalizeSvid(input) {
  if (!isPlainObject(input)) {
    throw new Error("svid must be an object");
  }
  return {
    svidRef: requireString(input.svidRef, "svid.svidRef"),
    issuer: requireString(input.issuer, "svid.issuer"),
    subject: requireString(input.subject, "svid.subject"),
    tenant: requireString(input.tenant, "svid.tenant"),
    audience: requireString(input.audience, "svid.audience"),
    expiresAt: requireIso(input.expiresAt, "svid.expiresAt"),
    scope: normalizeSvidScope(input.scope),
  };
}

function normalizeSvidScope(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("svid.scope must be a non-empty array");
  }
  return input.map((entry, index) => {
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

function normalizeProviderCredential(input) {
  if (!isPlainObject(input)) {
    throw new Error("provider STS response must be an object");
  }
  return {
    credentialRef: requireString(input.credentialRef, "provider credentialRef"),
    expiresAt: requireIso(input.expiresAt, "provider credential expiresAt"),
    permissions: normalizePermissionSet(input.permissions),
  };
}

function normalizePermissionSet(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new Error("provider permissions must be a non-empty array");
  }
  return input.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`provider permissions[${index}] must be an object`);
    }
    if (!Array.isArray(entry.actions) || entry.actions.length === 0) {
      throw new Error(`provider permissions[${index}].actions must be a non-empty array`);
    }
    return {
      port: requireString(entry.port, `provider permissions[${index}].port`),
      resource: requireString(entry.resource, `provider permissions[${index}].resource`),
      actions: entry.actions.map((action, actionIndex) =>
        requireString(action, `provider permissions[${index}].actions[${actionIndex}]`),
      ),
    };
  });
}

function normalizePrincipal(input, field) {
  if (!isPlainObject(input)) {
    throw new Error(`${field} must be a PrincipalRef`);
  }
  const principal = {
    kind: requireString(input.kind, `${field}.kind`),
    id: requireString(input.id, `${field}.id`),
  };
  if (input.delegatedBy !== undefined) {
    principal.delegatedBy = normalizePrincipal(input.delegatedBy, `${field}.delegatedBy`);
  }
  return principal;
}

function normalizeScope(input, field) {
  if (!isPlainObject(input)) {
    throw new Error(`${field} must include port, resource, and action`);
  }
  return {
    port: requireString(input.port, `${field}.port`),
    resource: requireString(input.resource, `${field}.resource`),
    action: requireString(input.action, `${field}.action`),
  };
}

function svidAllows(svidScope, requested) {
  return svidScope.some((grant) =>
    grant.port === requested.port &&
    grant.resource === requested.resource &&
    grant.actions.includes(requested.action),
  );
}

function scopeGrant(scope) {
  return {
    port: scope.port,
    resource: scope.resource,
    actions: [scope.action],
  };
}

function scopeKey(scope) {
  return `${scope.port}:${scope.resource}:${scope.action}`;
}

function buildIdentityEvent(type, data, overrides) {
  const event = createIdentityEvent(type, data, {
    actor: EVENT_ACTOR,
    ...overrides,
  });
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

function requireProviderSts(providerSts) {
  if (!providerSts || !isCallable(providerSts.exchange)) {
    throw new Error("OIDC federation broker requires providerSts.exchange(input)");
  }
  return providerSts;
}

function normalizePositiveInteger(input, field) {
  if (!Number.isSafeInteger(input) || input <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return input;
}

function requireString(input, field) {
  if (!isString(input) || input.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return input;
}

function requireIso(input, field) {
  requireIsoMs(input, field);
  return input;
}

function requireIsoMs(input, field) {
  requireString(input, field);
  const parsed = Date.parse(input);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${field} must be an ISO timestamp`);
  }
  return parsed;
}

function base64UrlJson(input) {
  return Buffer.from(JSON.stringify(input)).toString("base64url");
}

function digest(input) {
  return createHash("sha256")
    .update(isString(input) ? input : JSON.stringify(input))
    .digest("hex");
}

function defaultIdFactory() {
  let next = 1;
  return (prefix) => `${prefix}-${next++}`;
}

function isPlainObject(input) {
  return (
    input !== null &&
    isObjectRecord(input) &&
    !Array.isArray(input) &&
    (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null)
  );
}

function isObjectRecord(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isCallable(value) {
  return ["[object Function]", "[object AsyncFunction]", "[object GeneratorFunction]"].includes(
    Object.prototype.toString.call(value),
  );
}

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}

function clone(input) {
  if (input === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(input));
}
