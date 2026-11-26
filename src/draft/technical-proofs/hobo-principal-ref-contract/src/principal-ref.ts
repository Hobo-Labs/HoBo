const PRINCIPAL_KINDS = new Set(["user", "agent", "service"]);
const tagOf = Object.prototype.toString;

export const BUILT_IN_ROLES = Object.freeze({
  ORG_ADMIN: "org-admin",
  SECURITY_POLICY_ADMIN: "security-policy-admin",
  PLATFORM_ENGINEER: "platform-engineer",
  DEPLOYER: "deployer",
  OPERATOR_SUPERVISOR: "operator-supervisor",
  AUDITOR: "auditor",
});

const ROLE_ORDER = new Map(
  Object.values(BUILT_IN_ROLES)
    .sort()
    .map((role, index) => [role, index]),
);

export function createPrincipalRef(input) {
  assertObject(input, "principal input");
  if (!PRINCIPAL_KINDS.has(input.kind)) {
    throw new Error(`unsupported principal kind: ${input.kind}`);
  }
  if (!input.id || !isString(input.id)) {
    throw new Error("principal id is required");
  }
  if (input.delegatedBy?.kind === "service") {
    throw new Error("delegatedBy cannot reference a service principal");
  }

  const grantedRoles = normalizeRoles(input.roleBindings?.[input.id] ?? []);
  const principal = {
    kind: input.kind,
    id: input.id,
    roles: grantedRoles,
    scopes: normalizeStrings(input.scopes ?? []),
    tenant: normalizeTenant(input.tenant),
    ctxTenants: normalizeCtxTenants(input.ctxTenants),
  };

  if (input.delegatedBy) {
    principal.delegatedBy = stripNestedDelegation(input.delegatedBy);
  }

  return deepFreeze(principal);
}

export function serializeAsPolicySubject(principal) {
  return serializePrincipal(principal);
}

export function serializeAsEventActor(principal) {
  return serializePrincipal(principal);
}

function serializePrincipal(principal) {
  assertObject(principal, "principal");
  return deepFreeze({
    kind: principal.kind,
    id: principal.id,
    roles: [...(principal.roles ?? [])],
    scopes: [...(principal.scopes ?? [])],
    platformTenant: principal.tenant.platform,
    ctxTenant: principal.tenant.app
      ? { kind: "resolved", value: principal.tenant.app }
      : { kind: "unresolved", failClosed: true },
    ctxTenants: principal.ctxTenants.length
      ? { kind: "explicit-set", values: [...principal.ctxTenants] }
      : { kind: "none" },
    delegatedBy: principal.delegatedBy ? serializeDelegatedBy(principal.delegatedBy) : undefined,
  });
}

function stripNestedDelegation(principal) {
  return deepFreeze({
    kind: principal.kind,
    id: principal.id,
    roles: [...(principal.roles ?? [])],
    scopes: [...(principal.scopes ?? [])],
    tenant: normalizeTenant(principal.tenant),
    ctxTenants: normalizeCtxTenants(principal.ctxTenants),
  });
}

function serializeDelegatedBy(principal) {
  return deepFreeze({
    kind: principal.kind,
    id: principal.id,
    roles: [...(principal.roles ?? [])],
    scopes: [...(principal.scopes ?? [])],
    platformTenant: principal.tenant.platform,
    ctxTenant: principal.tenant.app
      ? { kind: "resolved", value: principal.tenant.app }
      : { kind: "unresolved", failClosed: true },
    ctxTenants: principal.ctxTenants.length
      ? { kind: "explicit-set", values: [...principal.ctxTenants] }
      : { kind: "none" },
  });
}

function normalizeTenant(tenant) {
  assertObject(tenant, "tenant");
  if (!tenant.platform || !isString(tenant.platform)) {
    throw new Error("platform tenant is required");
  }
  return {
    platform: tenant.platform,
    app: tenant.app && isString(tenant.app) ? tenant.app : undefined,
  };
}

function normalizeCtxTenants(ctxTenants = []) {
  return normalizeStrings(ctxTenants);
}

function normalizeRoles(roles) {
  const knownRoles = new Set(Object.values(BUILT_IN_ROLES));
  return normalizeStrings(roles)
    .filter((role) => knownRoles.has(role))
    .sort((left, right) => ROLE_ORDER.get(left) - ROLE_ORDER.get(right));
}

function normalizeStrings(values) {
  if (!Array.isArray(values)) {
    throw new Error("expected an array");
  }
  return [...new Set(values)].filter((value) => isString(value) && value.length > 0).sort();
}

function assertObject(value, name) {
  if (!value || !isObjectTag(value) || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function deepFreeze(value) {
  if (!value || (!isObjectTag(value) && !Array.isArray(value)) || Object.isFrozen(value)) {
    return value;
  }
  for (const nested of Object.values(value)) {
    deepFreeze(nested);
  }
  return Object.freeze(value);
}

function isString(value) {
  return tagOf.call(value) === "[object String]";
}

function isObjectTag(value) {
  return tagOf.call(value) === "[object Object]";
}
