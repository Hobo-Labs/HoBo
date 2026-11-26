import {
  BUILD_SPEC_VERSION,
  IAC_PROGRAM_VERSION,
  REALIZE_EMISSION_VERSION,
  outputPlaceholder,
  validateEmission
} from "../../hobo-realize-emission-contract/src/realize-emission-contract.js";
import { isJsonObject } from "./json.js";


export const KUBERNETES_PROVIDER_ID = "@hobo/provider-kubernetes";
export const KUBERNETES_PROVIDER_VERSION = "hobo.provider-kubernetes/v1";
export const KUBERNETES_PROVIDER_TARGET = "kubernetes";
export const IAC_CROSSPLANE_DRIVER = "@hobo/iac-crossplane";

const SEED_CAPABILITIES = ["compute", "database", "cache"];
const DEFAULT_CRDS = [
  "v1/Namespace",
  "apps/v1/Deployment",
  "v1/Service",
  "networking.k8s.io/v1/Ingress",
  "acid.zalan.do/v1/Postgresql",
  "redis.redis.opstreelabs.in/v1beta2/Redis",
  "wasmcloud.dev/v1/Host"
];

const DEFINITIONS = [
  {
    port: "compute",
    service: "Kubernetes Deployment",
    resourceClass: "k8s:deployment",
    className: "container",
    features: ["container", "http", "namespace-isolated"],
    outputs: ["url", "serviceName", "workloadRef"],
    defaultId: "k8s.default.compute.deployment",
    requiredCrds: ["apps/v1/Deployment"],
    costSku: "k8s.compute.pod-millicore-hour",
    costUnit: "millicore-hour"
  },
  {
    port: "networking",
    service: "Kubernetes Service",
    resourceClass: "k8s:service",
    className: "service",
    features: ["cluster-dns", "service-discovery"],
    outputs: ["serviceName", "clusterDns"],
    defaultId: "k8s.default.networking.service",
    requiredCrds: ["v1/Service"],
    costSku: "k8s.networking.service-hour",
    costUnit: "service-hour"
  },
  {
    port: "networking",
    service: "Kubernetes Ingress",
    resourceClass: "k8s:ingress",
    className: "ingress",
    features: ["http", "tls-termination"],
    outputs: ["host", "url"],
    defaultId: "k8s.default.networking.ingress",
    requiredCrds: ["networking.k8s.io/v1/Ingress"],
    costSku: "k8s.networking.ingress-hour",
    costUnit: "ingress-hour"
  },
  {
    port: "componentHost",
    service: "wasmCloud Operator",
    resourceClass: "k8s:wasmcloud-operator",
    className: "wasmcloud",
    features: ["wasmcloud", "wrpc", "nats-lattice"],
    outputs: ["hostRef", "lattice"],
    defaultId: "k8s.default.component-host.wasmcloud",
    requiredCrds: ["wasmcloud.dev/v1/Host"],
    costSku: "k8s.wasmcloud.host-hour",
    costUnit: "host-hour"
  },
  {
    port: "database",
    service: "In-cluster Postgres",
    resourceClass: "k8s:postgres-statefulset",
    className: "postgres",
    features: ["postgres", "managed"],
    outputs: ["connectionString", "serviceName", "secretRef"],
    defaultId: "k8s.default.database.postgres",
    requiredCrds: ["acid.zalan.do/v1/Postgresql"],
    costSku: "k8s.postgres.pod-hour",
    costUnit: "pod-hour"
  },
  {
    port: "cache",
    service: "In-cluster Redis",
    resourceClass: "k8s:redis-statefulset",
    className: "redis",
    features: ["redis", "managed"],
    outputs: ["endpoint", "serviceName"],
    defaultId: "k8s.default.cache.redis",
    requiredCrds: ["redis.redis.opstreelabs.in/v1beta2/Redis"],
    costSku: "k8s.redis.pod-hour",
    costUnit: "pod-hour"
  },
  {
    port: "namespace",
    service: "Kubernetes Namespace",
    resourceClass: "k8s:namespace",
    className: "namespace",
    features: ["rbac-boundary", "tenant-isolation"],
    outputs: ["namespace"],
    defaultId: "k8s.default.namespace",
    requiredCrds: ["v1/Namespace"],
    costSku: "k8s.namespace",
    costUnit: "namespace"
  }
];

const DEFINITIONS_BY_CLASS = new Map(DEFINITIONS.map((definition) => [definition.resourceClass, definition]));
const SEED_DEFINITION_BY_PORT = new Map(DEFINITIONS.filter((definition) => SEED_CAPABILITIES.includes(definition.port)).map((definition) => [definition.port, definition]));
const RESOURCE_CLASS_BY_BUILDER = new Map([
  ["deployment", "k8s:deployment"],
  ["service", "k8s:service"],
  ["ingress", "k8s:ingress"],
  ["wasmCloudHost", "k8s:wasmcloud-operator"],
  ["postgres", "k8s:postgres-statefulset"],
  ["redis", "k8s:redis-statefulset"],
  ["namespace", "k8s:namespace"]
]);

export const kubernetes = {
  with: {
    deployment(options = {}) {
      return optionBlock("compute", "deployment", { replicas: 1, runtimeClassName: "runc", cpuMillicores: 500, memoryMiB: 512 }, options);
    },
    ingress(options = {}) {
      return optionBlock("networking", "ingress", { className: "nginx", tls: true }, options);
    },
    namespace(options = {}) {
      return optionBlock("namespace", "namespace", { enforceRbac: true, networkPolicy: "deny-by-default" }, options);
    },
    postgres(options = {}) {
      return optionBlock("database", "postgres", { storageGb: 10, operator: "zalando-postgres" }, options);
    },
    redis(options = {}) {
      return optionBlock("cache", "redis", { memoryMiB: 256, operator: "opstree-redis" }, options);
    },
    service(options = {}) {
      return optionBlock("networking", "service", { type: "ClusterIP", port: 80 }, options);
    },
    wasmCloudHost(options = {}) {
      return optionBlock("componentHost", "wasmCloudHost", { replicas: 1, nats: "helm-bundled" }, options);
    }
  }
};

export function createKubernetesProvider(options = {}) {
  const cluster = normalizeCluster(options.cluster);
  const resources = new Map();
  let nextId = 1;

  return {
    id: KUBERNETES_PROVIDER_ID,
    apiVersion: KUBERNETES_PROVIDER_VERSION,
    target: KUBERNETES_PROVIDER_TARGET,
    capabilities: createCapabilities(cluster),
    manifest: {
      claimedCapabilities: [...SEED_CAPABILITIES]
    },
    with: kubernetes.with,
    registerDefaultDefinitions(registry) {
      registry.push(...createDefaultDefinitions());
      return registry;
    },
    capabilityManifest() {
      return createCapabilityManifest(cluster);
    },
    realize(plan) {
      return realizeKubernetesPlan(this, plan);
    },
    provision(capability, plan = {}) {
      const definition = requireSeedCapability(capability);
      const id = `${capability}-${nextId++}`;
      const resource = {
        id,
        capability,
        plan,
        outputs: fakeOutputsFor(definition, id, plan.namespace ?? "local")
      };
      resources.set(id, resource);
      return resource;
    },
    client(capability, resource = {}) {
      requireSeedCapability(capability);
      return createKubernetesClient(capability, resource.outputs ?? resource);
    },
    negotiate(capability, hints = {}) {
      const definition = requireSeedCapability(capability);
      const required = normalizeHintValues(hints.require);
      const missing = [...required].filter((feature) => feature !== "region" && !definition.features.includes(feature) && feature !== "local");
      return {
        capability,
        provider: KUBERNETES_PROVIDER_ID,
        requireSatisfied: missing.length === 0,
        missing,
        preferHonored: hints.prefer?.durability ? ["durability"] : normalizePreferHints(hints.prefer, definition)
      };
    },
    injectDrift(id) {
      const resource = resources.get(id);
      if (resource) resource.drifted = true;
    },
    refresh(id) {
      const resource = resources.get(id);
      return {
        id,
        exists: Boolean(resource),
        drift: Boolean(resource?.drifted),
        drifted: Boolean(resource?.drifted)
      };
    },
    destroy(id) {
      resources.delete(id);
    },
    hasResource(id) {
      return resources.has(id);
    },
    campEvidence(capability) {
      requireSeedCapability(capability);
      return normalizeCampEvidence(options.campEvidence, capability);
    },
    cluster
  };
}

export function createKubernetesClusterFixturePlan(options = {}) {
  const namespace = options.namespace ?? "preview-a";
  const tenant = options.tenant ?? "tenant-a";
  const resourceOptions = options.resourceOptions ?? {};

  return {
    id: options.id ?? "kubernetes-cluster-fixture",
    context: {
      app: "kubernetes-provider-fixture",
      env: options.env ?? "preview",
      envType: options.envType ?? "ephemeral",
      provider: KUBERNETES_PROVIDER_ID,
      namespace,
      tenant
    },
    resources: options.resources ?? [
      {
        id: "app-namespace",
        type: "namespace",
        className: "namespace",
        namespace,
        tenant,
        options: resourceOptions["app-namespace"] ?? [kubernetes.with.namespace()]
      },
      {
        id: "orders-db",
        type: "database",
        className: "postgres",
        namespace,
        tenant,
        options: resourceOptions["orders-db"] ?? [kubernetes.with.postgres({ storageGb: 20 })]
      },
      {
        id: "session-cache",
        type: "cache",
        className: "redis",
        namespace,
        tenant,
        options: resourceOptions["session-cache"] ?? [kubernetes.with.redis({ memoryMiB: 512 })]
      },
      {
        id: "web",
        type: "compute",
        className: "container",
        namespace,
        tenant,
        options: resourceOptions.web ?? [kubernetes.with.deployment()],
        build: {
          artifactId: "web-image",
          source: "examples/kubernetes-provider-fixture/web",
          target: "wasm-component"
        },
        binds: [
          { import: "wasi:sql/query", providerResourceId: "orders-db", capability: "database" },
          { import: "hobo:cache/redis", providerResourceId: "session-cache", capability: "cache" },
          { import: "hobo:runtime/component-host", providerResourceId: "wasmcloud-host", capability: "componentHost" }
        ]
      },
      {
        id: "web-service",
        type: "networking",
        className: "service",
        namespace,
        tenant,
        targetResourceId: "web",
        options: resourceOptions["web-service"] ?? [kubernetes.with.service()]
      },
      {
        id: "web-ingress",
        type: "networking",
        className: "ingress",
        namespace,
        tenant,
        targetResourceId: "web-service",
        options: resourceOptions["web-ingress"] ?? [kubernetes.with.ingress({ host: `${namespace}.apps.example.test` })]
      },
      {
        id: "wasmcloud-host",
        type: "componentHost",
        className: "wasmcloud",
        namespace,
        tenant,
        options: resourceOptions["wasmcloud-host"] ?? [kubernetes.with.wasmCloudHost({ lattice: namespace })]
      }
    ]
  };
}

export function mergeKubernetesResolvedOptions(_provider, optionBlocks = []) {
  const merged = new Map();
  const dropped = [];

  for (const block of optionBlocks ?? []) {
    if (!block) continue;
    if (block.providerId !== KUBERNETES_PROVIDER_TARGET) {
      dropped.push(block);
      continue;
    }
    const resourceClass = RESOURCE_CLASS_BY_BUILDER.get(block.optionName);
    const definition = requireDefinition(resourceClass);
    const prior = merged.get(block.port) ?? {
      providerId: KUBERNETES_PROVIDER_TARGET,
      port: block.port,
      resourceClass: definition.resourceClass,
      optionName: block.optionName,
      options: {}
    };
    merged.set(block.port, {
      ...prior,
      resourceClass: definition.resourceClass,
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

export function evaluateKubernetesPlan(provider, plan) {
  const cluster = provider.cluster ?? normalizeCluster();

  for (const resource of plan.resources ?? []) {
    const normalized = normalizeResource(resource, plan);
    const existingNamespace = cluster.namespaces[normalized.namespace];
    if (existingNamespace?.tenant && existingNamespace.tenant !== normalized.tenant) {
      return planRejected("k8s-namespace-rbac-boundary", normalized.id, {
        message: `namespace ${normalized.namespace} already belongs to ${existingNamespace.tenant}; refusing ${normalized.tenant}`,
        namespace: normalized.namespace,
        existingTenant: existingNamespace.tenant,
        requestedTenant: normalized.tenant
      });
    }

    const definition = definitionForResource(normalized);
    const missingCrds = definition.requiredCrds.filter((crd) => !cluster.installedCrds.includes(crd));
    if (missingCrds.length > 0) {
      return planRejected("k8s-required-crd-missing", normalized.id, {
        message: `${definition.service} requires missing CRDs: ${missingCrds.join(", ")}`,
        missingCrds,
        resourceClass: definition.resourceClass
      });
    }

    const missing = (normalized.require ?? []).filter((feature) => !definition.features.includes(feature));
    if (missing.length > 0) {
      return planRejected("k8s-capability-require-unsatisfied", normalized.id, {
        message: `${KUBERNETES_PROVIDER_ID} cannot satisfy ${normalized.type} require facts: ${missing.join(", ")}`,
        missing,
        require: normalized.require,
        provider: KUBERNETES_PROVIDER_ID,
        capability: normalized.type
      });
    }
  }

  return {
    type: "deployment.Planned",
    provider: KUBERNETES_PROVIDER_ID,
    planId: plan.id,
    namespace: plan.context?.namespace
  };
}

export function realizeKubernetesPlan(provider, plan) {
  const evaluation = evaluateKubernetesPlan(provider, plan);
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
    const node = createIacNode(resource, plan);
    nodes.push(node);

    if (resource.targetResourceId) {
      edges.push({ from: resource.targetResourceId, to: resource.id, reason: "kubernetes-target" });
    }

    if (resource.type === "compute" && resource.build?.artifactId) {
      buildArtifacts.push({
        id: resource.build.artifactId,
        source: resource.build.source ?? `services/${resource.id}`,
        target: resource.build.target ?? "wasm-component",
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
    provider: KUBERNETES_PROVIDER_ID,
    planId: plan.id,
    portabilityReport: {
      apiVersion: "hobo.portabilityReport/v1",
      planId: plan.id,
      entries: [],
      zeroSecretExceptions: []
    },
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
  if (!validation.ok) throw new Error(validation.errors.join("; "));
  return emission;
}

export function simulateKubernetesApply(provider, plan, options = {}) {
  const evaluation = evaluateKubernetesPlan(provider, plan);
  if (evaluation.type === "deployment.PlanRejected") return evaluation;

  const resources = (plan.resources ?? []).map((resource) => normalizeResource(resource, plan));
  for (const resource of resources) {
    const required = resourceCapacity(resource);
    const capacity = options.capacity;
    if (capacity && (required.cpuMillicores > capacity.cpuMillicores || required.memoryMiB > capacity.memoryMiB)) {
      return planRejected("k8s-cluster-capacity-exhausted", resource.id, {
        message: `cluster capacity cannot schedule ${resource.id}`,
        required,
        capacity
      });
    }
  }

  for (const resource of resources) {
    if (options.clusterDrift?.[resource.id]) {
      return planRejected("k8s-crossplane-drift-detected", resource.id, {
        message: `Crossplane observed drift for ${resource.id}; reconcile before apply`,
        resourceId: resource.id
      });
    }
  }

  return {
    type: "deployment.Applied",
    provider: KUBERNETES_PROVIDER_ID,
    planId: plan.id,
    resources: resources.map((resource) => resource.id)
  };
}

function optionBlock(port, builder, defaults, options, negotiation = "prefer") {
  return {
    providerId: KUBERNETES_PROVIDER_TARGET,
    port,
    optionName: builder,
    negotiation,
    options: {
      ...defaults,
      ...options
    }
  };
}

function createCapabilities(cluster) {
  return DEFINITIONS.filter((definition) => SEED_CAPABILITIES.includes(definition.port)).map((definition) => ({
    port: definition.port,
    service: definition.service,
    resourceClass: definition.resourceClass,
    resourceClasses: [definition.resourceClass],
    features: definition.features,
    regions: ["local", cluster.name],
    conformance: { tags: ["local", "camp"] },
    driver: IAC_CROSSPLANE_DRIVER
  }));
}

function createCapabilityManifest(cluster) {
  return {
    apiVersion: KUBERNETES_PROVIDER_VERSION,
    provider: KUBERNETES_PROVIDER_ID,
    claimedCapabilities: [...SEED_CAPABILITIES],
    auth: {
      mode: "svid-federation",
      tokenBroker: "identity.RequestToken",
      staticSecrets: false
    },
    regions: ["local", cluster.name],
    runtimeHosts: [
      {
        kind: "wasmcloud-operator",
        resourceClass: "k8s:wasmcloud-operator",
        wrpc: true,
        nats: "helm-bundled"
      }
    ],
    networking: {
      serviceDiscovery: "kubernetes-service-dns",
      ingress: "networking.k8s.io/v1/Ingress",
      isolation: "namespace-rbac-network-policy"
    },
    capabilities: DEFINITIONS.filter((definition) => definition.port !== "namespace").map((definition) => ({
      port: definition.port,
      service: definition.service,
      resourceClass: definition.resourceClass,
      resourceClasses: [definition.resourceClass],
      features: definition.features,
      regions: ["local", cluster.name],
      conformance: SEED_CAPABILITIES.includes(definition.port) ? { tags: ["local", "camp"] } : { tags: ["local"] },
      driver: IAC_CROSSPLANE_DRIVER
    })),
    cost: {
      currency: "USD",
      source: "cost.json",
      facts: DEFINITIONS.map((definition) => ({
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

function createDefaultDefinitions() {
  return DEFINITIONS.filter((definition) => definition.port !== "namespace").map((definition) => ({
    id: definition.defaultId,
    provider: KUBERNETES_PROVIDER_ID,
    port: definition.port,
    resourceClass: definition.resourceClass,
    className: definition.className,
    source: "provider-default",
    driver: IAC_CROSSPLANE_DRIVER,
    satisfies: definition.features,
    equivalence: {
      providerService: definition.service,
      features: definition.features
    },
    regions: ["local", "kind", "k3d"]
  }));
}

function createIacNode(resource, plan) {
  const definition = definitionForResource(resource);
  const resolved = mergeKubernetesResolvedOptions(null, resource.options).merged[resource.type];
  const options = {
    namespace: resource.namespace,
    ...resolved?.options
  };
  if (resource.id === "wasmcloud-host" && !("lattice" in options)) {
    options.lattice = plan.context?.namespace ?? resource.namespace;
  }

  return {
    id: resource.id,
    type: resource.type,
    className: resource.className,
    resourceClass: resolved?.resourceClass ?? definition.resourceClass,
    driverIntent: {
      capability: resource.type,
      operation: resource.type === "networking" ? "route" : "create",
      iacProvider: IAC_CROSSPLANE_DRIVER
    },
    inputs: {
      namespace: resource.namespace,
      name: `${resource.id}-${resource.namespace}`,
      options,
      labels: {
        hoboPlan: resource.planId,
        hoboResource: resource.id,
        hoboTenant: resource.tenant
      }
    },
    outputs: definition.outputs
  };
}

function normalizeResource(resource, plan) {
  const definition = definitionForResource(resource);
  return {
    ...resource,
    planId: plan.id,
    className: resource.className ?? definition.className,
    namespace: resource.namespace ?? plan.context?.namespace ?? "default",
    tenant: resource.tenant ?? plan.context?.tenant ?? "tenant-a",
    require: resource.require ?? [],
    options: resource.options ?? []
  };
}

function definitionForResource(resource) {
  const resolved = mergeKubernetesResolvedOptions(null, resource.options).merged[resource.type];
  if (resolved?.resourceClass) return requireDefinition(resolved.resourceClass);

  if (resource.type === "networking" && resource.className === "ingress") return requireDefinition("k8s:ingress");
  if (resource.type === "networking") return requireDefinition("k8s:service");
  if (resource.type === "componentHost") return requireDefinition("k8s:wasmcloud-operator");
  if (resource.type === "namespace") return requireDefinition("k8s:namespace");
  return requireSeedCapability(resource.type);
}

function normalizeCluster(cluster = {}) {
  return {
    name: cluster.name ?? "kind-local",
    installedCrds: cluster.installedCrds ?? [...DEFAULT_CRDS],
    namespaces: cluster.namespaces ?? {}
  };
}

function requireSeedCapability(port) {
  const definition = SEED_DEFINITION_BY_PORT.get(port);
  if (!definition) throw new Error(`${KUBERNETES_PROVIDER_ID} does not implement seed port ${port}`);
  return definition;
}

function requireDefinition(resourceClass) {
  const definition = DEFINITIONS_BY_CLASS.get(resourceClass);
  if (!definition) throw new Error(`${KUBERNETES_PROVIDER_ID} does not define ${resourceClass}`);
  return definition;
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
  return new Set(Object.values(value).concat(Object.keys(value)));
}

function normalizePreferHints(value, definition) {
  if (Array.isArray(value)) return value.filter((feature) => definition.features.includes(feature));
  if (!value || !isJsonObject(value)) return [];
  return Object.keys(value);
}

function resourceCapacity(resource) {
  if (resource.type !== "compute" && resource.type !== "componentHost") {
    return { cpuMillicores: 0, memoryMiB: 0 };
  }
  const options = mergeKubernetesResolvedOptions(null, resource.options).merged[resource.type]?.options ?? {};
  return {
    cpuMillicores: options.cpuMillicores ?? 500,
    memoryMiB: options.memoryMiB ?? 512
  };
}

function fakeOutputsFor(definition, id, namespace) {
  if (definition.port === "compute") {
    return {
      url: `http://${id}.${namespace}.svc.cluster.local`,
      serviceName: id,
      workloadRef: `deployment/${namespace}/${id}`
    };
  }
  if (definition.port === "database") {
    return {
      connectionString: `postgres://k8s/${namespace}/${id}`,
      serviceName: `${id}.${namespace}.svc.cluster.local`,
      secretRef: `secret://${namespace}/${id}/database`
    };
  }
  return {
    endpoint: `redis://${id}.${namespace}.svc.cluster.local:6379`,
    serviceName: `${id}.${namespace}.svc.cluster.local`
  };
}

function createKubernetesClient(port, outputs) {
  const base = {
    port,
    providerId: KUBERNETES_PROVIDER_ID,
    ping() {
      return `${port}:ok`;
    },
    describe() {
      return outputs;
    }
  };
  if (port === "compute") {
    return { ...base, url: outputs.url, serviceName: outputs.serviceName };
  }
  if (port === "database") {
    return {
      ...base,
      connectionString: outputs.connectionString ?? outputs.endpoint,
      async query() {
        return { rows: [] };
      }
    };
  }
  return { ...base, endpoint: outputs.endpoint };
}

function planRejected(code, resourceId, reason) {
  return {
    type: "deployment.PlanRejected",
    provider: KUBERNETES_PROVIDER_ID,
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
    cache: "endpoint",
    componentHost: "hostRef",
    compute: "url",
    networking: "url",
    namespace: "namespace"
  }[port];
}

function envNameFor(resourceId, output) {
  if (resourceId === "orders-db") return "ORDERS_DB_CONNECTION";
  if (resourceId === "session-cache") return "SESSION_CACHE_ENDPOINT";
  if (resourceId === "wasmcloud-host") return "WASMCLOUD_HOST_REF";
  return `${resourceId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_${output.toUpperCase()}`;
}
