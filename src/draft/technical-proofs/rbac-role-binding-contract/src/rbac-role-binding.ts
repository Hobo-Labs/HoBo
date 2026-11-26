import {
  CONTROL_PLANE_ACTIONS,
  buildControlPlaneActionId,
  expandManage,
} from "../../control-plane-action-taxonomy-contract/src/control-plane-action-taxonomy.js";
import { BUILT_IN_ROLES } from "../../hobo-principal-ref-contract/src/principal-ref.js";
import { isJsonString, isJsonObject } from "./json.js";


const PRINCIPAL_KINDS = new Set(["user", "agent", "service"]);
const BUILT_IN_ROLE_IDS = new Set(Object.values(BUILT_IN_ROLES));
const ACTION_IDS = Object.entries(CONTROL_PLANE_ACTIONS.resources).flatMap(([resource, definition]) =>
  definition.actions.map((verb) => buildControlPlaneActionId(resource, verb)),
);
const ACTION_ID_SET = new Set(ACTION_IDS);
const ACTION_ORDER = new Map(ACTION_IDS.map((actionId, index) => [actionId, index]));
const ROLE_BIND_ACTION_ID = grantAction("role", "bind");

const CONTROL_PLANE_SETUP_RESOURCES = [
  "provider",
  "resource-definition",
  "resource-pack",
  "driver",
  "integration",
  "dispatcher",
];
const SCOPE_RESOURCES = ["yard", "camp", "junction"];

export const BUILT_IN_ROLE_DEFINITIONS = deepFreeze(
  Object.fromEntries(
    [
      builtInRole(BUILT_IN_ROLES.ORG_ADMIN, "Org-Admin", allControlPlaneGrantIds()),
      builtInRole(BUILT_IN_ROLES.SECURITY_POLICY_ADMIN, "Security/Policy-Admin", [
        ...existingGrants(["role"], ["read", "bind"]),
        ...manage("policy-pack"),
        ...existingGrants(CONTROL_PLANE_SETUP_RESOURCES, ["read"]),
        ...existingGrants(SCOPE_RESOURCES, ["read", "configure"]),
        ...existingGrants(["delta", "deployment"], ["read"]),
        ...existingGrants(["forge", "operator"], ["read"]),
        ...existingGrants(["secret-broker"], ["configure", "rotate"]),
        ...existingGrants(["audit"], ["read", "export"]),
      ]),
      builtInRole(BUILT_IN_ROLES.PLATFORM_ENGINEER, "Platform-Engineer", [
        ...existingGrants(["policy-pack"], ["read"]),
        ...CONTROL_PLANE_SETUP_RESOURCES.flatMap((resource) => manage(resource)),
        ...existingGrants(SCOPE_RESOURCES, ["configure"]),
        ...existingGrants(["delta"], ["create", "update"]),
        ...existingGrants(["forge"], ["execute"]),
        ...existingGrants(["operator"], ["configure"]),
        ...existingGrants(["secret-broker"], ["rotate"]),
        ...existingGrants(["audit"], ["read"]),
      ]),
      builtInRole(BUILT_IN_ROLES.DEPLOYER, "Deployer", [
        ...existingGrants(["policy-pack"], ["read"]),
        ...existingGrants(CONTROL_PLANE_SETUP_RESOURCES, ["read"]),
        ...existingGrants(SCOPE_RESOURCES, ["read"]),
        ...existingGrants(["delta"], ["create", "update", "promote"]),
        ...existingGrants(["audit"], ["read"]),
      ]),
      builtInRole(BUILT_IN_ROLES.OPERATOR_SUPERVISOR, "Operator-Supervisor", [
        ...existingGrants(["policy-pack"], ["read"]),
        ...existingGrants(CONTROL_PLANE_SETUP_RESOURCES, ["read"]),
        ...existingGrants(SCOPE_RESOURCES, ["read"]),
        ...existingGrants(["forge"], ["execute"]),
        ...manage("operator"),
        ...existingGrants(["secret-broker"], ["rotate"]),
        ...existingGrants(["audit"], ["read"]),
      ]),
      builtInRole(BUILT_IN_ROLES.AUDITOR, "Auditor", [
        ...existingGrants(["role"], ["read", "list"]),
        ...existingGrants(["policy-pack"], ["read", "list"]),
        ...existingGrants(CONTROL_PLANE_SETUP_RESOURCES, ["read", "list"]),
        ...existingGrants(SCOPE_RESOURCES, ["read", "list"]),
        ...existingGrants(["delta", "deployment"], ["read", "list"]),
        ...existingGrants(["forge", "operator"], ["read"]),
        ...existingGrants(["audit"], ["read", "export"]),
      ]),
    ].map((role) => [role.id, role]),
  ),
);

export function grantAction(resource, verb) {
  const definition = CONTROL_PLANE_ACTIONS.resources[resource];
  if (!definition || !definition.actions.includes(verb)) {
    throw new Error(`unknown RBAC grant hobo:${resource}:${verb}`);
  }
  return buildControlPlaneActionId(resource, verb);
}

export function defineCustomRole(input) {
  assertObject(input, "custom role");
  const id = requireString(input.id, "custom role id");
  if (BUILT_IN_ROLE_IDS.has(id)) {
    throw new Error(`cannot shadow built-in role: ${id}`);
  }

  return deepFreeze({
    id,
    name: input.name && isJsonString(input.name) ? input.name : id,
    kind: "custom",
    grants: normalizeGrantIds(input.grants ?? []),
  });
}

export function bindPrincipalToRole(input) {
  assertObject(input, "principal role binding");
  return deepFreeze({
    kind: "principal",
    principalId: requireString(input.principalId, "principal id"),
    roleId: requireString(input.roleId, "role id"),
  });
}

export function bindScimGroupToRole(input) {
  assertObject(input, "SCIM group role binding");
  return deepFreeze({
    kind: "scim-group",
    groupId: requireString(input.groupId, "SCIM group id"),
    roleId: requireString(input.roleId, "role id"),
  });
}

export function resolveRbacSubject(input) {
  assertObject(input, "RBAC subject input");
  assertObject(input.principal, "principal");
  const principal = input.principal;
  const kind = requireString(principal.kind, "principal kind");
  const id = requireString(principal.id, "principal id");
  if (!PRINCIPAL_KINDS.has(kind)) {
    throw new Error(`unsupported principal kind: ${kind}`);
  }

  const auth = input.auth ?? {};
  const scimGroups = new Set(normalizeStrings(auth.scimGroups ?? []));
  const adapter = auth.adapter && isJsonString(auth.adapter) ? auth.adapter : undefined;
  const roleMap = new Map();
  for (const binding of input.bindings ?? []) {
    assertObject(binding, "role binding");
    if (binding.kind === "principal" && binding.principalId === id) {
      rememberRole(roleMap, binding.roleId, {
        roleId: binding.roleId,
        source: "direct-binding",
        principalId: id,
      });
      continue;
    }
    if (binding.kind === "scim-group" && auth.port === "hobo:auth" && scimGroups.has(binding.groupId)) {
      rememberRole(roleMap, binding.roleId, {
        roleId: binding.roleId,
        source: "hobo:auth/scim",
        groupId: binding.groupId,
        adapter,
      });
    }
  }

  const roles = sortRoleIds([...roleMap.keys()]);
  return deepFreeze({
    kind,
    id,
    roles,
    roleSources: roles.flatMap((roleId) => roleMap.get(roleId)),
  });
}

export function authorizeControlPlaneAction(input) {
  assertObject(input, "authorization input");
  assertObject(input.subject, "subject");
  const actionId = requireKnownGrant(input.actionId);
  const roleIds = normalizeStrings(input.subject.roles ?? []);
  if (roleIds.length === 0) {
    return deepFreeze({ effect: "deny", reason: "unbound-principal", matchedRoles: [] });
  }

  const catalog = createRoleCatalog(input.roles ?? []);
  const matchedRoles = roleIds.filter((roleId) => catalog.get(roleId)?.grants.includes(actionId));
  if (matchedRoles.length === 0) {
    return deepFreeze({ effect: "deny", reason: "no-bound-role-grants-action", matchedRoles: [] });
  }

  return deepFreeze({ effect: "allow", matchedRoles: sortRoleIds(matchedRoles) });
}

export function canBindRole(input) {
  assertObject(input, "role bind check");
  assertObject(input.binder, "binder subject");
  const targetPrincipalId = requireString(input.targetPrincipalId, "target principal id");
  const roleId = requireString(input.roleId, "role id");
  const catalog = createRoleCatalog(input.roles ?? []);
  const targetRole = catalog.get(roleId);
  if (!targetRole) {
    return deepFreeze({ effect: "deny", reason: "unknown-role" });
  }

  const binderGrantSet = grantSetForSubject(input.binder, catalog);
  const missingGrantIds = targetRole.grants.filter((grantId) => !binderGrantSet.has(grantId));
  if (input.binder.id === targetPrincipalId && missingGrantIds.length > 0) {
    return deepFreeze({ effect: "deny", reason: "self-escalation", missingGrantIds });
  }
  if (missingGrantIds.length > 0) {
    return deepFreeze({ effect: "deny", reason: "role-grants-exceed-binder", missingGrantIds });
  }
  if (!binderGrantSet.has(ROLE_BIND_ACTION_ID)) {
    return deepFreeze({
      effect: "deny",
      reason: "missing-role-bind",
      missingGrantIds: [ROLE_BIND_ACTION_ID],
    });
  }

  return deepFreeze({ effect: "allow", reason: "binder-has-role-bind-and-target-grants" });
}

function builtInRole(id, name, grants) {
  return deepFreeze({
    id,
    name,
    kind: "built-in",
    grants: normalizeGrantIds(grants),
  });
}

function allControlPlaneGrantIds() {
  return normalizeGrantIds(ACTION_IDS);
}

function manage(resource) {
  return expandManage(resource).map((verb) => grantAction(resource, verb));
}

function existingGrants(resources, verbs) {
  return resources.flatMap((resource) => {
    const actions = CONTROL_PLANE_ACTIONS.resources[resource]?.actions ?? [];
    return verbs.filter((verb) => actions.includes(verb)).map((verb) => grantAction(resource, verb));
  });
}

function createRoleCatalog(customRoles) {
  const catalog = new Map(Object.values(BUILT_IN_ROLE_DEFINITIONS).map((role) => [role.id, role]));
  for (const role of customRoles) {
    assertObject(role, "role definition");
    if (role.kind && role.kind !== "custom") {
      throw new Error(`custom role catalog cannot override ${role.kind} role: ${role.id}`);
    }
    if (catalog.has(role.id)) {
      throw new Error(`duplicate role definition: ${role.id}`);
    }
    catalog.set(
      role.id,
      deepFreeze({
        id: requireString(role.id, "role id"),
        name: role.name && isJsonString(role.name) ? role.name : role.id,
        kind: "custom",
        grants: normalizeGrantIds(role.grants ?? []),
      }),
    );
  }
  return catalog;
}

function grantSetForSubject(subject, catalog) {
  const grantIds = normalizeStrings(subject.roles ?? []).flatMap((roleId) => catalog.get(roleId)?.grants ?? []);
  return new Set(normalizeGrantIds(grantIds));
}

function rememberRole(roleMap, roleId, source) {
  const normalizedRoleId = requireString(roleId, "role id");
  const sources = roleMap.get(normalizedRoleId) ?? [];
  sources.push(source);
  roleMap.set(normalizedRoleId, sources);
}

function normalizeGrantIds(grants) {
  if (!Array.isArray(grants)) {
    throw new Error("role grants must be an array");
  }
  const normalized = [...new Set(grants.map((grant) => requireKnownGrant(grant)))];
  return normalized.sort((left, right) => ACTION_ORDER.get(left) - ACTION_ORDER.get(right));
}

function requireKnownGrant(grant) {
  const value = requireString(grant, "grant id");
  if (!ACTION_ID_SET.has(value)) {
    throw new Error(`unknown RBAC grant: ${value}`);
  }
  return value;
}

function sortRoleIds(roleIds) {
  return normalizeStrings(roleIds).sort((left, right) => roleSortKey(left).localeCompare(roleSortKey(right)));
}

function roleSortKey(roleId) {
  const builtInOrder = Object.values(BUILT_IN_ROLES).indexOf(roleId);
  return builtInOrder === -1 ? `1:${roleId}` : `0:${String(builtInOrder).padStart(2, "0")}`;
}

function normalizeStrings(values) {
  if (!Array.isArray(values)) {
    throw new Error("expected an array");
  }
  return [...new Set(values)].filter((value) => isJsonString(value) && value.length > 0).sort();
}

function requireString(value, name) {
  if (!value || !isJsonString(value)) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function assertObject(value, name) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
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
