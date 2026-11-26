export const MAPPING_STYLES_PLANNER_VERSION = "hobo.mapping-styles-planner-resolution/v1";

export const PLAN_REJECTED_FIXTURE_REASON =
  "capability.require.unsatisfied resourceType=database missing=database.ha";

import { compileCampMapping, registerCompiledDefinitions } from "../../../technical-proofs/camp-mapping-sugar-compiler/src/camp-mapping-sugar-compiler.js";
import {
  capabilityDecisionToMatchEvent,
  capabilityDecisionToPlanRejectedEvent,
  capabilityRequest,
  decideCapabilityNegotiatedDefinition,
  defineCapability
} from "../../../technical-proofs/capability-negotiation-contract/src/capability-negotiation.js";
import { createPlannedEvent, validateControlPlaneEvent } from "../../../technical-proofs/control-plane-event-schema-contract/src/control-plane-events.js";
import { createResourceCatalog } from "../../../technical-proofs/resource-definition-driver-contract/src/resource-definition-driver-contract.js";
import {
  bindle,
  camp,
  providerSelection,
  yard
} from "../../../technical-proofs/topology-objects-contract/src/topology-objects.js";
import {
  aws,
  azure,
  createManifest,
  database,
  resolvedProviderOptions,
  service
} from "../../../technical-proofs/provider-options-pattern-contract/src/provider-options-contract.js";

const RUNTIME = Object.freeze({ kind: "runtime", id: "runtime-postgres-fixture" });

const REFERENCE_RESOURCES = Object.freeze([
  { id: "shop.db", type: "database", engine: "postgres", serviceModel: "saas", port: "database" },
  { id: "shop.api", type: "compute", serviceModel: "paas", port: "service" },
  { id: "shop.web", type: "web", engine: "static", serviceModel: "edge", port: "web" }
]);

const CAPABILITY_MANIFESTS = Object.freeze({
  aws: {
    database: ["managed", "ha", "postgres"],
    service: ["containerService", "http2"],
    web: ["cdn"]
  },
  azure: {
    database: ["managed", "postgres"],
    service: ["containerService"],
    web: ["cdn"]
  }
});

export function createReferenceShopBindle() {
  return bindle("shop", (collector) => {
    const db = collector.use(resourceDescriptor("data", "db", "shop.db", ["hobo:sql"], "saas"));
    const api = collector.use(resourceDescriptor("service", "api", "shop.api", ["wasi:http"], "paas"));
    const web = collector.use(resourceDescriptor("web", "site", "shop.web", ["hobo:static"], "edge"));
    return { db, api, web };
  });
}

export function wholeAppCamp(bindleObject, providerId, region = "us-east-1") {
  return camp("prod", {
    bindle: bindleObject,
    envType: "production",
    runtime: RUNTIME,
    defaultProvider: providerSelection(providerId, "default", { region })
  });
}

export function perTierCamp(bindleObject, providerId) {
  return camp("prod", {
    bindle: bindleObject,
    envType: "production",
    runtime: RUNTIME,
    defaultProvider: providerSelection(providerId, "default"),
    tiers: {
      data: providerSelection(providerId, "managed-data"),
      service: providerSelection(providerId, "container-service"),
      web: providerSelection(providerId, "cdn-edge")
    }
  });
}

export function perBindingCamp(bindleObject, providerId) {
  return camp("prod", {
    bindle: bindleObject,
    envType: "production",
    runtime: RUNTIME,
    defaultProvider: providerSelection(providerId, "default"),
    bindings: {
      "shop.db": providerSelection(providerId, "rds", { engine: "postgres" }),
      "shop.api": providerSelection(providerId, "fargate"),
      "shop.web": providerSelection(providerId, "cloudfront")
    }
  });
}

export function composeYard(campObject) {
  return yard(campObject.providerId, { camps: [campObject] });
}

export function detectMappingStyle(campObject) {
  const hasBindings = Object.keys(campObject.mappings.bindings ?? {}).length > 0;
  const hasTiers = Object.keys(campObject.mappings.tiers ?? {}).length > 0;
  if (hasBindings) return "per-binding";
  if (hasTiers) return "per-tier";
  return "whole-app";
}

export function capabilitiesByProvider(providerIds = ["aws", "azure"]) {
  return Object.fromEntries(
    providerIds.map((providerId) => [
      providerId,
      Object.entries(CAPABILITY_MANIFESTS[providerId] ?? {}).flatMap(([port, features]) => [
        defineCapability({ provider: providerId, port, features })
      ])
    ])
  );
}

export function planCampDeployment({
  campObject,
  objective = "single-provider",
  deploymentId = "dep-shop-prod",
  portRequestsByResource = defaultPortRequests(),
  capabilities = capabilitiesByProvider()
}) {
  if (campObject?.kind !== "camp") {
    throw new TypeError("planCampDeployment expects a Camp object");
  }

  const mappingStyle = detectMappingStyle(campObject);
  const compiled = compileCampMapping({
    campId: campObject.env,
    resources: bindleResourcesForCompiler(campObject.bindle),
    mapping: campMappingsForCompiler(campObject)
  });
  const catalog = createResourceCatalog({ id: `camp-${campObject.id}` });
  registerCompiledDefinitions(catalog, compiled);

  const matchEvents = [];
  const planResources = [];
  const rationale = [
    `mapping-style:${mappingStyle}`,
    `objective:${objective}`,
    `provider:${campObject.providerId}`
  ];
  const planWarnings = [];

  for (const resource of REFERENCE_RESOURCES) {
    const context = {
      deploymentId,
      resourceType: resource.type,
      resourceId: resource.id,
      resourceClass: resource.serviceModel,
      envType: campObject.envType,
      env: campObject.env,
      app: campObject.bindle.name,
      tenant: "tenant-acme"
    };

    const decision = decideCapabilityNegotiatedDefinition({
      catalog,
      context,
      capabilitiesByProvider: capabilities,
      portRequests: portRequestsByResource[resource.id] ?? defaultRequestsForResource(resource),
      objective
    });

    if (!decision.ok) {
      const rejected = capabilityDecisionToPlanRejectedEvent(decision, {
        deploymentId,
        correlationId: `corr-${deploymentId}`,
        causationId: `cmd-plan:${campObject.id}`
      });
      validateControlPlaneEvent(rejected);
      return {
        ok: false,
        mappingStyle,
        providerId: campObject.providerId,
        event: rejected,
        reason: rejected.data.reason
      };
    }

    const matchEvent = capabilityDecisionToMatchEvent(decision, {
      correlationId: `corr-${deploymentId}`,
      causationId: `cmd-plan:${campObject.id}`
    });
    validateControlPlaneEvent(matchEvent);
    matchEvents.push(matchEvent);
    planWarnings.push(...decision.planWarnings);
    planResources.push({
      name: resource.id,
      port: resource.port,
      provider: decision.winner.provider,
      definitionId: decision.winner.id,
      driver: decision.winner.driver ?? "terraform"
    });
    rationale.push(`match:${resource.id}→${decision.winner.provider}.${decision.winner.id}`);
  }

  const plan = {
    schema: "hobo.deployment-plan/v1",
    contract: MAPPING_STYLES_PLANNER_VERSION,
    deploymentId,
    campId: campObject.id,
    yardProvider: campObject.providerId,
    mappingStyle,
    objective,
    rationale: [...new Set(rationale)],
    planWarnings,
    resources: planResources,
    dependencyOrder: ["shop.db", "shop.api", "shop.web"],
    matchEvents: matchEvents.map((event) => event.type)
  };

  const planned = createPlannedEvent(plan, {
    correlationId: `corr-${deploymentId}`,
    causationId: `cmd-plan:${campObject.id}`
  });
  validateControlPlaneEvent(planned);

  return {
    ok: true,
    mappingStyle,
    providerId: campObject.providerId,
    plan,
    event: planned,
    matchEvents
  };
}

export function applyProviderWithInert(resolvedProvider, resourceHandle, ...options) {
  const applied = [];
  const inert = [];

  for (const option of options) {
    const provider = option.provider ?? option.annotationKey?.split(".")[0];
    if (provider === resolvedProvider) {
      resourceHandle.with(option);
      applied.push({
        provider,
        annotation: option.annotationKey,
        status: "applied"
      });
    } else {
      inert.push({
        provider,
        option: `.with(${provider}.${option.optionName}(...))`,
        status: "inert",
        reason: "option belongs to a non-resolved provider"
      });
    }
  }

  const resolved = resolvedProviderOptions(
    createManifest([resourceHandle]).resources[resourceHandle.id],
    resolvedProvider
  );

  return { applied, inert, resolved, manifest: createManifest([resourceHandle]) };
}

export function referenceAppWithProviderOptions(resolvedProvider) {
  const db = database("shop.db", { engine: "postgres", require: "managed" });
  const api = service("shop.api");
  const withResult = applyProviderWithInert(
    resolvedProvider,
    db,
    aws.rds({ multiAz: true }),
    azure.flexibleServer({ haMode: "zone-redundant" })
  );
  api.with(resolvedProvider === "aws" ? aws.fargate({ cpu: 512 }) : azure.containerApp({ workloadProfile: "consumption" }));
  return { db, api, withResult };
}

function defaultPortRequests() {
  return {
    "shop.db": [
      capabilityRequest({ port: "database", features: ["managed", "postgres"], strictness: "require" })
    ],
    "shop.api": [
      capabilityRequest({ port: "service", features: ["containerService"], strictness: "require" })
    ],
    "shop.web": [
      capabilityRequest({ port: "web", features: ["cdn"], strictness: "require" })
    ]
  };
}

function defaultRequestsForResource(resource) {
  return defaultPortRequests()[resource.id] ?? [];
}

function bindleResourcesForCompiler(_bindleObject) {
  return REFERENCE_RESOURCES.map((resource) => ({
    id: resource.id,
    type: resource.type,
    engine: resource.engine,
    serviceModel: resource.serviceModel
  }));
}

function campMappingsForCompiler(campObject) {
  const mapping = {};
  if (campObject.mappings.defaultProvider) {
    mapping.defaultProvider = providerTarget(campObject.mappings.defaultProvider);
  }
  if (campObject.mappings.tiers) {
    mapping.tiers = Object.fromEntries(
      Object.entries(campObject.mappings.tiers).map(([tier, selection]) => [
        tierKindToServiceModel(tier),
        providerTarget(selection)
      ])
    );
  }
  if (campObject.mappings.bindings) {
    mapping.bindings = Object.fromEntries(
      Object.entries(campObject.mappings.bindings).map(([key, selection]) => [
        key,
        providerTarget(selection)
      ])
    );
  }
  return mapping;
}

function providerTarget(selection) {
  return {
    provider: selection.providerId,
    driver: "terraform",
    with: selection.options ?? {}
  };
}

function tierKindToServiceModel(kind) {
  const map = {
    data: "saas",
    service: "paas",
    web: "edge"
  };
  return map[kind] ?? kind;
}

function resourceDescriptor(kind, name, stableId, portRef, serviceModel) {
  return Object.freeze({
    kind,
    name,
    stableId,
    portRef,
    serviceModel,
    toDescriptor() {
      return { kind, name, stableId, portRef };
    }
  });
}
