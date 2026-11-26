import {
  BUILD_SPEC_VERSION,
  IAC_PROGRAM_VERSION,
  REALIZE_EMISSION_VERSION,
  outputPlaceholder,
  validateEmission
} from "../../hobo-realize-emission-contract/src/realize-emission-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


export const AZURE_PROVIDER_ID = "@hobo/provider-azure";
export const AZURE_PROVIDER_VERSION = "hobo.provider-azure/v1";
export const AZURE_PROVIDER_TARGET = "azure";
export const IAC_PULUMI_DRIVER = "@hobo/iac-pulumi";

const CAPABILITY_DEFINITIONS = [
  {
    port: "database",
    service: "Flexible Server",
    resourceClass: "azure:postgres-flexible-server",
    className: "postgres",
    features: ["postgres", "managed", "ha"],
    outputs: ["connectionString", "fqdn", "resourceId", "secretRef"],
    defaultId: "azure.default.database.flexible-postgres",
    costSku: "azure.postgres.flexible.vcore-hour",
    costUnit: "vCore-hour",
    roleActions: ["Microsoft.DBforPostgreSQL/flexibleServers/write"]
  },
  {
    port: "objectStore",
    service: "Blob Storage",
    resourceClass: "azure:storage-blob-container",
    className: "container",
    features: ["durable", "versioned"],
    outputs: ["accountName", "containerName", "endpoint"],
    defaultId: "azure.default.objectStore.blob",
    costSku: "azure.blob.hot.gb-month",
    costUnit: "GB-month",
    roleActions: ["Microsoft.Storage/storageAccounts/blobServices/containers/write"]
  },
  {
    port: "compute",
    service: "Container Apps",
    resourceClass: "azure:container-app",
    className: "container",
    features: ["container", "http"],
    outputs: ["url", "appName", "revisionName"],
    defaultId: "azure.default.compute.container-app",
    costSku: "azure.containerapps.vcpu-second",
    costUnit: "vCPU-second",
    roleActions: ["Microsoft.App/containerApps/write"]
  },
  {
    port: "queue",
    service: "Service Bus",
    resourceClass: "azure:service-bus-queue",
    className: "standard",
    features: ["durable", "sessions"],
    outputs: ["queueName", "namespace", "connectionString"],
    defaultId: "azure.default.queue.service-bus",
    costSku: "azure.servicebus.operation",
    costUnit: "operation",
    roleActions: ["Microsoft.ServiceBus/namespaces/queues/write"]
  },
  {
    port: "cache",
    service: "Cache for Redis",
    resourceClass: "azure:cache-for-redis",
    className: "redis",
    features: ["redis", "managed"],
    outputs: ["endpoint", "resourceId"],
    defaultId: "azure.default.cache.redis",
    costSku: "azure.redis.cache-hour",
    costUnit: "cache-hour",
    roleActions: ["Microsoft.Cache/redis/write"]
  }
];

const CAPABILITY_BY_PORT = new Map(CAPABILITY_DEFINITIONS.map((definition) => [definition.port, definition]));
const RESOURCE_CLASS_BY_BUILDER = new Map([
  ["flexiblePostgres", "azure:postgres-flexible-server"],
  ["blob", "azure:storage-blob-container"],
  ["containerApp", "azure:container-app"],
  ["serviceBus", "azure:service-bus-queue"],
  ["cacheForRedis", "azure:cache-for-redis"]
]);
const AZURE_ONLY_FEATURES = new Map([
  ["flexiblePostgres.zoneRedundantHa", {
    idSuffix: "zoneRedundantHa",
    detail: "Azure Flexible Server zone-redundant HA requires target provider support."
  }],
  ["blob.immutableStorage", {
    idSuffix: "immutableStorage",
    detail: "Azure Blob immutable storage is provider-specific retention behavior."
  }],
  ["containerApp.daprEnabled", {
    idSuffix: "daprEnabled",
    detail: "Azure Container Apps Dapr sidecars require Azure Container Apps support."
  }],
  ["containerApp.providerManagedCertificate", {
    idSuffix: "providerManagedCertificate",
    detail: "ADR-0035 allows provider-managed certs only as an explicit per-Camp adapter."
  }]
]);

export const azure = {
  with: {
    blob(options = {}) {
      return optionBlock("objectStore", "blob", { redundancy: "LRS", accessTier: "Hot", versioning: false }, options);
    },
    cacheForRedis(options = {}) {
      return optionBlock("cache", "cacheForRedis", { sku: "Basic", capacity: 0, tlsMinimumVersion: "1.2" }, options);
    },
    containerApp(options = {}) {
      return optionBlock("compute", "containerApp", { cpu: 0.5, memoryGiB: 1, ingress: "internal" }, options);
    },
    flexiblePostgres(options = {}) {
      return optionBlock("database", "flexiblePostgres", { engine: "postgres", version: "16", sku: "B_Standard_B1ms" }, options);
    },
    serviceBus(options = {}) {
      return optionBlock("queue", "serviceBus", { tier: "Standard", sessions: false }, options);
    }
  }
};

export function createAzureProvider(options = {}) {
  const regions = options.regions ?? ["eastus", "westus2", "westeurope"];
  const serviceMatrix = normalizeServiceMatrix(options.serviceMatrix, regions);
  const provisioned = new Map();
  let nextId = 1;

  return {
    id: AZURE_PROVIDER_ID,
    apiVersion: AZURE_PROVIDER_VERSION,
    target: AZURE_PROVIDER_TARGET,
    capabilities: createCapabilities(serviceMatrix, regions),
    manifest: {
      claimedCapabilities: CAPABILITY_DEFINITIONS.map((definition) => definition.port)
    },
    with: azure.with,
    registerDefaultDefinitions(registry) {
      registry.push(...createDefaultDefinitions(regions));
      return registry;
    },
    capabilityManifest() {
      return createCapabilityManifest(regions, serviceMatrix);
    },
    realize(plan) {
      return realizeAzurePlan(this, plan);
    },
    provision(capability, plan = {}) {
      const definition = requireCapability(capability);
      const region = plan.region ?? plan.require?.region ?? regions[0];
      assertServiceAvailable(definition, region, serviceMatrix);

      const id = `${capability}-${nextId++}`;
      const resource = {
        id,
        capability,
        region,
        plan,
        outputs: fakeOutputsFor(definition, id, region)
      };
      provisioned.set(id, resource);
      return resource;
    },
    client(capability, resource = {}) {
      return createAzureClient(capability, resource.outputs ?? resource);
    },
    negotiate(capability, hints = {}) {
      const definition = requireCapability(capability);
      const requested = normalizeHintValues(hints.require);
      const missing = [...requested].filter((feature) => !definition.features.includes(feature));
      return {
        capability,
        provider: AZURE_PROVIDER_ID,
        requireSatisfied: missing.length === 0,
        missing,
        preferHonored: normalizePreferHints(hints.prefer, definition)
      };
    },
    injectDrift(id) {
      const resource = provisioned.get(id);
      if (resource) resource.drifted = true;
    },
    refresh(id) {
      const resource = provisioned.get(id);
      return {
        id,
        exists: Boolean(resource),
        drift: Boolean(resource?.drifted),
        drifted: Boolean(resource?.drifted)
      };
    },
    destroy(id) {
      provisioned.delete(id);
    },
    hasResource(id) {
      return provisioned.has(id);
    },
    campEvidence(capability) {
      requireCapability(capability);
      return normalizeCampEvidence(options.campEvidence, capability);
    }
  };
}

export function createAzureMultiCloudShopPlan(options = {}) {
  const region = options.region ?? "eastus";
  const resourceOptions = options.resourceOptions ?? {};

  return {
    id: options.id ?? "multi-cloud-shop-azure",
    context: {
      app: "multi-cloud-shop",
      env: options.env ?? "preview",
      envType: options.envType ?? "ephemeral",
      provider: AZURE_PROVIDER_ID,
      region
    },
    resources:
      options.resources ??
      [
        {
          id: "orders-db",
          type: "database",
          className: "postgres",
          require: ["postgres", "managed", "ha"],
          region,
          options: resourceOptions["orders-db"] ?? [azure.with.flexiblePostgres({ storageGb: 64 })]
        },
        {
          id: "assets",
          type: "objectStore",
          className: "bucket",
          require: ["durable"],
          region,
          options: resourceOptions.assets ?? [azure.with.blob({ versioning: true })]
        },
        {
          id: "jobs",
          type: "queue",
          className: "standard",
          require: ["durable"],
          region,
          options: resourceOptions.jobs ?? [azure.with.serviceBus()]
        },
        {
          id: "session-cache",
          type: "cache",
          className: "redis",
          require: ["redis", "managed"],
          region,
          options: resourceOptions["session-cache"] ?? [azure.with.cacheForRedis()]
        },
        {
          id: "web",
          type: "compute",
          className: "container",
          require: ["container"],
          region,
          options: resourceOptions.web ?? [azure.with.containerApp()],
          build: {
            artifactId: "web-image",
            source: "examples/multi-cloud-shop/web",
            target: "container"
          },
          binds: [
            { import: "wasi:sql/query", providerResourceId: "orders-db", capability: "database" },
            { import: "wasi:blobstore/blobstore", providerResourceId: "assets", capability: "objectStore" },
            { import: "wasi:messaging/messaging", providerResourceId: "jobs", capability: "queue" },
            { import: "hobo:cache/redis", providerResourceId: "session-cache", capability: "cache" }
          ]
        }
      ]
  };
}

export function mergeAzureResolvedOptions(_provider, optionBlocks = []) {
  const merged = new Map();
  const dropped = [];

  for (const block of optionBlocks ?? []) {
    if (!block) continue;
    if (block.providerId !== AZURE_PROVIDER_TARGET) {
      dropped.push(block);
      continue;
    }
    const capability = requireCapability(block.port);
    const prior = merged.get(block.port) ?? {
      providerId: AZURE_PROVIDER_TARGET,
      port: block.port,
      resourceClass: capability.resourceClass,
      optionName: block.optionName,
      options: {}
    };
    merged.set(block.port, {
      ...prior,
      resourceClass: RESOURCE_CLASS_BY_BUILDER.get(block.optionName) ?? prior.resourceClass,
      optionName: block.optionName ?? prior.optionName,
      options: {
        ...prior.options,
        ...block.options
      }
    });
  }

  return {
    merged: Object.fromEntries(merged),
    dropped
  };
}

export function evaluateAzurePlan(provider, plan) {
  const serviceMatrix = manifestServiceMatrix(provider);

  for (const rawResource of plan.resources ?? []) {
    const resource = normalizeResource(rawResource, plan);
    const definition = requireCapability(resource.type);
    const resolved = mergeAzureResolvedOptions(provider, resource.options).merged[resource.type];
    const unavailable = availabilityError(resource, definition, serviceMatrix, resolved?.resourceClass ?? definition.resourceClass);
    if (unavailable) return unavailable;

    const missingRoles = (resource.requiredRoles ?? []).filter((role) => !definition.roleActions.includes(role));
    if (missingRoles.length > 0) {
      return planRejected("azure-role-mapping-unsupported", resource.id, {
        message: `${AZURE_PROVIDER_ID} cannot silently translate Azure role actions for ${resource.id}`,
        missingRoles,
        provider: AZURE_PROVIDER_ID,
        capability: resource.type
      });
    }

    const missing = (resource.require ?? []).filter((feature) => !definition.features.includes(feature));
    if (missing.length > 0) {
      return planRejected("azure-capability-require-unsatisfied", resource.id, {
        message: `${AZURE_PROVIDER_ID} cannot satisfy ${resource.type} require facts: ${missing.join(", ")}`,
        missing,
        require: resource.require,
        provider: AZURE_PROVIDER_ID,
        capability: resource.type
      });
    }
  }

  return {
    type: "deployment.Planned",
    provider: AZURE_PROVIDER_ID,
    planId: plan.id,
    region: plan.context?.region ?? plan.region ?? "eastus"
  };
}

export function realizeAzurePlan(provider, plan) {
  const evaluation = evaluateAzurePlan(provider, plan);
  if (evaluation.type === "deployment.PlanRejected") {
    throw new Error(`${evaluation.reason.code}: ${evaluation.reason.message}`);
  }

  const resources = new Map((plan.resources ?? []).map((resource) => [resource.id, normalizeResource(resource, plan)]));
  const nodes = [];
  const edges = [];
  const links = [];
  const outputPlaceholders = [];
  const buildArtifacts = [];

  for (const resource of resources.values()) {
    const node = createIacNode(resource);
    nodes.push(node);

    if (resource.type === "compute" && resource.build?.artifactId) {
      buildArtifacts.push({
        id: resource.build.artifactId,
        source: resource.build.source ?? `services/${resource.id}`,
        target: resource.build.target ?? "container",
        outputKind: "ImageRef",
        dependsOn: resource.build.dependsOn ?? []
      });
      node.inputs.image = { $build: resource.build.artifactId };
    }

    for (const bind of resource.binds ?? []) {
      const producer = resources.get(bind.providerResourceId);
      if (!producer) continue;

      const output = primaryOutputFor(producer.type);
      const placeholder = outputPlaceholder({
        type: producer.type,
        className: producer.className,
        id: producer.id,
        output
      });
      const inputName = envNameFor(producer.id, output);
      node.inputs.env ??= {};
      node.inputs.env[inputName] = placeholder;
      edges.push({ from: producer.id, to: resource.id, reason: "binding-output" });
      outputPlaceholders.push({
        placeholder,
        producerNode: producer.id,
        output,
        consumerNode: resource.id,
        inputPath: `inputs.env.${inputName}`
      });
      links.push({
        component: resource.id,
        import: bind.import,
        providerNode: producer.id,
        capability: bind.capability ?? producer.type
      });
    }
  }

  const emission = {
    apiVersion: REALIZE_EMISSION_VERSION,
    provider: AZURE_PROVIDER_ID,
    planId: plan.id,
    portabilityReport: createPortabilityReport(plan),
    iac: {
      apiVersion: IAC_PROGRAM_VERSION,
      intent: "driver-agnostic-resource-graph",
      context: plan.context,
      nodes,
      edges,
      outputPlaceholders,
      links
    }
  };

  if (buildArtifacts.length > 0) {
    emission.build = {
      apiVersion: BUILD_SPEC_VERSION,
      artifacts: buildArtifacts
    };
  }

  const validation = validateEmission(emission);
  if (!validation.ok) {
    throw new Error(validation.errors.join("; "));
  }
  return emission;
}

export function simulateAzureApply(provider, plan, options = {}) {
  const evaluation = evaluateAzurePlan(provider, plan);
  if (evaluation.type === "deployment.PlanRejected") return evaluation;

  const quota = options.quota ?? {};
  for (const resource of plan.resources ?? []) {
    if (quota[resource.type] === 0) {
      return planRejected("azure-quota-throttling", resource.id, {
        message: `${AZURE_PROVIDER_ID} quota or throttling blocked ${resource.type} before applying ${resource.id}`,
        quota: resource.type,
        provider: AZURE_PROVIDER_ID
      });
    }
  }

  return {
    type: "deployment.Applied",
    provider: AZURE_PROVIDER_ID,
    planId: plan.id,
    resources: plan.resources?.map((resource) => resource.id) ?? []
  };
}

function optionBlock(port, builder, defaults, options, negotiation = "prefer") {
  return {
    providerId: AZURE_PROVIDER_TARGET,
    port,
    optionName: builder,
    negotiation,
    options: {
      ...defaults,
      ...options
    }
  };
}

function createCapabilities(serviceMatrix, defaultRegions) {
  return CAPABILITY_DEFINITIONS.map((definition) => ({
    port: definition.port,
    service: definition.service,
    resourceClass: definition.resourceClass,
    resourceClasses: [definition.resourceClass],
    resourceClassesByRegion: Object.fromEntries(defaultRegions.map((region) => [
      region,
      serviceMatrix[region]?.includes(definition.resourceClass) ? [definition.resourceClass] : []
    ])),
    features: definition.features,
    regions: defaultRegions.filter((region) => serviceMatrix[region]?.includes(definition.resourceClass)),
    conformance: { tags: ["local", "camp"] },
    driver: IAC_PULUMI_DRIVER
  }));
}

function createCapabilityManifest(regions, serviceMatrix) {
  return {
    apiVersion: AZURE_PROVIDER_VERSION,
    provider: AZURE_PROVIDER_ID,
    claimedCapabilities: CAPABILITY_DEFINITIONS.map((definition) => definition.port),
    auth: {
      mode: "svid-federation",
      tokenBroker: "identity.RequestToken",
      staticSecrets: false
    },
    regions,
    capabilities: createCapabilities(serviceMatrix, regions),
    cost: {
      currency: "USD",
      source: "cost.json",
      facts: CAPABILITY_DEFINITIONS.map((definition) => ({
        port: definition.port,
        sku: definition.costSku,
        unit: definition.costUnit,
        trust: "declared"
      }))
    },
    conformance: {
      suites: ["@hobo/provider-conformance"],
      tags: ["local", "camp"]
    }
  };
}

function createDefaultDefinitions(regions) {
  return CAPABILITY_DEFINITIONS.map((definition) => ({
    id: definition.defaultId,
    provider: AZURE_PROVIDER_ID,
    port: definition.port,
    resourceClass: definition.resourceClass,
    className: definition.className,
    source: "provider-default",
    driver: IAC_PULUMI_DRIVER,
    satisfies: definition.features,
    equivalence: {
      providerService: definition.service,
      features: definition.features
    },
    regions
  }));
}

function createIacNode(resource) {
  const definition = requireCapability(resource.type);
  const resolved = mergeAzureResolvedOptions(null, resource.options).merged[resource.type];
  const options = resolved?.options ?? {};

  return {
    id: resource.id,
    type: resource.type,
    className: resource.className,
    resourceClass: resolved?.resourceClass ?? definition.resourceClass,
    driverIntent: {
      capability: resource.type,
      operation: resource.type === "compute" ? "deploy" : "create",
      iacProvider: IAC_PULUMI_DRIVER
    },
    inputs: {
      region: resource.region,
      name: `${resource.id}-${resource.region}`,
      options,
      tags: {
        hoboPlan: resource.planId,
        hoboResource: resource.id
      }
    },
    outputs: definition.outputs
  };
}

function normalizeResource(resource, plan) {
  const definition = requireCapability(resource.type);
  return {
    ...resource,
    planId: plan.id,
    className: resource.className ?? definition.className,
    region: resource.region ?? plan.context?.region ?? plan.region ?? "eastus",
    require: resource.require ?? [],
    options: resource.options ?? []
  };
}

function availabilityError(resource, definition, serviceMatrix, resourceClass) {
  if (serviceMatrix[resource.region]?.includes(resourceClass)) return null;

  return planRejected("azure-region-service-unavailable", resource.id, {
    message: `${definition.service} is not available in ${resource.region} for ${resource.id}`,
    provider: AZURE_PROVIDER_ID,
    region: resource.region,
    service: definition.service,
    resourceClass
  });
}

function assertServiceAvailable(definition, region, serviceMatrix) {
  if (region === "local") return;
  if (!serviceMatrix[region]?.includes(definition.resourceClass)) {
    throw new Error(`${definition.service} is not available in ${region}`);
  }
}

function manifestServiceMatrix(provider) {
  const manifest = provider.capabilityManifest();
  const matrix = {};
  for (const region of manifest.regions ?? []) {
    matrix[region] = [];
  }
  for (const capability of manifest.capabilities ?? []) {
    for (const region of capability.regions ?? []) {
      matrix[region] ??= [];
      matrix[region].push(...(capability.resourceClassesByRegion?.[region] ?? capability.resourceClasses ?? [capability.resourceClass]));
    }
  }
  return matrix;
}

function normalizeServiceMatrix(serviceMatrix, defaultRegions) {
  if (serviceMatrix) return serviceMatrix;

  const allResourceClasses = CAPABILITY_DEFINITIONS.map((definition) => definition.resourceClass);
  return Object.fromEntries(defaultRegions.map((region) => [region, allResourceClasses]));
}

function createPortabilityReport(plan) {
  const entries = [];
  for (const resource of plan.resources ?? []) {
    for (const block of resource.options ?? []) {
      if (block?.providerId !== AZURE_PROVIDER_TARGET) continue;
      for (const [optionName, value] of Object.entries(block.options ?? {})) {
        if (!value) continue;
        const feature = AZURE_ONLY_FEATURES.get(`${block.optionName}.${optionName}`);
        if (!feature) continue;
        entries.push({
          id: `${resource.id}.provider-option.azure.${feature.idSuffix}`,
          category: "provider-option",
          severity: "target-scoped",
          resourceId: resource.id,
          provider: AZURE_PROVIDER_TARGET,
          path: `resources.${resource.id}.with.azure.${feature.idSuffix}`,
          detail: feature.detail,
          gateEffect: "target-provider-must-satisfy"
        });
      }
    }
  }

  return {
    apiVersion: "hobo.portabilityReport/v1",
    planId: plan.id,
    entries,
    zeroSecretExceptions: []
  };
}

function normalizeCampEvidence(evidence = "pass", capability) {
  if (evidence === "pass") {
    return {
      realProviderDrift: true,
      iam: true,
      mtls: true,
      quota: true
    };
  }
  if (evidence === "fail") {
    return {
      realProviderDrift: false,
      iam: false,
      mtls: false,
      quota: false
    };
  }
  return {
    realProviderDrift: true,
    iam: true,
    mtls: true,
    quota: true,
    ...(evidence[capability] ?? evidence.default)
  };
}

function normalizeHintValues(value) {
  if (Array.isArray(value)) return new Set(value);
  if (!value || !isJsonObject(value)) return new Set();

  const features = new Set();
  for (const [key, hintValue] of Object.entries(value)) {
    if (key === "region") continue;
    features.add(key);
    if (isJsonString(hintValue)) features.add(hintValue);
  }
  return features;
}

function normalizePreferHints(value, definition) {
  if (Array.isArray(value)) return value.filter((feature) => definition.features.includes(feature));
  if (!value || !isJsonObject(value)) return [];
  return Object.keys(value);
}

function requireCapability(port) {
  const definition = CAPABILITY_BY_PORT.get(port);
  if (!definition) throw new Error(`${AZURE_PROVIDER_ID} does not implement port ${port}`);
  return definition;
}

function fakeOutputsFor(definition, id, region) {
  if (definition.port === "database") {
    return {
      connectionString: `postgres://azure/${region}/${id}`,
      fqdn: `${id}.postgres.database.azure.com`,
      resourceId: `/subscriptions/fixture/resourceGroups/hobo/providers/Microsoft.DBforPostgreSQL/flexibleServers/${id}`,
      secretRef: `secret://${id}/database`
    };
  }
  if (definition.port === "objectStore") {
    return {
      accountName: id.replace(/[^a-z0-9]/g, ""),
      containerName: id,
      endpoint: `https://${id}.blob.core.windows.net`
    };
  }
  if (definition.port === "compute") {
    return {
      url: `https://${id}.${region}.azurecontainerapps.io`,
      appName: id,
      revisionName: `${id}--0001`
    };
  }
  if (definition.port === "queue") {
    return {
      queueName: id,
      namespace: `${id}-ns`,
      connectionString: `Endpoint=sb://${id}.servicebus.windows.net/;SharedAccessKeyName=fixture`
    };
  }
  return {
    endpoint: `${id}.redis.cache.windows.net:6380`,
    resourceId: `/subscriptions/fixture/resourceGroups/hobo/providers/Microsoft.Cache/Redis/${id}`
  };
}

function createAzureClient(port, outputs) {
  requireCapability(port);
  const base = {
    port,
    providerId: AZURE_PROVIDER_ID,
    ping() {
      return `${port}:ok`;
    },
    describe() {
      return outputs;
    }
  };

  if (port === "database") {
    return {
      ...base,
      connectionString: outputs.connectionString ?? outputs.fqdn,
      async query() {
        return { rows: [] };
      }
    };
  }
  if (port === "objectStore") {
    return {
      ...base,
      containerName: outputs.containerName,
      async put() {},
      async get() {
        return undefined;
      }
    };
  }
  if (port === "compute") {
    return {
      ...base,
      url: outputs.url
    };
  }
  if (port === "queue") {
    return {
      ...base,
      queueName: outputs.queueName,
      async publish() {}
    };
  }
  return {
    ...base,
    endpoint: outputs.endpoint
  };
}

function planRejected(code, resourceId, reason) {
  return {
    type: "deployment.PlanRejected",
    provider: AZURE_PROVIDER_ID,
    resourceId,
    reason: {
      code,
      resourceId,
      ...reason
    }
  };
}

function primaryOutputFor(port) {
  return {
    database: "connectionString",
    objectStore: "containerName",
    compute: "url",
    queue: "queueName",
    cache: "endpoint"
  }[port];
}

function envNameFor(resourceId, output) {
  if (resourceId === "orders-db") return "ORDERS_DB_CONNECTION";
  if (resourceId === "assets") return "ASSETS_CONTAINER";
  if (resourceId === "jobs") return "JOBS_QUEUE";
  if (resourceId === "session-cache") return "SESSION_CACHE_ENDPOINT";
  return `${resourceId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_${output.toUpperCase()}`;
}
