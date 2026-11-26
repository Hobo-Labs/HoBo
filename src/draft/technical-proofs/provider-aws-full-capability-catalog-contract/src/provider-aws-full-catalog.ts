import {
  BUILD_SPEC_VERSION,
  IAC_PROGRAM_VERSION,
  REALIZE_EMISSION_VERSION,
  outputPlaceholder,
  validateEmission
} from "../../hobo-realize-emission-contract/src/realize-emission-contract.js";
import {
  hoboVerify,
  runProviderCapabilitySuites
} from "../../provider-capability-conformance-suites/src/provider-capability-conformance.js";
import { isJsonString, isJsonObject } from "./json.js";


export const AWS_PROVIDER_ID = "@hobo/provider-aws";
export const AWS_PROVIDER_VERSION = "hobo.provider-aws/v1";
export const AWS_PROVIDER_TARGET = "aws";
export const IAC_PULUMI_DRIVER = "@hobo/iac-pulumi";

export const AWS_FULL_CATALOG_PORTS = Object.freeze([
  "web/service",
  "kv",
  "bucket",
  "queue",
  "topic",
  "sql",
  "secret"
]);

const PORT_DEFINITIONS = [
  {
    port: "web/service",
    seedPort: "compute",
    service: "Fargate/App Runner",
    resourceClass: "aws:fargate-service",
    alternateResourceClasses: ["aws:apprunner-service"],
    className: "container",
    features: ["container", "http"],
    outputs: ["url", "serviceArn"],
    defaultId: "aws.default.web-service.fargate",
    costSku: "aws.fargate.vcpu-hour",
    costUnit: "vCPU-hour",
    witPort: "wasi:http/incoming-handler"
  },
  {
    port: "kv",
    seedPort: "cache",
    service: "DynamoDB",
    resourceClass: "aws:dynamodb-table",
    alternateResourceClasses: ["aws:elasticache-redis"],
    className: "keyvalue",
    features: ["get", "set", "delete"],
    outputs: ["tableName", "tableArn", "endpoint"],
    defaultId: "aws.default.kv.dynamodb",
    costSku: "aws.dynamodb.rcu-hour",
    costUnit: "RCU-hour",
    witPort: "wasi:keyvalue/store"
  },
  {
    port: "bucket",
    seedPort: "objectStore",
    service: "S3",
    resourceClass: "aws:s3-bucket",
    className: "bucket",
    features: ["read", "write", "delete", "durable"],
    outputs: ["bucketName", "bucketArn", "endpoint"],
    defaultId: "aws.default.bucket.s3",
    costSku: "aws.s3.standard.gb-month",
    costUnit: "GB-month",
    witPort: "wasi:blobstore/blobstore"
  },
  {
    port: "queue",
    seedPort: "queue",
    service: "SQS",
    resourceClass: "aws:sqs-queue",
    className: "standard",
    features: ["durable", "fifo"],
    outputs: ["queueUrl", "queueArn"],
    defaultId: "aws.default.queue.sqs",
    costSku: "aws.sqs.request",
    costUnit: "request",
    witPort: "wasi:messaging/queue"
  },
  {
    port: "topic",
    seedPort: "topic",
    service: "SNS",
    resourceClass: "aws:sns-topic",
    className: "topic",
    features: ["publish", "subscribe"],
    outputs: ["topicArn", "topicName"],
    defaultId: "aws.default.topic.sns",
    costSku: "aws.sns.publish",
    costUnit: "publish",
    witPort: "wasi:messaging/publish-subscribe"
  },
  {
    port: "sql",
    seedPort: "database",
    service: "RDS/Aurora",
    resourceClass: "aws:rds-aurora-postgres",
    className: "postgres",
    features: ["postgres", "managed", "ha"],
    outputs: ["connectionString", "endpoint", "arn", "secretRef"],
    defaultId: "aws.default.sql.rds-aurora",
    costSku: "aws.rds.aurora-postgres.acu-hour",
    costUnit: "ACU-hour",
    witPort: "wasi:sql/database"
  },
  {
    port: "secret",
    seedPort: "secret",
    service: "Secrets Manager",
    resourceClass: "aws:secretsmanager-secret",
    className: "secret",
    features: ["put", "access"],
    outputs: ["secretArn", "secretName"],
    defaultId: "aws.default.secret.secretsmanager",
    costSku: "aws.secretsmanager.secret-month",
    costUnit: "secret-month",
    witPort: "hobo:secrets/store"
  }
];

const PORT_BY_NAME = new Map(PORT_DEFINITIONS.map((definition) => [definition.port, definition]));
const RESOURCE_CLASS_BY_BUILDER = new Map([
  ["rds", "aws:rds-aurora-postgres"],
  ["s3", "aws:s3-bucket"],
  ["fargate", "aws:fargate-service"],
  ["appRunner", "aws:apprunner-service"],
  ["sqs", "aws:sqs-queue"],
  ["sns", "aws:sns-topic"],
  ["dynamodb", "aws:dynamodb-table"],
  ["elasticache", "aws:elasticache-redis"],
  ["secretsmanager", "aws:secretsmanager-secret"]
]);

export const awsFull = {
  with: {
    appRunner(options = {}) {
      return optionBlock("web/service", "appRunner", { cpu: 1, memoryMb: 2048 }, options);
    },
    dynamodb(options = {}) {
      return optionBlock("kv", "dynamodb", { billingMode: "PAY_PER_REQUEST" }, options);
    },
    elasticache(options = {}) {
      return optionBlock("kv", "elasticache", { engine: "redis", nodeType: "cache.t4g.micro" }, options);
    },
    fargate(options = {}) {
      return optionBlock("web/service", "fargate", { cpu: 1, memoryMb: 2048 }, options);
    },
    rds(options = {}) {
      return optionBlock("sql", "rds", { engine: "postgres", instanceClass: "db.t4g.micro" }, options);
    },
    s3(options = {}) {
      return optionBlock("bucket", "s3", { encryption: "aws:kms", versioning: false }, options);
    },
    secretsmanager(options = {}) {
      return optionBlock("secret", "secretsmanager", { rotation: false }, options);
    },
    sns(options = {}) {
      return optionBlock("topic", "sns", { fifo: false }, options);
    },
    sqs(options = {}) {
      return optionBlock("queue", "sqs", { fifo: false, visibilityTimeoutSeconds: 30 }, options);
    }
  }
};

export function createAwsFullCatalogProvider(options = {}) {
  const regions = options.regions ?? ["us-east-1", "us-west-2", "eu-west-1"];
  const serviceMatrix = normalizeServiceMatrix(options.serviceMatrix, regions);
  const provisioned = new Map();
  let nextId = 1;

  const provider = {
    id: AWS_PROVIDER_ID,
    apiVersion: AWS_PROVIDER_VERSION,
    target: AWS_PROVIDER_TARGET,
    catalogPorts: [...AWS_FULL_CATALOG_PORTS],
    capabilities: createCapabilities(serviceMatrix, regions),
    manifest: {
      claimedCapabilities: [...AWS_FULL_CATALOG_PORTS]
    },
    with: awsFull.with,
    registerDefaultDefinitions(registry) {
      registry.push(...createDefaultDefinitions(regions));
      return registry;
    },
    capabilityManifest() {
      return createCapabilityManifest(regions, serviceMatrix);
    },
    publishAuthJson() {
      return createAuthJson(regions);
    },
    publishManifestBundle() {
      return publishAwsManifestBundle(provider);
    },
    realize(plan) {
      return realizeAwsFullCatalogPlan(provider, plan);
    },
    provision(port, plan = {}) {
      const definition = requirePort(port);
      const region = plan.region ?? plan.require?.region ?? regions[0];
      assertServiceAvailable(definition, region, serviceMatrix);

      const id = `${port}-${nextId++}`;
      const resource = {
        id,
        port,
        region,
        plan,
        outputs: fakeOutputsFor(definition, id, region)
      };
      provisioned.set(id, resource);
      return resource;
    },
    client(port, resource = {}) {
      return createAwsClient(port, resource.outputs ?? resource);
    },
    negotiate(port, hints = {}) {
      const definition = requirePort(port);
      const requested = normalizeHintValues(hints.require);
      const missing = [...requested].filter((feature) => !definition.features.includes(feature));
      return {
        port,
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
    campEvidence(port) {
      requirePort(port);
      return normalizeCampEvidence(options.campEvidence, port);
    }
  };

  return provider;
}

export function createAwsFullCatalogShopPlan(options = {}) {
  const region = options.region ?? "us-east-1";
  const resourceOptions = options.resourceOptions ?? {};

  return {
    id: options.id ?? "multi-cloud-shop-aws-full",
    context: {
      app: "multi-cloud-shop",
      env: options.env ?? "preview",
      envType: "ephemeral",
      provider: AWS_PROVIDER_ID,
      region
    },
    resources:
      options.resources ??
      [
        {
          id: "orders-db",
          type: "sql",
          className: "postgres",
          require: ["postgres", "managed", "ha"],
          region,
          options: resourceOptions["orders-db"] ?? [awsFull.with.rds({ engine: "postgres", storageGb: 50 })]
        },
        {
          id: "assets",
          type: "bucket",
          className: "bucket",
          require: ["durable", "read", "write"],
          region,
          options: resourceOptions.assets ?? [awsFull.with.s3({ versioning: true })]
        },
        {
          id: "jobs",
          type: "queue",
          className: "standard",
          require: ["durable"],
          region,
          options: resourceOptions.jobs ?? [awsFull.with.sqs()]
        },
        {
          id: "events",
          type: "topic",
          className: "topic",
          require: ["publish"],
          region,
          options: resourceOptions.events ?? [awsFull.with.sns()]
        },
        {
          id: "sessions",
          type: "kv",
          className: "keyvalue",
          require: ["get", "set"],
          region,
          options: resourceOptions.sessions ?? [awsFull.with.dynamodb()]
        },
        {
          id: "app-secrets",
          type: "secret",
          className: "secret",
          require: ["access"],
          region,
          options: resourceOptions["app-secrets"] ?? [awsFull.with.secretsmanager()]
        },
        {
          id: "web",
          type: "web/service",
          className: "container",
          require: ["container"],
          region,
          options: resourceOptions.web ?? [awsFull.with.fargate()],
          build: {
            artifactId: "web-image",
            source: "examples/multi-cloud-shop/web",
            target: "container"
          },
          binds: [
            { import: "wasi:sql/database", providerResourceId: "orders-db", port: "sql" },
            { import: "wasi:blobstore/blobstore", providerResourceId: "assets", port: "bucket" },
            { import: "wasi:messaging/queue", providerResourceId: "jobs", port: "queue" },
            { import: "wasi:messaging/publish-subscribe", providerResourceId: "events", port: "topic" },
            { import: "wasi:keyvalue/store", providerResourceId: "sessions", port: "kv" },
            { import: "hobo:secrets/store", providerResourceId: "app-secrets", port: "secret" }
          ]
        }
      ]
  };
}

export function mergeAwsFullResolvedOptions(_provider, optionBlocks = []) {
  const merged = new Map();
  const dropped = [];

  for (const block of optionBlocks ?? []) {
    if (!block) continue;
    if (block.providerId !== AWS_PROVIDER_TARGET) {
      dropped.push(block);
      continue;
    }
    const definition = requirePort(block.port);
    const prior = merged.get(block.port) ?? {
      providerId: AWS_PROVIDER_TARGET,
      port: block.port,
      resourceClass: definition.resourceClass,
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

export function evaluateAwsFullCatalogPlan(provider, plan) {
  const serviceMatrix = manifestServiceMatrix(provider);

  for (const rawResource of plan.resources ?? []) {
    const resource = normalizeResource(rawResource, plan);
    const definition = requirePort(resource.type);
    const resolved = mergeAwsFullResolvedOptions(provider, resource.options).merged[resource.type];
    const unavailable = availabilityError(resource, definition, serviceMatrix, resolved?.resourceClass ?? definition.resourceClass);
    if (unavailable) return unavailable;

    const missing = (resource.require ?? []).filter((feature) => !definition.features.includes(feature));
    if (missing.length > 0) {
      return planRejected("aws-capability-require-unsatisfied", resource.id, {
        message: `${AWS_PROVIDER_ID} cannot satisfy ${resource.type} require facts: ${missing.join(", ")}`,
        missing,
        require: resource.require,
        provider: AWS_PROVIDER_ID,
        port: resource.type
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

export function realizeAwsFullCatalogPlan(provider, plan) {
  const evaluation = evaluateAwsFullCatalogPlan(provider, plan);
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

    if (resource.type === "web/service" && resource.build?.artifactId) {
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
        port: bind.port ?? producer.type
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

export function publishAwsManifestBundle(provider) {
  const manifest = provider.capabilityManifest();
  return {
    "index.json": {
      apiVersion: "hobo.capability-manifest/v1",
      provider: AWS_PROVIDER_ID,
      version: AWS_PROVIDER_VERSION,
      issuer: AWS_PROVIDER_ID,
      links: {
        capabilities: "capabilities.json",
        auth: "auth.json",
        cost: "cost.json"
      },
      signature: "fixture:unsigned-draft-poc"
    },
    "capabilities.json": {
      provider: AWS_PROVIDER_ID,
      ports: manifest.capabilities.map((capability) => ({
        port: capability.port,
        service: capability.service,
        resourceClass: capability.resourceClass,
        features: capability.features,
        regions: capability.regions
      })),
      equivalence: manifest.equivalence
    },
    "auth.json": createAuthJson(manifest.regions ?? []),
    "cost.json": manifest.cost
  };
}

export function ingestAwsCapabilityManifest(registry, bundle) {
  const required = ["index.json", "capabilities.json", "auth.json", "cost.json"];
  const missing = required.filter((file) => !bundle[file]);
  if (missing.length > 0) {
    return {
      ok: false,
      provider: AWS_PROVIDER_ID,
      reasons: missing.map((file) => `manifest.missing:${file}`)
    };
  }

  const auth = bundle["auth.json"];
  if (auth.staticSecrets === true) {
    return {
      ok: false,
      provider: AWS_PROVIDER_ID,
      reasons: ["auth.staticSecrets.forbidden"]
    };
  }

  const hasOidcFederation = (auth.flows ?? []).some((flow) => flow.type === "oidc-federation");
  if (!hasOidcFederation) {
    return {
      ok: false,
      provider: AWS_PROVIDER_ID,
      reasons: ["auth.oidc-federation.required"]
    };
  }

  const broker = auth.brokerTargets?.bucket;
  if (!broker || broker.flow !== "oidc-federation") {
    return {
      ok: false,
      provider: AWS_PROVIDER_ID,
      reasons: ["auth.broker.bucket.oidc-federation.required"]
    };
  }

  const entry = {
    provider: AWS_PROVIDER_ID,
    version: bundle["index.json"].version,
    claimedPorts: bundle["capabilities.json"].ports.map((port) => port.port),
    equivalence: bundle["capabilities.json"].equivalence,
    authMode: "brokered-oidc",
    brokeredAuthOnly: true,
    ingestedAt: new Date().toISOString()
  };
  registry.set(AWS_PROVIDER_ID, entry);

  return {
    ok: true,
    provider: AWS_PROVIDER_ID,
    entry,
    includes: ["capabilities", "auth.json", "cost.json", "regions", "conformance"]
  };
}

export function simulateBrokeredKeylessApply(provider, plan, options = {}) {
  const evaluation = evaluateAwsFullCatalogPlan(provider, plan);
  if (evaluation.type === "deployment.PlanRejected") return evaluation;

  const authJson = provider.publishAuthJson();
  const bucketBroker = authJson.brokerTargets?.bucket;
  if (!bucketBroker || bucketBroker.flow !== "oidc-federation") {
    return planRejected("aws-broker-missing-oidc", "assets", {
      message: "S3 broker requires oidc-federation auth flow",
      provider: AWS_PROVIDER_ID
    });
  }

  if (authJson.flows.some((flow) => flow.type === "api-key")) {
    return planRejected("aws-broker-static-secret", "assets", {
      message: "brokered apply rejects api-key-only manifests",
      provider: AWS_PROVIDER_ID
    });
  }

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
    auth: {
      mode: "brokered-oidc",
      flow: "oidc-federation",
      staticSecrets: false,
      brokerTarget: "bucket",
      auditEvents: authJson.audit.events
    },
    resources: plan.resources?.map((resource) => resource.id) ?? []
  };
}

export function conformanceAdapter(provider) {
  const catalogPortBySeed = new Map(PORT_DEFINITIONS.map((definition) => [definition.seedPort, definition.port]));

  const resolveCatalogPort = (capability) =>
    catalogPortBySeed.get(capability) ?? capability;

  return {
    ...provider,
    manifest: {
      claimedCapabilities: [...new Set(PORT_DEFINITIONS.map((definition) => definition.seedPort))]
    },
    provision(capability, plan) {
      return provider.provision(resolveCatalogPort(capability), plan);
    },
    client(capability, resource) {
      const client = provider.client(resolveCatalogPort(capability), resource);
      return {
        ...client,
        ping() {
          return `${capability}:ok`;
        }
      };
    },
    negotiate(capability, hints) {
      return provider.negotiate(resolveCatalogPort(capability), hints);
    },
    campEvidence(capability) {
      return provider.campEvidence(resolveCatalogPort(capability));
    }
  };
}

export function runAwsFullCatalogConformance(provider, {
  tags = ["local", "camp"]
} = {}) {
  const adapter = conformanceAdapter(provider);
  const seedCapabilities = [...new Set(PORT_DEFINITIONS.map((definition) => definition.seedPort))];
  const seedReport = runProviderCapabilitySuites(adapter, {
    capabilities: seedCapabilities.filter((port) => port !== "topic" && port !== "secret"),
    tags
  });
  const extensionFailures = runExtendedPortChecks(provider, tags);
  const failures = [...seedReport.failures, ...extensionFailures];

  return {
    status: failures.length === 0 ? "pass" : "fail",
    failures,
    checks: seedReport.checks,
    coverage: seedReport.coverage
  };
}

export function verifyAwsFullCatalog(provider, options = {}) {
  const run = runAwsFullCatalogConformance(provider, options);
  const verify = hoboVerify(conformanceAdapter(provider), {
    capabilities: ["database", "objectStore", "compute", "queue", "cache"],
    runTags: options.tags ?? ["local", "camp"],
    claimProdReady: options.claimProdReady ?? true
  });

  return {
    status: run.status === "pass" && verify.status === "pass" ? "pass" : "fail",
    catalog: run,
    seedVerify: verify
  };
}

function runExtendedPortChecks(provider, tags) {
  const failures = [];
  if (!tags.includes("local")) return failures;

  for (const port of ["topic", "secret"]) {
    const definition = requirePort(port);
    const resource = provider.provision(port, { region: "us-east-1" });
    const client = provider.client(port, resource);
    if (!client?.ping?.().includes(port)) {
      failures.push({
        capability: port,
        checkId: `${port}.local.provision-connects`,
        tag: "local",
        message: `${port} client did not connect`
      });
    }
    const negotiation = provider.negotiate(port, { require: definition.features.slice(0, 1) });
    if (!negotiation.requireSatisfied) {
      failures.push({
        capability: port,
        checkId: `${port}.local.honors-require-prefer`,
        tag: "local",
        message: `${port} failed require negotiation`
      });
    }
  }

  return failures;
}

function createAuthJson(regions) {
  return {
    issuer: "https://sts.amazonaws.com",
    flows: [
      {
        type: "oidc-federation",
        audience: "hobo",
        exchange: "sts:AssumeRoleWithWebIdentity",
        trust: {
          oidcDiscovery: "https://yard.example.com/.well-known/openid-configuration"
        }
      }
    ],
    scopeModel: "least-privilege-per-resource",
    resourceIndicators: regions.map((region) => `arn:aws:s3:${region}:*:bucket/*`),
    tokenLifetimeSec: 3600,
    audit: {
      events: ["token.Granted", "token.Used", "token.Revoked"]
    },
    brokerTargets: {
      bucket: {
        flow: "oidc-federation",
        scope: "s3:PutObject,s3:GetObject,s3:ListBucket",
        exchange: "sts:AssumeRoleWithWebIdentity"
      }
    }
  };
}

function createCapabilities(serviceMatrix, defaultRegions) {
  return PORT_DEFINITIONS.map((definition) => ({
    port: definition.port,
    seedPort: definition.seedPort,
    service: definition.service,
    resourceClass: definition.resourceClass,
    resourceClasses: resourceClassesFor(definition),
    resourceClassesByRegion: availableResourceClassesByRegion(definition, serviceMatrix, defaultRegions),
    features: definition.features,
    regions: availableRegionsFor(definition, serviceMatrix, defaultRegions),
    equivalence: {
      providerService: definition.service,
      witPort: definition.witPort,
      features: definition.features
    },
    conformance: { tags: ["local", "camp", "credentialed"] },
    driver: IAC_PULUMI_DRIVER
  }));
}

function createCapabilityManifest(regions, serviceMatrix) {
  const authJson = createAuthJson(regions);
  return {
    apiVersion: AWS_PROVIDER_VERSION,
    provider: AWS_PROVIDER_ID,
    claimedCapabilities: [...AWS_FULL_CATALOG_PORTS],
    auth: {
      mode: "brokered-oidc",
      tokenBroker: "identity.RequestToken",
      staticSecrets: false,
      authJson
    },
    regions,
    capabilities: createCapabilities(serviceMatrix, regions),
    equivalence: Object.fromEntries(
      PORT_DEFINITIONS.map((definition) => [
        definition.port,
        {
          providerService: definition.service,
          resourceClass: definition.resourceClass,
          witPort: definition.witPort,
          features: definition.features
        }
      ])
    ),
    cost: {
      currency: "USD",
      source: "cost.json",
      facts: PORT_DEFINITIONS.map((definition) => ({
        port: definition.port,
        sku: definition.costSku,
        unit: definition.costUnit,
        trust: "declared"
      }))
    },
    conformance: {
      suites: ["@hobo/conformance/provider-capability"],
      tags: ["local", "camp", "credentialed"]
    }
  };
}

function createDefaultDefinitions(regions) {
  return PORT_DEFINITIONS.flatMap((definition) => [{
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
      witPort: definition.witPort,
      features: definition.features
    },
    regions
  }, ...defaultAlternatesFor(definition, regions)]);
}

function createIacNode(resource) {
  const definition = requirePort(resource.type);
  const resolved = mergeAwsFullResolvedOptions(null, resource.options).merged[resource.type];
  const options = resolved?.options ?? {};

  return {
    id: resource.id,
    type: resource.type,
    className: resource.className,
    resourceClass: resolved?.resourceClass ?? definition.resourceClass,
    driverIntent: {
      port: resource.type,
      operation: resource.type === "web/service" ? "deploy" : "create",
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

function normalizeResource(resource, plan) {
  const definition = requirePort(resource.type);
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

  const allResourceClasses = PORT_DEFINITIONS.flatMap(resourceClassesFor);
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
  if (definition.port === "web/service") {
    return [{
      id: "aws.default.web-service.apprunner",
      provider: AWS_PROVIDER_ID,
      port: definition.port,
      resourceClass: "aws:apprunner-service",
      className: "container",
      source: "provider-default",
      driver: IAC_PULUMI_DRIVER,
      satisfies: definition.features,
      equivalence: {
        providerService: "App Runner",
        witPort: definition.witPort,
        features: definition.features
      },
      regions
    }];
  }
  if (definition.port === "kv") {
    return [{
      id: "aws.default.kv.elasticache",
      provider: AWS_PROVIDER_ID,
      port: definition.port,
      resourceClass: "aws:elasticache-redis",
      className: "keyvalue",
      source: "provider-default",
      driver: IAC_PULUMI_DRIVER,
      satisfies: definition.features,
      equivalence: {
        providerService: "ElastiCache",
        witPort: definition.witPort,
        features: definition.features
      },
      regions
    }];
  }
  return [];
}

function normalizeCampEvidence(evidence = "pass", port) {
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
    ...(evidence[port] ?? evidence.default)
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

function requirePort(port) {
  const definition = PORT_BY_NAME.get(port);
  if (!definition) throw new Error(`${AWS_PROVIDER_ID} does not implement port ${port}`);
  return definition;
}

function fakeOutputsFor(definition, id, region) {
  if (definition.port === "sql") {
    return {
      connectionString: `postgres://aws/${region}/${id}`,
      endpoint: `${id}.${region}.rds.amazonaws.com`,
      arn: `arn:aws:rds:${region}:123456789012:cluster:${id}`,
      secretRef: `secret://${id}/database`
    };
  }
  if (definition.port === "bucket") {
    return {
      bucketName: id,
      bucketArn: `arn:aws:s3:::${id}`,
      endpoint: `https://${id}.s3.${region}.amazonaws.com`
    };
  }
  if (definition.port === "web/service") {
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
  if (definition.port === "topic") {
    return {
      topicArn: `arn:aws:sns:${region}:123456789012:${id}`,
      topicName: id
    };
  }
  if (definition.port === "secret") {
    return {
      secretArn: `arn:aws:secretsmanager:${region}:123456789012:secret:${id}`,
      secretName: id
    };
  }
  return {
    tableName: id,
    tableArn: `arn:aws:dynamodb:${region}:123456789012:table/${id}`,
    endpoint: `${id}.${region}.dynamodb.amazonaws.com`
  };
}

function createAwsClient(port, outputs) {
  requirePort(port);
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

  if (port === "sql") {
    return {
      ...base,
      connectionString: outputs.connectionString ?? outputs.endpoint,
      async query() {
        return { rows: [] };
      }
    };
  }
  if (port === "bucket") {
    return {
      ...base,
      bucketName: outputs.bucketName,
      async put() {},
      async get() {
        return undefined;
      }
    };
  }
  if (port === "web/service") {
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
  if (port === "topic") {
    return {
      ...base,
      topicArn: outputs.topicArn,
      async publish() {}
    };
  }
  if (port === "secret") {
    return {
      ...base,
      secretArn: outputs.secretArn,
      async access() {
        return { value: "redacted" };
      }
    };
  }
  return {
    ...base,
    endpoint: outputs.endpoint ?? outputs.tableName,
    async get() {},
    async set() {}
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
    "web/service": "url",
    kv: "endpoint",
    bucket: "bucketName",
    queue: "queueUrl",
    topic: "topicArn",
    sql: "connectionString",
    secret: "secretArn"
  }[port];
}

function envNameFor(resourceId, output) {
  if (resourceId === "orders-db") return "ORDERS_DB_CONNECTION";
  if (resourceId === "assets") return "ASSETS_BUCKET";
  if (resourceId === "jobs") return "JOBS_QUEUE_URL";
  if (resourceId === "events") return "EVENTS_TOPIC_ARN";
  if (resourceId === "sessions") return "SESSIONS_KV_ENDPOINT";
  if (resourceId === "app-secrets") return "APP_SECRETS_ARN";
  return `${resourceId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_${output.toUpperCase()}`;
}
