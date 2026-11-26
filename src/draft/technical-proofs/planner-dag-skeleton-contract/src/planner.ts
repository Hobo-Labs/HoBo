import { canonicalManifestHash } from "../../hobo-manifest-contract/src/manifest.js";
import { createPlannedEvent } from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import {
  DEPLOYMENT_PLAN_IR_VERSION,
  outputPlaceholder
} from "../../deployment-plan-ir-contract/src/deployment-plan-ir.js";
import { isJsonString, isJsonObject } from "./json.js";


export const PLANNER_DAG_SKELETON_VERSION = "hobo.planner-dag-skeleton/v1";

const RESOURCE_ID = /^[A-Za-z][A-Za-z0-9_-]*$/;
const EMPTY_CATALOG_HASH = `sha256:${"0".repeat(64)}`;

export class PlannerValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PlannerValidationError";
  }
}

export function createFixtureManifestIr() {
  return {
    schema: "hobo.manifest/v1",
    componentHost: {
      kind: "wasmtime",
      version: "1.0.0"
    },
    resources: {
      assets: {
        type: "data.v1",
        port: "hobo:data",
        paradigm: "postgres",
        outputs: ["connectionString"],
        allow: ["query"]
      },
      api: {
        type: "component.v1",
        image: "oci://registry.example.com/gallery-api@sha256:abc123",
        runtime: "wasm",
        exports: ["wasi:http/incoming-handler"],
        links: [{ import: "hobo:data", to: "assets" }],
        env: {
          DATABASE_URL: outputPlaceholder({
            type: "data",
            className: "postgres",
            id: "assets",
            output: "connectionString"
          })
        }
      },
      site: {
        type: "website.v1",
        bind: ["api"]
      }
    }
  };
}

export function plan(manifest, config = {}, registry = {}) {
  const resources = normalizeResources(manifest);
  const context = normalizeContext(config.context);
  const sourceManifestHash = canonicalManifestHash(manifest);
  const catalogContentHash = normalizeCatalogHash(config, registry);

  const deploymentPlan = {
    apiVersion: DEPLOYMENT_PLAN_IR_VERSION,
    deploymentId: config.deploymentId ?? `deploy-${context.app}-${context.env}`,
    resources: [],
    edges: [],
    meta: {
      objective: config.objective ?? "cost",
      provenance: {
        sourceManifestHash,
        catalogContentHash,
        matchDecisionIds: []
      }
    }
  };

  const resourcePlans = new Map();
  for (const [id, resource] of resources) {
    const dependencies = collectDependencies(id, resource, resources);
    const resourcePlan = manifestResourceToPlan(id, resource, dependencies.ids, context);
    deploymentPlan.resources.push(resourcePlan);
    resourcePlans.set(id, resourcePlan);
    deploymentPlan.edges.push(...dependencies.edges);
  }

  expandCoProvisionedResources({
    coProvisioning: config.coProvisioning ?? {},
    deploymentPlan,
    resourcePlans,
    context
  });

  const cycle = findDependencyCycle(deploymentPlan.resources);
  if (cycle) {
    throw new PlannerValidationError(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  return {
    schema: PLANNER_DAG_SKELETON_VERSION,
    deploymentPlan,
    plannedEvent: createPlannedEvent(deploymentPlan, {
      tenant: context.tenant,
      correlationId: `deploy:${deploymentPlan.deploymentId}`,
      causationId: `manifest:${sourceManifestHash}`
    }),
    sourceManifestHash
  };
}

function normalizeResources(manifest) {
  if (!manifest || !isJsonObject(manifest) || Array.isArray(manifest)) {
    throw new PlannerValidationError("manifest must be an object");
  }
  if (manifest.schema !== "hobo.manifest/v1") {
    throw new PlannerValidationError("manifest.schema must be hobo.manifest/v1");
  }

  const rawResources = manifest.resources;
  const entries = Array.isArray(rawResources)
    ? rawResources.map(normalizeTupleEntry)
    : Object.entries(rawResources ?? {});

  if (entries.length === 0) {
    throw new PlannerValidationError("manifest.resources must declare at least one resource");
  }

  const resources = new Map();
  for (const [id, resource] of entries) {
    assertResourceId(id);
    if (resources.has(id)) {
      throw new PlannerValidationError(`duplicate resource id ${id}`);
    }
    if (!resource || !isJsonObject(resource) || Array.isArray(resource)) {
      throw new PlannerValidationError(`resource ${id} must be an object`);
    }
    if (!isJsonString(resource.type) || resource.type.length === 0) {
      throw new PlannerValidationError(`resource ${id} type is required`);
    }
    resources.set(id, resource);
  }

  return resources;
}

function normalizeTupleEntry(entry) {
  if (Array.isArray(entry) && entry.length === 2) {
    return [entry[0], entry[1]];
  }
  if (entry && isJsonObject(entry) && isJsonString(entry.id)) {
    const { id, ...resource } = entry;
    return [id, resource];
  }
  throw new PlannerValidationError("manifest.resources array entries must be [id, resource]");
}

function normalizeContext(context = {}) {
  const normalized = {
    envType: context.envType ?? "ephemeral",
    app: context.app ?? "app",
    env: context.env ?? "dev",
    tenant: context.tenant ?? "tenant-hobo"
  };
  for (const [field, value] of Object.entries(normalized)) {
    if (!isJsonString(value) || value.length === 0) {
      throw new PlannerValidationError(`context.${field} must be a non-empty string`);
    }
  }
  return normalized;
}

function normalizeCatalogHash(config, registry) {
  const value = config.catalogContentHash ??
    (registry.contentHash instanceof Function ? registry.contentHash() : registry.contentHash) ??
    EMPTY_CATALOG_HASH;
  if (!isJsonString(value) || value.length === 0) {
    throw new PlannerValidationError("catalogContentHash must be a non-empty string");
  }
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

function collectDependencies(id, resource, resources) {
  const ids = [];
  const edges = [];

  for (const targetId of resource.bind ?? []) {
    assertDependency(id, targetId, resources, "binds");
    addUnique(ids, targetId);
    edges.push({ from: targetId, to: id, reason: "bind" });
  }

  for (const [index, link] of (resource.links ?? []).entries()) {
    if (!link || !isJsonObject(link) || Array.isArray(link)) {
      throw new PlannerValidationError(`resource ${id} links[${index}] must be an object`);
    }
    if (!isJsonString(link.import) || link.import.length === 0) {
      throw new PlannerValidationError(`resource ${id} links[${index}].import is required`);
    }
    assertDependency(id, link.to, resources, "links");
    addUnique(ids, link.to);
    edges.push({ from: link.to, to: id, reason: `link:${link.import}` });
  }

  return { ids, edges };
}

function assertDependency(id, targetId, resources, verb) {
  if (!isJsonString(targetId) || targetId.length === 0) {
    throw new PlannerValidationError(`resource ${id} ${verb} must reference a resource id`);
  }
  if (targetId === id) {
    throw new PlannerValidationError(`resource ${id} cannot bind to itself`);
  }
  if (!resources.has(targetId)) {
    throw new PlannerValidationError(`resource ${id} ${verb} missing resource ${targetId}`);
  }
}

function manifestResourceToPlan(id, resource, deps, baseContext) {
  const port = portForResource(id, resource);
  return {
    id,
    name: resource.name ?? id,
    port,
    provider: providerStubFor(id, port),
    context: matchContext(baseContext, port.type, port.className, id),
    options: {},
    deps,
    strategy: resource.strategy ?? "reconcile",
    replication: resource.replication ?? "single-region",
    workloadProfile: workloadProfileFor(resource),
    outputs: outputListFor(resource),
    inputs: resource.env ? clone(resource.env) : undefined
  };
}

function expandCoProvisionedResources({ coProvisioning, deploymentPlan, resourcePlans, context }) {
  for (const [parentId, specs] of Object.entries(coProvisioning)) {
    if (!resourcePlans.has(parentId)) {
      throw new PlannerValidationError(`co-provisioning references missing parent ${parentId}`);
    }
    if (!Array.isArray(specs)) {
      throw new PlannerValidationError(`co-provisioning for ${parentId} must be an array`);
    }

    for (const spec of specs) {
      const id = spec?.id;
      assertResourceId(id);
      if (resourcePlans.has(id)) {
        throw new PlannerValidationError(`duplicate resource id ${id}`);
      }
      const port = normalizePort(id, spec.port);
      const deps = [parentId];
      for (const dep of spec.deps ?? []) {
        if (!resourcePlans.has(dep)) {
          throw new PlannerValidationError(`co-provisioned resource ${id} depends on missing resource ${dep}`);
        }
        addUnique(deps, dep);
      }

      const child = {
        id,
        name: spec.name ?? id,
        port,
        provider: providerStubFor(id, port),
        context: matchContext(context, port.type, port.className, id),
        options: {},
        deps,
        strategy: "co-provision",
        replication: "follows-parent",
        workloadProfile: "managed-resource",
        coProvisionedFor: parentId,
        outputs: Array.isArray(spec.outputs) ? [...spec.outputs] : [],
        inputs: spec.inputs ? clone(spec.inputs) : undefined
      };
      deploymentPlan.resources.push(child);
      resourcePlans.set(id, child);
      deploymentPlan.edges.push({ from: parentId, to: id, reason: "co-provisioned-output" });
    }
  }
}

function portForResource(id, resource) {
  if (resource.type === "data.v1") {
    if (!isJsonString(resource.port) || resource.port.length === 0) {
      throw new PlannerValidationError(`resource ${id} port is required`);
    }
    return {
      interface: resource.port,
      type: "data",
      className: resource.paradigm ?? "standard"
    };
  }

  if (resource.type === "component.v1") {
    return {
      interface: resource.exports?.[0] ?? "hobo:runtime/component",
      type: "service",
      className: resource.runtime ?? "component"
    };
  }

  if (resource.type === "website.v1") {
    return {
      interface: "hobo:web/website",
      type: "website",
      className: "static"
    };
  }

  throw new PlannerValidationError(`resource ${id} type ${resource.type} is not supported by the skeleton planner`);
}

function normalizePort(id, port) {
  if (!port || !isJsonObject(port) || Array.isArray(port)) {
    throw new PlannerValidationError(`co-provisioned resource ${id} port is required`);
  }
  for (const field of ["interface", "type", "className"]) {
    if (!isJsonString(port[field]) || port[field].length === 0) {
      throw new PlannerValidationError(`co-provisioned resource ${id} port.${field} is required`);
    }
  }
  return {
    interface: port.interface,
    type: port.type,
    className: port.className
  };
}

function providerStubFor(id, port) {
  return {
    id: "stub-provider",
    definitionId: `stub.${port.type}.${port.className}.${id}`,
    driver: "planner-stub"
  };
}

function workloadProfileFor(resource) {
  if (resource.type === "component.v1") return "wasm-component";
  return "managed-resource";
}

function outputListFor(resource) {
  if (Array.isArray(resource.outputs)) return [...resource.outputs];
  if (resource.type === "data.v1") return ["connectionString"];
  if (resource.type === "component.v1") return ["url"];
  if (resource.type === "website.v1") return ["url"];
  return [];
}

function matchContext(base, resourceType, resourceClass, resourceId) {
  return {
    ...base,
    resourceType,
    resourceClass,
    resourceId
  };
}

function findDependencyCycle(resources) {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const visiting = new Set();
  const visited = new Set();

  function walk(id, stack) {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return stack.slice(start);
    }
    if (visited.has(id)) return null;

    visiting.add(id);
    for (const dep of byId.get(id)?.deps ?? []) {
      const cycle = walk(dep, [...stack, dep]);
      if (cycle) return cycle;
    }
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const resource of resources) {
    const cycle = walk(resource.id, [resource.id]);
    if (cycle) return cycle;
  }

  return null;
}

function assertResourceId(id) {
  if (!isJsonString(id) || !RESOURCE_ID.test(id)) {
    throw new PlannerValidationError(`invalid resource id ${String(id)}`);
  }
}

function addUnique(items, value) {
  if (!items.includes(value)) items.push(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
