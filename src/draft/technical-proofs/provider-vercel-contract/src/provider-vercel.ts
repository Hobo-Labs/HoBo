export const PROVIDER_VERCEL_VERSION = "hobo.provider-vercel/v1";
export const VERCEL_REALIZE_VERSION = "hobo.provider-vercel.realize/v1";
export const VERCEL_PORTABILITY_REPORT_VERSION = "hobo.provider-vercel.portabilityReport/v1";
export const PROVIDER_ID = "@hobo/provider-vercel";

const SUPPORTED_REGIONS = new Set(["iad1", "sfo1", "fra1", "cdg1", "gru1", "hnd1", "sin1"]);
const CLAIMED_SEED_CAPABILITIES = Object.freeze(["compute", "objectStore", "database"]);
const INTEGRATION_MARKER_CATEGORY = "integration-backed";

export const vercel = Object.freeze({
  with: Object.freeze({
    web(options = {}) {
      return optionBlock({
        port: "compute",
        resourceClass: "web-ssr",
        optionName: "web",
        service: "vercel:web",
        project: options.project ?? "app-web",
        framework: options.framework ?? "nextjs",
        runtime: options.runtime ?? "nodejs20.x",
        regions: options.regions ?? ["iad1"]
      });
    },
    function(options = {}) {
      const runtime = options.runtime ?? "edge";
      return optionBlock({
        port: "compute",
        resourceClass: runtime === "edge" ? "edge-function" : "serverless-function",
        optionName: "function",
        service: runtime === "edge" ? "vercel:edge-function" : "vercel:serverless-function",
        runtime,
        entrypoint: options.entrypoint ?? "api/index.ts",
        regions: options.regions ?? ["iad1"],
        maxDurationSeconds: options.maxDurationSeconds ?? (runtime === "edge" ? 15 : 60)
      });
    },
    blob(options = {}) {
      return optionBlock({
        port: "objectStore",
        resourceClass: "vercel-blob",
        optionName: "blob",
        service: "vercel:blob",
        store: options.store ?? "assets",
        region: options.region ?? "global"
      });
    },
    neonPostgres(options = {}) {
      return optionBlock({
        port: "database",
        resourceClass: "neon-postgres",
        optionName: "neonPostgres",
        service: "marketplace:neon",
        integrationBacked: true,
        integration: "neon",
        project: options.project ?? "app-db",
        branch: options.branch ?? "main",
        engine: "postgres"
      });
    },
    upstashKv(options = {}) {
      return optionBlock({
        port: "kv",
        resourceClass: "upstash-kv",
        optionName: "upstashKv",
        service: "marketplace:upstash",
        integrationBacked: true,
        integration: "upstash",
        database: options.database ?? "app-kv"
      });
    },
    edgeConfig(options = {}) {
      return optionBlock({
        port: "kv",
        resourceClass: "vercel-edge-config",
        optionName: "edgeConfig",
        service: "vercel:edge-config",
        store: options.store ?? "edge-config"
      });
    }
  })
});

export function createRecordedVercelCampEvidence() {
  return Object.fromEntries(
    CLAIMED_SEED_CAPABILITIES.map((capability) => [
      capability,
      {
        realProviderDrift: true,
        iam: true,
        mtls: true,
        quota: true,
        evidenceRef: `recorded-vercel-${capability}-camp-evidence`
      }
    ])
  );
}

export function createVercelProvider({ projectPrefix = "hobo", campEvidence = {} } = {}) {
  const resources = new Map();
  let nextResourceId = 0;

  const provider = {
    id: PROVIDER_ID,
    apiVersion: PROVIDER_VERCEL_VERSION,
    projectPrefix,
    capabilities: createCapabilities(),
    with: vercel.with,
    registerDefaultDefinitions(registry) {
      registry.push(...createDefaultDefinitions());
      return registry;
    },
    capabilityManifest() {
      return createCapabilityManifest();
    },
    realize(plan) {
      return realizeVercelPlan(plan, { projectPrefix });
    },
    resolveProviderOptions(optionBlocks = []) {
      return resolveProviderOptions(optionBlocks);
    },
    provision(capability, request = {}) {
      assertClaimedCapability(capability);
      const id = `${capability}-${++nextResourceId}`;
      const provisioned = {
        id,
        capability,
        request,
        drift: false,
        providerId: PROVIDER_ID,
        outputs: outputsFor(capability, id)
      };
      resources.set(id, provisioned);
      return provisioned;
    },
    client(port, outputs) {
      assertKnownPort(port);
      return createClient(port, outputs);
    },
    negotiate(port, hints = {}) {
      return negotiateVercel(port, hints);
    },
    injectDrift(id) {
      const resource = resources.get(id);
      if (!resource) {
        throw new Error(`cannot drift missing resource ${id}`);
      }
      resource.drift = true;
    },
    refresh(id) {
      const resource = resources.get(id);
      if (!resource) {
        throw new Error(`cannot refresh missing resource ${id}`);
      }
      return { drift: resource.drift };
    },
    destroy(id) {
      if (!resources.has(id)) {
        throw new Error(`cannot destroy missing resource ${id}`);
      }
      resources.delete(id);
    },
    hasResource(id) {
      return resources.has(id);
    },
    campEvidence(capability) {
      assertClaimedCapability(capability);
      return campEvidence[capability] ?? {};
    }
  };

  return provider;
}

export function createVercelFixturePlan({ overrides = {}, extraOptionBlocks = [] } = {}) {
  const base = {
    web: {
      id: "web",
      type: "compute",
      className: "web-ssr",
      request: vercel.with.web({ project: "shop-web", framework: "nextjs" }),
      binds: [
        { providerResourceId: "api", capability: "compute", reason: "same-vercel-project" },
        { providerResourceId: "assets", capability: "objectStore", reason: "runtime-binding" },
        { providerResourceId: "db", capability: "database", reason: "marketplace-binding" }
      ]
    },
    api: {
      id: "api",
      type: "compute",
      className: "edge-function",
      request: vercel.with.function({ runtime: "edge", entrypoint: "api/index.ts" }),
      binds: [{ providerResourceId: "kv", capability: "kv", reason: "marketplace-binding" }]
    },
    assets: {
      id: "assets",
      type: "objectStore",
      className: "vercel-blob",
      request: vercel.with.blob({ store: "shop-assets" })
    },
    db: {
      id: "db",
      type: "database",
      className: "neon-postgres",
      request: vercel.with.neonPostgres({ project: "shop-db", branch: "main" })
    },
    kv: {
      id: "kv",
      type: "kv",
      className: "upstash-kv",
      request: vercel.with.upstashKv({ database: "shop-kv" })
    }
  };

  const resources = ["web", "api", "assets", "db", "kv"].map((id) => mergeResource(base[id], overrides[id]));
  return {
    id: "vercel-shop-fixture",
    context: {
      app: "shop",
      env: "preview",
      provider: PROVIDER_ID
    },
    resources,
    extraOptionBlocks
  };
}

export function validateVercelPortabilityReport(report) {
  const errors = [];
  if (report?.apiVersion !== VERCEL_PORTABILITY_REPORT_VERSION) {
    errors.push(`expected portability report ${VERCEL_PORTABILITY_REPORT_VERSION}`);
  }
  if (!Array.isArray(report?.entries)) {
    errors.push("portability report entries are required");
    return { ok: false, errors };
  }

  const ids = new Set();
  for (const entry of report.entries) {
    if (ids.has(entry.id)) {
      errors.push(`duplicate portability marker ${entry.id}`);
    }
    ids.add(entry.id);
    if (entry.category !== INTEGRATION_MARKER_CATEGORY) {
      errors.push(`unsupported Vercel marker category ${entry.category}`);
    }
    if (entry.severity !== "target-scoped") {
      errors.push(`integration marker ${entry.id} must be target-scoped`);
    }
    if (!["neon", "upstash"].includes(entry.integration)) {
      errors.push(`unknown marketplace integration ${entry.integration}`);
    }
    if (entry.gateEffect !== "marketplace-integration-must-be-registered") {
      errors.push(`integration marker ${entry.id} must gate on marketplace registration`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateVercelPlanReadiness(emission, { registeredIntegrations = [] } = {}) {
  const errors = [];
  const registered = new Set(registeredIntegrations);
  const report = emission?.deploymentPlanned?.portabilityReport;
  const reportValidation = validateVercelPortabilityReport(report);
  errors.push(...reportValidation.errors);

  for (const entry of report?.entries ?? []) {
    if (entry.category === INTEGRATION_MARKER_CATEGORY && !registered.has(entry.integration)) {
      errors.push(`marketplace integration ${entry.integration} is not registered for ${entry.resourceId}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function runVercelProviderContract(provider) {
  const errors = [];
  if (provider.id !== PROVIDER_ID) {
    errors.push(`expected provider id ${PROVIDER_ID}`);
  }
  const capabilityPorts = provider.capabilities?.map((capability) => capability.port) ?? [];
  for (const required of ["compute", "objectStore", "database", "kv"]) {
    if (!capabilityPorts.includes(required)) {
      errors.push(`missing Vercel capability ${required}`);
    }
  }
  for (const builder of ["web", "function", "blob", "neonPostgres", "upstashKv"]) {
    if (!(provider.with?.[builder] instanceof Function)) {
      errors.push(`missing Vercel .with builder ${builder}`);
    }
  }

  const registry = [];
  provider.registerDefaultDefinitions?.(registry);
  for (const required of [
    "vercel.compute.web-ssr",
    "vercel.compute.serverless-function",
    "vercel.compute.edge-function",
    "vercel.objectStore.blob",
    "vercel.database.neon-postgres",
    "vercel.kv.upstash"
  ]) {
    if (!registry.some((definition) => definition.id === required)) {
      errors.push(`missing default Resource Definition ${required}`);
    }
  }

  return {
    ok: errors.length === 0,
    checked: capabilityPorts,
    ...(errors.length > 0 ? { errors } : undefined)
  };
}

function realizeVercelPlan(plan, { projectPrefix }) {
  const nodes = [];
  const links = [];
  const resources = new Map(plan.resources.map((resource) => [resource.id, resource]));

  for (const resource of plan.resources) {
    nodes.push(createIacNode(resource, { projectPrefix }));
    for (const bind of resource.binds ?? []) {
      if (!resources.has(bind.providerResourceId)) {
        throw new Error(`binding target ${bind.providerResourceId} does not exist`);
      }
      links.push({
        component: resource.id,
        providerNode: bind.providerResourceId,
        capability: bind.capability,
        reason: bind.reason
      });
    }
  }

  const portabilityReport = createPortabilityReport(plan.id, nodes);
  return {
    apiVersion: VERCEL_REALIZE_VERSION,
    provider: PROVIDER_ID,
    planId: plan.id,
    iac: {
      apiVersion: "hobo.iacProgram/v1",
      adapter: "terraform:vercel",
      intent: "vercel-provider-resource-graph",
      nodes,
      links
    },
    deploymentPlanned: {
      type: "deployment.Planned",
      planId: plan.id,
      portabilityReport
    }
  };
}

function createIacNode(resource, { projectPrefix }) {
  const request = resource.request ?? {};
  if (request.providerId !== PROVIDER_ID) {
    throw new Error(`resource ${resource.id} must use ${PROVIDER_ID} .with options`);
  }
  if (request.port !== resource.type && !(resource.type === "compute" && request.port === "compute")) {
    throw new Error(`resource ${resource.id} type ${resource.type} does not match option port ${request.port}`);
  }
  validateRegions(request.regions ?? []);

  if (request.resourceClass === "edge-function" && request.maxDurationSeconds > 30) {
    throw new Error("edge functions support maxDurationSeconds <= 30");
  }

  if (request.resourceClass === "web-ssr") {
    return node(resource, request, {
      driver: "vercel-cli:project",
      inputs: {
        projectName: request.project ?? `${projectPrefix}-${resource.id}`,
        framework: request.framework,
        runtime: request.runtime,
        regions: [...request.regions]
      },
      outputs: ["url", "projectId", "deploymentId"]
    });
  }

  if (request.resourceClass === "edge-function" || request.resourceClass === "serverless-function") {
    return node(resource, request, {
      driver: "vercel-cli:function",
      inputs: {
        entrypoint: request.entrypoint,
        runtime: request.runtime,
        regions: [...request.regions],
        maxDurationSeconds: request.maxDurationSeconds
      },
      outputs: ["url", "functionId", "region"]
    });
  }

  if (request.resourceClass === "vercel-blob") {
    return node(resource, request, {
      driver: "terraform:vercel_blob_store",
      inputs: {
        store: request.store,
        region: request.region
      },
      outputs: ["storeId", "endpoint", "readWriteTokenRef"]
    });
  }

  if (request.resourceClass === "neon-postgres") {
    return node(resource, request, {
      driver: "marketplace:neon",
      integrationBacked: true,
      integration: "neon",
      inputs: {
        project: request.project,
        branch: request.branch,
        engine: request.engine
      },
      outputs: ["connectionString", "DATABASE_URL"]
    });
  }

  if (request.resourceClass === "upstash-kv") {
    return node(resource, request, {
      driver: "marketplace:upstash",
      integrationBacked: true,
      integration: "upstash",
      inputs: {
        database: request.database
      },
      outputs: ["restUrl", "tokenRef"]
    });
  }

  if (request.resourceClass === "vercel-edge-config") {
    return node(resource, request, {
      driver: "terraform:vercel_edge_config",
      inputs: {
        store: request.store
      },
      outputs: ["edgeConfigId", "tokenRef"]
    });
  }

  throw new Error(`unsupported Vercel resourceClass ${request.resourceClass}`);
}

function node(resource, request, details) {
  return {
    id: resource.id,
    type: resource.type,
    resourceClass: request.resourceClass,
    provider: PROVIDER_ID,
    service: request.service,
    ...details
  };
}

function createPortabilityReport(planId, nodes) {
  const entries = nodes
    .filter((node) => node.integrationBacked)
    .map((node) => ({
      id: `${node.id}.integration.${node.integration}`,
      category: INTEGRATION_MARKER_CATEGORY,
      severity: "target-scoped",
      resourceId: node.id,
      provider: PROVIDER_ID,
      integration: node.integration,
      path: `resources.${node.id}.marketplace.${node.integration}`,
      detail: `${node.resourceClass} is satisfied through the ${node.integration} marketplace integration.`,
      gateEffect: "marketplace-integration-must-be-registered"
    }));

  return {
    apiVersion: VERCEL_PORTABILITY_REPORT_VERSION,
    planId,
    entries
  };
}

function negotiateVercel(port, hints = {}) {
  assertKnownPort(port);
  const require = hints.require ?? {};
  const prefer = hints.prefer ?? {};
  const missing = [];
  let reason = "capability-satisfied";

  if (require.region && require.region !== "local" && !SUPPORTED_REGIONS.has(require.region)) {
    missing.push("supported-region");
    reason = `unsupported Vercel region ${require.region}`;
  }
  if (port === "database" && require.native) {
    missing.push("native-database");
    reason = "database is integration-backed through Neon, not native Vercel";
  }
  if (port === "objectStore" && require.s3Compatible) {
    missing.push("s3-compatible-api");
    reason = "Vercel Blob does not expose the full S3-compatible API";
  }

  return {
    requireSatisfied: missing.length === 0,
    preferHonored: Object.keys(prefer),
    ...(missing.length > 0 ? { missing, reason } : undefined)
  };
}

function resolveProviderOptions(optionBlocks) {
  const merged = {};
  const dropped = [];
  for (const block of optionBlocks) {
    if (block.providerId !== PROVIDER_ID) {
      dropped.push({
        providerId: block.providerId,
        port: block.port,
        optionName: block.optionName,
        reason: `option block belongs to unresolved provider ${block.providerId}`
      });
      continue;
    }
    merged[block.port] = structuredClone(block);
  }

  return { merged, dropped };
}

function createCapabilities() {
  return [
    {
      port: "compute",
      resourceClasses: ["web-ssr", "serverless-function", "edge-function"],
      fidelity: "camp",
      conformance: { tags: ["local", "camp"] }
    },
    {
      port: "objectStore",
      resourceClasses: ["vercel-blob"],
      fidelity: "camp",
      conformance: { tags: ["local", "camp"] }
    },
    {
      port: "database",
      resourceClasses: ["neon-postgres"],
      fidelity: "camp",
      integrationBacked: true,
      marketplaceProvider: "neon",
      conformance: { tags: ["local", "camp"] }
    },
    {
      port: "kv",
      resourceClasses: ["upstash-kv", "vercel-edge-config"],
      fidelity: "camp",
      integrationBacked: true,
      marketplaceProvider: "upstash"
    }
  ];
}

function createCapabilityManifest() {
  return {
    apiVersion: PROVIDER_VERCEL_VERSION,
    provider: PROVIDER_ID,
    auth: {
      mode: "brokered-oidc",
      staticKeysAllowed: false
    },
    iacAdapters: ["vercel-cli", "terraform:vercel"],
    claimedCapabilities: [...CLAIMED_SEED_CAPABILITIES],
    capabilities: createCapabilities().map((capability) => structuredClone(capability))
  };
}

function createDefaultDefinitions() {
  return [
    {
      id: "vercel.compute.web-ssr",
      source: "provider-default",
      provider: PROVIDER_ID,
      port: "compute",
      resourceClass: "web-ssr",
      driver: "vercel-cli:project",
      satisfies: ["web", "ssr", "nodejs"]
    },
    {
      id: "vercel.compute.edge-function",
      source: "provider-default",
      provider: PROVIDER_ID,
      port: "compute",
      resourceClass: "edge-function",
      driver: "vercel-cli:function",
      satisfies: ["function", "edge", "http"]
    },
    {
      id: "vercel.compute.serverless-function",
      source: "provider-default",
      provider: PROVIDER_ID,
      port: "compute",
      resourceClass: "serverless-function",
      driver: "vercel-cli:function",
      satisfies: ["function", "serverless", "http"]
    },
    {
      id: "vercel.objectStore.blob",
      source: "provider-default",
      provider: PROVIDER_ID,
      port: "objectStore",
      resourceClass: "vercel-blob",
      driver: "terraform:vercel_blob_store",
      satisfies: ["blob", "durable"]
    },
    {
      id: "vercel.database.neon-postgres",
      source: "provider-default",
      provider: PROVIDER_ID,
      port: "database",
      resourceClass: "neon-postgres",
      driver: "marketplace:neon",
      satisfies: ["postgres", "managed"],
      integrationBacked: true
    },
    {
      id: "vercel.kv.upstash",
      source: "provider-default",
      provider: PROVIDER_ID,
      port: "kv",
      resourceClass: "upstash-kv",
      driver: "marketplace:upstash",
      satisfies: ["kv", "managed"],
      integrationBacked: true
    }
  ];
}

function createClient(port, outputs) {
  const base = {
    port,
    providerId: PROVIDER_ID,
    ping: () => `${port}:ok`,
    describe: () => structuredClone(outputs)
  };

  if (port === "database") {
    return {
      ...base,
      connectionString: outputs.outputs?.connectionString ?? outputs.connectionString,
      integrationBacked: true,
      marketplaceProvider: "neon"
    };
  }
  if (port === "kv") {
    return {
      ...base,
      integrationBacked: true,
      marketplaceProvider: "upstash"
    };
  }
  return base;
}

function outputsFor(capability, id) {
  if (capability === "compute") {
    return { url: `https://${id}.vercel.app`, deploymentId: `dpl_${id}` };
  }
  if (capability === "objectStore") {
    return { endpoint: `vercel-blob://${id}`, storeId: id };
  }
  if (capability === "database") {
    return { connectionString: `postgres://neon/${id}` };
  }
  if (capability === "kv") {
    return { restUrl: `https://upstash.example/${id}` };
  }
  throw new Error(`unsupported capability ${capability}`);
}

function optionBlock(fields) {
  return {
    providerId: PROVIDER_ID,
    ...structuredClone(fields)
  };
}

function mergeResource(base, override = {}) {
  return {
    ...base,
    ...override,
    request: override.request ?? base.request,
    binds: override.binds ?? base.binds
  };
}

function validateRegions(regions) {
  for (const region of regions) {
    if (!SUPPORTED_REGIONS.has(region)) {
      throw new Error(`unsupported Vercel region ${region}`);
    }
  }
}

function assertClaimedCapability(capability) {
  if (!CLAIMED_SEED_CAPABILITIES.includes(capability)) {
    throw new Error(`provider does not claim ${capability}`);
  }
}

function assertKnownPort(port) {
  if (!["compute", "objectStore", "database", "kv"].includes(port)) {
    throw new Error(`provider does not declare port ${port}`);
  }
}
