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
export const FULL_CAPABILITY_PORTS = Object.freeze([
  "web",
  "service",
  "kv",
  "bucket",
  "queue",
  "topic",
  "sql",
  "secret"
]);

const CONFORMANCE_BRIDGE = Object.freeze({
  service: "compute",
  bucket: "objectStore",
  sql: "database",
  kv: "cache",
  queue: "queue"
});

const CAPABILITY_DEFINITIONS = [
  {
    port: "web",
    service: "Static Web Apps",
    resourceClass: "azure:static-web-app",
    className: "static",
    features: ["static", "cdn", "http"],
    outputs: ["url", "hostname", "resourceId"],
    defaultId: "azure.default.web.static-web-app",
    costSku: "azure.staticwebapp.gb-month",
    costUnit: "GB-month",
    roleActions: ["Microsoft.Web/staticSites/write"]
  },
  {
    port: "service",
    service: "Container Apps",
    resourceClass: "azure:container-app",
    className: "container",
    features: ["container", "http", "scale-to-zero"],
    outputs: ["url", "appName", "revisionName"],
    defaultId: "azure.default.service.container-app",
    costSku: "azure.containerapps.vcpu-second",
    costUnit: "vCPU-second",
    roleActions: ["Microsoft.App/containerApps/write"]
  },
  {
    port: "kv",
    service: "Table Storage",
    resourceClass: "azure:table-storage",
    className: "table",
    features: ["key-value", "durable"],
    outputs: ["endpoint", "accountName", "tableName"],
    defaultId: "azure.default.kv.table-storage",
    costSku: "azure.table.transaction",
    costUnit: "transaction",
    roleActions: ["Microsoft.Storage/storageAccounts/tableServices/tables/write"]
  },
  {
    port: "bucket",
    service: "Blob Storage",
    resourceClass: "azure:storage-blob-container",
    className: "container",
    features: ["durable", "versioned"],
    outputs: ["accountName", "containerName", "endpoint"],
    defaultId: "azure.default.bucket.blob",
    costSku: "azure.blob.hot.gb-month",
    costUnit: "GB-month",
    roleActions: ["Microsoft.Storage/storageAccounts/blobServices/containers/write"]
  },
  {
    port: "queue",
    service: "Service Bus Queue",
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
    port: "topic",
    service: "Service Bus Topic",
    resourceClass: "azure:service-bus-topic",
    className: "standard",
    features: ["durable", "pubsub"],
    outputs: ["topicName", "namespace", "connectionString"],
    defaultId: "azure.default.topic.service-bus",
    costSku: "azure.servicebus.operation",
    costUnit: "operation",
    roleActions: ["Microsoft.ServiceBus/namespaces/topics/write"]
  },
  {
    port: "sql",
    service: "Flexible Server",
    resourceClass: "azure:postgres-flexible-server",
    className: "postgres",
    features: ["postgres", "managed", "ha"],
    outputs: ["connectionString", "fqdn", "resourceId", "secretRef"],
    defaultId: "azure.default.sql.flexible-postgres",
    costSku: "azure.postgres.flexible.vcore-hour",
    costUnit: "vCore-hour",
    roleActions: ["Microsoft.DBforPostgreSQL/flexibleServers/write"]
  },
  {
    port: "secret",
    service: "Key Vault",
    resourceClass: "azure:key-vault-secret",
    className: "vault",
    features: ["secret", "managed", "rotation"],
    outputs: ["vaultUri", "secretName", "version"],
    defaultId: "azure.default.secret.key-vault",
    costSku: "azure.keyvault.operation",
    costUnit: "operation",
    roleActions: ["Microsoft.KeyVault/vaults/secrets/write"]
  }
];

const EQUIVALENCE_CLASSES = Object.freeze({
  "web{static}": "azure.static-web-app",
  "service{container}": "azure.container-app",
  "kv{table}": "azure.table-storage",
  bucket: "azure.blob.container",
  queue: "azure.service-bus.queue",
  topic: "azure.service-bus.topic",
  "sql{postgres}": "azure.postgres.flexible",
  secret: "azure.key-vault"
});

const CAPABILITY_BY_PORT = new Map(CAPABILITY_DEFINITIONS.map((definition) => [definition.port, definition]));
const RESOURCE_CLASS_BY_BUILDER = new Map([
  ["staticWebApp", "azure:static-web-app"],
  ["containerApp", "azure:container-app"],
  ["tableStorage", "azure:table-storage"],
  ["blob", "azure:storage-blob-container"],
  ["serviceBusQueue", "azure:service-bus-queue"],
  ["serviceBusTopic", "azure:service-bus-topic"],
  ["flexiblePostgres", "azure:postgres-flexible-server"],
  ["keyVault", "azure:key-vault-secret"]
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

export const azureFull = {
  with: {
    blob(options = {}) {
      return optionBlock("bucket", "blob", { redundancy: "LRS", accessTier: "Hot", versioning: false }, options);
    },
    containerApp(options = {}) {
      return optionBlock("service", "containerApp", { cpu: 0.5, memoryGiB: 1, ingress: "internal" }, options);
    },
    flexiblePostgres(options = {}) {
      return optionBlock("sql", "flexiblePostgres", { engine: "postgres", version: "16", sku: "B_Standard_B1ms" }, options);
    },
    keyVault(options = {}) {
      return optionBlock("secret", "keyVault", { sku: "standard", purgeProtection: true }, options);
    },
    serviceBusQueue(options = {}) {
      return optionBlock("queue", "serviceBusQueue", { tier: "Standard", sessions: false }, options);
    },
    serviceBusTopic(options = {}) {
      return optionBlock("topic", "serviceBusTopic", { tier: "Standard", duplicateDetection: false }, options);
    },
    staticWebApp(options = {}) {
      return optionBlock("web", "staticWebApp", { sku: "Free", customDomains: false }, options);
    },
    tableStorage(options = {}) {
      return optionBlock("kv", "tableStorage", { consistency: "strong", throughput: "provisioned" }, options);
    }
  }
};

export function createAzureFullProvider(options = {}) {
  const regions = options.regions ?? ["eastus", "westus2", "westeurope"];
  const serviceMatrix = normalizeServiceMatrix(options.serviceMatrix, regions);
  const provisioned = new Map();
  let nextId = 1;

  const provider = {
    id: AZURE_PROVIDER_ID,
    apiVersion: AZURE_PROVIDER_VERSION,
    target: AZURE_PROVIDER_TARGET,
    capabilities: createCapabilities(serviceMatrix, regions),
    manifest: {
      claimedCapabilities: [...FULL_CAPABILITY_PORTS]
    },
    with: azureFull.with,
    registerDefaultDefinitions(registry) {
      registry.push(...createDefaultDefinitions(regions));
      return registry;
    },
    capabilityManifest() {
      return createCapabilityManifest(regions, serviceMatrix);
    },
    publishManifestBundle() {
      return createManifestBundle(regions, serviceMatrix);
    },
    realize(plan) {
      return realizeAzureFullPlan(provider, plan);
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
    },
    conformanceAdapter() {
      return createConformanceAdapter(provider);
    }
  };

  return provider;
}

export function createAzureFullMultiCloudShopPlan(options = {}) {
  const region = options.region ?? "eastus";
  const resourceOptions = options.resourceOptions ?? {};

  return {
    id: options.id ?? "multi-cloud-shop-azure-full",
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
          id: "shop-web",
          type: "web",
          className: "static",
          require: ["static", "http"],
          region,
          options: resourceOptions["shop-web"] ?? [azureFull.with.staticWebApp()]
        },
        {
          id: "orders-db",
          type: "sql",
          className: "postgres",
          require: ["postgres", "managed", "ha"],
          region,
          options: resourceOptions["orders-db"] ?? [azureFull.with.flexiblePostgres({ storageGb: 64 })]
        },
        {
          id: "assets",
          type: "bucket",
          className: "container",
          require: ["durable"],
          region,
          options: resourceOptions.assets ?? [azureFull.with.blob({ versioning: true })]
        },
        {
          id: "jobs",
          type: "queue",
          className: "standard",
          require: ["durable"],
          region,
          options: resourceOptions.jobs ?? [azureFull.with.serviceBusQueue()]
        },
        {
          id: "events",
          type: "topic",
          className: "standard",
          require: ["pubsub"],
          region,
          options: resourceOptions.events ?? [azureFull.with.serviceBusTopic()]
        },
        {
          id: "session-kv",
          type: "kv",
          className: "table",
          require: ["key-value", "durable"],
          region,
          options: resourceOptions["session-kv"] ?? [azureFull.with.tableStorage()]
        },
        {
          id: "api-keys",
          type: "secret",
          className: "vault",
          require: ["secret", "managed"],
          region,
          options: resourceOptions["api-keys"] ?? [azureFull.with.keyVault()]
        },
        {
          id: "api",
          type: "service",
          className: "container",
          require: ["container"],
          region,
          options: resourceOptions.api ?? [azureFull.with.containerApp()],
          build: {
            artifactId: "api-image",
            source: "examples/multi-cloud-shop/api",
            target: "container"
          },
          binds: [
            { import: "wasi:sql/query", providerResourceId: "orders-db", capability: "sql" },
            { import: "wasi:blobstore/blobstore", providerResourceId: "assets", capability: "bucket" },
            { import: "wasi:messaging/messaging", providerResourceId: "jobs", capability: "queue" },
            { import: "hobo:messaging/topic", providerResourceId: "events", capability: "topic" },
            { import: "hobo:kv/table", providerResourceId: "session-kv", capability: "kv" },
            { import: "hobo:secret/vault", providerResourceId: "api-keys", capability: "secret" }
          ]
        }
      ]
  };
}

export function mergeAzureFullResolvedOptions(_provider, optionBlocks = []) {
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

export function evaluateAzureFullPlan(provider, plan) {
  const serviceMatrix = manifestServiceMatrix(provider);

  for (const rawResource of plan.resources ?? []) {
    const resource = normalizeResource(rawResource, plan);
    const definition = requireCapability(resource.type);
    const resolved = mergeAzureFullResolvedOptions(provider, resource.options).merged[resource.type];
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

export function realizeAzureFullPlan(provider, plan) {
  const evaluation = evaluateAzureFullPlan(provider, plan);
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

    if (resource.type === "service" && resource.build?.artifactId) {
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

export function simulateAzureFullApply(provider, plan, options = {}) {
  const evaluation = evaluateAzureFullPlan(provider, plan);
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

export function createManifestBundle(regions, serviceMatrix) {
  const manifest = createCapabilityManifest(regions, serviceMatrix);
  return {
    "index.json": {
      apiVersion: "hobo.capability-manifest/v1",
      provider: AZURE_PROVIDER_ID,
      version: AZURE_PROVIDER_VERSION,
      issuer: AZURE_PROVIDER_ID,
      links: {
        capabilities: "capabilities.json",
        auth: "auth.json",
        cost: "cost.json"
      },
      signature: "fixture:unsigned-draft-poc"
    },
    "capabilities.json": {
      provider: AZURE_PROVIDER_ID,
      ports: manifest.capabilities.map((capability) => ({
        port: capability.port,
        service: capability.service,
        resourceClass: capability.resourceClass,
        features: capability.features,
        regions: capability.regions
      })),
      equivalence: { ...EQUIVALENCE_CLASSES }
    },
    "auth.json": createAuthJson(),
    "cost.json": manifest.cost
  };
}

export function ingestAzureCapabilityManifest(registry, bundle) {
  const required = ["index.json", "capabilities.json", "auth.json", "cost.json"];
  const missing = required.filter((file) => !bundle[file]);
  if (missing.length > 0) {
    return {
      ok: false,
      provider: AZURE_PROVIDER_ID,
      reasons: missing.map((file) => `manifest.missing:${file}`)
    };
  }

  const auth = bundle["auth.json"];
  if (auth.staticSecrets === true) {
    return {
      ok: false,
      provider: AZURE_PROVIDER_ID,
      reasons: ["auth.staticSecrets.forbidden"]
    };
  }

  const hasWorkloadIdentity = (auth.flows ?? []).some((flow) => flow.type === "workload-identity-federation");
  if (!hasWorkloadIdentity) {
    return {
      ok: false,
      provider: AZURE_PROVIDER_ID,
      reasons: ["auth.workload-identity-federation.required"]
    };
  }

  const entry = {
    provider: AZURE_PROVIDER_ID,
    version: bundle["index.json"].version,
    claimedPorts: bundle["capabilities.json"].ports.map((port) => port.port),
    equivalence: bundle["capabilities.json"].equivalence,
    authMode: "workload-identity-federation",
    brokeredAuthOnly: true,
    ingestedAt: new Date().toISOString()
  };
  registry.set(AZURE_PROVIDER_ID, entry);

  return {
    ok: true,
    provider: AZURE_PROVIDER_ID,
    entry,
    includes: ["capabilities", "auth.json", "cost.json", "regions", "conformance"]
  };
}

export function createConformanceAdapter(provider) {
  const bridge = new Map(Object.entries(CONFORMANCE_BRIDGE));

  return {
    manifest: {
      claimedCapabilities: [...new Set(Object.values(CONFORMANCE_BRIDGE))]
    },
    provision(seedCapability, plan = {}) {
      const fullPort = [...bridge.entries()].find(([, mapped]) => mapped === seedCapability)?.[0] ?? seedCapability;
      return provider.provision(fullPort, plan);
    },
    client(seedCapability, resource = {}) {
      const fullPort = [...bridge.entries()].find(([, mapped]) => mapped === seedCapability)?.[0] ?? seedCapability;
      const client = provider.client(fullPort, resource);
      return {
        ...client,
        ping() {
          return `${seedCapability}:ok`;
        }
      };
    },
    negotiate(seedCapability, hints = {}) {
      const fullPort = [...bridge.entries()].find(([, mapped]) => mapped === seedCapability)?.[0] ?? seedCapability;
      return provider.negotiate(fullPort, hints);
    },
    injectDrift(id) {
      provider.injectDrift(id);
    },
    refresh(id) {
      return provider.refresh(id);
    },
    destroy(id) {
      provider.destroy(id);
    },
    hasResource(id) {
      return provider.hasResource(id);
    },
    campEvidence(seedCapability) {
      const fullPort = [...bridge.entries()].find(([, mapped]) => mapped === seedCapability)?.[0] ?? seedCapability;
      return provider.campEvidence(fullPort);
    }
  };
}

export function runExtendedPortConformance(provider, ports = ["web", "topic", "secret"]) {
  const failures = [];
  for (const port of ports) {
    try {
      const resource = provider.provision(port, { require: { region: "local" } });
      const client = provider.client(port, resource);
      if (client.ping() !== `${port}:ok`) {
        failures.push({ port, message: "extended conformance client ping failed" });
      }
      provider.destroy(resource.id);
      if (provider.hasResource(resource.id)) {
        failures.push({ port, message: "extended conformance destroy leaked state" });
      }
    } catch (error) {
      failures.push({
        port,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }
  return {
    status: failures.length === 0 ? "pass" : "fail",
    failures
  };
}

function createAuthJson() {
  return {
    issuer: "https://login.microsoftonline.com/{tenant}/v2.0",
    flows: [
      {
        type: "workload-identity-federation",
        audience: "api://AzureADTokenExchange",
        exchange: "azure:workload-identity-federation",
        trust: {
          oidcDiscovery: "https://yard.example.com/.well-known/openid-configuration",
          federatedCredential: "subject:spiffe://{tenant}/{bindle}/{resource}"
        }
      }
    ],
    scopeModel: "least-privilege-per-resource",
    resourceIndicators: [
      "urn:azure:sql",
      "urn:azure:compute",
      "urn:azure:storage",
      "urn:azure:keyvault"
    ],
    tokenLifetimeSec: 3600,
    staticSecrets: false,
    audit: {
      events: ["token.Granted", "token.Used", "token.Revoked"]
    }
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
    driver: IAC_PULUMI_DRIVER,
    equivalence: EQUIVALENCE_CLASSES
  }));
}

function createCapabilityManifest(regions, serviceMatrix) {
  return {
    apiVersion: AZURE_PROVIDER_VERSION,
    provider: AZURE_PROVIDER_ID,
    claimedCapabilities: [...FULL_CAPABILITY_PORTS],
    auth: {
      mode: "workload-identity-federation",
      tokenBroker: "identity.RequestToken",
      staticSecrets: false
    },
    regions,
    capabilities: createCapabilities(serviceMatrix, regions),
    equivalence: { ...EQUIVALENCE_CLASSES },
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
      features: definition.features,
      class: EQUIVALENCE_CLASSES[definition.port] ?? definition.resourceClass
    },
    regions
  }));
}

function createIacNode(resource) {
  const definition = requireCapability(resource.type);
  const resolved = mergeAzureFullResolvedOptions(null, resource.options).merged[resource.type];
  const options = resolved?.options ?? {};

  return {
    id: resource.id,
    type: resource.type,
    className: resource.className,
    resourceClass: resolved?.resourceClass ?? definition.resourceClass,
    driverIntent: {
      capability: resource.type,
      operation: resource.type === "service" ? "deploy" : "create",
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
  if (definition.port === "sql") {
    return {
      connectionString: `postgres://azure/${region}/${id}`,
      fqdn: `${id}.postgres.database.azure.com`,
      resourceId: `/subscriptions/fixture/resourceGroups/hobo/providers/Microsoft.DBforPostgreSQL/flexibleServers/${id}`,
      secretRef: `secret://${id}/database`
    };
  }
  if (definition.port === "bucket") {
    return {
      accountName: id.replace(/[^a-z0-9]/g, ""),
      containerName: id,
      endpoint: `https://${id}.blob.core.windows.net`
    };
  }
  if (definition.port === "service") {
    return {
      url: `https://${id}.${region}.azurecontainerapps.io`,
      appName: id,
      revisionName: `${id}--0001`
    };
  }
  if (definition.port === "web") {
    return {
      url: `https://${id}.azurestaticapps.net`,
      hostname: `${id}.azurestaticapps.net`,
      resourceId: `/subscriptions/fixture/resourceGroups/hobo/providers/Microsoft.Web/staticSites/${id}`
    };
  }
  if (definition.port === "queue") {
    return {
      queueName: id,
      namespace: `${id}-ns`,
      connectionString: `Endpoint=sb://${id}.servicebus.windows.net/;SharedAccessKeyName=fixture`
    };
  }
  if (definition.port === "topic") {
    return {
      topicName: id,
      namespace: `${id}-ns`,
      connectionString: `Endpoint=sb://${id}.servicebus.windows.net/;SharedAccessKeyName=fixture`
    };
  }
  if (definition.port === "kv") {
    return {
      endpoint: `https://${id}.table.core.windows.net`,
      accountName: id,
      tableName: `${id}-table`
    };
  }
  return {
    vaultUri: `https://${id}.vault.azure.net`,
    secretName: `${id}-secret`,
    version: "00000000000000000000000000000001"
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

  if (port === "sql") {
    return {
      ...base,
      connectionString: outputs.connectionString ?? outputs.fqdn,
      async query() {
        return { rows: [] };
      }
    };
  }
  if (port === "bucket") {
    return {
      ...base,
      containerName: outputs.containerName,
      async put() {},
      async get() {
        return undefined;
      }
    };
  }
  if (port === "service") {
    return {
      ...base,
      url: outputs.url
    };
  }
  if (port === "web") {
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
  if (port === "topic") {
    return {
      ...base,
      topicName: outputs.topicName,
      async publish() {}
    };
  }
  if (port === "kv") {
    return {
      ...base,
      endpoint: outputs.endpoint,
      async get() {
        return undefined;
      }
    };
  }
  return {
    ...base,
    vaultUri: outputs.vaultUri
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
    web: "url",
    service: "url",
    kv: "endpoint",
    bucket: "containerName",
    queue: "queueName",
    topic: "topicName",
    sql: "connectionString",
    secret: "vaultUri"
  }[port];
}

function envNameFor(resourceId, output) {
  if (resourceId === "orders-db") return "ORDERS_DB_CONNECTION";
  if (resourceId === "assets") return "ASSETS_CONTAINER";
  if (resourceId === "jobs") return "JOBS_QUEUE";
  if (resourceId === "events") return "EVENTS_TOPIC";
  if (resourceId === "session-kv") return "SESSION_KV_ENDPOINT";
  if (resourceId === "api-keys") return "API_KEYS_VAULT";
  return `${resourceId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_${output.toUpperCase()}`;
}
