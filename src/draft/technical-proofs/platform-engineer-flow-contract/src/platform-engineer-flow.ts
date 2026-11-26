import { createHash } from "node:crypto";

import { createResourceCatalog } from "../../resource-definition-driver-contract/src/resource-definition-driver-contract.js";
import {
  decideResourceDefinition,
  matchingDecisionToEvent
} from "../../matching-engine-skeleton-contract/src/matching-engine.js";
import { isJsonString, isJsonObject } from "./json.js";


export const PLATFORM_ENGINEER_FLOW_VERSION = "hobo.platform-engineer-flow/v1";

export function createFixturePlatform({
  providers = [fixtureAzureProvider()],
  camps,
  approvedDefaultProviders = ["azure"],
  overrides = []
} = {}) {
  return {
    apiVersion: PLATFORM_ENGINEER_FLOW_VERSION,
    yard: {
      id: "acme",
      trustDomain: "acme.yard"
    },
    providers: clone(providers),
    approvedDefaultProviders: [...approvedDefaultProviders],
    camps: clone(camps ?? [
      {
        id: "prod",
        provider: "azure",
        iac: "pulumi",
        envType: "production",
        env: "prod",
        tenant: "acme"
      }
    ]),
    overrides: clone(overrides)
  };
}

export function createSnapshopManifest(overrides = {}) {
  return {
    schema: "hobo.manifest/v1",
    app: overrides.app ?? "snapshop",
    tenant: overrides.tenant ?? "acme",
    resources: clone(overrides.resources ?? [
      { id: "catalog", type: "kv", serviceModel: "managed-data" },
      { id: "images", type: "bucket", serviceModel: "managed-data" },
      { id: "main", type: "api", serviceModel: "paas", deps: ["catalog", "images"] }
    ])
  };
}

export function hoboPlanPlatform({ platform, manifest, campId, inferredCamp, objective = "cost" }) {
  const errors = [];
  const resolvedManifest = normalizeManifest(manifest, errors);
  const camp = resolveCamp(platform, campId, inferredCamp, errors);

  if (errors.length > 0) {
    return failedPlan(errors, { campId, manifest: resolvedManifest, objective });
  }

  const catalog = createPlatformCatalog(platform);
  const decisions = [];

  for (const resource of resolvedManifest.resources) {
    const context = resourceContext({ resource, manifest: resolvedManifest, camp });
    const decision = decideResourceDefinition({ catalog, context, objective });
    if (!decision.ok) {
      errors.push(`${resource.id} (${resource.type}): ${decision.reason}`);
      continue;
    }
    decisions.push(decision);
  }

  if (errors.length > 0) {
    return failedPlan(errors, { campId, manifest: resolvedManifest, objective });
  }

  const digest = manifestDigest(resolvedManifest);
  const matchEvents = decisions.map((decision, index) =>
    matchingDecisionToEvent(decision, {
      seq: index + 1,
      causationId: `hobo plan --camp ${camp.id}`
    })
  );
  const deploymentPlan = {
    apiVersion: PLATFORM_ENGINEER_FLOW_VERSION,
    command: `hobo plan --camp ${camp.id}`,
    campId: camp.id,
    yardId: platform.yard.id,
    manifestDigest: digest,
    objective,
    resources: decisions.map((decision, index) => ({
      id: decision.context.resourceId,
      type: decision.context.resourceType,
      providerId: decision.winner.provider,
      definitionId: decision.winner.id,
      driver: decision.winner.driver,
      with: clone(decision.winner.with ?? {}),
      matchEventId: matchEvents[index].id
    })),
    meta: {
      catalogContentHash: decisions[0]?.catalogContentHash ?? `sha256:${"0".repeat(64)}`
    }
  };

  return {
    ok: true,
    errors: [],
    camp,
    manifest: resolvedManifest,
    manifestDigest: digest,
    decisions,
    matchEvents,
    deploymentPlan,
    events: [
      providerRegisteredEvent(camp.provider),
      campMappedEvent(camp),
      ...matchEvents,
      deploymentPlannedEvent(deploymentPlan)
    ]
  };
}

export async function hoboUpPlatform(input) {
  const plan = hoboPlanPlatform(input);
  if (!plan.ok) {
    return {
      status: "blocked",
      ok: false,
      reason: plan.errors.join("; "),
      errors: plan.errors,
      realizedResources: [],
      events: [deploymentRejectedEvent(input.campId, plan.errors.join("; "))]
    };
  }

  const realizedResources = plan.deploymentPlan.resources.map((resource) => ({
    id: resource.id,
    providerId: resource.providerId,
    definitionId: resource.definitionId,
    driver: resource.driver,
    outputs: {
      ref: `${resource.providerId}:${resource.id}`
    }
  }));

  return {
    status: "realized",
    ok: true,
    plan,
    realizedResources,
    events: [
      ...plan.events,
      yardRealizedEvent(plan.deploymentPlan.yardId, plan.camp, realizedResources),
      campRealizedEvent(plan.camp, realizedResources)
    ]
  };
}

export function explainResolution(plan, resourceId) {
  const decision = plan.decisions.find((candidate) => candidate.context.resourceId === resourceId);
  if (!decision) {
    throw new Error(`no resolution for ${resourceId}`);
  }

  return {
    resourceId,
    winner: decision.winner.id,
    providerId: decision.winner.provider,
    ranking: decision.ranking.map((entry) => entry.definitionId),
    rejectedCandidates: decision.rejectedCandidates.map((entry) => entry.definitionId),
    catalogContentHash: decision.catalogContentHash
  };
}

export function manifestDigest(manifest) {
  return `sha256:${stableDigest({
    schema: manifest?.schema,
    app: manifest?.app,
    tenant: manifest?.tenant,
    resources: Array.isArray(manifest?.resources)
      ? manifest.resources.map((resource) => ({
          id: resource.id,
          type: resource.type,
          serviceModel: resource.serviceModel ?? "managed",
          deps: [...(resource.deps ?? [])]
        }))
      : []
  })}`;
}

function fixtureAzureProvider() {
  return {
    id: "azure",
    defaultDefinitions: [
      {
        id: "azure.default.kv",
        type: "kv",
        driver: "terraform",
        match: {},
        with: { service: "azure:tableStorage" }
      },
      {
        id: "azure.default.bucket",
        type: "bucket",
        driver: "terraform",
        match: {},
        with: { service: "azure:blob" }
      },
      {
        id: "azure.default.api",
        type: "api",
        driver: "terraform",
        match: {},
        with: { service: "azure:containerApp" }
      }
    ]
  };
}

function resolveCamp(platform, campId, inferredCamp, errors) {
  const camp = inferredCamp?.id === campId
    ? clone(inferredCamp)
    : clone((platform?.camps ?? []).find((candidate) => candidate.id === campId));
  if (!camp) {
    errors.push(`unknown Camp ${campId}`);
    return null;
  }

  const provider = (platform?.providers ?? []).find((candidate) => candidate.id === camp.provider);
  if (!provider) {
    errors.push(`unknown provider ${camp.provider} for Camp ${camp.id}`);
    return camp;
  }

  if (camp.inferred && !(platform.approvedDefaultProviders ?? []).includes(camp.provider)) {
    errors.push(`provider ${camp.provider} is not approved as a default for inferred Camp ${camp.id}`);
  }

  return {
    env: camp.env ?? camp.id,
    tenant: camp.tenant ?? platform?.yard?.id ?? "tenant",
    envType: camp.envType ?? "development",
    ...camp
  };
}

function normalizeManifest(manifest, errors) {
  if (manifest?.schema !== "hobo.manifest/v1") {
    errors.push("manifest schema must be hobo.manifest/v1");
  }
  if (!Array.isArray(manifest?.resources) || manifest.resources.length === 0) {
    errors.push("manifest resources must be a non-empty array");
    return {
      schema: "hobo.manifest/v1",
      app: manifest?.app ?? "unknown",
      tenant: manifest?.tenant ?? "unknown",
      resources: []
    };
  }

  const seen = new Set();
  const resources = manifest.resources.map((resource, index) => {
    if (!isJsonString(resource?.id) || resource.id.length === 0) {
      errors.push(`resource[${index}].id is required`);
    }
    if (!isJsonString(resource?.type) || resource.type.length === 0) {
      errors.push(`resource[${index}].type is required`);
    }
    if (seen.has(resource.id)) {
      errors.push(`duplicate resource ${resource.id}`);
    }
    seen.add(resource.id);
    return {
      id: resource.id,
      type: resource.type,
      serviceModel: resource.serviceModel ?? "managed",
      deps: [...(resource.deps ?? [])]
    };
  });

  return {
    schema: "hobo.manifest/v1",
    app: manifest.app ?? "app",
    tenant: manifest.tenant ?? "tenant",
    resources
  };
}

function createPlatformCatalog(platform) {
  const catalog = createResourceCatalog({ id: `${platform.yard.id}-platform-catalog` });
  for (const provider of platform.providers ?? []) {
    catalog.register(provider);
  }
  for (const override of platform.overrides ?? []) {
    catalog.register(override);
  }
  return catalog;
}

function resourceContext({ resource, manifest, camp }) {
  return {
    resourceType: resource.type,
    resourceClass: resource.className ?? resource.class ?? "standard",
    resourceId: resource.id,
    app: manifest.app,
    tenant: manifest.tenant,
    env: camp.env,
    envType: camp.envType
  };
}

function failedPlan(errors, { campId, manifest, objective }) {
  return {
    ok: false,
    errors,
    camp: null,
    manifest,
    manifestDigest: manifest?.resources?.length ? manifestDigest(manifest) : null,
    objective,
    campId,
    decisions: [],
    matchEvents: [],
    deploymentPlan: null,
    events: []
  };
}

function providerRegisteredEvent(providerId) {
  return event("provider.Registered", { providerId });
}

function campMappedEvent(camp) {
  return event("camp.Mapped", {
    campId: camp.id,
    providerId: camp.provider,
    iac: camp.iac,
    inferred: Boolean(camp.inferred)
  });
}

function deploymentPlannedEvent(plan) {
  return event("deployment.Planned", {
    campId: plan.campId,
    manifestDigest: plan.manifestDigest,
    resourceIds: plan.resources.map((resource) => resource.id)
  });
}

function deploymentRejectedEvent(campId, reason) {
  return event("deployment.PlanRejected", { campId, reason });
}

function yardRealizedEvent(yardId, camp, resources) {
  return event("yard.Realized", {
    yardId,
    campId: camp.id,
    resourceIds: resources.map((resource) => resource.id)
  });
}

function campRealizedEvent(camp, resources) {
  return event("camp.Realized", {
    campId: camp.id,
    providerId: camp.provider,
    resourceIds: resources.map((resource) => resource.id)
  });
}

function event(type, data) {
  return {
    type,
    data: clone(data)
  };
}

function stableDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => [key, canonicalize(value[key])])
  );
}

function clone(value) {
  return structuredClone(value);
}
