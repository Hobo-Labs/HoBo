import {
  authorizeControlPlaneAction,
  bindPrincipalToRole,
  bindScimGroupToRole,
  canBindRole,
  defineCustomRole,
  grantAction,
  resolveRbacSubject,
} from "../../rbac-role-binding-contract/src/rbac-role-binding.js";
import { BUILT_IN_ROLES } from "../../hobo-principal-ref-contract/src/principal-ref.js";
import {
  CONTROL_PLANE_AUTHZ_NFR,
  createManualClock,
} from "../../control-plane-authz-cache-contract/src/control-plane-authz-cache.js";
import { isJsonString, isJsonObject } from "./json.js";


export {
  BUILT_IN_ROLES,
  bindPrincipalToRole,
  bindScimGroupToRole,
  defineCustomRole,
  grantAction,
};

export const AUTH_PORT_RBAC_CONTRACT_VERSION = "hobo.auth-port-rbac-resolution/v1";

export const AUTH_PORT_RBAC_NFR = Object.freeze({
  subjectCacheTtlMs: CONTROL_PLANE_AUTHZ_NFR.decisionCacheTtlMs,
  revocationPropagationBoundMs: CONTROL_PLANE_AUTHZ_NFR.revocationPropagationBoundMs,
});

export function createAuthPortSnapshot(input) {
  assertObject(input, "auth port snapshot input");
  assertObject(input.principal, "principal");
  const auth = input.auth ?? {};

  return deepFreeze({
    principal: {
      kind: requireString(input.principal.kind, "principal kind"),
      id: requireString(input.principal.id, "principal id"),
    },
    auth: {
      port: auth.port ?? "hobo:auth",
      adapter: auth.adapter && isJsonString(auth.adapter) ? auth.adapter : undefined,
      scimGroups: normalizeStrings(auth.scimGroups ?? []),
      assertedRoles: normalizeStrings(auth.assertedRoles ?? []),
      snapshotSeq: auth.snapshotSeq ?? "auth-snapshot:0",
    },
  });
}

export function createAuthPortRbacResolver({
  clock = createManualClock(),
  bindings = [],
  roles = [],
  nfr = AUTH_PORT_RBAC_NFR,
} = {}) {
  if (!clock || !(clock.nowMs instanceof Function)) {
    throw new TypeError("clock must expose nowMs()");
  }
  const bounds = normalizeNfr(nfr);
  const roleBindings = normalizeBindings(bindings);
  const customRoles = [...roles];
  const cache = new Map();
  const groupRevocations = new Map();

  function resolveSubject(snapshotInput) {
    const snapshot = createAuthPortSnapshot(snapshotInput);
    const nowMs = clock.nowMs();
    const key = subjectCacheKey(snapshot);
    const cached = cache.get(key);
    if (cached && cached.expiresAtMs > nowMs && !hasActiveRevocation(cached.subject, nowMs)) {
      return deepFreeze({
        subject: structuredClone(cached.subject),
        cacheHit: true,
        cacheExpiresAtMs: cached.expiresAtMs,
        roleRevocations: [],
      });
    }

    const activeRevocations = activeRevocationsForSnapshot(snapshot, nowMs);
    const filteredSnapshot = removeRevokedGroups(snapshot, activeRevocations);
    const rbacAuth = authForRbac(filteredSnapshot);
    const subject = resolveRbacSubject({
      principal: filteredSnapshot.principal,
      auth: rbacAuth,
      bindings: roleBindings,
    });
    const expiresAtMs = nowMs + bounds.subjectCacheTtlMs;
    cache.set(key, {
      subject,
      expiresAtMs,
    });

    return deepFreeze({
      subject,
      cacheHit: false,
      cacheExpiresAtMs: expiresAtMs,
      roleRevocations: activeRevocations,
    });
  }

  function authorize(snapshotInput, actionId) {
    const resolved = resolveSubject(snapshotInput);
    return deepFreeze({
      ...resolved,
      decision: authorizeControlPlaneAction({
        subject: resolved.subject,
        actionId,
        roles: customRoles,
      }),
    });
  }

  function canBind(snapshotInput, { targetPrincipalId, roleId } = {}) {
    const resolved = resolveSubject(snapshotInput);
    return deepFreeze({
      ...resolved,
      decision: canBindRole({
        binder: resolved.subject,
        targetPrincipalId,
        roleId,
        roles: customRoles,
      }),
    });
  }

  function observeScimGroupRevocation(input) {
    assertObject(input, "SCIM revocation");
    const groupId = requireString(input.groupId, "groupId");
    const roleId = requireString(input.roleId, "roleId");
    const principalId = requireString(input.principalId, "principalId");
    const revokedAtMs = normalizeMs(input.revokedAtMs, "revokedAtMs");
    const observedAtMs = normalizeMs(input.observedAtMs ?? clock.nowMs(), "observedAtMs");
    const propagationMs = observedAtMs - revokedAtMs;
    if (propagationMs > bounds.revocationPropagationBoundMs) {
      throw new Error(
        `SCIM revocation propagation exceeded bound: ${propagationMs}ms > ${bounds.revocationPropagationBoundMs}ms`,
      );
    }

    const revocation = deepFreeze({
      principalId,
      groupId,
      roleId,
      revokedAtMs,
      observedAtMs,
      effectiveAtMs: observedAtMs,
      sequence: input.sequence ?? `${principalId}:${groupId}:${roleId}:${observedAtMs}`,
      propagationBoundMs: bounds.revocationPropagationBoundMs,
    });
    groupRevocations.set(scimRevocationKey(principalId, groupId, roleId), revocation);
    invalidatePrincipalCache(cache, principalId);
    return revocation;
  }

  return {
    contractVersion: AUTH_PORT_RBAC_CONTRACT_VERSION,
    nfr: bounds,
    clock,
    resolveSubject,
    authorize,
    canBind,
    observeScimGroupRevocation,
    cacheSize() {
      return cache.size;
    },
  };

  function activeRevocationsForSnapshot(snapshot, nowMs) {
    const revocations = [];
    const emitted = new Set();
    for (const groupId of snapshot.auth.scimGroups) {
      for (const binding of roleBindings) {
        if (binding.kind !== "scim-group" || binding.groupId !== groupId) {
          continue;
        }
        const revocationKey = scimRevocationKey(snapshot.principal.id, groupId, binding.roleId);
        const revocation = groupRevocations.get(revocationKey);
        if (revocation && nowMs >= revocation.effectiveAtMs && !emitted.has(revocationKey)) {
          emitted.add(revocationKey);
          revocations.push(revocation);
        }
      }
    }
    return revocations;
  }

  function hasActiveRevocation(subject, nowMs) {
    for (const source of subject.roleSources ?? []) {
      if (source.source !== "hobo:auth/scim") {
        continue;
      }
      const revocation = groupRevocations.get(scimRevocationKey(subject.id, source.groupId, source.roleId));
      if (revocation && nowMs >= revocation.effectiveAtMs) {
        return true;
      }
    }
    return false;
  }
}

function removeRevokedGroups(snapshot, revocations) {
  const revokedGroupIds = new Set(revocations.map((revocation) => revocation.groupId));
  return {
    ...snapshot,
    auth: {
      ...snapshot.auth,
      scimGroups: snapshot.auth.scimGroups.filter((groupId) => !revokedGroupIds.has(groupId)),
    },
  };
}

function authForRbac(snapshot) {
  return {
    port: snapshot.auth.port,
    adapter: snapshot.auth.adapter,
    scimGroups: snapshot.principal.kind === "user" ? snapshot.auth.scimGroups : [],
  };
}

function subjectCacheKey(snapshot) {
  return JSON.stringify({
    principal: snapshot.principal,
    port: snapshot.auth.port,
    adapter: snapshot.auth.adapter,
    scimGroups: snapshot.auth.scimGroups,
    snapshotSeq: snapshot.auth.snapshotSeq,
  });
}

function scimRevocationKey(principalId, groupId, roleId) {
  return `${principalId}\u0000${groupId}\u0000${roleId}`;
}

function invalidatePrincipalCache(cache, principalId) {
  for (const [key, entry] of cache.entries()) {
    if (entry.subject.id === principalId) {
      cache.delete(key);
    }
  }
}

function normalizeBindings(bindings) {
  if (!Array.isArray(bindings)) {
    throw new TypeError("bindings must be an array");
  }
  return bindings.map((binding) => {
    assertObject(binding, "role binding");
    if (binding.kind === "principal") {
      return bindPrincipalToRole(binding);
    }
    if (binding.kind === "scim-group") {
      return bindScimGroupToRole(binding);
    }
    throw new Error(`unsupported role binding kind: ${binding.kind}`);
  });
}

function normalizeNfr(nfr) {
  return {
    ...AUTH_PORT_RBAC_NFR,
    ...nfr,
  };
}

function normalizeMs(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function normalizeStrings(values) {
  if (!Array.isArray(values)) {
    throw new Error("expected an array");
  }
  return [...new Set(values)].filter((value) => isJsonString(value) && value.length > 0).sort();
}

function requireString(value, name) {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function assertObject(value, name) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}
