import {
  createIdentityEvent,
  validateIdentityEvent,
} from "../../identity-event-contract/src/identity-event-contract.js";

const DEFAULT_TTL_SECONDS = 5 * 60;
const DEFAULT_ROTATE_BEFORE_SECONDS = 2 * 60;
const DEFAULT_OVERLAP_SECONDS = 30;
const DEFAULT_SKEW_TOLERANCE_SECONDS = 5;
const SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

export function createSvidRotationService(options = {}) {
  const issuer = requireIssuer(options.issuer);
  const now = options.now ?? (() => new Date());
  const ttlSeconds = positiveInteger(
    options.ttlSeconds ?? DEFAULT_TTL_SECONDS,
    "ttlSeconds",
  );
  const rotateBeforeSeconds = positiveInteger(
    options.rotateBeforeSeconds ?? DEFAULT_ROTATE_BEFORE_SECONDS,
    "rotateBeforeSeconds",
  );
  const overlapSeconds = positiveInteger(
    options.overlapSeconds ?? DEFAULT_OVERLAP_SECONDS,
    "overlapSeconds",
  );
  const skewToleranceSeconds = nonNegativeInteger(
    options.skewToleranceSeconds ?? DEFAULT_SKEW_TOLERANCE_SECONDS,
    "skewToleranceSeconds",
  );
  const idFactory = options.idFactory ?? defaultIdFactory("svid");
  const eventSink = options.eventSink ?? (() => {});

  return Object.freeze({
    async rotateIfDue(input) {
      const request = normalizeRotationRequest(input);
      const current = request.currentSvid;
      const currentExpiresAtMs = requireDateMs(current.expiresAt, "currentSvid.expiresAt");
      const currentValidFromMs = current.claims.nbf * 1000;
      const nowDate = now();
      const nowMs = nowDate.getTime();
      const secondsUntilExpiry = Math.floor((currentExpiresAtMs - nowMs) / 1000);

      if (secondsUntilExpiry <= 0) {
        return failure(request, "current-svid-expired");
      }

      if (secondsUntilExpiry > rotateBeforeSeconds) {
        return {
          ok: true,
          rotated: false,
          requestId: request.requestId,
          reason: "rotation-not-due",
          secondsUntilExpiry,
          nextRotationAt: new Date(
            currentExpiresAtMs - rotateBeforeSeconds * 1000,
          ).toISOString(),
          events: [],
        };
      }

      const verdict = request.attestationVerdict;
      if (verdict.state !== "attested") {
        return failure(request, "workload-not-attested");
      }

      if (!sameJson(current.claims.codeVersion, verdict.binding.codeVersion)) {
        return {
          ...failure(request, "attestation-code-version-changed"),
          requiresReevaluation: true,
        };
      }

      const newValidFromMs = nowMs - skewToleranceSeconds * 1000;
      const previousValidUntilMs = newValidFromMs + overlapSeconds * 1000;
      if (previousValidUntilMs > currentExpiresAtMs) {
        return failure(request, "rotation-overlap-window-missed");
      }

      const scope = intersectScopeSets(
        current.scope,
        request.requestedScope ?? current.scope,
        request.inferredGrant,
      );
      if (scope.length === 0) {
        return failure(request, "rotated-scope-empty");
      }

      const iat = Math.floor(newValidFromMs / 1000);
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
      const event = buildIdentityRotatedEvent({
        identityId,
        previousIdentityId: current.identityId,
        requestId: request.requestId,
        agentName: request.agentName,
        parentPrincipal: verdict.binding.parentPrincipal,
        svidRef,
        previousSvidRef: current.svidRef,
        scope,
        expiresAt: new Date(exp * 1000).toISOString(),
        previousValidUntil: new Date(previousValidUntilMs).toISOString(),
        time: nowDate.toISOString(),
        causationId: verdict.binding.runId,
      });

      eventSink(event);

      const validity = deepFreeze({
        previousValidFrom: new Date(currentValidFromMs).toISOString(),
        previousJwtExpiresAt: new Date(currentExpiresAtMs).toISOString(),
        previousValidUntil: new Date(previousValidUntilMs).toISOString(),
        newValidFrom: new Date(iat * 1000).toISOString(),
        newExpiresAt: new Date(exp * 1000).toISOString(),
        overlapSeconds,
        gapFree: iat * 1000 <= previousValidUntilMs,
      });

      return deepFreeze({
        ok: true,
        rotated: true,
        requestId: request.requestId,
        previousIdentityId: current.identityId,
        previousSvidRef: current.svidRef,
        identityId,
        svidRef,
        token,
        claims,
        scope,
        validity,
        events: [event],
      });
    },
  });
}

export function isSvidAcceptedDuringRotation(rotation, svidRef, at) {
  if (!rotation?.ok || rotation.rotated !== true) {
    return false;
  }
  const atMs = requireDateMs(at, "at");

  if (svidRef === rotation.previousSvidRef) {
    return (
      atMs >= requireDateMs(rotation.validity.previousValidFrom, "previousValidFrom") &&
      atMs <= requireDateMs(rotation.validity.previousValidUntil, "previousValidUntil")
    );
  }

  if (svidRef === rotation.svidRef) {
    return (
      atMs >= requireDateMs(rotation.validity.newValidFrom, "newValidFrom") &&
      atMs <= requireDateMs(rotation.validity.newExpiresAt, "newExpiresAt")
    );
  }

  return false;
}

function normalizeRotationRequest(input) {
  if (!isPlainObject(input)) {
    throw new Error("SVID rotation request must be an object");
  }
  const currentSvid = normalizeCurrentSvid(input.currentSvid);
  const inferredGrant = normalizeScopeSet(input.inferredGrant, "inferredGrant");
  const requestedScope = input.requestedScope === undefined
    ? undefined
    : normalizeScopeSet(input.requestedScope, "requestedScope");

  return deepFreeze({
    requestId: requireString(input.requestId, "requestId"),
    agentName: requireSegment(input.agentName, "agentName"),
    audience: normalizeAudience(input.audience),
    currentSvid,
    attestationVerdict: normalizeAttestationVerdict(input.attestationVerdict),
    requestedScope,
    inferredGrant,
  });
}

function normalizeCurrentSvid(current) {
  if (!isPlainObject(current)) {
    throw new Error("currentSvid must be an object");
  }
  const claims = normalizeCurrentClaims(current.claims);
  const scope = current.scope === undefined
    ? normalizeJwtScopeSet(claims.scope, "currentSvid.claims.scope")
    : normalizeScopeSet(current.scope, "currentSvid.scope");

  return deepFreeze({
    identityId: requireString(current.identityId, "currentSvid.identityId"),
    svidRef: requireString(current.svidRef, "currentSvid.svidRef"),
    claims,
    scope,
    expiresAt: current.expiresAt ?? new Date(claims.exp * 1000).toISOString(),
  });
}

function normalizeCurrentClaims(claims) {
  if (!isPlainObject(claims)) {
    throw new Error("currentSvid.claims must be an object");
  }
  requireString(claims.sub, "currentSvid.claims.sub");
  requireString(claims.tenant, "currentSvid.claims.tenant");
  if (!Number.isSafeInteger(claims.nbf) || claims.nbf < 0) {
    throw new Error("currentSvid.claims.nbf must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(claims.exp) || claims.exp <= claims.nbf) {
    throw new Error("currentSvid.claims.exp must be after nbf");
  }
  if (!isPlainObject(claims.codeVersion)) {
    throw new Error("currentSvid.claims.codeVersion must be an object");
  }
  return clone(claims);
}

function normalizeAttestationVerdict(verdict) {
  if (!isPlainObject(verdict)) {
    throw new Error("attestationVerdict must be an object");
  }
  if (verdict.state !== "attested") {
    return deepFreeze({
      state: verdict.state,
      reason: verdict.reason,
      policy: clone(verdict.policy),
    });
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
  return deepFreeze(clone(verdict));
}

function normalizeScopeSet(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty scope array`);
  }
  return value.map((entry, index) => normalizeScopeEntry(entry, `${field}[${index}]`));
}

function normalizeJwtScopeSet(value, field) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty scope array`);
  }
  return value.map((entry, index) => {
    if (!isPlainObject(entry)) {
      throw new Error(`${field}[${index}] must be an object`);
    }
    return normalizeScopeEntry(
      {
        port: entry.port,
        resource: entry.resource,
        actions: entry.actions ?? entry.verbs,
      },
      `${field}[${index}]`,
    );
  });
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

function intersectScopeSets(primary, ...bounds) {
  const boundMaps = bounds.map((bound) => new Map(
    bound.map((grant) => [scopeTargetKey(grant), new Set(grant.actions)]),
  ));
  const scoped = [];

  for (const grant of primary) {
    const target = scopeTargetKey(grant);
    const actions = grant.actions.filter((action) =>
      boundMaps.every((map) => map.get(target)?.has(action)),
    );
    if (actions.length > 0) {
      scoped.push({ port: grant.port, resource: grant.resource, actions });
    }
  }

  return scoped;
}

function buildIdentityRotatedEvent({
  identityId,
  previousIdentityId,
  requestId,
  agentName,
  parentPrincipal,
  svidRef,
  previousSvidRef,
  scope,
  expiresAt,
  previousValidUntil,
  time,
  causationId,
}) {
  const event = createIdentityEvent(
    "identity.Rotated",
    {
      identityId,
      previousIdentityId,
      subject: eventSubject(agentName, parentPrincipal),
      svidRef,
      previousSvidRef,
      scope: clone(scope),
      expiresAt,
      previousValidUntil,
    },
    {
      id: `evt-${identityId}-rotated`,
      actor: { kind: "service", id: "yard/identity" },
      time,
      seq: 1,
      correlationId: requestId,
      causationId: causationId ?? requestId,
    },
  );
  const validation = validateIdentityEvent(event);
  if (!validation.ok) {
    throw new Error(`invalid identity.Rotated event: ${validation.errors.join("; ")}`);
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

function failure(request, reason) {
  return {
    ok: false,
    rotated: false,
    requestId: request.requestId,
    reason,
    events: [],
  };
}

function normalizeAudience(value) {
  if (isString(value)) {
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
    !isCallable(issuer.signJwtSvid) ||
    !isCallable(issuer.discovery)
  ) {
    throw new Error("createSvidRotationService requires issuer.signJwtSvid() and discovery()");
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
  if (!isString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function requireDateMs(value, field) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`${field} must be an ISO-8601 date`);
  }
  return ms;
}

function scopeTargetKey(scope) {
  return `${scope.port}\u0000${scope.resource}`;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function defaultIdFactory(prefix) {
  let next = 1;
  return () => `${prefix}-${next++}`;
}

function isPlainObject(value) {
  return (
    value !== null &&
    isObjectRecord(value) &&
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

function deepFreeze(value) {
  if (!isObjectRecord(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
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
