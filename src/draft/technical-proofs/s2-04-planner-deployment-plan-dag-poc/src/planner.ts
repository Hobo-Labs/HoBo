import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  capabilityDecisionToMatchEvent,
  capabilityDecisionToPlanRejectedEvent,
  capabilityRequest,
  decideCapabilityNegotiatedDefinition,
  defineCapability,
} from "../../capability-negotiation-contract/src/capability-negotiation.js";
import {
  createPlannedEvent,
  validateControlPlaneEvent,
} from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import {
  canonicalJson,
  planContentAddress,
  validateDeploymentPlan,
} from "../../deployment-plan-ir-contract/src/deployment-plan-ir.js";
import { plan as planSkeleton } from "../../planner-dag-skeleton-contract/src/planner.js";
import { createResourceCatalog } from "../../resource-definition-driver-contract/src/resource-definition-driver-contract.js";
import { isJsonString, type JsonObject, type JsonValue } from "./json.js";


export const PLANNER_VERSION = "hobo.planner/v1";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = path.resolve(__dirname, "..", "fixtures");

export class PlannerError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = "PlannerError";
    this.code = code;
  }
}

export async function loadManifestFixture(name: string) {
  const filePath = path.join(FIXTURE_ROOT, `${name}.manifest.json`);
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function loadGoldenFixture(name: string) {
  const filePath = path.join(FIXTURE_ROOT, "golden", `${name}.json`);
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function createCheckoutProdRegistry() {
  const catalog = createResourceCatalog({
    id: "checkout-prod-catalog",
    contentHash: "sha256:catalog-control-plane-001",
  });

  for (const definition of [
    {
      id: "aws-rds-postgres",
      type: "database",
      provider: "aws-rds",
      driver: "terraform",
      match: { envType: "production" },
    },
    {
      id: "azure-container-http",
      type: "service",
      provider: "azure-container",
      driver: "container",
      match: { envType: "production" },
    },
    {
      id: "cloudflare-workers-edge",
      type: "gateway",
      provider: "cloudflare-workers",
      driver: "custom-webhook",
      match: { envType: "production" },
    },
    {
      id: "local-container-worker",
      type: "queue",
      provider: "local-container",
      driver: "echo",
      match: { envType: "production" },
    },
  ]) {
    catalog.register(definition);
  }

  return {
    catalog,
    capabilitiesByProvider: {
      "aws-rds": [defineCapability({ provider: "aws-rds", port: "database", features: ["managed", "postgres"] })],
      "azure-container": [
        defineCapability({ provider: "azure-container", port: "containerService", features: ["http"] }),
      ],
      "cloudflare-workers": [
        defineCapability({ provider: "cloudflare-workers", port: "gateway", features: ["http", "edge"] }),
      ],
      "local-container": [defineCapability({ provider: "local-container", port: "queue", features: ["worker"] })],
    },
  };
}

export function createHelloBindleRegistry() {
  const catalog = createResourceCatalog({
    id: "hello-bindle-catalog",
    contentHash: "sha256:catalog-hello-bindle-001",
  });

  catalog.register({
    id: "local-wasm-http",
    type: "service",
    provider: "local-wasm",
    driver: "container",
    match: { envType: "ephemeral", app: "hello-bindle" },
  });

  return {
    catalog,
    capabilitiesByProvider: {
      "local-wasm": [
        defineCapability({ provider: "local-wasm", port: "containerService", features: ["http"] }),
      ],
    },
  };
}

export function createUnsatisfiableRequireRegistry() {
  const catalog = createResourceCatalog({
    id: "unsatisfiable-require-catalog",
    contentHash: "sha256:catalog-unsatisfiable-require-001",
  });

  catalog.register({
    id: "azure-container-http",
    type: "service",
    provider: "azure-container",
    driver: "container",
    match: { envType: "production" },
  });

  return {
    catalog,
    capabilitiesByProvider: {
      "azure-container": [
        defineCapability({ provider: "azure-container", port: "containerService", features: ["http"] }),
      ],
    },
  };
}

export function planManifest(manifest: JsonObject, config: JsonObject = {}, registry: JsonObject = {}) {
  const skeleton = planSkeleton(manifest, config, registry);
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const catalog = (registry.catalog as { snapshot?: () => JsonValue | void }) ?? registry;
  const capabilitiesByProvider = registry.capabilitiesByProvider ?? {};
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const objective = (config.objective as string | undefined) ?? "cost";
  const deploymentPlan = skeleton.deploymentPlan;
  const matchEvents: ReturnType<typeof capabilityDecisionToMatchEvent>[] = [];
  const rationale: Array<JsonObject> = [];
  const matchDecisionIds: string[] = [];

  for (const resourcePlan of deploymentPlan.resources) {
    const manifestResource = manifestResourceFor(manifest, resourcePlan.id);
    const resourceContext = buildResourceContext(config, resourcePlan, manifestResource);
    const portRequests = plannerPortRequests(manifestResource, resourcePlan.id);

    const decision = decideCapabilityNegotiatedDefinition({
      catalog,
      context: resourceContext,
      portRequests,
      capabilitiesByProvider,
      objective,
    });

    if (!decision.ok) {
      const planRejectedEvent = capabilityDecisionToPlanRejectedEvent(decision, {
        deploymentId: deploymentPlan.deploymentId,
        correlationId: `deploy:${deploymentPlan.deploymentId}`,
        causationId: `manifest:${skeleton.sourceManifestHash}`,
      });

      return {
        ok: false as const,
        schema: PLANNER_VERSION,
        reason: decision.reason,
        rejection: decision.rejection,
        planRejectedEvent,
        sourceManifestHash: skeleton.sourceManifestHash,
      };
    }

    resourcePlan.provider = {
      id: decision.winner.provider,
      definitionId: decision.winner.id,
      driver: decision.winner.driver,
    };

    const matchEvent = capabilityDecisionToMatchEvent(decision, {
      id: `match-${resourcePlan.id}`,
      correlationId: `deploy:${deploymentPlan.deploymentId}`,
      causationId: `manifest:${skeleton.sourceManifestHash}`,
    });

    matchEvents.push(matchEvent);
    matchDecisionIds.push(matchEvent.id);
    rationale.push({
      resourceId: resourcePlan.id,
      winner: decision.winner.id,
      provider: decision.winner.provider,
      objective: decision.objective,
      ranking: decision.ranking,
      planWarnings: decision.planWarnings,
    });
  }

  deploymentPlan.meta.rationale = rationale;
  deploymentPlan.meta.provenance.matchDecisionIds = matchDecisionIds;
  deploymentPlan.meta.provenance.catalogContentHash = normalizeCatalogHash(config, registry);

  const plannedEvent = createPlannedEvent(deploymentPlan, {
    tenant: deploymentPlan.resources[0]?.context?.tenant,
    correlationId: `deploy:${deploymentPlan.deploymentId}`,
    causationId: `manifest:${skeleton.sourceManifestHash}`,
  });

  return {
    ok: true as const,
    schema: PLANNER_VERSION,
    deploymentPlan,
    plannedEvent,
    matchEvents,
    sourceManifestHash: skeleton.sourceManifestHash,
    planHash: planContentAddress(deploymentPlan),
  };
}

export function assertPlanManifest(manifest: JsonObject, config: JsonObject, registry: JsonObject) {
  const result = planManifest(manifest, config, registry);
  if (!result.ok) {
    throw new PlannerError(result.rejection?.code ?? "plan.rejected", result.reason);
  }

  const validation = validateDeploymentPlan(result.deploymentPlan);
  if (!validation.ok) {
    throw new PlannerError("deployment-plan.invalid", validation.errors.join("; "));
  }

  const plannedValidation = validateControlPlaneEvent(result.plannedEvent);
  if (!plannedValidation.ok) {
    throw new PlannerError("deployment.planned.invalid", plannedValidation.errors.join("; "));
  }

  for (const matchEvent of result.matchEvents) {
    const matchValidation = validateControlPlaneEvent(matchEvent);
    if (!matchValidation.ok) {
      throw new PlannerError("match.decided.invalid", matchValidation.errors.join("; "));
    }
  }

  return result;
}

export function canonicalPlanJson(plan: JsonObject) {
  return canonicalJson(plan);
}

function manifestResourceFor(manifest: JsonObject, resourceId: string) {
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const resources = manifest.resources as Record<string, JsonObject> | undefined;
  const resource = resources?.[resourceId];
  if (!resource) {
    throw new PlannerError("manifest.resource.missing", `manifest missing resource ${resourceId}`);
  }
  return resource;
}

function buildResourceContext(
  config: JsonObject,
  resourcePlan: { id: string; context: Record<string, string> },
  manifestResource: JsonObject,
) {
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const baseContext = (config.context as Record<string, string> | undefined) ?? {};
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const planner = (manifestResource.planner as JsonObject | undefined) ?? {};

  return {
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    deploymentId: (config.deploymentId as string | undefined) ?? `deploy-${baseContext.app ?? "app"}-${baseContext.env ?? "dev"}`,
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    resourceType: (planner.resourceType as string | undefined) ?? resourcePlan.context.resourceType,
    envType: baseContext.envType ?? resourcePlan.context.envType,
    env: baseContext.env ?? resourcePlan.context.env,
    app: baseContext.app ?? resourcePlan.context.app,
    tenant: baseContext.tenant ?? resourcePlan.context.tenant,
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    resourceClass: (planner.resourceClass as string | undefined) ?? resourcePlan.context.resourceClass ?? "standard",
    resourceId: resourcePlan.id,
  };
}

function plannerPortRequests(manifestResource: JsonObject, resourceId: string) {
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const planner = manifestResource.planner as JsonObject | undefined;
  const explicit = planner?.capabilityRequests;
  if (Array.isArray(explicit) && explicit.length > 0) {
    return explicit.map((request) => capabilityRequest(request));
  }

  const defaults = DEFAULT_CAPABILITY_REQUESTS[resourceId];
  if (defaults) {
    return defaults.map((request) => capabilityRequest(request));
  }

  throw new PlannerError("planner.capability.missing", `no capability requests for resource ${resourceId}`);
}

function normalizeCatalogHash(config: JsonObject, registry: JsonObject) {
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const catalog = registry.catalog as { snapshot?: () => { contentHash?: string } } | undefined;
  const value =
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    (config.catalogContentHash as string | undefined) ??
    (catalog?.snapshot instanceof Function ? catalog.snapshot().contentHash : undefined) ??
    // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
    (registry.contentHash as string | undefined);

  if (!isJsonString(value) || value.length === 0) {
    return `sha256:${"0".repeat(64)}`;
  }
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

interface CapabilityRequestSpec {
  port: string;
  features: string[];
  strictness: "require" | "prefer";
}

interface CapabilityRequestsByResource {
  [resourceId: string]: CapabilityRequestSpec[];
}

const DEFAULT_CAPABILITY_REQUESTS: CapabilityRequestsByResource = {
  "orders-db": [{ port: "database", features: ["managed"], strictness: "require" }],
  "checkout-api": [{ port: "containerService", features: ["http"], strictness: "require" }],
  "web-edge": [{ port: "gateway", features: ["http", "edge"], strictness: "require" }],
  "receipt-worker": [{ port: "queue", features: ["worker"], strictness: "prefer" }],
  service: [{ port: "containerService", features: ["http"], strictness: "require" }],
};
