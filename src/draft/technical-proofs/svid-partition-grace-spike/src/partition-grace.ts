import { isJsonString, isJsonObject } from "./json.js";
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_ROTATION_FRACTION = 2 / 3;
const DEFAULT_MAX_GRACE_MS = 5 * 60 * 1000;

export function createRotationLease(input = {}) {
  const issuedAtMs = requireMs(input.issuedAt ?? "2026-06-26T20:00:00.000Z", "issuedAt");
  const ttlMs = positiveInteger(input.ttlMs ?? DEFAULT_TTL_MS, "ttlMs");
  const rotateAtMs =
    input.rotateAt === undefined
      ? issuedAtMs + Math.floor(ttlMs * DEFAULT_ROTATION_FRACTION)
      : requireMs(input.rotateAt, "rotateAt");
  const notAfterMs = issuedAtMs + ttlMs;
  const requestedGraceMs = positiveInteger(
    input.renewalGraceMs ?? DEFAULT_MAX_GRACE_MS,
    "renewalGraceMs",
  );
  const graceUntilMs = Math.min(rotateAtMs + requestedGraceMs, notAfterMs);

  if (rotateAtMs <= issuedAtMs || rotateAtMs >= notAfterMs) {
    throw new Error("rotateAt must be inside the SVID validity window");
  }
  if (!Array.isArray(input.scope) || input.scope.length === 0) {
    throw new Error("scope must be a non-empty grant array");
  }

  return deepFreeze({
    tenant: requireString(input.tenant ?? "tenant-a", "tenant"),
    runId: requireString(input.runId ?? "run-hobo-266", "runId"),
    agent: requireString(input.agent ?? "release-agent", "agent"),
    epoch: nonNegativeInteger(input.epoch ?? 7, "epoch"),
    issuedAt: iso(issuedAtMs),
    rotateAt: iso(rotateAtMs),
    notAfter: iso(notAfterMs),
    renewalGraceUntil: iso(graceUntilMs),
    graceMs: graceUntilMs - rotateAtMs,
    scope: normalizeScope(input.scope),
    signedBy: requireString(input.signedBy ?? "yard-identity", "signedBy"),
  });
}

export function evaluateTokenRenewal(lease, request = {}) {
  const normalized = normalizeLease(lease);
  const nowMs = requireMs(request.now, "now");
  const requestedScope = normalizeScope(request.scope ?? normalized.scope);
  const requestedGraceUntil = request.requestedGraceUntil;

  if (!isSubsetScope(requestedScope, normalized.scope)) {
    return deny("scope-widening-requires-identity", normalized, nowMs);
  }

  if (requestedGraceUntil !== undefined) {
    const requestedGraceMs = requireMs(requestedGraceUntil, "requestedGraceUntil");
    if (requestedGraceMs > Date.parse(normalized.renewalGraceUntil)) {
      return deny("workload-cannot-extend-renewal-grace", normalized, nowMs);
    }
  }

  if (nowMs < Date.parse(normalized.rotateAt)) {
    return allow("normal", normalized, nowMs, requestedScope);
  }

  if (nowMs <= Date.parse(normalized.renewalGraceUntil)) {
    return allow("partition-grace", normalized, nowMs, requestedScope, [
      "identity.PartitionGraceEntered",
    ]);
  }

  return deny("renewal-grace-expired", normalized, nowMs, [
    "identity.PartitionGraceExpired",
  ]);
}

export function reconcileAfterPartition(lease, input = {}) {
  const normalized = normalizeLease(lease);
  const nowMs = requireMs(input.now, "now");
  const observedEpochs = new Set(input.observedEpochs ?? []);

  if (nowMs > Date.parse(normalized.renewalGraceUntil)) {
    return deepFreeze({
      ok: false,
      action: "fail-closed",
      reason: "partition-outlasted-renewal-grace",
      now: iso(nowMs),
      previousEpoch: normalized.epoch,
      events: ["identity.PartitionGraceExpired"],
    });
  }

  const nextEpoch = normalized.epoch + 1;
  if (observedEpochs.has(nextEpoch)) {
    return deepFreeze({
      ok: true,
      action: "reuse-existing-rotation",
      epoch: nextEpoch,
      previousEpoch: normalized.epoch,
      events: [],
    });
  }

  const rotated = createRotationLease({
    tenant: normalized.tenant,
    runId: normalized.runId,
    agent: normalized.agent,
    epoch: nextEpoch,
    issuedAt: iso(nowMs),
    ttlMs: Date.parse(normalized.notAfter) - Date.parse(normalized.issuedAt),
    scope: normalized.scope,
    signedBy: normalized.signedBy,
  });

  return deepFreeze({
    ok: true,
    action: "rotate-on-heal",
    previousEpoch: normalized.epoch,
    epoch: nextEpoch,
    lease: rotated,
    events: ["identity.Rotated"],
  });
}

export function summarizeRecommendation({ ttlMs = DEFAULT_TTL_MS } = {}) {
  const graceMs = Math.min(DEFAULT_MAX_GRACE_MS, Math.floor(ttlMs / 3));

  return deepFreeze({
    decision: "fail-open-within-signed-grace-then-fail-closed",
    ttlMs,
    rotateAtFraction: DEFAULT_ROTATION_FRACTION,
    maxRenewalGraceMs: graceMs,
    graceCannotExceed: "current-svid-notAfter",
    workloadCanExtendGrace: false,
    staleBeyondSvidExpiry: false,
  });
}

function allow(mode, lease, nowMs, scope, events = []) {
  return deepFreeze({
    ok: true,
    mode,
    now: iso(nowMs),
    leaseEpoch: lease.epoch,
    validUntil: mode === "partition-grace" ? lease.renewalGraceUntil : lease.rotateAt,
    scope,
    events,
  });
}

function deny(reason, lease, nowMs, events = []) {
  return deepFreeze({
    ok: false,
    mode: "fail-closed",
    reason,
    now: iso(nowMs),
    leaseEpoch: lease.epoch,
    events,
  });
}

function normalizeLease(value) {
  if (!isPlainObject(value)) {
    throw new Error("lease must be an object");
  }
  const issuedAt = requireIso(value.issuedAt, "lease.issuedAt");
  const rotateAt = requireIso(value.rotateAt, "lease.rotateAt");
  const notAfter = requireIso(value.notAfter, "lease.notAfter");
  const renewalGraceUntil = requireIso(value.renewalGraceUntil, "lease.renewalGraceUntil");
  if (Date.parse(rotateAt) <= Date.parse(issuedAt) || Date.parse(rotateAt) >= Date.parse(notAfter)) {
    throw new Error("lease.rotateAt must be inside the SVID validity window");
  }
  if (Date.parse(renewalGraceUntil) < Date.parse(rotateAt)) {
    throw new Error("lease.renewalGraceUntil must not precede lease.rotateAt");
  }
  if (Date.parse(renewalGraceUntil) > Date.parse(notAfter)) {
    throw new Error("lease.renewalGraceUntil must not exceed lease.notAfter");
  }
  return deepFreeze({
    tenant: requireString(value.tenant, "lease.tenant"),
    runId: requireString(value.runId, "lease.runId"),
    agent: requireString(value.agent, "lease.agent"),
    epoch: nonNegativeInteger(value.epoch, "lease.epoch"),
    issuedAt,
    rotateAt,
    notAfter,
    renewalGraceUntil,
    graceMs: nonNegativeInteger(value.graceMs, "lease.graceMs"),
    scope: normalizeScope(value.scope),
    signedBy: requireString(value.signedBy, "lease.signedBy"),
  });
}

function normalizeScope(scope) {
  return scope.map((grant, index) => {
    if (!isPlainObject(grant)) {
      throw new Error(`scope[${index}] must be an object`);
    }
    if (!Array.isArray(grant.actions) || grant.actions.length === 0) {
      throw new Error(`scope[${index}].actions must be a non-empty array`);
    }
    return {
      port: requireString(grant.port, `scope[${index}].port`),
      resource: requireString(grant.resource, `scope[${index}].resource`),
      actions: [...new Set(grant.actions.map((action, actionIndex) =>
        requireString(action, `scope[${index}].actions[${actionIndex}]`),
      ))].sort(),
    };
  });
}

function isSubsetScope(requested, allowed) {
  const allowedByTarget = new Map(
    allowed.map((grant) => [`${grant.port}\0${grant.resource}`, new Set(grant.actions)]),
  );

  return requested.every((grant) => {
    const allowedActions = allowedByTarget.get(`${grant.port}\0${grant.resource}`);
    return grant.actions.every((action) => allowedActions?.has(action));
  });
}

function requireIso(value, field) {
  requireMs(value, field);
  return new Date(Date.parse(value)).toISOString();
}

function requireMs(value, field) {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(ms)) {
    throw new Error(`${field} must be an ISO-8601 date`);
  }
  return ms;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function requireString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
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

function isPlainObject(value) {
  return (
    value !== null &&
    isJsonObject(value) &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
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
