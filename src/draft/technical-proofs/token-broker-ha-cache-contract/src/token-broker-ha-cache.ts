import { isJsonString, isJsonObject } from "./json.js";
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const DEFAULT_ROTATE_AT_FRACTION = 2 / 3;
const DEFAULT_MAX_RENEWAL_GRACE_MS = 5 * 60 * 1000;

export function recommendedBrokerCacheBounds(input = {}) {
  const ttlMs = positiveInteger(input.ttlMs ?? DEFAULT_TTL_MS, "ttlMs");
  const maxRenewalGraceMs = Math.min(DEFAULT_MAX_RENEWAL_GRACE_MS, Math.floor(ttlMs / 3));

  return deepFreeze({
    ttlMs,
    rotateAtFraction: DEFAULT_ROTATE_AT_FRACTION,
    maxRenewalGraceMs,
    renewalGraceCannotExceed: "current-svid-notAfter",
  });
}

export function createTokenBrokerCluster(input = {}) {
  const replicas = normalizeReplicaIds(input.replicas ?? ["broker-a", "broker-b"]);
  const issuer = requireString(input.issuer ?? "yard-identity", "issuer");
  const bounds = recommendedBrokerCacheBounds({
    ttlMs: input.ttlMs ?? DEFAULT_TTL_MS,
  });
  const maxRenewalGraceMs = positiveInteger(
    input.maxRenewalGraceMs ?? bounds.maxRenewalGraceMs,
    "maxRenewalGraceMs",
  );

  if (maxRenewalGraceMs > bounds.maxRenewalGraceMs) {
    throw new Error("maxRenewalGraceMs must not exceed recommended broker cache bounds");
  }

  const replicaState = new Map(replicas.map((replicaId) => [replicaId, true]));
  const cache = new Map();
  const revokedTokenIds = new Set();
  let identityAvailable = true;
  let tokenSequence = 0;

  return {
    requestCredential(request) {
      const normalized = normalizeRequest(request);
      const selection = chooseReplica(replicas, replicaState);
      const events = [...selection.events];

      if (!selection.replicaId) {
        return deny({
          reason: "broker-cluster-unavailable",
          replicaId: null,
          events: [...events, "token.Denied"],
        });
      }

      const cacheKey = credentialCacheKey(normalized);
      const cached = cache.get(cacheKey);

      if (normalized.pinnedTokenId !== undefined) {
        if (!cached || normalized.pinnedTokenId !== cached.tokenId || revokedTokenIds.has(cached.tokenId)) {
          if (cached) {
            cache.delete(cacheKey);
          }
          return deny({
            reason: "workload-cannot-pin-stale-credential",
            replicaId: selection.replicaId,
            events: ["identity.CacheEntryInvalidated", "token.Denied"],
          });
        }
      }

      if (cached && revokedTokenIds.has(cached.tokenId)) {
        cache.delete(cacheKey);
        return deny({
          reason: "cached-token-revoked",
          replicaId: selection.replicaId,
          events: ["identity.CacheEntryInvalidated", "token.Revoked", "token.Denied"],
        });
      }

      if (identityAvailable) {
        const lease = createSignedLease({
          ...normalized,
          issuer,
          issuedAtMs: normalized.nowMs,
          ttlMs: bounds.ttlMs,
          maxRenewalGraceMs,
        });
        const tokenId = nextTokenId(normalized, ++tokenSequence);
        const entry = deepFreeze({
          tokenId,
          lease,
          scope: normalized.scope,
        });
        cache.set(cacheKey, entry);

        return deepFreeze({
          ok: true,
          source: "identity",
          mode: cached ? "live-renewal" : "initial-issue",
          replicaId: selection.replicaId,
          tokenId,
          lease,
          scope: normalized.scope,
          dataPlaneOutage: false,
          events: [...events, "token.Granted", "token.Used"],
        });
      }

      if (!cached) {
        return deny({
          reason: "credential-cache-miss",
          replicaId: selection.replicaId,
          events: [...events, "token.Denied"],
        });
      }

      const leaseDecision = evaluateCachedLease(cached.lease, normalized);
      if (!leaseDecision.ok) {
        return deny({
          reason: leaseDecision.reason,
          replicaId: selection.replicaId,
          events: [...events, ...leaseDecision.events, "token.Denied"],
        });
      }

      return deepFreeze({
        ok: true,
        source: "credential-cache",
        mode: leaseDecision.mode,
        replicaId: selection.replicaId,
        tokenId: cached.tokenId,
        lease: cached.lease,
        scope: normalized.scope,
        dataPlaneOutage: false,
        events: [...events, ...leaseDecision.events, "token.Granted", "token.Used"],
      });
    },

    revokeToken(tokenId) {
      revokedTokenIds.add(requireString(tokenId, "tokenId"));
    },

    setIdentityAvailable(nextAvailable) {
      identityAvailable = Boolean(nextAvailable);
    },

    startReplica(replicaId) {
      requireKnownReplica(replicaState, replicaId);
      replicaState.set(replicaId, true);
    },

    stopReplica(replicaId) {
      requireKnownReplica(replicaState, replicaId);
      replicaState.set(replicaId, false);
    },
  };
}

function evaluateCachedLease(lease, request) {
  if (!isSubsetScope(request.scope, lease.scope)) {
    return {
      ok: false,
      reason: "scope-widening-requires-identity",
      events: ["identity.PartitionGraceEntered"],
    };
  }

  if (request.nowMs < Date.parse(lease.rotateAt)) {
    return {
      ok: true,
      mode: "cache-renewal",
      events: [],
    };
  }

  if (request.nowMs <= Date.parse(lease.renewalGraceUntil)) {
    return {
      ok: true,
      mode: "renewal-grace",
      events: ["identity.PartitionGraceEntered"],
    };
  }

  return {
    ok: false,
    reason: "renewal-grace-expired",
    events: ["identity.PartitionGraceExpired"],
  };
}

function chooseReplica(replicas, replicaState) {
  const firstReplica = replicas[0];
  const firstIsAvailable = replicaState.get(firstReplica) === true;
  if (firstIsAvailable) {
    return {
      replicaId: firstReplica,
      events: [],
    };
  }

  const fallback = replicas.find((replicaId) => replicaState.get(replicaId) === true);
  if (!fallback) {
    return {
      replicaId: null,
      events: ["identity.BrokerReplicaUnavailable"],
    };
  }

  return {
    replicaId: fallback,
    events: ["identity.BrokerReplicaUnavailable", "identity.BrokerFailover"],
  };
}

function createSignedLease(input) {
  const notAfterMs = input.issuedAtMs + input.ttlMs;
  const rotateAtMs = input.issuedAtMs + Math.floor(input.ttlMs * DEFAULT_ROTATE_AT_FRACTION);
  const renewalGraceUntilMs = Math.min(rotateAtMs + input.maxRenewalGraceMs, notAfterMs);

  return deepFreeze({
    issuer: input.issuer,
    tenant: input.tenant,
    workloadId: input.workloadId,
    audience: input.audience,
    issuedAt: iso(input.issuedAtMs),
    rotateAt: iso(rotateAtMs),
    notAfter: iso(notAfterMs),
    renewalGraceUntil: iso(renewalGraceUntilMs),
    scope: input.scope,
    signedBy: input.issuer,
  });
}

function normalizeRequest(request) {
  if (!isPlainObject(request)) {
    throw new Error("request must be an object");
  }
  return {
    nowMs: requireMs(request.now, "request.now"),
    workloadId: requireString(request.workloadId, "request.workloadId"),
    tenant: requireString(request.tenant, "request.tenant"),
    audience: requireString(request.audience, "request.audience"),
    scope: normalizeScope(request.scope),
    pinnedTokenId:
      request.pinnedTokenId === undefined
        ? undefined
        : requireString(request.pinnedTokenId, "request.pinnedTokenId"),
  };
}

function normalizeScope(scope) {
  if (!Array.isArray(scope) || scope.length === 0) {
    throw new Error("scope must be a non-empty grant array");
  }

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
      actions: [
        ...new Set(
          grant.actions.map((action, actionIndex) =>
            requireString(action, `scope[${index}].actions[${actionIndex}]`),
          ),
        ),
      ].sort(),
    };
  });
}

function isSubsetScope(requested, allowed) {
  const allowedActionsByTarget = new Map(
    allowed.map((grant) => [`${grant.port}\0${grant.resource}`, new Set(grant.actions)]),
  );

  return requested.every((grant) => {
    const allowedActions = allowedActionsByTarget.get(`${grant.port}\0${grant.resource}`);
    return grant.actions.every((action) => allowedActions?.has(action));
  });
}

function normalizeReplicaIds(replicas) {
  if (!Array.isArray(replicas) || replicas.length < 2) {
    throw new Error("replicas must contain at least two broker replica ids");
  }
  const normalized = replicas.map((replicaId, index) =>
    requireString(replicaId, `replicas[${index}]`),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("replicas must contain distinct broker replica ids");
  }
  return normalized;
}

function credentialCacheKey(request) {
  return `${request.tenant}\0${request.workloadId}\0${request.audience}`;
}

function nextTokenId(request, sequence) {
  return `${request.tenant}:${request.workloadId}:${request.audience}:token-${sequence}`;
}

function deny({ reason, replicaId, events }) {
  return deepFreeze({
    ok: false,
    mode: "fail-closed",
    reason,
    replicaId,
    dataPlaneOutage: true,
    events,
  });
}

function requireKnownReplica(replicaState, replicaId) {
  const normalizedReplicaId = requireString(replicaId, "replicaId");
  if (!replicaState.has(normalizedReplicaId)) {
    throw new Error(`unknown broker replica: ${normalizedReplicaId}`);
  }
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
