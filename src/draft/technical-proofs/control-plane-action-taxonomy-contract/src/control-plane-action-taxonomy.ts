import { isJsonString, isJsonObject } from "./json.js";
export const ACTION_TAXONOMY_SCHEMA = "hobo.control-plane-action-taxonomy/v1";

export const CONTROL_PLANE_ACTIONS = deepFreeze({
  schema: ACTION_TAXONOMY_SCHEMA,
  resources: {
    provider: resource({
      actions: ["register", "read", "list", "update", "deprecate"],
      phase: ["author", "plan"],
      governs: "CloudProvider and capability-provider registry entries"
    }),
    "resource-definition": resource({
      actions: ["create", "read", "list", "update", "delete"],
      phase: ["author"],
      governs: "Matching resource definitions"
    }),
    "resource-pack": resource({
      actions: ["install", "read", "list", "publish", "yank"],
      phase: ["author"],
      governs: "Resource packs"
    }),
    listing: resource({
      actions: ["publish", "read", "list", "install", "yank", "approve"],
      phase: ["author"],
      governs: "Registry listings and pre-approved catalog curation"
    }),
    driver: resource({
      actions: ["register", "read", "list", "update"],
      phase: ["author"],
      governs: "Driver taxonomy entries"
    }),
    integration: resource({
      actions: ["register", "read", "list", "update", "deprecate"],
      phase: ["author"],
      governs: "Swappable adapters such as auth, artifact repos, runners, issue trackers, and knowledge"
    }),
    dispatcher: resource({
      actions: ["read", "configure"],
      phase: ["author"],
      governs: "Cost-routing objective"
    }),
    "policy-pack": resource({
      actions: ["create", "read", "list", "update", "delete", "approve"],
      phase: ["author", "apply"],
      governs: "Policy and deny-ceiling packs"
    }),
    role: resource({
      actions: ["create", "read", "list", "update", "delete", "bind"],
      phase: ["author"],
      governs: "RBAC roles and bindings"
    }),
    yard: resource({
      actions: ["create", "read", "list", "update", "delete", "configure"],
      phase: ["plan", "apply"],
      governs: "Yard lifecycle and governance config"
    }),
    camp: resource({
      actions: ["create", "read", "list", "update", "delete", "configure"],
      phase: ["plan", "apply"],
      governs: "Camp lifecycle and governance config"
    }),
    junction: resource({
      actions: ["create", "read", "list", "update", "delete", "configure"],
      phase: ["plan", "apply"],
      governs: "Junction lifecycle and governance config"
    }),
    delta: resource({
      actions: ["create", "read", "update", "approve", "promote"],
      phase: ["apply"],
      governs: "Deploy change unit"
    }),
    deployment: resource({
      actions: ["read", "rollback"],
      phase: ["apply", "runtime"],
      governs: "Live deployment"
    }),
    forge: resource({
      actions: ["execute", "read"],
      phase: ["author", "repair"],
      governs: "Generation and repair loop"
    }),
    operator: resource({
      actions: ["read", "configure", "dispatch", "disable"],
      phase: ["runtime", "repair"],
      governs: "Crew operator agents"
    }),
    "secret-broker": resource({
      actions: ["read-metadata", "rotate", "configure"],
      phase: ["runtime"],
      governs: "Brokered credentials; values are never grantable reads"
    }),
    audit: resource({
      actions: ["read", "export"],
      phase: ["observe"],
      governs: "Event log and OCSF export"
    }),
    derivative: resource({
      actions: ["upgrade", "read"],
      phase: ["author", "repair"],
      governs: "Derived HoBo implementations, engine swaps, and persisted patches",
      highPrivilege: ["upgrade"]
    }),
    registry: resource({
      actions: ["import", "read"],
      phase: ["author"],
      governs: "Signed offline bundle import",
      highPrivilege: ["import"]
    }),
    relay: resource({
      actions: ["register", "attach", "read", "revoke"],
      phase: ["apply"],
      governs: "Outbound Relay registration and private-network attachment",
      highPrivilege: ["register", "attach"]
    })
  }
});

export function validateControlPlaneTaxonomy(taxonomy = CONTROL_PLANE_ACTIONS) {
  const errors = [];

  if (!taxonomy || !isJsonObject(taxonomy) || Array.isArray(taxonomy)) {
    return { ok: false, errors: ["taxonomy must be an object"] };
  }
  if (taxonomy.schema !== ACTION_TAXONOMY_SCHEMA) {
    errors.push(`schema must be ${ACTION_TAXONOMY_SCHEMA}`);
  }
  if (!taxonomy.resources || !isJsonObject(taxonomy.resources) || Array.isArray(taxonomy.resources)) {
    errors.push("resources must be an object");
    return { ok: false, errors };
  }

  const actionIds = new Set();
  for (const [resourceName, row] of Object.entries(taxonomy.resources)) {
    validateResourceName(resourceName, errors);
    if (!row || !isJsonObject(row) || Array.isArray(row)) {
      errors.push(`${resourceName} row must be an object`);
      continue;
    }
    if (!Array.isArray(row.actions) || row.actions.length === 0) {
      errors.push(`${resourceName} actions must be a non-empty array`);
      continue;
    }
    if (!Array.isArray(row.phase) || row.phase.length === 0) {
      errors.push(`${resourceName} phase must be a non-empty array`);
    }

    const seenVerbs = new Set();
    for (const verb of row.actions) {
      validateVerb(resourceName, verb, errors);
      if (seenVerbs.has(verb)) {
        errors.push(`${resourceName} declares duplicate verb ${verb}`);
      }
      seenVerbs.add(verb);

      const actionId = `hobo:${resourceName}:${verb}`;
      if (actionIds.has(actionId)) {
        errors.push(`duplicate action id ${actionId}`);
      }
      actionIds.add(actionId);
    }

    for (const verb of row.highPrivilege ?? []) {
      if (!seenVerbs.has(verb)) {
        errors.push(`${resourceName} marks unknown high-privilege verb ${verb}`);
      }
    }
  }

  for (const required of [
    "hobo:derivative:upgrade",
    "hobo:registry:import",
    "hobo:relay:register",
    "hobo:relay:attach"
  ]) {
    if (!actionIds.has(required)) {
      errors.push(`missing high-privilege action ${required}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function buildControlPlaneActionId(resourceName, verb, taxonomy = CONTROL_PLANE_ACTIONS) {
  const id = `hobo:${resourceName}:${verb}`;
  if (!hasAction(taxonomy, resourceName, verb)) {
    throw new Error(`unknown action id ${id}`);
  }
  return id;
}

export function checkControlPlaneCompleteness({ taxonomy = CONTROL_PLANE_ACTIONS, controlPlaneVerbs = [] } = {}) {
  const missingMappings = [];
  const mappedActionIds = [];

  for (const item of controlPlaneVerbs) {
    const actionId = `hobo:${item.resource}:${item.verb}`;
    if (!hasAction(taxonomy, item.resource, item.verb)) {
      missingMappings.push({
        surface: item.surface,
        command: item.command,
        resource: item.resource,
        verb: item.verb,
        reason: `unknown action id ${actionId}`
      });
      continue;
    }
    mappedActionIds.push(actionId);
  }

  return {
    ok: missingMappings.length === 0,
    mappedActionIds,
    missingMappings
  };
}

export function lowerControlPlaneDecisionRequest({
  subject,
  resource: resourceName,
  verb,
  phase,
  context = {}
}, taxonomy = CONTROL_PLANE_ACTIONS) {
  const actionId = buildControlPlaneActionId(resourceName, verb, taxonomy);
  return {
    subject,
    action: verb,
    resource: {
      kind: `hobo:${resourceName}`
    },
    phase,
    context,
    actionId
  };
}

export function expandManage(resourceName, taxonomy = CONTROL_PLANE_ACTIONS) {
  const row = taxonomy.resources?.[resourceName];
  if (!row) {
    throw new Error(`unknown control-plane resource hobo:${resourceName}`);
  }
  return [...row.actions];
}

export function highPrivilegeActionIds(taxonomy = CONTROL_PLANE_ACTIONS) {
  const ids = [];
  for (const [resourceName, row] of Object.entries(taxonomy.resources ?? {})) {
    for (const verb of row.highPrivilege ?? []) {
      ids.push(buildControlPlaneActionId(resourceName, verb, taxonomy));
    }
  }
  return ids.sort();
}

function resource({ actions, phase, governs, highPrivilege = [] }) {
  return { actions, phase, governs, highPrivilege };
}

function hasAction(taxonomy, resourceName, verb) {
  return Boolean(taxonomy.resources?.[resourceName]?.actions?.includes(verb));
}

function validateResourceName(resourceName, errors) {
  if (!/^[a-z][a-z0-9-]*$/.test(resourceName)) {
    errors.push(`invalid resource name ${resourceName}`);
  }
}

function validateVerb(resourceName, verb, errors) {
  if (!isJsonString(verb) || !/^[a-z][a-z0-9-]*$/.test(verb)) {
    errors.push(`${resourceName} has invalid verb ${String(verb)}`);
  }
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
