import { createHash } from "node:crypto";
import { isJsonObject } from "./json.js";


const REPORT_VERSION = "hobo.portabilityReport/v1";
const DEPLOYMENT_PLANNED_EVENT = "deployment.Planned";

const _SHARED_CONFORMANCE_CLAIMS = Object.freeze(["compute", "database", "objectStore", "queue", "cache"]);
const FLY_CAPABILITY_CLAIMS = Object.freeze(["compute", "volume", "database", "objectStore", "queue", "cache"]);
const RESOURCE_CLASSES = Object.freeze({
  compute: {
    resourceClass: "fly.machine",
    providerResource: "machines",
    satisfies: ["container", "regional"]
  },
  volume: {
    resourceClass: "fly.volume",
    providerResource: "volumes",
    satisfies: ["persistent", "regional", "single-region"]
  },
  database: {
    resourceClass: "fly.postgres",
    providerResource: "postgres",
    satisfies: ["postgres", "managed", "regional"]
  },
  objectStore: {
    resourceClass: "tigris.bucket",
    providerResource: "tigris",
    satisfies: ["objectStore", "s3-compatible"]
  },
  queue: {
    resourceClass: "nats.stream",
    providerResource: "nats",
    satisfies: ["queue", "pubsub"]
  },
  cache: {
    resourceClass: "upstash.redis",
    providerResource: "upstash",
    satisfies: ["cache", "redis"]
  }
});

export function createFlyProvider(options = {}) {
  return new FlyProvider({
    regions: options.regions ?? ["iad", "ord", "lhr", "fra", "sin", "syd"],
    defaultRegion: options.defaultRegion ?? "iad",
    builderOptions: options.builderOptions ?? {}
  });
}

export function createPortableFlyBindle(name) {
  const resources = [
    { id: "web", type: "compute", image: `registry.example/${name}:web` },
    { id: `${name}-db`, type: "database", engine: "postgres" }
  ];
  return {
    apiVersion: "hobo.bindle/v1",
    name,
    resources,
    digest: `sha256:${sha256({ name, resources })}`
  };
}

export function provisionFlyFixture(provider, fixture) {
  return provider.realize({
    bindle: fixture.bindle,
    app: fixture.app,
    target: "fly",
    region: fixture.region,
    resources: fixture.resources
  });
}

export function runFlyVolumeConformance(provider) {
  const checks = [];
  const failures = [];

  runCheck("volume.local.realizes-regional-volume", checks, failures, () => {
    const fixture = provisionFlyFixture(provider, {
      app: "volume-check",
      region: "iad",
      resources: [
        { id: "web", type: "compute", image: "registry.example/check:web" },
        { id: "data", type: "volume", attachedTo: "web", sizeGb: 3 }
      ]
    });
    const volume = fixture.iacProgram.nodes.find((node) => node.id === "data");
    if (volume.resourceClass !== "fly.volume") {
      throw new Error("volume must realize to Fly volumes");
    }
    if (volume.region !== "iad" || volume.attachedTo !== "web") {
      throw new Error("volume region and attachment must be explicit");
    }
  });

  runCheck("volume.local.rejects-cross-region-attachment", checks, failures, () => {
    assertThrowsMessage(
      () =>
        provisionFlyFixture(provider, {
          app: "volume-check",
          region: "iad",
          resources: [
            { id: "web", type: "compute", image: "registry.example/check:web", region: "iad" },
            { id: "data", type: "volume", attachedTo: "web", region: "fra" }
          ]
        }),
      "fly-volume-region-unreachable"
    );
  });

  return {
    status: failures.length === 0 ? "pass" : "fail",
    checks,
    failures
  };
}

class FlyProvider {
  constructor({ regions, defaultRegion, builderOptions }) {
    this.id = "fly";
    this.regions = Object.freeze([...regions]);
    this.defaultRegion = defaultRegion;
    this.builderOptions = deepFreeze(structuredClone(builderOptions));
    this.resources = new Map();
    this.nextId = 0;
    this.manifest = deepFreeze({ claimedCapabilities: [...FLY_CAPABILITY_CLAIMS] });
    this.capabilities = Object.freeze(
      FLY_CAPABILITY_CLAIMS.map((type) => ({ type, ...RESOURCE_CLASSES[type] })),
    );
    this.defaultDefinitions = deepFreeze(
      Object.entries(RESOURCE_CLASSES).map(([type, equivalence]) => ({
        id: `fly.default.${type}`,
        type,
        provider: "fly",
        driver: "terraform",
        source: "provider-default",
        resourceClass: equivalence.resourceClass,
        providerResource: equivalence.providerResource,
        satisfies: equivalence.satisfies,
        equivalence: {
          providerResourceClass: equivalence.resourceClass,
          providerResource: equivalence.providerResource,
          satisfies: equivalence.satisfies
        },
        realization: {
          provider: "fly",
          driver: "terraform",
          resourceClass: equivalence.resourceClass,
          providerResource: equivalence.providerResource
        }
      }))
    );
    this.with = Object.freeze({
      machines: (options) => this.withOptions("machines", options),
      volume: (options) => this.withOptions("volume", options),
      postgres: (options) => this.withOptions("postgres", options),
      tigris: (options) => this.withOptions("tigris", options),
      nats: (options) => this.withOptions("nats", options),
      upstash: (options) => this.withOptions("upstash", options)
    });
  }

  withOptions(port, options) {
    return new FlyProvider({
      regions: this.regions,
      defaultRegion: this.defaultRegion,
      builderOptions: {
        ...this.builderOptions,
        [port]: structuredClone(options ?? {})
      }
    });
  }

  capabilityManifest() {
    return {
      apiVersion: "hobo.providerCapabilityManifest/v1",
      provider: "fly",
      claimedCapabilities: [...this.manifest.claimedCapabilities],
      providerResources: Object.entries(RESOURCE_CLASSES).map(([type, resource]) => ({
        type,
        providerResource: resource.providerResource,
        resourceClass: resource.resourceClass,
        satisfies: [...resource.satisfies],
        conformance:
          type === "volume"
            ? "@hobo/provider-fly/volume-local"
            : `@hobo/conformance/provider-capability/${type}`
      })),
      defaults: this.defaultDefinitions.map((definition) => definition.id)
    };
  }

  realize(plan) {
    const target = plan?.target ?? "fly";
    if (target !== "fly") {
      throw new Error(`provider-fly cannot realize target ${target}`);
    }

    const baseRegion = plan?.region ?? this.defaultRegion;
    assertKnownRegion(this, baseRegion);
    const resources = plan?.resources ?? [];
    validateFlyPlan(this, resources, baseRegion);

    const nodes = resources.map((resource) => this.realizeResource(resource, baseRegion));
    const portabilityReport = buildPortabilityReport(plan?.bindle?.digest ?? plan?.app ?? "fly-plan", nodes);

    return {
      status: "planned",
      provider: "fly",
      bindle: plan?.bindle,
      resourcePlan: structuredClone({ ...plan, target, region: baseRegion }),
      iacProgram: {
        apiVersion: "hobo.iacProgram/v1",
        provider: "fly",
        driver: "terraform",
        execution: "declarative-only",
        nodes
      },
      deploymentPlanned: {
        type: DEPLOYMENT_PLANNED_EVENT,
        planId: plan?.bindle?.digest ?? plan?.app ?? "fly-plan",
        portabilityReport
      }
    };
  }

  realizeResource(resource, baseRegion) {
    const type = resource.type;
    const equivalence = RESOURCE_CLASSES[type];
    if (!equivalence) {
      throw new Error(`fly-unsupported-resource-type:${type}`);
    }
    const region = resource.region ?? baseRegion;
    assertKnownRegion(this, region);

    if (type === "database" && resource.require?.ha) {
      throw new Error("fly-postgres-ha-not-equivalent: Fly Postgres is not a managed HA RDS equivalent");
    }
    if (type === "database" && (resource.engine ?? "postgres") !== "postgres") {
      throw new Error(`fly-database-engine-unsupported:${resource.engine}`);
    }
    if (type === "compute" && (resource.runtime ?? "container") !== "container") {
      throw new Error(`fly-compute-runtime-unsupported:${resource.runtime}`);
    }
    if (type === "objectStore" && (resource.require?.strictS3Features ?? []).length > 0) {
      throw new Error("tigris-s3-compat-divergence: strict S3 feature must be explicitly requalified");
    }

    const node = {
      id: resource.id,
      type,
      provider: "fly",
      driver: "terraform",
      region,
      resourceClass: equivalence.resourceClass,
      providerResource: equivalence.providerResource,
      satisfies: [...equivalence.satisfies],
      inputs: stripPlanningFields(resource),
      with: this.providerOptionsFor(type),
      nonPortableEvidence: []
    };

    if (type === "compute") {
      const machines = this.builderOptions.machines ?? {};
      const minMachinesRunning = machines.minMachinesRunning ?? 1;
      node.image = resource.image;
      node.placement = {
        region,
        coldStart: minMachinesRunning > 0 ? "guarded" : "allowed",
        minMachinesRunning
      };
    }

    if (type === "volume") {
      const volume = this.builderOptions.volume ?? {};
      node.sizeGb = resource.sizeGb ?? volume.sizeGb ?? 1;
      node.attachedTo = resource.attachedTo;
    }

    const optionName = optionNameForType(type);
    if (optionName && Object.keys(this.builderOptions[optionName] ?? {}).length > 0) {
      node.nonPortableEvidence.push({
        category: "provider-option",
        provider: "fly",
        option: optionName,
        detail: optionName === "machines"
          ? "Fly Machine placement/cold-start settings are target-scoped provider options."
          : `Fly ${optionName} settings are target-scoped provider options.`
      });
    }

    return deepFreeze(node);
  }

  provision(capability, plan) {
    this.assertCapability(capability);
    const id = `${capability}-${++this.nextId}`;
    const resource = {
      id,
      capability,
      plan: structuredClone(plan ?? {}),
      drift: false
    };
    this.resources.set(id, resource);
    return resource;
  }

  client(capability, resource) {
    this.assertCapability(capability);
    if (resource?.id && !this.resources.has(resource.id)) {
      throw new Error(`resource ${resource.id} is not provisioned`);
    }
    return {
      provider: "fly",
      capability,
      ping: () => `${capability}:ok`
    };
  }

  negotiate(capability, hints = {}) {
    this.assertCapability(capability);
    const require = hints.require ?? {};
    if (capability === "database" && require.ha) {
      return {
        requireSatisfied: false,
        code: "fly-postgres-ha-not-equivalent",
        preferHonored: []
      };
    }
    const region = require.region ?? this.defaultRegion;
    return {
      requireSatisfied: region === "local" || this.regions.includes(region),
      preferHonored: hints.prefer?.durability ? ["durability"] : []
    };
  }

  injectDrift(id) {
    const resource = this.resources.get(id);
    if (!resource) {
      throw new Error(`cannot drift missing resource ${id}`);
    }
    resource.drift = true;
  }

  refresh(id) {
    const resource = this.resources.get(id);
    if (!resource) {
      throw new Error(`cannot refresh missing resource ${id}`);
    }
    return { drift: resource.drift };
  }

  destroy(id) {
    if (!this.resources.has(id)) {
      throw new Error(`cannot destroy missing resource ${id}`);
    }
    this.resources.delete(id);
  }

  hasResource(id) {
    return this.resources.has(id);
  }

  campEvidence(capability) {
    this.assertCapability(capability);
    return {
      realProviderDrift: false,
      iam: false,
      mtls: false,
      quota: false,
      reason: "provider-fly POC does not execute real Fly Camp checks"
    };
  }

  providerOptionsFor(type) {
    const optionName = optionNameForType(type);
    return optionName ? structuredClone(this.builderOptions[optionName] ?? {}) : {};
  }

  assertCapability(capability) {
    if (!FLY_CAPABILITY_CLAIMS.includes(capability)) {
      throw new Error(`provider-fly does not claim capability ${capability}`);
    }
  }
}

function validateFlyPlan(provider, resources, baseRegion) {
  const computeRegions = new Map();
  for (const resource of resources) {
    if (resource.type !== "compute") continue;
    const region = resource.region ?? baseRegion;
    assertKnownRegion(provider, region);
    computeRegions.set(resource.id, region);
  }

  for (const resource of resources) {
    if (resource.type !== "volume") continue;
    const region = resource.region ?? baseRegion;
    assertKnownRegion(provider, region);
    if (!resource.attachedTo) continue;
    const computeRegion = computeRegions.get(resource.attachedTo);
    if (!computeRegion) {
      throw new Error(
        `fly-volume-attachment-missing: volume ${resource.id} attaches to missing Machine ${resource.attachedTo}`
      );
    }
    if (computeRegion && computeRegion !== region) {
      throw new Error(
        `fly-volume-region-unreachable: volume ${resource.id} in ${region} cannot attach to ${resource.attachedTo} in ${computeRegion}`
      );
    }
  }
}

function buildPortabilityReport(planId, nodes) {
  const entries = nodes.flatMap((node) =>
    node.nonPortableEvidence.map((evidence) => ({
      id: markerId(node, evidence),
      category: evidence.category,
      severity: "target-scoped",
      resourceId: node.id,
      provider: evidence.provider,
      path: `resources.${node.id}.with.${evidence.provider}.${evidence.option}`,
      detail: evidence.detail ?? "Provider-specific .with option requires target provider support.",
      gateEffect: "target-provider-must-satisfy"
    }))
  );

  return {
    apiVersion: REPORT_VERSION,
    planId,
    entries,
    zeroSecretExceptions: []
  };
}

function markerId(resource, evidence) {
  if (evidence.category === "provider-option") {
    return `${resource.id}.provider-option.${evidence.provider}.${evidence.option}`;
  }
  return `${resource.id}.${evidence.category}`;
}

function optionNameForType(type) {
  switch (type) {
    case "compute":
      return "machines";
    case "volume":
      return "volume";
    case "database":
      return "postgres";
    case "objectStore":
      return "tigris";
    case "queue":
      return "nats";
    case "cache":
      return "upstash";
    default:
      return null;
  }
}

function stripPlanningFields(resource) {
  const clone = structuredClone(resource);
  delete clone.id;
  delete clone.type;
  delete clone.require;
  return clone;
}

function assertKnownRegion(provider, region) {
  if (!provider.regions.includes(region)) {
    throw new Error(`fly-region-unsupported:${region}`);
  }
}

function runCheck(checkId, checks, failures, fn) {
  try {
    fn();
    checks.push({ checkId, status: "pass" });
  } catch (error) {
    failures.push({
      checkId,
      message: error instanceof Error ? error.message : String(error)
    });
    checks.push({ checkId, status: "fail" });
  }
}

function assertThrowsMessage(fn, expectedMessage) {
  try {
    fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes(expectedMessage)) {
      return;
    }
    throw error;
  }
  throw new Error(`expected ${expectedMessage}`);
}

function sha256(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) {
    return value;
  }
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}
