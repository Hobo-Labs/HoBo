import { isJsonString, isJsonObject } from "./json.js";
export const IDENTITY_EVENT_SCHEMA_VERSION = "hobo.identity-events/v1";

export const IDENTITY_EVENT_TYPES = Object.freeze([
  "identity.Issued",
  "identity.Rotated",
  "token.Granted",
  "token.Used",
  "token.Denied",
  "token.Revoked",
  "user.Authenticated",
  "session.Started",
  "session.Refreshed",
  "session.Revoked",
  "secret.Accessed",
  "config.Resolved",
]);

export const CREDENTIAL_AUDIT_RETENTION = deepFreeze({
  class: "security-audit",
  neverCompact: true,
  streamPolicy: "retain-token-identity-session-audit",
});

const EVENT_TYPE_SET = new Set(IDENTITY_EVENT_TYPES);
const PRINCIPAL_KINDS = new Set(["user", "agent", "service"]);
const FORBIDDEN_SENSITIVE_KEYS = new Set([
  "accessToken",
  "apiKey",
  "email",
  "jwt",
  "password",
  "plaintext",
  "refreshToken",
  "secret",
  "secretValue",
  "ssn",
  "token",
  "value",
]);

export const REQUIRED_EVENT_BODY_FIELDS = deepFreeze({
  "identity.Issued": ["identityId", "subject", "svidRef", "scope", "expiresAt"],
  "identity.Rotated": ["identityId", "previousIdentityId", "subject", "svidRef", "expiresAt"],
  "token.Granted": ["grantId", "subject", "target", "audience", "scopes", "tokenRef", "expiresAt"],
  "token.Used": ["grantId", "usageId", "operation", "resource"],
  "token.Denied": ["requestId", "subject", "target", "reason"],
  "token.Revoked": ["grantId", "reason"],
  "user.Authenticated": ["principal", "provider", "authTime", "sessionId"],
  "session.Started": ["sessionId", "principal", "expiresAt"],
  "session.Refreshed": ["sessionId", "previousSessionId", "principal", "expiresAt"],
  "session.Revoked": ["sessionId", "reason"],
  "secret.Accessed": ["secretRef", "source", "tokenUsageId"],
  "config.Resolved": ["configRef", "source"],
});

export function createIdentityEvent(type, data, overrides = {}) {
  return deepFreeze({
    id: overrides.id ?? `evt-${type.toLowerCase().replaceAll(".", "-")}`,
    type,
    schemaVersion: IDENTITY_EVENT_SCHEMA_VERSION,
    tenant: overrides.tenant ?? "platform-acme",
    seq: overrides.seq ?? 0,
    time: overrides.time ?? "2026-06-25T10:00:00.000Z",
    actor: clone(overrides.actor ?? { kind: "service", id: "yard/identity" }),
    correlationId: overrides.correlationId ?? "corr-identity-audit",
    causationId: overrides.causationId ?? "cmd-identity-audit",
    retention: clone(overrides.retention ?? CREDENTIAL_AUDIT_RETENTION),
    data: clone(data),
  });
}

export function createFixtureEventForType(type) {
  const commonActor = {
    kind: "agent",
    id: "agent:release",
    delegatedBy: { kind: "user", id: "user:priya" },
  };
  const dataByType = {
    "identity.Issued": {
      identityId: "svid-agent-release-1",
      subject: commonActor,
      svidRef: "identity://svid/agent-release-1",
      scope: [{ port: "database", resource: "shop.db", actions: ["write"] }],
      expiresAt: "2026-06-25T10:10:00.000Z",
    },
    "identity.Rotated": {
      identityId: "svid-agent-release-2",
      previousIdentityId: "svid-agent-release-1",
      subject: commonActor,
      svidRef: "identity://svid/agent-release-2",
      expiresAt: "2026-06-25T10:20:00.000Z",
    },
    "token.Granted": {
      grantId: "grant-db-write",
      subject: commonActor,
      target: { kind: "provider", id: "acme-cloud" },
      audience: "urn:acme:db",
      scopes: ["db:write"],
      tokenRef: "vault://tokens/grant-db-write",
      expiresAt: "2026-06-25T10:10:00.000Z",
    },
    "token.Used": {
      grantId: "grant-db-write",
      usageId: "use-db-write",
      operation: "database.write",
      resource: "shop.db/orders",
    },
    "token.Denied": {
      requestId: "token-request-denied",
      subject: commonActor,
      target: { kind: "provider", id: "acme-cloud" },
      reason: "scope database.admin denied by policy",
    },
    "token.Revoked": {
      grantId: "grant-db-write",
      reason: "session revoked",
    },
    "user.Authenticated": {
      principal: { kind: "user", id: "user:priya" },
      provider: "workos",
      authTime: "2026-06-25T10:00:00.000Z",
      sessionId: "session-priya-1",
    },
    "session.Started": {
      sessionId: "session-priya-1",
      principal: { kind: "user", id: "user:priya" },
      expiresAt: "2026-06-25T18:00:00.000Z",
    },
    "session.Refreshed": {
      sessionId: "session-priya-2",
      previousSessionId: "session-priya-1",
      principal: { kind: "user", id: "user:priya" },
      expiresAt: "2026-06-26T02:00:00.000Z",
    },
    "session.Revoked": {
      sessionId: "session-priya-2",
      reason: "sign-out-everywhere",
    },
    "secret.Accessed": {
      secretRef: "secret://prod/db-password",
      source: "provider-secret-store",
      tokenUsageId: "use-db-write",
    },
    "config.Resolved": {
      configRef: "config://prod/api-base-url",
      source: "camp-config",
    },
  };

  if (!dataByType[type]) {
    throw new Error(`unsupported identity event fixture type: ${type}`);
  }

  return createIdentityEvent(type, dataByType[type], {
    id: `evt-${type.toLowerCase().replaceAll(".", "-")}`,
    actor: type.startsWith("user.") || type.startsWith("session.")
      ? { kind: "user", id: "user:priya" }
      : commonActor,
  });
}

export function validateIdentityEvent(event) {
  const errors = [];

  if (!isPlainObject(event)) {
    return { ok: false, errors: ["event must be an object"] };
  }

  requireString(event.id, "id", errors);
  requireString(event.type, "type", errors);
  if (!EVENT_TYPE_SET.has(event.type)) {
    errors.push(`type ${String(event.type)} is not an identity audit event`);
  }
  if (event.schemaVersion !== IDENTITY_EVENT_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${IDENTITY_EVENT_SCHEMA_VERSION}`);
  }
  requireString(event.tenant, "tenant", errors);
  if (!Number.isSafeInteger(event.seq) || event.seq < 0) {
    errors.push("seq must be a non-negative safe integer");
  }
  requireIso(event.time, "time", errors);
  validatePrincipal(event.actor, "actor", errors);
  requireString(event.correlationId, "correlationId", errors);
  requireString(event.causationId, "causationId", errors);
  validateRetention(event.retention, errors);

  if (!isPlainObject(event.data)) {
    errors.push("data must be an object");
  } else {
    validateRequiredFields(event.type, event.data, errors);
    validateBody(event.type, event.data, errors);
    validateRedaction(event.type, event.data, errors);
  }

  return { ok: errors.length === 0, errors };
}

export function roundTripIdentityEvent(event) {
  return JSON.parse(JSON.stringify(event));
}

export function foldCredentialAudit(events) {
  const grantsById = new Map();
  const usesByGrantId = new Map();
  const grantIdByUsageId = new Map();
  const secretRefsByUsageId = new Map();
  const revokedGrantIds = new Set();
  const anomalies = [];

  for (const event of events) {
    const validation = validateIdentityEvent(event);
    if (!validation.ok) {
      throw new Error(validation.errors.join("; "));
    }

    if (event.type === "token.Granted") {
      if (grantsById.has(event.data.grantId)) {
        anomalies.push({
          type: event.type,
          id: event.id,
          code: "duplicate-token-grant",
          grantId: event.data.grantId,
        });
      } else {
        grantsById.set(event.data.grantId, clone(event));
      }
      continue;
    }

    if (event.type === "token.Used") {
      const grant = grantsById.get(event.data.grantId);
      if (!grant) {
        anomalies.push({
          type: event.type,
          id: event.id,
          code: "missing-token-grant",
          grantId: event.data.grantId,
        });
        continue;
      }
      appendToMapArray(usesByGrantId, event.data.grantId, clone(event));
      grantIdByUsageId.set(event.data.usageId, event.data.grantId);
      continue;
    }

    if (event.type === "secret.Accessed") {
      const grantId = grantIdByUsageId.get(event.data.tokenUsageId);
      if (!grantId) {
        anomalies.push({
          type: event.type,
          id: event.id,
          code: "secret-access-without-token-use",
          tokenUsageId: event.data.tokenUsageId,
        });
        continue;
      }
      appendToMapArray(secretRefsByUsageId, event.data.tokenUsageId, event.data.secretRef);
      continue;
    }

    if (event.type === "token.Revoked") {
      if (!grantsById.has(event.data.grantId)) {
        anomalies.push({
          type: event.type,
          id: event.id,
          code: "missing-token-grant",
          grantId: event.data.grantId,
        });
      } else {
        revokedGrantIds.add(event.data.grantId);
      }
    }
  }

  const chains = [];
  for (const [grantId, grant] of grantsById) {
    const subject = grant.data.subject;
    const target = grant.data.target;
    const uses = usesByGrantId.get(grantId) ?? [];
    const usageIds = uses.map((event) => event.data.usageId).sort();
    const secretRefs = [...new Set(usageIds.flatMap((usageId) => secretRefsByUsageId.get(usageId) ?? []))].sort();

    chains.push({
      user: subject.delegatedBy ? principalKey(subject.delegatedBy) : subject.kind === "user" ? principalKey(subject) : undefined,
      agent: subject.kind === "agent" ? principalKey(subject) : undefined,
      target: `${target.kind}:${target.id}`,
      audience: grant.data.audience,
      scopes: normalizeStrings(grant.data.scopes),
      grants: [grantId],
      uses: usageIds,
      secretRefs,
      revoked: revokedGrantIds.has(grantId),
    });
  }

  return deepFreeze({
    chains: chains.sort((left, right) => left.grants[0].localeCompare(right.grants[0])),
    grantsById: Object.fromEntries([...grantsById].map(([id, event]) => [id, event])),
    revokedGrantIds: [...revokedGrantIds].sort(),
    anomalies,
  });
}

function validateBody(type, data, errors) {
  switch (type) {
    case "identity.Issued":
      validatePrincipal(data.subject, `${type} data.subject`, errors);
      validateScopeEntries(data.scope, `${type} data.scope`, errors);
      requireIso(data.expiresAt, `${type} data.expiresAt`, errors);
      break;
    case "identity.Rotated":
      validatePrincipal(data.subject, `${type} data.subject`, errors);
      requireIso(data.expiresAt, `${type} data.expiresAt`, errors);
      break;
    case "token.Granted":
      validatePrincipal(data.subject, `${type} data.subject`, errors);
      validateTarget(data.target, `${type} data.target`, errors);
      validateStringArray(data.scopes, `${type} data.scopes`, errors);
      requireIso(data.expiresAt, `${type} data.expiresAt`, errors);
      break;
    case "token.Denied":
      validatePrincipal(data.subject, `${type} data.subject`, errors);
      validateTarget(data.target, `${type} data.target`, errors);
      break;
    case "user.Authenticated":
    case "session.Started":
    case "session.Refreshed":
      validatePrincipal(data.principal, `${type} data.principal`, errors);
      if (data.authTime) {
        requireIso(data.authTime, `${type} data.authTime`, errors);
      }
      if (data.expiresAt) {
        requireIso(data.expiresAt, `${type} data.expiresAt`, errors);
      }
      break;
    default:
      break;
  }
}

function validateRequiredFields(type, data, errors) {
  for (const field of REQUIRED_EVENT_BODY_FIELDS[type] ?? []) {
    if (data[field] === undefined || data[field] === null) {
      errors.push(`${type} data.${field} is required`);
    }
  }
}

function validateRedaction(type, data, errors) {
  for (const path of findForbiddenPaths(data, `${type} data`)) {
    errors.push(`${path} is forbidden; emit a ref, digest, or source marker instead`);
  }
}

function findForbiddenPaths(value, path) {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => findForbiddenPaths(entry, `${path}[${index}]`));
  }
  if (!isPlainObject(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, nested]) => {
    const nextPath = `${path}.${key}`;
    const direct = FORBIDDEN_SENSITIVE_KEYS.has(key) ? [nextPath] : [];
    return [...direct, ...findForbiddenPaths(nested, nextPath)];
  });
}

function validateRetention(retention, errors) {
  if (!isPlainObject(retention)) {
    errors.push("retention is required");
    return;
  }
  if (retention.class !== CREDENTIAL_AUDIT_RETENTION.class) {
    errors.push("retention.class must be security-audit");
  }
  if (retention.neverCompact !== true) {
    errors.push("retention.neverCompact must be true");
  }
}

function validatePrincipal(principal, path, errors) {
  if (!isPlainObject(principal)) {
    errors.push(`${path} must be a principal object`);
    return;
  }
  if (!PRINCIPAL_KINDS.has(principal.kind)) {
    errors.push(`${path}.kind must be user, agent, or service`);
  }
  requireString(principal.id, `${path}.id`, errors);
  if (principal.delegatedBy !== undefined) {
    if (!isPlainObject(principal.delegatedBy)) {
      errors.push(`${path}.delegatedBy must be a principal object`);
    } else if (principal.delegatedBy.kind === "service") {
      errors.push(`${path}.delegatedBy cannot be a service principal`);
    } else {
      validatePrincipal(principal.delegatedBy, `${path}.delegatedBy`, errors);
    }
  }
}

function validateTarget(target, path, errors) {
  if (!isPlainObject(target)) {
    errors.push(`${path} must be an object`);
    return;
  }
  requireString(target.kind, `${path}.kind`, errors);
  requireString(target.id, `${path}.id`, errors);
}

function validateScopeEntries(scope, path, errors) {
  if (!Array.isArray(scope)) {
    errors.push(`${path} must be an array`);
    return;
  }
  scope.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (!isPlainObject(entry)) {
      errors.push(`${entryPath} must be an object`);
      return;
    }
    requireString(entry.port, `${entryPath}.port`, errors);
    requireString(entry.resource, `${entryPath}.resource`, errors);
    validateStringArray(entry.actions, `${entryPath}.actions`, errors);
  });
}

function validateStringArray(value, path, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path} must be a non-empty array`);
    return;
  }
  value.forEach((entry, index) => requireString(entry, `${path}[${index}]`, errors));
}

function requireString(value, path, errors) {
  if (!isJsonString(value) || value.length === 0) {
    errors.push(`${path} is required`);
  }
}

function requireIso(value, path, errors) {
  requireString(value, path, errors);
  if (isJsonString(value) && Number.isNaN(Date.parse(value))) {
    errors.push(`${path} must be ISO-8601`);
  }
}

function appendToMapArray(map, key, value) {
  const current = map.get(key) ?? [];
  current.push(value);
  map.set(key, current);
}

function principalKey(principal) {
  return `${principal.kind}:${principal.id.replace(/^(user|agent|service):/, "")}`;
}

function normalizeStrings(values) {
  return [...new Set(values)].sort();
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

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
