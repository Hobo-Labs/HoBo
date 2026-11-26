import {
  createIdentityEvent,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


const DEFAULT_TTL_SECONDS = 5 * 60;
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

export function createJwtSvidIssuer(options = {}) {
  const issuer = requireIssuer(options.issuer);
  const now = options.now ?? (() => new Date());
  const ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const idFactory = options.idFactory ?? defaultIdFactory("svid");
  const eventSink = options.eventSink ?? (() => {});

  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("ttlSeconds must be a positive safe integer");
  }

  return Object.freeze({
    async issue(input) {
      const request = normalizeRequest(input);
      const verdict = request.attestationVerdict;

      if (verdict.state !== "attested") {
        return {
          ok: false,
          requestId: request.requestId,
          reason: "workload-not-attested",
          policy: clone(verdict.policy),
          events: [],
        };
      }

      const scope = clampScopeToInferredGrant(request.requestedScope, request.inferredGrant);
      if (scope.length === 0) {
        return {
          ok: false,
          requestId: request.requestId,
          reason: "requested-scope-outside-inferred-grant",
          events: [],
        };
      }

      const issuedAt = now();
      const iat = Math.floor(issuedAt.getTime() / 1000);
      const exp = iat + ttlSeconds;
      const identityId = idFactory("svid");
      const svidRef = `identity://svid/${identityId}`;
      const tenant = verdict.binding.tenant;
      const claims = {
        iss: issuer.discovery().issuer,
        sub: `spiffe://yard/${tenant}/agent/${request.agentName}`,
        aud: request.audience,
        tenant,
        parentPrincipal: toJwtPrincipal(verdict.binding.parentPrincipal),
        codeVersion: clone(verdict.binding.codeVersion),
        scope: scope.map(toJwtScopeGrant),
        iat,
        nbf: iat,
        exp,
      };
      const token = await issuer.signJwtSvid(claims);
      const event = buildIdentityIssuedEvent({
        identityId,
        requestId: request.requestId,
        agentName: request.agentName,
        parentPrincipal: verdict.binding.parentPrincipal,
        svidRef,
        scope,
        expiresAt: new Date(exp * 1000).toISOString(),
        time: issuedAt.toISOString(),
        causationId: verdict.binding.runId,
      });

      eventSink(event);

      return {
        ok: true,
        requestId: request.requestId,
        identityId,
        svidRef,
        token,
        claims,
        scope,
        events: [event],
      };
    },
  });
}

function normalizeRequest(input) {
  if (!isPlainObject(input)) {
    throw new Error("SVID issuance request must be an object");
  }

  const inferredGrant = normalizeScopeSet(input.inferredGrant, "inferredGrant");
  return {
    requestId: requireString(input.requestId, "requestId"),
    agentName: requireSegment(input.agentName, "agentName"),
    audience: normalizeAudience(input.audience),
    attestationVerdict: normalizeAttestationVerdict(input.attestationVerdict),
    requestedScope: input.requestedScope === undefined
      ? inferredGrant
      : normalizeScopeSet(input.requestedScope, "requestedScope"),
    inferredGrant,
  };
}

function normalizeAttestationVerdict(verdict) {
  if (!isPlainObject(verdict)) {
    throw new Error("attestationVerdict must be an object");
  }
  if (verdict.state !== "attested") {
    return {
      state: verdict.state,
      reason: verdict.reason,
      policy: clone(verdict.policy),
    };
  }
  if (!isPlainObject(verdict.binding)) {
    throw new Error("attested verdict must include binding");
  }
  requireSegment(verdict.binding.tenant, "attestationVerdict.binding.tenant");
  requireString(verdict.binding.runId, "attestationVerdict.binding.runId");
  normalizePrincipal(verdict.binding.parentPrincipal, "attestationVerdict.binding.parentPrincipal");
  if (!isPlainObject(verdict.binding.codeVersion)) {
    throw new Error("attestationVerdict.binding.codeVersion must be an object");
  }

  return clone(verdict);
}

function normalizeScopeSet(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty scope array`);
  }

  return value.map((entry, index) => normalizeScopeEntry(entry, `${field}[${index}]`));
}

function normalizeScopeEntry(entry, field) {
  if (!isPlainObject(entry)) {
    throw new Error(`${field} must be an object`);
  }
  if (!Array.isArray(entry.actions) || entry.actions.length === 0) {
    throw new Error(`${field}.actions must be a non-empty array`);
  }

  return {
    port: requireString(entry.port, `${field}.port`),
    resource: requireString(entry.resource, `${field}.resource`),
    actions: [...new Set(entry.actions.map((action, index) =>
      requireString(action, `${field}.actions[${index}]`),
    ))],
  };
}

function clampScopeToInferredGrant(requestedScope, inferredGrant) {
  const inferredByTarget = new Map(
    inferredGrant.map((grant) => [scopeTargetKey(grant), grant]),
  );
  const clamped = [];

  for (const requested of requestedScope) {
    const inferred = inferredByTarget.get(scopeTargetKey(requested));
    if (!inferred) {
      continue;
    }
    const requestedActions = new Set(requested.actions);
    const actions = inferred.actions.filter((action) => requestedActions.has(action));
    if (actions.length > 0) {
      clamped.push({ port: inferred.port, resource: inferred.resource, actions });
    }
  }

  return clamped;
}

function buildIdentityIssuedEvent({
  identityId,
  requestId,
  agentName,
  parentPrincipal,
  svidRef,
  scope,
  expiresAt,
  time,
  causationId,
}) {
  const event = createIdentityEvent(
    "identity.Issued",
    {
      identityId,
      subject: eventSubject(agentName, parentPrincipal),
      svidRef,
      scope: clone(scope),
      expiresAt,
    },
    {
      id: `evt-${identityId}-issued`,
      actor: { kind: "service", id: "yard/identity" },
      time,
      seq: 1,
      correlationId: requestId,
      causationId: causationId ?? requestId,
    },
  );
  const validation = validateIdentityEvent(event);
  if (!validation.ok) {
    throw new Error(`invalid identity.Issued event: ${validation.errors.join("; ")}`);
  }
  return event;
}

function eventSubject(agentName, parentPrincipal) {
  const subject = {
    kind: "agent",
    id: `agent:${agentName}`,
  };
  if (parentPrincipal.kind === "user" || parentPrincipal.kind === "agent") {
    subject.delegatedBy = clone(parentPrincipal);
  }
  return subject;
}

function toJwtScopeGrant(grant) {
  return {
    port: grant.port,
    resource: grant.resource,
    verbs: [...grant.actions],
  };
}

function toJwtPrincipal(principal) {
  const id = principal.id.startsWith(`${principal.kind}:`)
    ? principal.id.slice(principal.kind.length + 1)
    : principal.id;
  requireSegment(id, "attestationVerdict.binding.parentPrincipal.id");
  return {
    kind: principal.kind,
    id,
  };
}

function scopeTargetKey(scope) {
  return `${scope.port}\u0000${scope.resource}`;
}

function normalizeAudience(value) {
  if (isJsonString(value)) {
    return requireString(value, "audience");
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("audience must be a non-empty string or array");
  }
  return value.map((entry, index) => requireString(entry, `audience[${index}]`));
}

function normalizePrincipal(value, field) {
  if (!isPlainObject(value)) {
    throw new Error(`${field} must be a principal object`);
  }
  requireString(value.kind, `${field}.kind`);
  requireString(value.id, `${field}.id`);
  if (value.delegatedBy !== undefined) {
    normalizePrincipal(value.delegatedBy, `${field}.delegatedBy`);
  }
}

function requireIssuer(issuer) {
  if (
    !issuer ||
    !(issuer.signJwtSvid instanceof Function) ||
    !(issuer.discovery instanceof Function)
  ) {
    throw new Error("createJwtSvidIssuer requires an issuer with signJwtSvid() and discovery()");
  }
  return issuer;
}

function requireSegment(value, field) {
  const segment = requireString(value, field);
  if (!SEGMENT_PATTERN.test(segment)) {
    throw new Error(`${field} contains invalid characters`);
  }
  return segment;
}

function requireString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function defaultIdFactory(prefix) {
  let next = 1;
  return () => `${prefix}-${next++}`;
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
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}
