import {
  buildJwtBearerGrantRequest,
  createFixtureIdJag,
  ID_JAG_TOKEN_TYPE,
  parseIdJagTokenExchangeResponse,
} from "../../id-jag-token-exchange-contract/src/id-jag-token-exchange.js";
import {
  createIdentityEvent,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


const DEFAULT_ID_JAG_TTL_MS = 5 * 60 * 1000;
const DEFAULT_ACCESS_TOKEN_MAX_LIFETIME_MS = 10 * 60 * 1000;
const DEFAULT_EVENT_ACTOR = { kind: "service", id: "yard/identity" };
const SUBJECT_TOKEN_TYPES = new Set([
  "urn:ietf:params:oauth:token-type:id_token",
  "urn:ietf:params:oauth:token-type:jwt",
]);

export function createOutboundXaaTokenBroker(options = {}) {
  const issuer = requireString(options.issuer ?? "https://identity.hobo.test", "issuer");
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? defaultIdFactory();
  const preMintPolicy = options.preMintPolicy ?? (async () => ({ ok: true }));
  const targetAuthorizationServers = options.targetAuthorizationServers ?? {};
  const fallbackExchanger = options.fallbackExchanger ?? defaultFallbackExchanger(now);
  const idJagTtlMs = options.idJagTtlMs ?? DEFAULT_ID_JAG_TTL_MS;
  const accessTokenMaxLifetimeMs =
    options.accessTokenMaxLifetimeMs ?? DEFAULT_ACCESS_TOKEN_MAX_LIFETIME_MS;
  const eventSink = options.eventSink ?? (() => {});

  return Object.freeze({
    async exchangeToken(input) {
      const request = normalizeExchangeRequest(input);
      if (request.target.authFlow.type !== "oauth2-xaa") {
        return exchangeFallback({
          request,
          fallbackExchanger,
          now,
          idFactory,
          accessTokenMaxLifetimeMs,
          eventSink,
        });
      }

      if (!request.subject.delegatedBy) {
        return denied({
          request,
          reason: "subject.delegatedBy is required before minting ID-JAG",
          now,
          eventSink,
        });
      }
      if (request.subject.delegatedBy.kind !== "user") {
        return denied({
          request,
          reason: "subject.delegatedBy.kind must be user before minting ID-JAG",
          now,
          eventSink,
        });
      }

      const policy = await preMintPolicy({
        requestId: request.requestId,
        subject: clone(request.subject),
        subjectToken: clone(request.subjectToken),
        target: clone(request.target),
        requestedScopes: clone(request.requestedScopes),
      });
      if (!policy || policy.ok !== true) {
        return denied({
          request,
          reason: policy?.reason ?? "pre-mint policy denied outbound XAA",
          now,
          eventSink,
        });
      }

      return exchangeXaa({
        request,
        issuer,
        now,
        idFactory,
        idJagTtlMs,
        accessTokenMaxLifetimeMs,
        targetAuthorizationServers,
        eventSink,
      });
    },
  });
}

async function exchangeXaa({
  request,
  issuer,
  now,
  idFactory,
  idJagTtlMs,
  accessTokenMaxLifetimeMs,
  targetAuthorizationServers,
  eventSink,
}) {
  const grantId = idFactory("grant");
  const usageId = idFactory("use");
  const nonce = idFactory("nonce");
  const issuedAt = Math.floor(now().getTime() / 1000);
  const expiresAt = issuedAt + Math.floor(idJagTtlMs / 1000);
  const assertion = createFixtureIdJag({
    issuer,
    subjectId: request.subject.delegatedBy.id,
    subject: request.subject,
    audience: request.target.audience,
    resource: request.target.resource,
    clientId: request.subject.id,
    scopes: request.requestedScopes,
    nonce,
    issuedAt,
    expiresAt,
  });
  const idJag = parseIdJagTokenExchangeResponse(
    {
      issued_token_type: ID_JAG_TOKEN_TYPE,
      access_token: assertion,
      token_type: "N_A",
      scope: request.requestedScopes.join(" "),
      expires_in: expiresAt - issuedAt,
    },
    {
      expectedAudience: request.target.audience,
      expectedResource: request.target.resource,
      allowedScopes: request.target.allowedScopes,
      maxLifetimeSec: Math.floor(idJagTtlMs / 1000),
      now: issuedAt,
    },
  ).claims;

  const authorizationServerId =
    request.target.authFlow.targetAuthorizationServer ?? request.target.id;
  const authorizationServer = targetAuthorizationServers[authorizationServerId];
  if (!authorizationServer) {
    return denied({
      request,
      reason: `unknown target authorization server ${authorizationServerId}`,
      now,
      eventSink,
    });
  }

  let rawCredential;
  try {
    rawCredential = await redeemJwtBearer(authorizationServer, {
      request,
      assertion,
    });
  } catch (error) {
    return denied({
      request,
      reason: errorMessage(error),
      now,
      eventSink,
    });
  }

  let credential;
  try {
    credential = normalizeCredential(rawCredential, {
      request,
      now,
      accessTokenMaxLifetimeMs,
    });
  } catch (error) {
    return denied({
      request,
      reason: errorMessage(error),
      now,
      eventSink,
    });
  }

  const events = grantedAndUsedEvents({
    request,
    credential,
    grantId,
    usageId,
    operation: "oauth2-xaa.redeem",
    now,
    eventSink,
  });

  return {
    ok: true,
    requestId: request.requestId,
    flow: { type: "oauth2-xaa", targetAuthorizationServer: authorizationServerId },
    idJag: {
      audience: idJag.aud,
      resource: idJag.resource,
      scopes: clone(idJag.scope),
      subject: clone(idJag.subject),
      nonce: idJag.nonce,
      expiresAt: new Date(idJag.exp * 1000).toISOString(),
    },
    credential,
    events,
  };
}

async function exchangeFallback({
  request,
  fallbackExchanger,
  now,
  idFactory,
  accessTokenMaxLifetimeMs,
  eventSink,
}) {
  const grantId = idFactory("grant");
  const usageId = idFactory("use");
  let rawCredential;
  try {
    rawCredential = await fallbackExchanger({
      requestId: request.requestId,
      subject: clone(request.subject),
      subjectToken: clone(request.subjectToken),
      target: clone(request.target),
      requestedScopes: clone(request.requestedScopes),
    });
  } catch (error) {
    return denied({
      request,
      reason: errorMessage(error),
      now,
      eventSink,
    });
  }

  let credential;
  try {
    credential = normalizeCredential(rawCredential, {
      request,
      now,
      accessTokenMaxLifetimeMs,
    });
  } catch (error) {
    return denied({
      request,
      reason: errorMessage(error),
      now,
      eventSink,
    });
  }

  const events = grantedAndUsedEvents({
    request,
    credential,
    grantId,
    usageId,
    operation: "oauth2-obo.exchange",
    now,
    eventSink,
  });

  return {
    ok: true,
    requestId: request.requestId,
    flow: { type: "oauth2-obo", fallbackFrom: request.target.authFlow.type },
    credential,
    events,
  };
}

function normalizeExchangeRequest(input) {
  assertObject(input, "exchange request");
  const target = normalizeTarget(input.target, "target");
  const requestedScopes = normalizeScopes(input.requestedScopes, {
    allowedScopes: target.allowedScopes,
    field: "requestedScopes",
  });

  return {
    requestId: requireString(input.requestId, "requestId"),
    subject: normalizePrincipal(input.subject, "subject"),
    subjectToken: normalizeSubjectToken(input.subjectToken),
    target,
    requestedScopes,
  };
}

function normalizeTarget(value, field) {
  assertObject(value, field);
  const allowedScopes = normalizeScopes(value.allowedScopes, { field: `${field}.allowedScopes` });
  assertObject(value.authFlow, `${field}.authFlow`);

  return {
    id: requireString(value.id, `${field}.id`),
    audience: requireString(value.audience, `${field}.audience`),
    resource: requireString(value.resource, `${field}.resource`),
    allowedScopes,
    authFlow: {
      type: requireString(value.authFlow.type, `${field}.authFlow.type`),
      targetAuthorizationServer:
        value.authFlow.targetAuthorizationServer === undefined
          ? undefined
          : requireString(
              value.authFlow.targetAuthorizationServer,
              `${field}.authFlow.targetAuthorizationServer`,
            ),
    },
  };
}

function normalizeSubjectToken(value) {
  assertObject(value, "subjectToken");
  const tokenType = requireString(value.tokenType, "subjectToken.tokenType");
  if (!SUBJECT_TOKEN_TYPES.has(tokenType)) {
    throw new Error("subjectToken.tokenType must be id_token or jwt");
  }
  return {
    tokenRef: requireString(value.tokenRef, "subjectToken.tokenRef"),
    tokenType,
  };
}

function normalizePrincipal(value, field) {
  assertObject(value, field);
  const principal = {
    kind: requireString(value.kind, `${field}.kind`),
    id: requireString(value.id, `${field}.id`),
  };
  if (value.delegatedBy !== undefined) {
    principal.delegatedBy = normalizePrincipal(value.delegatedBy, `${field}.delegatedBy`);
  }
  return principal;
}

function normalizeCredential(rawCredential, { request, now, accessTokenMaxLifetimeMs }) {
  assertObject(rawCredential, "credential");
  const nowTime = now().getTime();
  const expiresAt = requireIso(rawCredential.expiresAt, "credential.expiresAt");
  if (expiresAt.getTime() <= nowTime) {
    throw new Error("access token is expired");
  }
  if (expiresAt.getTime() - nowTime > accessTokenMaxLifetimeMs) {
    throw new Error("access token exceeds short-lived maxLifetimeMs");
  }

  const audience = requireString(rawCredential.audience, "credential.audience");
  if (audience !== request.target.audience) {
    throw new Error("access token audience must match target audience");
  }
  const scopes = normalizeScopes(rawCredential.scopes ?? request.requestedScopes, {
    allowedScopes: request.requestedScopes,
    field: "credential.scopes",
  });

  return Object.freeze({
    tokenRef: requireString(rawCredential.tokenRef, "credential.tokenRef"),
    audience,
    scopes,
    expiresAt: expiresAt.toISOString(),
    target: { kind: "external-app", id: request.target.id },
  });
}

async function redeemJwtBearer(authorizationServer, { request, assertion }) {
  const jwtBearerRequest = buildJwtBearerGrantRequest({ assertion });
  if (authorizationServer && authorizationServer.redeemJwtBearer instanceof Function) {
    return authorizationServer.redeemJwtBearer(jwtBearerRequest, {
      target: clone(request.target),
    });
  }
  throw new Error("target authorization server must expose redeemJwtBearer(request)");
}

function grantedAndUsedEvents({ request, credential, grantId, usageId, operation, now, eventSink }) {
  const granted = buildIdentityEvent(
    "token.Granted",
    {
      grantId,
      subject: request.subject,
      target: credential.target,
      audience: credential.audience,
      scopes: credential.scopes,
      tokenRef: credential.tokenRef,
      expiresAt: credential.expiresAt,
    },
    {
      id: `evt-${grantId}-granted`,
      time: now().toISOString(),
      actor: DEFAULT_EVENT_ACTOR,
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
      operation,
      resource: request.target.resource,
    },
    {
      id: `evt-${usageId}-used`,
      time: now().toISOString(),
      actor: DEFAULT_EVENT_ACTOR,
      seq: 2,
      correlationId: request.requestId,
      causationId: granted.id,
    },
  );
  emitEvents(eventSink, [granted, used]);
  return [granted, used];
}

function denied({ request, reason, now, eventSink }) {
  const event = buildIdentityEvent(
    "token.Denied",
    {
      requestId: request.requestId,
      subject: request.subject,
      target: { kind: "external-app", id: request.target.id },
      reason,
    },
    {
      id: `evt-${request.requestId}-denied`,
      time: now().toISOString(),
      actor: DEFAULT_EVENT_ACTOR,
      seq: 1,
      correlationId: request.requestId,
      causationId: request.requestId,
    },
  );
  emitEvents(eventSink, [event]);

  return {
    ok: false,
    requestId: request.requestId,
    flow: { type: request.target.authFlow.type },
    target: { kind: "external-app", id: request.target.id },
    reason,
    events: [event],
  };
}

function buildIdentityEvent(type, data, overrides) {
  const event = createIdentityEvent(type, data, overrides);
  const validation = validateIdentityEvent(event);
  if (!validation.ok) {
    throw new Error(`invalid ${type} event: ${validation.errors.join("; ")}`);
  }
  return event;
}

function defaultFallbackExchanger(now) {
  return async (request) => ({
    tokenRef: `vault://tokens/${request.target.id}/${request.requestId}`,
    audience: request.target.audience,
    expiresAt: new Date(now().getTime() + 2 * 60 * 1000).toISOString(),
    scopes: request.requestedScopes,
  });
}

function emitEvents(eventSink, events) {
  for (const event of events) {
    eventSink(event);
  }
}

function normalizeScopes(scopes, { allowedScopes, field } = {}) {
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error(`${field ?? "scopes"} must be a non-empty array`);
  }
  const seen = new Set();
  const normalized = scopes.map((scope, index) => {
    const value = requireString(scope, `${field ?? "scopes"}[${index}]`);
    if (/\s/.test(value)) {
      throw new Error(`${field ?? "scopes"}[${index}] must not contain whitespace`);
    }
    if (seen.has(value)) {
      throw new Error(`duplicate scope '${value}'`);
    }
    seen.add(value);
    return value;
  });
  if (allowedScopes !== undefined) {
    const allowed = new Set(normalizeScopes(allowedScopes, { field: "allowedScopes" }));
    for (const scope of normalized) {
      if (!allowed.has(scope)) {
        throw new Error(`scope '${scope}' is outside allowed scopes`);
      }
    }
  }
  return normalized.sort();
}

function requireIso(value, field) {
  const raw = requireString(value, field);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${field} must be ISO-8601`);
  }
  return parsed;
}

function defaultIdFactory() {
  let next = 1;
  return (prefix) => `${prefix}-${next++}`;
}

function assertObject(value, field) {
  if (!isPlainObject(value)) {
    throw new Error(`${field} must be an object`);
  }
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
