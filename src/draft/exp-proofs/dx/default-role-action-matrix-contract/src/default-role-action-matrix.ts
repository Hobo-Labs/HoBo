import {
  CONTROL_PLANE_ACTIONS,
  buildControlPlaneActionId,
  expandManage,
} from "../../../../technical-proofs/control-plane-action-taxonomy-contract/src/control-plane-action-taxonomy.js";
import { isJsonString, isJsonObject } from "./json.js";


export const DEFAULT_ROLE_ACTION_MATRIX_SCHEMA = "hobo.default-role-action-matrix/v1";

export const BUILT_IN_ROLES = deepFreeze([
  "Org-Admin",
  "Security/Policy-Admin",
  "Platform-Engineer",
  "Deployer",
  "Operator-Supervisor",
  "Auditor",
]);

const PROVIDER_RESOURCE_GROUP = [
  "provider",
  "resource-definition",
  "resource-pack",
  "driver",
  "integration",
  "dispatcher",
];
const SCOPE_RESOURCE_GROUP = ["yard", "camp", "junction"];
const DELTA_DEPLOYMENT_GROUP = ["delta", "deployment"];

const ROLE_GRANTS = deepFreeze({
  "Org-Admin": grants([
    manage("role"),
    manage("policy-pack"),
    manageGroup(PROVIDER_RESOURCE_GROUP),
    manageGroup(SCOPE_RESOURCE_GROUP),
    manageGroup(DELTA_DEPLOYMENT_GROUP),
    actions("forge", ["execute"]),
    manage("operator"),
    actions("secret-broker", ["configure", "rotate"]),
    actions("audit", ["read", "export"]),
  ]),
  "Security/Policy-Admin": grants([
    actions("role", ["read", "bind"]),
    manage("policy-pack"),
    actionsGroup(PROVIDER_RESOURCE_GROUP, ["read"]),
    actionsGroup(SCOPE_RESOURCE_GROUP, ["read", "configure"]),
    actionsGroup(DELTA_DEPLOYMENT_GROUP, ["read"]),
    actions("forge", ["read"]),
    actions("operator", ["read"]),
    actions("secret-broker", ["configure", "rotate"]),
    actions("audit", ["read", "export"]),
  ]),
  "Platform-Engineer": grants([
    actions("policy-pack", ["read"]),
    manageGroup(PROVIDER_RESOURCE_GROUP),
    actionsGroup(SCOPE_RESOURCE_GROUP, ["configure"]),
    actionsGroup(DELTA_DEPLOYMENT_GROUP, ["create", "update"]),
    actions("forge", ["execute"]),
    actions("operator", ["configure"]),
    actions("secret-broker", ["rotate"]),
    actions("audit", ["read"]),
  ]),
  Deployer: grants([
    actions("policy-pack", ["read"]),
    actionsGroup(PROVIDER_RESOURCE_GROUP, ["read"]),
    actionsGroup(SCOPE_RESOURCE_GROUP, ["read"]),
    actionsGroup(DELTA_DEPLOYMENT_GROUP, ["create", "update", "promote"]),
    actions("audit", ["read"]),
  ]),
  "Operator-Supervisor": grants([
    actions("policy-pack", ["read"]),
    actionsGroup(PROVIDER_RESOURCE_GROUP, ["read"]),
    actionsGroup(SCOPE_RESOURCE_GROUP, ["read"]),
    actionsGroup(DELTA_DEPLOYMENT_GROUP, ["read"]),
    actions("forge", ["execute"]),
    manage("operator"),
    actions("secret-broker", ["rotate"]),
    actions("audit", ["read"]),
  ]),
  Auditor: grants([
    actions("role", ["read", "list"]),
    actions("policy-pack", ["read", "list"]),
    actionsGroup(PROVIDER_RESOURCE_GROUP, ["read", "list"]),
    actionsGroup(SCOPE_RESOURCE_GROUP, ["read", "list"]),
    actionsGroup(DELTA_DEPLOYMENT_GROUP, ["read", "list"]),
    actions("forge", ["read"]),
    actions("operator", ["read"]),
    actions("audit", ["read", "export"]),
  ]),
});

export function buildGrantSet() {
  return {
    schema: DEFAULT_ROLE_ACTION_MATRIX_SCHEMA,
    roles: Object.fromEntries(BUILT_IN_ROLES.map((role) => [role, resolveRoleGrantSet(role)])),
  };
}

export function resolveRoleGrantSet(role) {
  if (!BUILT_IN_ROLES.includes(role)) {
    throw new Error(`unknown built-in role ${role}`);
  }
  return [...ROLE_GRANTS[role]];
}

export function evaluateControlPlaneAuthorization(input) {
  const request = normalizeRequest(input);
  const grantSet = grantSetForRoles(request.subject.roles);
  const decisionBase = {
    schema: DEFAULT_ROLE_ACTION_MATRIX_SCHEMA,
    subject: request.subject,
    actionId: request.actionId,
    resource: request.resource,
    verb: request.verb,
    phase: request.phase,
    grantedBy: rolesGranting(request.subject.roles, request.actionId),
    obligations: [],
    violations: [],
  };

  if (!grantSet.has(request.actionId)) {
    return deny(decisionBase, `no built-in role grants ${request.actionId}`, [
      `${request.subject.roles.join(", ")} cannot ${request.actionId}`,
    ]);
  }

  const sodDecision = enforceSeparationOfDuties(request, decisionBase, grantSet);
  if (sodDecision) {
    return sodDecision;
  }

  return allow(decisionBase, "built-in role grant allows action");
}

function enforceSeparationOfDuties(request, decisionBase, grantSet) {
  const { actionId, context, subject } = request;

  if (actionId === "hobo:policy-pack:approve") {
    if (!isNonEmptyString(context.changeAuthorId)) {
      return deny(decisionBase, "separation-of-duties context missing", [
        "policy-pack approval requires context.changeAuthorId to enforce author-not-approver",
      ]);
    }
    if (context.changeAuthorId === subject.id) {
      const message = context.requiresTwoPersonApproval
        ? "two-person approval blocks self-approval even for Org-Admin"
        : "policy-pack author cannot approve their own change";
      return deny(decisionBase, "separation-of-duties denied policy approval", [message]);
    }
  }

  if (actionId === "hobo:delta:promote") {
    if (!isNonEmptyString(context.targetEnvironment)) {
      return deny(decisionBase, "separation-of-duties context missing", [
        "delta promotion requires context.targetEnvironment before approval obligations can be evaluated",
      ]);
    }
    if (context.targetEnvironment === "prod") {
      if (!isNonEmptyString(context.deltaOpenedBy)) {
        return deny(decisionBase, "separation-of-duties context missing", [
          "prod delta promotion requires context.deltaOpenedBy to enforce opener-not-promoter",
        ]);
      }
      if (context.deltaOpenedBy === subject.id) {
        return deny(decisionBase, "separation-of-duties denied prod promotion", [
          "delta opener cannot promote that Delta to prod",
        ]);
      }
      return requireApproval(decisionBase, "prod delta promotion requires approval", [
        {
          kind: "policy.approval-required",
          actionId,
          reason: "prod delta promotion requires approval",
          approverRole: "Security/Policy-Admin",
        },
      ]);
    }
  }

  if (actionId === "hobo:role:bind") {
    const requested = roleBindingGrantActionIds(context);
    if (requested.length === 0) {
      return deny(decisionBase, "role:bind target grants missing", [
        "role:bind requires targetRole or requestedGrantActionIds to enforce no-self-escalation",
      ]);
    }
    const missing = requested.filter((grant) => !grantSet.has(grant));
    if (missing.length > 0) {
      return deny(decisionBase, "role:bind no-self-escalation denied", [
        `binder cannot bind grants it does not already hold: ${missing.join(", ")}`,
      ]);
    }
  }

  if (
    actionId === "hobo:forge:execute" &&
    decisionBase.grantedBy.length === 1 &&
    decisionBase.grantedBy[0] === "Operator-Supervisor"
  ) {
    if (subject.kind !== "operator") {
      return deny(decisionBase, "Operator-Supervisor forge execution is Crew-only", [
        "Operator-Supervisor forge:execute is reserved for a capped Crew operator principal",
      ]);
    }
    return allow(decisionBase, "Crew operator may execute forge under cap", [
      {
        kind: "crew.operator-cap",
        actionId,
        principalId: subject.id,
      },
    ]);
  }

  return null;
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.length > 0;
}

function normalizeRequest(input) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new TypeError("input must be an object");
  }
  const subject = normalizeSubject(input.subject);
  const resource = requireString(input.resource, "input.resource");
  const verb = requireString(input.verb, "input.verb");
  return {
    subject,
    resource,
    verb,
    phase: requireString(input.phase, "input.phase"),
    actionId: buildControlPlaneActionId(resource, verb),
    context: normalizeContext(input.context),
  };
}

function normalizeSubject(input) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new TypeError("input.subject must be an object");
  }
  const roles = Array.isArray(input.roles) ? input.roles.map((role) => requireString(role, "subject.role")) : [];
  return {
    kind: requireString(input.kind, "input.subject.kind"),
    id: requireString(input.id, "input.subject.id"),
    roles,
  };
}

function normalizeContext(input) {
  if (input === undefined || input === null) {
    return {};
  }
  if (!isJsonObject(input) || Array.isArray(input)) {
    throw new TypeError("input.context must be an object");
  }
  return input;
}

function grantSetForRoles(roles) {
  return new Set(roles.flatMap((role) => (BUILT_IN_ROLES.includes(role) ? ROLE_GRANTS[role] : [])));
}

function rolesGranting(roles, actionId) {
  return roles.filter((role) => BUILT_IN_ROLES.includes(role) && ROLE_GRANTS[role].includes(actionId));
}

function parseRequestedGrantActionIds(input) {
  if (input === undefined || input === null) {
    return [];
  }
  if (!Array.isArray(input)) {
    throw new TypeError("context.requestedGrantActionIds must be an array");
  }
  return input.map((grant) => requireString(grant, "context.requestedGrantActionIds[]"));
}

function roleBindingGrantActionIds(context) {
  const grants = [];
  if (isNonEmptyString(context.targetRole) && ROLE_GRANTS[context.targetRole]) {
    grants.push(...resolveRoleGrantSet(context.targetRole));
  }
  grants.push(...parseRequestedGrantActionIds(context.requestedGrantActionIds));
  return unique(grants);
}

function actionsGroup(resources, verbs) {
  return resources.flatMap((resource) => actions(resource, verbs));
}

function manageGroup(resources) {
  return resources.flatMap((resource) => manage(resource));
}

function manage(resource) {
  return actions(resource, expandManage(resource));
}

function actions(resource, verbs) {
  return verbs
    .filter((verb) => CONTROL_PLANE_ACTIONS.resources?.[resource]?.actions?.includes(verb))
    .map((verb) => buildControlPlaneActionId(resource, verb));
}

function grants(groups) {
  return unique(groups.flat()).sort();
}

function deny(base, reason, violations) {
  return {
    ...base,
    effect: "deny",
    reason,
    violations,
  };
}

function allow(base, reason, obligations = []) {
  return {
    ...base,
    effect: "allow",
    reason,
    obligations,
  };
}

function requireApproval(base, reason, obligations) {
  return {
    ...base,
    effect: "require-approval",
    reason,
    obligations,
  };
}

function requireString(input, fieldName) {
  if (!isJsonString(input) || input.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return input;
}

function unique(values) {
  return [...new Set(values)];
}

function deepFreeze(value) {
  if (value && isJsonObject(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}
