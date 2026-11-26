import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const DEPLOYMENT_PLAN_IR_VERSION = "hobo.deployment-plan/v1";

const RESOURCE_PLACEHOLDER_RE =
  /^\$\{resources\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)#([A-Za-z0-9_-]+)\.outputs\.([A-Za-z0-9_-]+)\}$/;
const CONTEXT_PLACEHOLDER_RE = /^\$\{context\.([A-Za-z0-9_.-]+)\}$/;
const CONTEXT_FIELDS = new Set([
  "app",
  "env",
  "envType",
  "tenant",
  "resourceId",
  "resourceClass",
  "resourceType",
  "res.id",
  "class",
  "type"
]);

export function createFixtureDeploymentPlan() {
  const baseContext = {
    envType: "ephemeral",
    app: "gallery",
    env: "preview",
    tenant: "tenant-acme"
  };

  const assetsPlaceholder = outputPlaceholder({
    type: "objectStore",
    className: "standard",
    id: "assets",
    output: "bucketName"
  });

  return {
    apiVersion: DEPLOYMENT_PLAN_IR_VERSION,
    deploymentId: "deploy-gallery-preview",
    resources: [
      {
        id: "assets",
        name: "assets",
        port: {
          interface: "wasi:blobstore/blobstore",
          type: "objectStore",
          className: "standard"
        },
        provider: {
          id: "aws",
          definitionId: "aws-s3-ephemeral",
          driver: "terraform"
        },
        context: matchContext(baseContext, "objectStore", "standard", "assets"),
        options: {
          durability: "regional",
          providerOptions: {
            aws: {
              bucketLifecycleDays: 7
            }
          }
        },
        deps: [],
        strategy: "reconcile",
        replication: "single-region",
        workloadProfile: "managed-resource",
        outputs: ["bucketName", "bucketArn"]
      },
      {
        id: "assets-read-policy",
        name: "assets-read-policy",
        port: {
          interface: "hobo:policy/iam",
          type: "iamPolicy",
          className: "standard"
        },
        provider: {
          id: "aws",
          definitionId: "aws-s3-read-policy",
          driver: "terraform"
        },
        context: matchContext(baseContext, "iamPolicy", "standard", "assets-read-policy"),
        options: {
          action: "objectStore.read"
        },
        deps: ["assets"],
        strategy: "co-provision",
        replication: "follows-parent",
        workloadProfile: "managed-resource",
        coProvisionedFor: "assets",
        outputs: ["policyRef"],
        inputs: {
          resourceArn: outputPlaceholder({
            type: "objectStore",
            className: "standard",
            id: "assets",
            output: "bucketArn"
          })
        }
      },
      {
        id: "api",
        name: "api",
        port: {
          interface: "hobo:runtime/workflow",
          type: "service",
          className: "http"
        },
        provider: {
          id: "aws",
          definitionId: "aws-lambda-wasm",
          driver: "terraform"
        },
        context: matchContext(baseContext, "service", "http", "api"),
        options: {
          workloadProfile: "wasm-component"
        },
        deps: ["assets", "assets-read-policy"],
        strategy: "rolling",
        replication: "stateless",
        workloadProfile: "wasm-component",
        outputs: ["url"],
        inputs: {
          env: {
            ASSETS_BUCKET: assetsPlaceholder,
            DEPLOY_ENV: "${context.env}"
          }
        }
      }
    ],
    edges: [
      { from: "assets", to: "assets-read-policy", reason: "co-provisioned-output" },
      { from: "assets", to: "api", reason: "binding-output" },
      { from: "assets-read-policy", to: "api", reason: "runtime-policy" }
    ],
    meta: {
      objective: "cost",
      provenance: {
        sourceManifestHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        catalogContentHash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
        matchDecisionIds: ["match-assets", "match-assets-read-policy", "match-api"]
      }
    }
  };
}

export function outputPlaceholder({ type, className, id, output }) {
  return `\${resources.${type}.${className}#${id}.outputs.${output}}`;
}

export function parsePlaceholder(value) {
  const resourceMatch = RESOURCE_PLACEHOLDER_RE.exec(value);
  if (resourceMatch) {
    return {
      kind: "resource-output",
      type: resourceMatch[1],
      className: resourceMatch[2],
      id: resourceMatch[3],
      output: resourceMatch[4]
    };
  }

  const contextMatch = CONTEXT_PLACEHOLDER_RE.exec(value);
  if (contextMatch) {
    const field = contextMatch[1];
    if (!CONTEXT_FIELDS.has(field)) {
      throw new Error(`unsupported context field ${field}`);
    }
    return {
      kind: "context",
      field
    };
  }

  throw new Error(`invalid placeholder ${value}`);
}

export function validateDeploymentPlan(plan) {
  const errors = [];
  if (plan?.apiVersion !== DEPLOYMENT_PLAN_IR_VERSION) {
    errors.push(`expected apiVersion ${DEPLOYMENT_PLAN_IR_VERSION}`);
  }
  if (!Array.isArray(plan?.resources) || plan.resources.length === 0) {
    errors.push("DeploymentPlan resources must be a non-empty array");
    return result(errors);
  }

  const resources = new Map();
  for (const resource of plan.resources) {
    if (resources.has(resource.id)) {
      errors.push(`duplicate resource id ${resource.id}`);
    } else {
      resources.set(resource.id, resource);
    }
    validateResource(resource, errors);
  }

  for (const resource of plan.resources) {
    for (const dep of resource.deps ?? []) {
      if (!resources.has(dep)) {
        errors.push(`resource ${resource.id} depends on missing resource ${dep}`);
      }
    }
    if (resource.coProvisionedFor) {
      if (!resources.has(resource.coProvisionedFor)) {
        errors.push(`co-provisioned node ${resource.id} references missing parent ${resource.coProvisionedFor}`);
      }
      if (resource.id === resource.coProvisionedFor) {
        errors.push(`co-provisioned node ${resource.id} collides with parent ${resource.coProvisionedFor}`);
      }
    }

    for (const providerId of Object.keys(resource.options?.providerOptions ?? {})) {
      if (providerId !== resource.provider?.id) {
        errors.push(`resource ${resource.id} carries unresolved provider option block ${providerId}`);
      }
    }
  }

  for (const edge of plan.edges ?? []) {
    if (!resources.has(edge.from)) errors.push(`edge references missing source ${edge.from}`);
    if (!resources.has(edge.to)) errors.push(`edge references missing target ${edge.to}`);
  }

  for (const cycle of findDependencyCycles(plan.resources)) {
    errors.push(`dependency cycle: ${cycle.join(" -> ")}`);
  }

  visit(plan.resources, (value) => {
    if (!isJsonString(value) || !value.startsWith("${")) return;

    let placeholder;
    try {
      placeholder = parsePlaceholder(value);
    } catch (error) {
      errors.push(error.message);
      return;
    }

    if (placeholder.kind !== "resource-output") return;
    const producer = resources.get(placeholder.id);
    if (!producer) {
      errors.push(`placeholder ${value} references missing resource ${placeholder.id}`);
      return;
    }
    if (producer.port?.type !== placeholder.type || producer.port?.className !== placeholder.className) {
      errors.push(`placeholder ${value} does not match producer ${placeholder.id} type/class`);
    }
    if (!producer.outputs?.includes(placeholder.output)) {
      errors.push(`placeholder ${value} references missing output ${placeholder.output}`);
    }
  });

  return result(errors);
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

export function planContentAddress(plan) {
  return `sha256:${createHash("sha256").update(canonicalJson(plan)).digest("hex")}`;
}

function matchContext(base, resourceType, resourceClass, resourceId) {
  return {
    ...base,
    resourceType,
    resourceClass,
    resourceId
  };
}

function validateResource(resource, errors) {
  for (const field of ["id", "name", "strategy", "replication", "workloadProfile"]) {
    if (!isJsonString(resource?.[field]) || resource[field].length === 0) {
      errors.push(`resource ${resource?.id ?? "<unknown>"} ${field} is required`);
    }
  }
  for (const field of ["interface", "type", "className"]) {
    if (!isJsonString(resource?.port?.[field]) || resource.port[field].length === 0) {
      errors.push(`resource ${resource?.id ?? "<unknown>"} port.${field} is required`);
    }
  }
  for (const field of ["id", "definitionId", "driver"]) {
    if (!isJsonString(resource?.provider?.[field]) || resource.provider[field].length === 0) {
      errors.push(`resource ${resource?.id ?? "<unknown>"} provider.${field} is required`);
    }
  }
  for (const field of ["envType", "app", "env", "tenant", "resourceType", "resourceClass", "resourceId"]) {
    if (!isJsonString(resource?.context?.[field]) || resource.context[field].length === 0) {
      errors.push(`resource ${resource?.id ?? "<unknown>"} context.${field} is required`);
    }
  }
  if (!Array.isArray(resource?.deps)) {
    errors.push(`resource ${resource?.id ?? "<unknown>"} deps must be an array`);
  }
  if (!Array.isArray(resource?.outputs)) {
    errors.push(`resource ${resource?.id ?? "<unknown>"} outputs must be an array`);
  }
}

function findDependencyCycles(resources) {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const visiting = new Set();
  const visited = new Set();
  const cycles = [];

  function walk(id, stack) {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start), id]);
      return;
    }
    if (visited.has(id)) return;

    visiting.add(id);
    for (const dep of byId.get(id)?.deps ?? []) {
      if (byId.has(dep)) {
        walk(dep, [...stack, dep]);
      }
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const resource of resources) {
    walk(resource.id, [resource.id]);
  }

  return cycles;
}

function visit(value, callback) {
  callback(value);
  if (Array.isArray(value)) {
    for (const item of value) visit(item, callback);
    return;
  }
  if (!value || !isJsonObject(value)) return;
  for (const child of Object.values(value)) {
    visit(child, callback);
  }
}

function result(errors) {
  return {
    ok: errors.length === 0,
    errors
  };
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
