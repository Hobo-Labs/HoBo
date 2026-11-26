import {
  BUILD_SPEC_VERSION,
  IAC_PROGRAM_VERSION,
  REALIZE_EMISSION_VERSION,
  outputPlaceholder,
  validateEmission
} from "../../hobo-realize-emission-contract/src/realize-emission-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


export const AWS_PROVIDER_ID = "@hobo/provider-aws";
export const AWS_PROVIDER_VERSION = "hobo.provider-aws/v1";
export const AWS_PROVIDER_TARGET = "aws";
export const IAC_PULUMI_DRIVER = "@hobo/iac-pulumi";

const CAPABILITY_DEFINITIONS = [
  {
    port: "database",
    service: "RDS/Aurora",
    resourceClass: "aws:rds-aurora-postgres",
    className: "postgres",
    features: ["postgres", "managed", "ha"],
    outputs: ["connectionString", "endpoint", "arn", "secretRef"],
    defaultId: "aws.default.database.rds-aurora",
    costSku: "aws.rds.aurora-postgres.acu-hour",
    costUnit: "ACU-hour"
  },
  {
    port: "objectStore",
    service: "S3",
    resourceClass: "aws:s3-bucket",
    className: "bucket",
    features: ["durable", "versioned"],
    outputs: ["bucketName", "bucketArn", "endpoint"],
    defaultId: "aws.default.objectStore.s3",
    costSku: "aws.s3.standard.gb-month",
    costUnit: "GB-month"
  },
  {
    port: "compute",
    service: "Fargate/App Runner",
    resourceClass: "aws:fargate-service",
    alternateResourceClasses: ["aws:apprunner-service"],
    className: "container",
    features: ["container", "http"],
    outputs: ["url", "serviceArn"],
    defaultId: "aws.default.compute.fargate",
    costSku: "aws.fargate.vcpu-hour",
    costUnit: "vCPU-hour"
  },
  {
    port: "queue",
    service: "SQS",
    resourceClass: "aws:sqs-queue",
    className: "standard",
    features: ["durable", "fifo"],
    outputs: ["queueUrl", "queueArn"],
    defaultId: "aws.default.queue.sqs",
    costSku: "aws.sqs.request",
    costUnit: "request"
  },
  {
    port: "cache",
    service: "ElastiCache",
    resourceClass: "aws:elasticache-redis",
    className: "redis",
    features: ["redis", "managed"],
    outputs: ["endpoint", "arn"],
    defaultId: "aws.default.cache.elasticache",
    costSku: "aws.elasticache.node-hour",
    costUnit: "node-hour"
  }
];

const CAPABILITY_BY_PORT = new Map(CAPABILITY_DEFINITIONS.map((definition) => [definition.port, definition]));
const RESOURCE_CLASS_BY_BUILDER = new Map([
  ["rds", "aws:rds-aurora-postgres"],
  ["s3", "aws:s3-bucket"],
  ["fargate", "aws:fargate-service"],
  ["appRunner", "aws:apprunner-service"],
  ["sqs", "aws:sqs-queue"],
  ["elasticache", "aws:elasticache-redis"]
]);

export const aws = {
  with: {
    appRunner(options = {}) {
      return optionBlock("compute", "appRunner", { cpu: 1, memoryMb: 2048 }, options);
    },
    elasticache(options = {}) {
      return optionBlock("cache", "elasticache", { engine: "redis", nodeType: "cache.t4g.micro" }, options);
    },
    fargate(options = {}) {
      return optionBlock("compute", "fargate", { cpu: 1, memoryMb: 2048 }, options);
    },
    rds(options = {}) {
      return optionBlock("database", "rds", { engine: "postgres", instanceClass: "db.t4g.micro" }, options);
    },
    s3(options = {}) {
      return optionBlock("objectStore", "s3", { encryption: "aws:kms", versioning: false }, options);
    },
    sqs(options = {}) {
      return optionBlock("queue", "sqs", { fifo: false, visibilityTimeoutSeconds: 30 }, options);
    }
  }
};

export function createAwsProvider(options = {}) {
  const regions = options.regions ?? ["us-east-1", "us-west-2", "eu-west-1"];
  const serviceMatrix = normalizeServiceMatrix(options.serviceMatrix, regions);
  const provisioned = new Map();
  let nextId = 1;

  return {
    id: AWS_PROVIDER_ID,
    apiVersion: AWS_PROVIDER_VERSION,
    target: AWS_PROVIDER_TARGET,
    capabilities: createCapabilities(serviceMatrix, regions),
    manifest: {
      claimedCapabilities: CAPABILITY_DEFINITIONS.map((definition) => definition.port)
    },
    with: aws.with,
    registerDefaultDefinitions(registry) {
      registry.push(...createDefaultDefinitions(regions));
      return registry;
    },
    capabilityManifest() {
      return createCapabilityManifest(regions, serviceMatrix);
    },
    realize(plan) {
      return realizeAwsPlan(this, plan);
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
      return createAwsClient(capability, resource.outputs ?? resource);
    },
    negotiate(capability, hints = {}) {
      const definition = requireCapability(capability);
      const requested = normalizeHintValues(hints.require);
      const missing = [...requested].filter((feature) => !definition.features.includes(feature));
      return {
        capability,
        provider: AWS_PROVIDER_ID,
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

export function createAwsMultiCloudShopPlan(options = {}) {
  const region = options.region ?? "us-east-1";
  const resourceOptions = options.resourceOptions ?? {};

  return {
    id: options.id ?? "multi-cloud-shop-aws",
    context: {
      app: "multi-cloud-shop",
      env: options.env ?? "preview",
      envType: options.envType ?? "ephemeral",
      provider: AWS_PROVIDER_ID,
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
          options: resourceOptions["orders-db"] ?? [aws.with.rds({ engine: "postgres", storageGb: 50 })]
        },
        {
          id: "assets",
          type: "objectStore",
          className: "bucket",
          require: ["durable"],
          region,
          options: resourceOptions.assets ?? [aws.with.s3({ versioning: true })]
        },
        {
          id: "jobs",
          type: "queue",
          className: "standard",
          require: ["durable"],
          region,
          options: resourceOptions.jobs ?? [aws.with.sqs()]
        },
        {
          id: "session-cache",
          type: "cache",
          className: "redis",
          require: ["redis", "managed"],
          region,
          options: resourceOptions["session-cache"] ?? [aws.with.elasticache()]
        },
        {
          id: "web",
          type: "compute",
          className: "container",
          require: ["container"],
          region,
          options: resourceOptions.web ?? [aws.with.fargate()],
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

export function mergeAwsResolvedOptions(_provider, optionBlocks = []) {
  const merged = new Map();
  const dropped = [];

  for (const block of optionBlocks ?? []) {
    if (!block) continue;
    if (block.providerId !== AWS_PROVIDER_TARGET) {
      dropped.push(block);
      continue;
    }
    const capability = requireCapability(block.port);
    const prior = merged.get(block.port) ?? {
      providerId: AWS_PROVIDER_TARGET,
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

export function evaluateAwsPlan(provider, plan) {
  const serviceMatrix = manifestServiceMatrix(provider);

  for (const rawResource of plan.resources ?? []) {
    const resource = normalizeResource(rawResource, plan);
    const definition = requireCapability(resource.type);
    const resolved = mergeAwsResolvedOptions(provider, resource.options).merged[resource.type];
    const unavailable = availabilityError(resource, definition, serviceMatrix, resolved?.resourceClass ?? definition.resourceClass);
    if (unavailable) return unavailable;

    const missing = (resource.require ?? []).filter((feature) => !definition.features.includes(feature));
    if (missing.length > 0) {
      return planRejected("aws-capability-require-unsatisfied", resource.id, {
        message: `${AWS_PROVIDER_ID} cannot satisfy ${resource.type} require facts: ${missing.join(", ")}`,
        missing,
        require: resource.require,
        provider: AWS_PROVIDER_ID,
        capability: resource.type
      });
    }
  }

  return {
    type: "deployment.Planned",
    provider: AWS_PROVIDER_ID,
    planId: plan.id,
    region: plan.context?.region ?? plan.region ?? "us-east-1"
  };
}

export function realizeAwsPlan(provider, plan) {
  const evaluation = evaluateAwsPlan(provider, plan);
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
    provider: AWS_PROVIDER_ID,
    planId: plan.id,
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

export function simulateAwsApply(provider, plan, options = {}) {
  const evaluation = evaluateAwsPlan(provider, plan);
  if (evaluation.type === "deployment.PlanRejected") return evaluation;

  const quota = options.quota ?? {};
  for (const resource of plan.resources ?? []) {
    if (quota[resource.type] === 0) {
      return planRejected("aws-quota-exhausted", resource.id, {
        message: `${AWS_PROVIDER_ID} quota exhausted for ${resource.type} before applying ${resource.id}`,
        quota: resource.type,
        provider: AWS_PROVIDER_ID
      });
    }
  }

  return {
    type: "deployment.Applied",
    provider: AWS_PROVIDER_ID,
    planId: plan.id,
    resources: plan.resources?.map((resource) => resource.id) ?? []
  };
}

function optionBlock(port, builder, defaults, options, negotiation = "prefer") {
  return {
    providerId: AWS_PROVIDER_TARGET,
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
    resourceClasses: resourceClassesFor(definition),
    resourceClassesByRegion: availableResourceClassesByRegion(definition, serviceMatrix, defaultRegions),
    features: definition.features,
    regions: availableRegionsFor(definition, serviceMatrix, defaultRegions),
    conformance: { tags: ["local", "camp"] },
    driver: IAC_PULUMI_DRIVER
  }));
}

function createCapabilityManifest(regions, serviceMatrix) {
  return {
    apiVersion: AWS_PROVIDER_VERSION,
    provider: AWS_PROVIDER_ID,
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
  return CAPABILITY_DEFINITIONS.flatMap((definition) => [{
    id: definition.defaultId,
    provider: AWS_PROVIDER_ID,
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
  }, ...defaultAlternatesFor(definition, regions)]);
}

function createIacNode(resource) {
  const definition = requireCapability(resource.type);
  const resolved = mergeAwsResolvedOptions(null, resource.options).merged[resource.type];
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
    region: resource.region ?? plan.context?.region ?? plan.region ?? "us-east-1",
    require: resource.require ?? [],
    options: resource.options ?? []
  };
}

function availabilityError(resource, definition, serviceMatrix, resourceClass) {
  if (serviceMatrix[resource.region]?.includes(resourceClass)) return null;

  return planRejected("aws-region-service-unavailable", resource.id, {
    message: `${definition.service} is not available in ${resource.region} for ${resource.id}`,
    provider: AWS_PROVIDER_ID,
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

  const allResourceClasses = CAPABILITY_DEFINITIONS.flatMap(resourceClassesFor);
  return Object.fromEntries(defaultRegions.map((region) => [region, allResourceClasses]));
}

function availableRegionsFor(definition, serviceMatrix, defaultRegions) {
  return defaultRegions.filter((region) =>
    resourceClassesFor(definition).some((resourceClass) => serviceMatrix[region]?.includes(resourceClass))
  );
}

function availableResourceClassesByRegion(definition, serviceMatrix, defaultRegions) {
  return Object.fromEntries(defaultRegions.map((region) => [
    region,
    resourceClassesFor(definition).filter((resourceClass) => serviceMatrix[region]?.includes(resourceClass))
  ]));
}

function resourceClassesFor(definition) {
  return [definition.resourceClass, ...(definition.alternateResourceClasses ?? [])];
}

function defaultAlternatesFor(definition, regions) {
  if (definition.port !== "compute") return [];
  return [{
    id: "aws.default.compute.apprunner",
    provider: AWS_PROVIDER_ID,
    port: definition.port,
    resourceClass: "aws:apprunner-service",
    className: "container",
    source: "provider-default",
    driver: IAC_PULUMI_DRIVER,
    satisfies: definition.features,
    equivalence: {
      providerService: "App Runner",
      features: definition.features
    },
    regions
  }];
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
  if (!definition) throw new Error(`${AWS_PROVIDER_ID} does not implement port ${port}`);
  return definition;
}

function fakeOutputsFor(definition, id, region) {
  if (definition.port === "database") {
    return {
      connectionString: `postgres://aws/${region}/${id}`,
      endpoint: `${id}.${region}.rds.amazonaws.com`,
      arn: `arn:aws:rds:${region}:123456789012:cluster:${id}`,
      secretRef: `secret://${id}/database`
    };
  }
  if (definition.port === "objectStore") {
    return {
      bucketName: id,
      bucketArn: `arn:aws:s3:::${id}`,
      endpoint: `https://${id}.s3.${region}.amazonaws.com`
    };
  }
  if (definition.port === "compute") {
    return {
      url: `https://${id}.${region}.example.aws`,
      serviceArn: `arn:aws:ecs:${region}:123456789012:service/${id}`
    };
  }
  if (definition.port === "queue") {
    return {
      queueUrl: `https://sqs.${region}.amazonaws.com/123456789012/${id}`,
      queueArn: `arn:aws:sqs:${region}:123456789012:${id}`
    };
  }
  return {
    endpoint: `${id}.${region}.cache.amazonaws.com`,
    arn: `arn:aws:elasticache:${region}:123456789012:cluster:${id}`
  };
}

function createAwsClient(port, outputs) {
  requireCapability(port);
  const base = {
    port,
    providerId: AWS_PROVIDER_ID,
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
      connectionString: outputs.connectionString ?? outputs.endpoint,
      async query() {
        return { rows: [] };
      }
    };
  }
  if (port === "objectStore") {
    return {
      ...base,
      bucketName: outputs.bucketName,
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
      queueUrl: outputs.queueUrl,
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
    provider: AWS_PROVIDER_ID,
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
    objectStore: "bucketName",
    compute: "url",
    queue: "queueUrl",
    cache: "endpoint"
  }[port];
}

function envNameFor(resourceId, output) {
  if (resourceId === "orders-db") return "ORDERS_DB_CONNECTION";
  if (resourceId === "assets") return "ASSETS_BUCKET";
  if (resourceId === "jobs") return "JOBS_QUEUE_URL";
  if (resourceId === "session-cache") return "SESSION_CACHE_ENDPOINT";
  return `${resourceId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_${output.toUpperCase()}`;
}
