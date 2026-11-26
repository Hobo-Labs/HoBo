import {
  BUILD_SPEC_VERSION,
  IAC_PROGRAM_VERSION,
  REALIZE_EMISSION_VERSION,
  outputPlaceholder,
  validateEmission
} from "../../hobo-realize-emission-contract/src/realize-emission-contract.js";
import { asJsonObject, cloneAsJson, isJsonNumber, isJsonString, isJsonObject, type JsonValue, type JsonObject, type JsonBag, type StringBag } from "./json.js";


export const CLOUDFLARE_PROVIDER_ID = "@hobo/provider-cloudflare";
export const CLOUDFLARE_PROVIDER_VERSION = "hobo.provider-cloudflare/v1";
export const CLOUDFLARE_PROVIDER_TARGET = "cloudflare";
export const CLOUDFLARE_TERRAFORM_DRIVER = "terraform:cloudflare";
export const CLOUDFLARE_WRANGLER_DRIVER = "wrangler";

export type CloudflareCapabilityPort =
  | "compute"
  | "objectStore"
  | "database"
  | "kv"
  | "queue"
  | "dns";

type OptionValues = JsonBag;
type OutputValues = StringBag;
interface ServiceMatrix {
  [colo: string]: string[];
}
interface ResourceClassByColo {
  [colo: string]: string[];
}
type HintValue = string[] | JsonObject;

interface CapabilityDefinition {
  port: CloudflareCapabilityPort;
  service: string;
  resourceClass: string;
  alternateResourceClasses?: string[];
  className: string;
  features: string[];
  outputs: string[];
  defaultId: string;
  costSku: string;
  costUnit: string;
  drivers: string[];
}

interface CapabilityEquivalence {
  providerService: string;
  features: string[];
  degradation?: string;
}

interface CapabilityDefaultDefinition {
  id: string;
  provider: string;
  port: CloudflareCapabilityPort;
  resourceClass: string;
  className: string;
  source: string;
  driver: string;
  satisfies: string[];
  equivalence: CapabilityEquivalence;
  regions: string[];
}

interface CloudflareOnlyFeature {
  idSuffix: string;
  detail: string;
}

interface CloudflareOptionBlock {
  providerId: string;
  port: CloudflareCapabilityPort;
  optionName: string;
  negotiation: string;
  options: OptionValues;
}

interface MergedOptionEntry {
  providerId: string;
  port: CloudflareCapabilityPort;
  resourceClass: string;
  optionName: string;
  options: OptionValues;
}

interface BuildSpec {
  artifactId: string;
  source?: string;
  target?: string;
  dependsOn?: string[];
}

interface ResourceBind {
  import: string;
  providerResourceId: string;
  capability?: CloudflareCapabilityPort;
}

interface PlanResource {
  id: string;
  type: CloudflareCapabilityPort;
  className?: string;
  require?: string[];
  prefer?: string[];
  colo?: string;
  options?: CloudflareOptionBlock[];
  build?: BuildSpec;
  binds?: ResourceBind[];
  safeRolloutGate?: string;
}

interface ResolvedResource extends PlanResource {
  planId: string;
  className: string;
  colo: string;
  require: string[];
  prefer: string[];
  options: CloudflareOptionBlock[];
}

interface PlanContext {
  app?: string;
  env?: string;
  envType?: string;
  provider?: string;
  colo?: string;
}

interface Plan {
  id: string;
  context?: PlanContext;
  colo?: string;
  resources?: PlanResource[];
}

interface EdgeShopPlanOptions {
  id?: string;
  colo?: string;
  env?: string;
  envType?: string;
  resourceOptions?: { [resourceId: string]: CloudflareOptionBlock[] };
  resources?: PlanResource[];
}

interface CapabilityInfo {
  port: CloudflareCapabilityPort;
  service: string;
  resourceClass: string;
  resourceClasses: string[];
  resourceClassesByColo: ResourceClassByColo;
  features: string[];
  regions: string[];
  conformance: { tags: string[] };
  drivers: string[];
}

interface CapabilityManifest {
  apiVersion: string;
  provider: string;
  claimedCapabilities: CloudflareCapabilityPort[];
  auth: { mode: string; tokenBroker: string; staticSecrets: boolean };
  hostRuntime: { providerNativeWasm: string; componentHost: string; adr: string };
  colos: string[];
  capabilities: CapabilityInfo[];
  cost: {
    currency: string;
    source: string;
    facts: Array<{ port: CloudflareCapabilityPort; sku: string; unit: string; trust: string }>;
  };
  conformance: { suites: string[]; tags: string[] };
}

interface CapabilityManifestSource {
  capabilityManifest(): CapabilityManifest;
}

interface PlanRejectedResult {
  type: "deployment.PlanRejected";
  provider: string;
  resourceId: string;
  reason: JsonBag;
}

interface PostgresPreferWarning {
  code: string;
  resourceId: string;
  message: string;
  provider: string;
  resourceClass: string;
}

interface PlanPlannedResult {
  type: "deployment.Planned";
  provider: string;
  planId: string;
  colo: string;
  warnings: PostgresPreferWarning[];
}

type EvaluationResult = PlanRejectedResult | PlanPlannedResult;

interface AppliedResult {
  type: "deployment.Applied";
  provider: string;
  planId: string;
  resources: string[];
}

type ApplySimulationResult = PlanRejectedResult | AppliedResult;

interface IacEdge {
  from: string;
  to: string;
  reason: string;
}

interface IacLink {
  component: string;
  import: string;
  providerNode: string;
  capability: CloudflareCapabilityPort;
}

interface OutputPlaceholderEntry {
  placeholder: string;
  producerNode: string;
  output: string;
  consumerNode: string;
  inputPath: string;
}

interface BuildArtifact {
  id: string;
  source: string;
  target: string;
  outputKind: string;
  dependsOn: string[];
}

interface IacNode {
  id: string;
  type: CloudflareCapabilityPort;
  className: string;
  resourceClass: string;
  driverIntent: {
    capability: CloudflareCapabilityPort;
    operation: string;
    iacProvider: string;
  };
  inputs: {
    colo: string;
    name: string;
    options: OptionValues;
    metadata: { hoboPlan: string; hoboResource: string };
    bundle?: { $build: string };
    bindings?: StringBag;
  };
  outputs: string[];
}

interface PortabilityReportEntry {
  id: string;
  category: string;
  severity: string;
  resourceId: string;
  provider: string;
  path: string;
  detail: string;
  gateEffect: string;
}

interface PortabilityReport {
  apiVersion: string;
  planId: string;
  entries: PortabilityReportEntry[];
  zeroSecretExceptions: JsonValue[];
}

interface RealizeEmission {
  apiVersion: string;
  provider: string;
  planId: string;
  portabilityReport: PortabilityReport;
  iac: {
    apiVersion: string;
    intent: string;
    context: JsonValue | undefined;
    nodes: IacNode[];
    edges: IacEdge[];
    outputPlaceholders: OutputPlaceholderEntry[];
    links: IacLink[];
  };
  build?: {
    apiVersion: string;
    artifacts: BuildArtifact[];
  };
}

interface CampEvidenceFields {
  realProviderDrift: boolean;
  iam: boolean;
  mtls: boolean;
  quota: boolean;
}

type CampEvidenceOverrides = {
  [K in CloudflareCapabilityPort | "default"]?: Partial<CampEvidenceFields>;
};
type CampEvidenceOption = "pass" | "fail" | CampEvidenceOverrides;

interface NegotiateHints {
  require?: HintValue;
  prefer?: HintValue;
}

interface NegotiateResult {
  capability: CloudflareCapabilityPort;
  provider: string;
  requireSatisfied: boolean;
  missing: string[];
  preferHonored: string[];
}

interface ProvisionPlan {
  colo?: string;
  require?: { region?: string; colo?: string };
}

interface ProvisionedResource {
  id: string;
  capability: CloudflareCapabilityPort;
  colo: string;
  plan: ProvisionPlan;
  outputs: OutputValues;
  drifted?: boolean;
}

interface CloudflareProviderOptions {
  colos?: string[];
  serviceMatrix?: ServiceMatrix;
  campEvidence?: CampEvidenceOption;
}

const WORKER_LIMITS = Object.freeze({
  cpuMs: 30_000,
  scriptSizeMb: 10,
  memoryMb: 128
});

const CAPABILITY_DEFINITIONS: CapabilityDefinition[] = [
  {
    port: "compute",
    service: "Workers",
    resourceClass: "cloudflare:workers-script",
    className: "worker",
    features: ["edge", "worker", "wasm-native", "http"],
    outputs: ["url", "scriptName", "route"],
    defaultId: "cloudflare.default.compute.workers",
    costSku: "cloudflare.workers.request",
    costUnit: "request",
    drivers: [CLOUDFLARE_WRANGLER_DRIVER, CLOUDFLARE_TERRAFORM_DRIVER]
  },
  {
    port: "objectStore",
    service: "R2",
    resourceClass: "cloudflare:r2-bucket",
    className: "bucket",
    features: ["durable", "s3-compatible"],
    outputs: ["bucketName", "endpoint", "jurisdiction"],
    defaultId: "cloudflare.default.objectStore.r2",
    costSku: "cloudflare.r2.storage.gb-month",
    costUnit: "GB-month",
    drivers: [CLOUDFLARE_TERRAFORM_DRIVER]
  },
  {
    port: "database",
    service: "D1",
    resourceClass: "cloudflare:d1-database",
    alternateResourceClasses: ["cloudflare:hyperdrive-postgres"],
    className: "d1",
    features: ["sql", "sqlite", "serverless"],
    outputs: ["databaseId", "bindingName", "connectionString"],
    defaultId: "cloudflare.default.database.d1",
    costSku: "cloudflare.d1.query",
    costUnit: "query",
    drivers: [CLOUDFLARE_TERRAFORM_DRIVER]
  },
  {
    port: "kv",
    service: "KV",
    resourceClass: "cloudflare:kv-namespace",
    className: "namespace",
    features: ["eventual", "edge", "key-value"],
    outputs: ["namespaceId", "bindingName"],
    defaultId: "cloudflare.default.kv.namespace",
    costSku: "cloudflare.kv.read",
    costUnit: "operation",
    drivers: [CLOUDFLARE_TERRAFORM_DRIVER]
  },
  {
    port: "queue",
    service: "Queues",
    resourceClass: "cloudflare:queue",
    className: "queue",
    features: ["durable", "at-least-once"],
    outputs: ["queueName", "producerBinding"],
    defaultId: "cloudflare.default.queue.queues",
    costSku: "cloudflare.queues.message",
    costUnit: "message",
    drivers: [CLOUDFLARE_TERRAFORM_DRIVER]
  },
  {
    port: "dns",
    service: "DNS",
    resourceClass: "cloudflare:dns-record",
    className: "record",
    features: ["authoritative", "safe-rollout-required", "dns-01"],
    outputs: ["zoneId", "recordId", "fqdn"],
    defaultId: "cloudflare.default.dns.record",
    costSku: "cloudflare.dns.zone",
    costUnit: "zone",
    drivers: [CLOUDFLARE_TERRAFORM_DRIVER]
  }
];

const HYPERDRIVE_DEFAULT_DEFINITION: CapabilityDefaultDefinition = Object.freeze({
  id: "cloudflare.default.database.hyperdrive-postgres",
  provider: CLOUDFLARE_PROVIDER_ID,
  port: "database",
  resourceClass: "cloudflare:hyperdrive-postgres",
  className: "postgres",
  source: "provider-default",
  driver: CLOUDFLARE_TERRAFORM_DRIVER,
  satisfies: ["postgres", "managed", "partial"],
  equivalence: {
    providerService: "Hyperdrive + Neon",
    features: ["postgres", "managed", "partial"],
    degradation: "Cloudflare brokers external Postgres; it is not a native strongly consistent managed SQL service."
  },
  regions: ["global"]
});

const CAPABILITY_BY_PORT = new Map(
  CAPABILITY_DEFINITIONS.map((definition): [CloudflareCapabilityPort, CapabilityDefinition] => [definition.port, definition])
);
const RESOURCE_CLASS_BY_BUILDER = new Map([
  ["worker", "cloudflare:workers-script"],
  ["r2", "cloudflare:r2-bucket"],
  ["d1", "cloudflare:d1-database"],
  ["hyperdrivePostgres", "cloudflare:hyperdrive-postgres"],
  ["kv", "cloudflare:kv-namespace"],
  ["queues", "cloudflare:queue"],
  ["dns", "cloudflare:dns-record"]
]);
const CLOUDFLARE_ONLY_FEATURES = new Map<string, CloudflareOnlyFeature>([
  ["worker.smartPlacement", {
    idSuffix: "smartPlacement",
    detail: "Cloudflare Workers Smart Placement requires target provider support."
  }],
  ["r2.s3Compatibility", {
    idSuffix: "r2S3Compatibility",
    detail: "Cloudflare R2 is S3-compatible but not bit-for-bit identical to AWS S3 semantics."
  }],
  ["dns.proxied", {
    idSuffix: "proxiedDns",
    detail: "Cloudflare proxied DNS records couple traffic policy to the Cloudflare edge."
  }]
]);

export const cloudflare = {
  with: {
    worker(options: OptionValues = {}): CloudflareOptionBlock {
      return optionBlock("compute", "worker", {
        compatibilityDate: "2026-01-01",
        cpuMs: 10_000,
        memoryMb: 128,
        scriptSizeMb: 3
      }, options);
    },
    r2(options: OptionValues = {}): CloudflareOptionBlock {
      return optionBlock("objectStore", "r2", {
        jurisdiction: "auto",
        s3Compatibility: "aws-sdk-v3-basic",
        publicAccess: false
      }, options);
    },
    d1(options: OptionValues = {}): CloudflareOptionBlock {
      return optionBlock("database", "d1", {
        migrationsTable: "_cf_d1_migrations",
        readReplication: false
      }, options);
    },
    hyperdrivePostgres(options: OptionValues = {}): CloudflareOptionBlock {
      return optionBlock("database", "hyperdrivePostgres", {
        backingProvider: "neon",
        pooledConnections: true
      }, options);
    },
    kv(options: OptionValues = {}): CloudflareOptionBlock {
      return optionBlock("kv", "kv", {
        ttlSeconds: 0,
        eventualConsistency: true
      }, options);
    },
    queues(options: OptionValues = {}): CloudflareOptionBlock {
      return optionBlock("queue", "queues", {
        delivery: "at-least-once",
        retentionDays: 4
      }, options);
    },
    dns(options: OptionValues = {}): CloudflareOptionBlock {
      return optionBlock("dns", "dns", {
        proxied: false,
        ttl: 300
      }, options);
    }
  }
};

export function createCloudflareProvider(options: CloudflareProviderOptions = {}) {
  const colos = options.colos ?? ["WNAM", "ENAM", "WEUR"];
  const serviceMatrix = normalizeServiceMatrix(options.serviceMatrix, colos);
  const provisioned = new Map<string, ProvisionedResource>();
  let nextId = 1;

  return {
    id: CLOUDFLARE_PROVIDER_ID,
    apiVersion: CLOUDFLARE_PROVIDER_VERSION,
    target: CLOUDFLARE_PROVIDER_TARGET,
    capabilities: createCapabilities(serviceMatrix, colos),
    manifest: {
      claimedCapabilities: CAPABILITY_DEFINITIONS.map((definition) => definition.port)
    },
    with: cloudflare.with,
    registerDefaultDefinitions(registry: CapabilityDefaultDefinition[]): CapabilityDefaultDefinition[] {
      registry.push(...createDefaultDefinitions(colos));
      return registry;
    },
    capabilityManifest(): CapabilityManifest {
      return createCapabilityManifest(colos, serviceMatrix);
    },
    realize(plan: Plan): RealizeEmission {
      return realizeCloudflarePlan(this, plan);
    },
    provision(capability: CloudflareCapabilityPort, plan: ProvisionPlan = {}): ProvisionedResource {
      const definition = requireCapability(capability);
      const colo = plan.colo ?? plan.require?.region ?? plan.require?.colo ?? colos[0];
      assertServiceAvailable(definition, colo, serviceMatrix);

      const id = `${capability}-${nextId++}`;
      const resource: ProvisionedResource = {
        id,
        capability,
        colo,
        plan,
        outputs: fakeOutputsFor(definition, id, colo)
      };
      provisioned.set(id, resource);
      return resource;
    },
    client(capability: CloudflareCapabilityPort, resource: JsonObject = {}) {
      const outputsBag = isJsonObject(resource.outputs) ? resource.outputs : resource;
      const outputs: OutputValues = {};
      for (const [key, value] of Object.entries(outputsBag)) {
        if (isJsonString(value)) outputs[key] = value;
      }
      return createCloudflareClient(capability, outputs);
    },
    negotiate(capability: CloudflareCapabilityPort, hints: NegotiateHints = {}): NegotiateResult {
      const definition = requireCapability(capability);
      const requested = normalizeHintValues(hints.require);
      const missing = [...requested].filter((feature) => !definition.features.includes(feature));
      return {
        capability,
        provider: CLOUDFLARE_PROVIDER_ID,
        requireSatisfied: missing.length === 0,
        missing,
        preferHonored: normalizePreferHints(hints.prefer, definition)
      };
    },
    injectDrift(id: string): void {
      const resource = provisioned.get(id);
      if (resource) resource.drifted = true;
    },
    refresh(id: string) {
      const resource = provisioned.get(id);
      return {
        id,
        exists: Boolean(resource),
        drift: Boolean(resource?.drifted),
        drifted: Boolean(resource?.drifted)
      };
    },
    destroy(id: string): void {
      provisioned.delete(id);
    },
    hasResource(id: string): boolean {
      return provisioned.has(id);
    },
    campEvidence(capability: CloudflareCapabilityPort): CampEvidenceFields {
      requireCapability(capability);
      return normalizeCampEvidence(options.campEvidence, capability);
    },
    verifyKvEvidence({ tags = ["local", "camp"] }: { tags?: string[] } = {}) {
      const evidence = normalizeCampEvidence(options.campEvidence, "kv");
      const localOk = !tags.includes("local") || this.negotiate("kv", {
        require: { region: "local" },
        prefer: { consistency: "eventual" }
      }).requireSatisfied;
      const campOk = !tags.includes("camp") || Boolean(evidence.realProviderDrift && evidence.iam && evidence.mtls && evidence.quota);
      return {
        port: "kv" as const,
        provider: CLOUDFLARE_PROVIDER_ID,
        tags,
        status: localOk && campOk ? "pass" : "fail",
        checks: [
          { id: "kv.local.provision-connects", tag: "local", status: localOk ? "pass" : "fail" },
          { id: "kv.camp.iam-mtls-quota-evidence", tag: "camp", status: campOk ? "pass" : "fail" }
        ].filter((check) => tags.includes(check.tag))
      };
    }
  };
}

export function createCloudflareEdgeShopPlan(options: EdgeShopPlanOptions = {}): Plan {
  const colo = options.colo ?? "WNAM";
  const resourceOptions = options.resourceOptions ?? {};

  return {
    id: options.id ?? "edge-shop-cloudflare",
    context: {
      app: "edge-shop",
      env: options.env ?? "preview",
      envType: options.envType ?? "ephemeral",
      provider: CLOUDFLARE_PROVIDER_ID,
      colo
    },
    resources:
      options.resources ??
      [
        {
          id: "worker",
          type: "compute",
          className: "worker",
          require: ["edge", "worker", "wasm-native"],
          colo,
          options: resourceOptions.worker ?? [cloudflare.with.worker()],
          build: {
            artifactId: "worker-wasm",
            source: "examples/edge-shop/worker",
            target: "wasm-component"
          },
          binds: [
            { import: "wasi:blobstore/blobstore", providerResourceId: "assets", capability: "objectStore" },
            { import: "wasi:sql/query", providerResourceId: "app-db", capability: "database" },
            { import: "hobo:kv/store", providerResourceId: "sessions", capability: "kv" },
            { import: "wasi:messaging/messaging", providerResourceId: "jobs", capability: "queue" },
            { import: "hobo:dns/zone", providerResourceId: "app-domain", capability: "dns" }
          ]
        },
        {
          id: "assets",
          type: "objectStore",
          className: "bucket",
          require: ["durable", "s3-compatible"],
          colo,
          options: resourceOptions.assets ?? [cloudflare.with.r2()]
        },
        {
          id: "app-db",
          type: "database",
          className: "d1",
          require: ["sql", "sqlite"],
          colo,
          options: resourceOptions["app-db"] ?? [cloudflare.with.d1()]
        },
        {
          id: "sessions",
          type: "kv",
          className: "namespace",
          require: ["eventual", "edge"],
          colo,
          options: resourceOptions.sessions ?? [cloudflare.with.kv()]
        },
        {
          id: "jobs",
          type: "queue",
          className: "queue",
          require: ["durable"],
          colo,
          options: resourceOptions.jobs ?? [cloudflare.with.queues()]
        },
        {
          id: "app-domain",
          type: "dns",
          className: "record",
          require: ["authoritative"],
          safeRolloutGate: "domain-validation-gate/adr-0035",
          colo,
          options: resourceOptions["app-domain"] ?? [cloudflare.with.dns()]
        }
      ]
  };
}

export function mergeCloudflareResolvedOptions(_provider: CapabilityManifestSource | null, optionBlocks: CloudflareOptionBlock[] = []) {
  const merged = new Map<string, MergedOptionEntry>();
  const dropped: CloudflareOptionBlock[] = [];

  for (const block of optionBlocks ?? []) {
    if (!block) continue;
    if (block.providerId !== CLOUDFLARE_PROVIDER_TARGET) {
      dropped.push(block);
      continue;
    }
    const capability = requireCapability(block.port);
    const prior = merged.get(block.port) ?? {
      providerId: CLOUDFLARE_PROVIDER_TARGET,
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

export function evaluateCloudflarePlan(provider: CapabilityManifestSource, plan: Plan): EvaluationResult {
  const serviceMatrix = manifestServiceMatrix(provider);
  const warnings: PostgresPreferWarning[] = [];

  for (const rawResource of plan.resources ?? []) {
    const resource = normalizeResource(rawResource, plan);
    const definition = requireCapability(resource.type);
    const resolved = mergeCloudflareResolvedOptions(provider, resource.options).merged[resource.type];
    const resourceClass = resolved?.resourceClass ?? definition.resourceClass;
    const unavailable = availabilityError(resource, definition, serviceMatrix, resourceClass);
    if (unavailable) return unavailable;

    const specialReject = rejectCloudflareSpecificRequirements(resource, resolved);
    if (specialReject) return specialReject;

    const missing = (resource.require ?? []).filter((feature) => !supportedFeaturesFor(definition, resourceClass).includes(feature));
    if (missing.length > 0) {
      return planRejected("cloudflare-capability-require-unsatisfied", resource.id, {
        message: `${CLOUDFLARE_PROVIDER_ID} cannot satisfy ${resource.type} require facts: ${missing.join(", ")}`,
        missing,
        require: resource.require,
        provider: CLOUDFLARE_PROVIDER_ID,
        capability: resource.type
      });
    }

    const degradation = postgresPreferWarning(resource, resolved);
    if (degradation) warnings.push(degradation);
  }

  return {
    type: "deployment.Planned",
    provider: CLOUDFLARE_PROVIDER_ID,
    planId: plan.id,
    colo: plan.context?.colo ?? plan.colo ?? "WNAM",
    warnings
  };
}

export function realizeCloudflarePlan(provider: CapabilityManifestSource, plan: Plan): RealizeEmission {
  const evaluation = evaluateCloudflarePlan(provider, plan);
  if (evaluation.type === "deployment.PlanRejected") {
    throw new Error(`${evaluation.reason.code}: ${evaluation.reason.message}`);
  }

  const resources = new Map((plan.resources ?? []).map((resource): [string, ResolvedResource] => [resource.id, normalizeResource(resource, plan)]));
  const nodes: IacNode[] = [];
  const edges: IacEdge[] = [];
  const links: IacLink[] = [];
  const outputPlaceholders: OutputPlaceholderEntry[] = [];
  const buildArtifacts: BuildArtifact[] = [];

  for (const resource of resources.values()) {
    const node = createIacNode(resource);
    nodes.push(node);

    if (resource.type === "compute" && resource.build?.artifactId) {
      buildArtifacts.push({
        id: resource.build.artifactId,
        source: resource.build.source ?? `services/${resource.id}`,
        target: resource.build.target ?? "wasm-component",
        outputKind: "WorkerBundle",
        dependsOn: resource.build.dependsOn ?? []
      });
      node.inputs.bundle = { $build: resource.build.artifactId };
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
      const inputName = bindingNameFor(producer.id, output);
      node.inputs.bindings ??= {};
      node.inputs.bindings[inputName] = placeholder;
      edges.push({ from: producer.id, to: resource.id, reason: "binding-output" });
      outputPlaceholders.push({
        placeholder,
        producerNode: producer.id,
        output,
        consumerNode: resource.id,
        inputPath: `inputs.bindings.${inputName}`
      });
      links.push({
        component: resource.id,
        import: bind.import,
        providerNode: producer.id,
        capability: bind.capability ?? producer.type
      });
    }
  }

  const emission: RealizeEmission = {
    apiVersion: REALIZE_EMISSION_VERSION,
    provider: CLOUDFLARE_PROVIDER_ID,
    planId: plan.id,
    portabilityReport: createPortabilityReport(plan, evaluation.warnings),
    iac: {
      apiVersion: IAC_PROGRAM_VERSION,
      intent: "driver-agnostic-resource-graph",
      context: plan.context === undefined ? undefined : cloneAsJson(plan.context),
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

interface AccountQuota {
  [port: string]: number;
}

export function simulateCloudflareApply(provider: CapabilityManifestSource, plan: Plan, options: { accountQuota?: AccountQuota } = {}): ApplySimulationResult {
  const evaluation = evaluateCloudflarePlan(provider, plan);
  if (evaluation.type === "deployment.PlanRejected") return evaluation;

  const accountQuota = options.accountQuota ?? {};
  for (const resource of plan.resources ?? []) {
    if (accountQuota[resource.type] === 0) {
      return planRejected("cloudflare-account-quota-exhausted", resource.id, {
        message: `${CLOUDFLARE_PROVIDER_ID} account quota exhausted for ${resource.type} before applying ${resource.id}`,
        quota: resource.type,
        provider: CLOUDFLARE_PROVIDER_ID
      });
    }
  }

  return {
    type: "deployment.Applied",
    provider: CLOUDFLARE_PROVIDER_ID,
    planId: plan.id,
    resources: plan.resources?.map((resource) => resource.id) ?? []
  };
}

function optionBlock(port: CloudflareCapabilityPort, builder: string, defaults: OptionValues, options: OptionValues, negotiation = "prefer"): CloudflareOptionBlock {
  return {
    providerId: CLOUDFLARE_PROVIDER_TARGET,
    port,
    optionName: builder,
    negotiation,
    options: {
      ...defaults,
      ...options
    }
  };
}

function createCapabilities(serviceMatrix: ServiceMatrix, colos: string[]): CapabilityInfo[] {
  return CAPABILITY_DEFINITIONS.map((definition) => ({
    port: definition.port,
    service: definition.service,
    resourceClass: definition.resourceClass,
    resourceClasses: resourceClassesFor(definition),
    resourceClassesByColo: availableResourceClassesByColo(definition, serviceMatrix, colos),
    features: definition.features,
    regions: availableColosFor(definition, serviceMatrix, colos),
    conformance: { tags: ["local", "camp"] },
    drivers: definition.drivers
  }));
}

function createCapabilityManifest(colos: string[], serviceMatrix: ServiceMatrix): CapabilityManifest {
  return {
    apiVersion: CLOUDFLARE_PROVIDER_VERSION,
    provider: CLOUDFLARE_PROVIDER_ID,
    claimedCapabilities: CAPABILITY_DEFINITIONS.map((definition) => definition.port),
    auth: {
      mode: "svid-federation",
      tokenBroker: "identity.RequestToken",
      staticSecrets: false
    },
    hostRuntime: {
      providerNativeWasm: "opt-in",
      componentHost: "scope-out",
      adr: "ADR-0031"
    },
    colos,
    capabilities: createCapabilities(serviceMatrix, colos),
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

function createDefaultDefinitions(colos: string[]): CapabilityDefaultDefinition[] {
  const defaults: CapabilityDefaultDefinition[] = [];
  for (const definition of CAPABILITY_DEFINITIONS) {
    defaults.push({
      id: definition.defaultId,
      provider: CLOUDFLARE_PROVIDER_ID,
      port: definition.port,
      resourceClass: definition.resourceClass,
      className: definition.className,
      source: "provider-default",
      driver: definition.drivers[0],
      satisfies: definition.features,
      equivalence: {
        providerService: definition.service,
        features: definition.features
      },
      regions: colos
    });
    if (definition.port === "database") {
      defaults.push({
        ...HYPERDRIVE_DEFAULT_DEFINITION,
        regions: colos
      });
    }
  }
  return defaults;
}

function createIacNode(resource: ResolvedResource): IacNode {
  const definition = requireCapability(resource.type);
  const resolved = mergeCloudflareResolvedOptions(null, resource.options).merged[resource.type];
  const options = resolved?.options ?? {};
  const resourceClass = resolved?.resourceClass ?? definition.resourceClass;

  return {
    id: resource.id,
    type: resource.type,
    className: resource.className,
    resourceClass,
    driverIntent: {
      capability: resource.type,
      operation: resource.type === "compute" ? "deploy" : "create",
      iacProvider: driverFor(resource.type, resourceClass)
    },
    inputs: {
      colo: resource.colo,
      name: `${resource.id}-${resource.colo}`,
      options,
      metadata: {
        hoboPlan: resource.planId,
        hoboResource: resource.id
      }
    },
    outputs: outputsFor(definition, resourceClass)
  };
}

function normalizeResource(resource: PlanResource, plan: Plan): ResolvedResource {
  const definition = requireCapability(resource.type);
  return {
    ...resource,
    planId: plan.id,
    className: resource.className ?? definition.className,
    colo: resource.colo ?? plan.context?.colo ?? plan.colo ?? "WNAM",
    require: resource.require ?? [],
    prefer: resource.prefer ?? [],
    options: resource.options ?? []
  };
}

function rejectCloudflareSpecificRequirements(resource: ResolvedResource, resolved: MergedOptionEntry | undefined): PlanRejectedResult | null {
  const resourceClass = resolved?.resourceClass;
  if (resource.type === "database" && resource.require.includes("strong-consistency")) {
    return planRejected("cloudflare-d1-strong-consistency-partial", resource.id, {
      message: "D1/Hyperdrive cannot prove strong-consistency SQL semantics for this resource.",
      provider: CLOUDFLARE_PROVIDER_ID,
      capability: resource.type,
      require: resource.require
    });
  }

  if (resource.type === "database" && resource.require.includes("postgres") && resource.require.includes("managed")) {
    return planRejected("cloudflare-postgres-require-partial", resource.id, {
      message: "Cloudflare can only partially satisfy managed Postgres via Hyperdrive plus an external backing store.",
      provider: CLOUDFLARE_PROVIDER_ID,
      capability: resource.type,
      require: resource.require,
      degradedResourceClass: resourceClass ?? "cloudflare:hyperdrive-postgres"
    });
  }

  if (resource.type === "objectStore") {
    const strictS3Facts = resource.require.filter((feature) => feature === "s3-etag-md5" || feature === "s3-read-after-overwrite");
    if (strictS3Facts.length > 0) {
      return planRejected("cloudflare-r2-s3-compat-divergence", resource.id, {
        message: "R2 supports common S3 APIs but cannot claim strict AWS S3 ETag/read-after-overwrite edge semantics.",
        provider: CLOUDFLARE_PROVIDER_ID,
        capability: resource.type,
        missing: strictS3Facts,
        require: resource.require
      });
    }
  }

  if (resource.type === "compute") {
    const options = resolved?.options ?? {};
    const violations: JsonBag = {};
    const cpuMs = options.cpuMs;
    const scriptSizeMb = options.scriptSizeMb;
    const memoryMb = options.memoryMb;
    if (isJsonNumber(cpuMs) && cpuMs > WORKER_LIMITS.cpuMs) violations.cpuMs = cpuMs;
    if (isJsonNumber(scriptSizeMb) && scriptSizeMb > WORKER_LIMITS.scriptSizeMb) violations.scriptSizeMb = scriptSizeMb;
    if (isJsonNumber(memoryMb) && memoryMb > WORKER_LIMITS.memoryMb) violations.memoryMb = memoryMb;
    if (Object.keys(violations).length > 0) {
      return planRejected("cloudflare-worker-limit-exceeded", resource.id, {
        message: "Worker CPU, memory, or bundle size exceeds the Cloudflare edge limit captured by this provider contract.",
        provider: CLOUDFLARE_PROVIDER_ID,
        capability: resource.type,
        violations,
        limits: asJsonObject(WORKER_LIMITS)
      });
    }
  }

  if (resource.type === "dns" && !resource.safeRolloutGate) {
    return planRejected("cloudflare-dns-safe-rollout-required", resource.id, {
      message: "Cloudflare DNS changes require an ADR-0035 safe-rollout gate before realization.",
      provider: CLOUDFLARE_PROVIDER_ID,
      capability: resource.type,
      adr: "ADR-0035"
    });
  }

  return null;
}

function postgresPreferWarning(resource: ResolvedResource, resolved: MergedOptionEntry | undefined): PostgresPreferWarning | null {
  if (resource.type !== "database") return null;
  if (!resource.prefer.includes("postgres") && !resource.prefer.includes("managed")) return null;

  return {
    code: "cloudflare-postgres-prefer-degraded",
    resourceId: resource.id,
    message: "Managed Postgres was requested as a preference and is degraded to Hyperdrive plus Neon.",
    provider: CLOUDFLARE_PROVIDER_ID,
    resourceClass: resolved?.resourceClass ?? "cloudflare:hyperdrive-postgres"
  };
}

function availabilityError(resource: ResolvedResource, definition: CapabilityDefinition, serviceMatrix: ServiceMatrix, resourceClass: string): PlanRejectedResult | null {
  if (serviceMatrix[resource.colo]?.includes(resourceClass)) return null;

  return planRejected("cloudflare-colo-service-unavailable", resource.id, {
    message: `${definition.service} is not available in ${resource.colo} for ${resource.id}`,
    provider: CLOUDFLARE_PROVIDER_ID,
    colo: resource.colo,
    service: definition.service,
    resourceClass
  });
}

function assertServiceAvailable(definition: CapabilityDefinition, colo: string, serviceMatrix: ServiceMatrix): void {
  if (colo === "local") return;
  if (!serviceMatrix[colo]?.includes(definition.resourceClass)) {
    throw new Error(`${definition.service} is not available in ${colo}`);
  }
}

function manifestServiceMatrix(provider: CapabilityManifestSource): ServiceMatrix {
  const manifest = provider.capabilityManifest();
  const matrix: ServiceMatrix = {};
  for (const colo of manifest.colos ?? []) {
    matrix[colo] = [];
  }
  for (const capability of manifest.capabilities ?? []) {
    for (const colo of capability.regions ?? []) {
      matrix[colo] ??= [];
      matrix[colo].push(...(capability.resourceClassesByColo?.[colo] ?? capability.resourceClasses ?? [capability.resourceClass]));
    }
  }
  return matrix;
}

function normalizeServiceMatrix(serviceMatrix: ServiceMatrix | undefined, colos: string[]): ServiceMatrix {
  if (serviceMatrix) return serviceMatrix;

  const allResourceClasses = CAPABILITY_DEFINITIONS.flatMap(resourceClassesFor);
  return Object.fromEntries(colos.map((colo) => [colo, allResourceClasses]));
}

function availableColosFor(definition: CapabilityDefinition, serviceMatrix: ServiceMatrix, colos: string[]): string[] {
  return colos.filter((colo) =>
    resourceClassesFor(definition).some((resourceClass) => serviceMatrix[colo]?.includes(resourceClass))
  );
}

function availableResourceClassesByColo(definition: CapabilityDefinition, serviceMatrix: ServiceMatrix, colos: string[]): ResourceClassByColo {
  return Object.fromEntries(colos.map((colo) => [
    colo,
    resourceClassesFor(definition).filter((resourceClass) => serviceMatrix[colo]?.includes(resourceClass))
  ]));
}

function resourceClassesFor(definition: CapabilityDefinition): string[] {
  return [definition.resourceClass, ...(definition.alternateResourceClasses ?? [])];
}

function supportedFeaturesFor(definition: CapabilityDefinition, resourceClass: string): string[] {
  if (resourceClass === "cloudflare:hyperdrive-postgres") {
    return ["postgres", "managed", "partial"];
  }
  return definition.features;
}

function driverFor(port: CloudflareCapabilityPort, resourceClass: string): string {
  if (port === "compute" && resourceClass === "cloudflare:workers-script") {
    return CLOUDFLARE_WRANGLER_DRIVER;
  }
  return CLOUDFLARE_TERRAFORM_DRIVER;
}

function outputsFor(definition: CapabilityDefinition, resourceClass: string): string[] {
  if (resourceClass === "cloudflare:hyperdrive-postgres") {
    return ["connectionString", "hyperdriveId", "secretRef"];
  }
  return definition.outputs;
}

function createPortabilityReport(plan: Plan, warnings: PostgresPreferWarning[] = []): PortabilityReport {
  return {
    apiVersion: "hobo.portabilityReport/v1",
    planId: plan.id,
    entries: [
      ...collectProviderOptionEntries(plan),
      ...warnings.map((warning) => ({
        id: `${warning.resourceId}.cloudflare.postgres.degraded`,
        category: "degradation",
        severity: "prefer-degraded",
        resourceId: warning.resourceId,
        provider: CLOUDFLARE_PROVIDER_TARGET,
        path: `resources.${warning.resourceId}.database.postgres`,
        detail: warning.message,
        gateEffect: "require-would-reject"
      }))
    ],
    zeroSecretExceptions: []
  };
}

function collectProviderOptionEntries(plan: Plan): PortabilityReportEntry[] {
  const entries: PortabilityReportEntry[] = [];
  for (const resource of plan.resources ?? []) {
    for (const block of resource.options ?? []) {
      if (block?.providerId !== CLOUDFLARE_PROVIDER_TARGET) continue;
      for (const key of Object.keys(block.options ?? {})) {
        const marker = `${block.optionName}.${key}`;
        const feature = CLOUDFLARE_ONLY_FEATURES.get(marker);
        if (!feature) continue;
        entries.push({
          id: `${resource.id}.provider-option.cloudflare.${feature.idSuffix}`,
          category: "provider-option",
          severity: "target-scoped",
          resourceId: resource.id,
          provider: CLOUDFLARE_PROVIDER_TARGET,
          path: `resources.${resource.id}.with.cloudflare.${key}`,
          detail: feature.detail,
          gateEffect: "target-provider-must-satisfy"
        });
      }
    }
  }
  return entries;
}

function normalizeCampEvidence(evidence: CampEvidenceOption = "pass", capability: CloudflareCapabilityPort): CampEvidenceFields {
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

function normalizeHintValues(value: HintValue | undefined): Set<string> {
  if (Array.isArray(value)) return new Set(value);
  if (!value || !isJsonObject(value)) return new Set();

  const features = new Set<string>();
  for (const [key, hintValue] of Object.entries(value)) {
    if (key === "region" || key === "colo") continue;
    features.add(key);
    if (isJsonString(hintValue)) features.add(hintValue);
  }
  return features;
}

function normalizePreferHints(value: HintValue | undefined, definition: CapabilityDefinition): string[] {
  if (Array.isArray(value)) return value.filter((feature) => definition.features.includes(feature));
  if (!value || !isJsonObject(value)) return [];
  return Object.keys(value);
}

function requireCapability(port: CloudflareCapabilityPort): CapabilityDefinition {
  const definition = CAPABILITY_BY_PORT.get(port);
  if (!definition) throw new Error(`${CLOUDFLARE_PROVIDER_ID} does not implement port ${port}`);
  return definition;
}

function fakeOutputsFor(definition: CapabilityDefinition, id: string, colo: string): OutputValues {
  if (definition.port === "compute") {
    const outputs: OutputValues = {
      url: `https://${id}.${colo.toLowerCase()}.workers.dev`,
      scriptName: id,
      route: `${id}.example.com/*`
    };
    return outputs;
  }
  if (definition.port === "objectStore") {
    const outputs: OutputValues = {
      bucketName: id,
      endpoint: `https://${id}.r2.cloudflarestorage.com`,
      jurisdiction: colo
    };
    return outputs;
  }
  if (definition.port === "database") {
    const outputs: OutputValues = {
      databaseId: id,
      bindingName: bindingNameFor(id, "databaseId"),
      connectionString: `d1://${colo}/${id}`
    };
    return outputs;
  }
  if (definition.port === "kv") {
    const outputs: OutputValues = {
      namespaceId: id,
      bindingName: bindingNameFor(id, "namespaceId")
    };
    return outputs;
  }
  if (definition.port === "queue") {
    const outputs: OutputValues = {
      queueName: id,
      producerBinding: bindingNameFor(id, "queueName")
    };
    return outputs;
  }
  const outputs: OutputValues = {
    zoneId: `zone-${id}`,
    recordId: `record-${id}`,
    fqdn: `${id}.example.com`
  };
  return outputs;
}

function createCloudflareClient(port: CloudflareCapabilityPort, outputs: OutputValues) {
  requireCapability(port);
  const base = {
    port,
    providerId: CLOUDFLARE_PROVIDER_ID,
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
      connectionString: outputs.connectionString ?? outputs.databaseId,
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
  if (port === "kv") {
    return {
      ...base,
      namespaceId: outputs.namespaceId,
      async put() {},
      async get() {
        return undefined;
      }
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
    zoneId: outputs.zoneId
  };
}

function planRejected(code: string, resourceId: string, reason: JsonBag): PlanRejectedResult {
  return {
    type: "deployment.PlanRejected",
    provider: CLOUDFLARE_PROVIDER_ID,
    resourceId,
    reason: {
      code,
      resourceId,
      ...reason
    }
  };
}

type OutputByPort = { readonly [K in CloudflareCapabilityPort]: string };

function primaryOutputFor(port: CloudflareCapabilityPort): string {
  const outputByPort = {
    compute: "url",
    objectStore: "bucketName",
    database: "connectionString",
    kv: "namespaceId",
    queue: "queueName",
    dns: "fqdn"
  } satisfies OutputByPort;
  return outputByPort[port];
}

function bindingNameFor(resourceId: string, output: string): string {
  if (resourceId === "assets") return "ASSETS_BUCKET";
  if (resourceId === "app-db") return "APP_DB_CONNECTION";
  if (resourceId === "sessions") return "SESSIONS_KV_NAMESPACE";
  if (resourceId === "jobs") return "JOBS_QUEUE";
  if (resourceId === "app-domain") return "APP_DOMAIN_FQDN";
  return `${resourceId.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}_${output.toUpperCase()}`;
}
