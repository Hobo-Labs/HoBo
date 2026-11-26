import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import {
  BUILD_SPEC_VERSION,
  IAC_PROGRAM_VERSION,
  REALIZE_EMISSION_VERSION,
  outputPlaceholder,
  validateEmission
} from "../../hobo-realize-emission-contract/src/realize-emission-contract.js";

export const PROVIDER_LOCAL_VERSION = "hobo.provider-local/v1";

const PROVIDER_ID = "@hobo/provider-local";
const activeLocalLocks = new Set();

export const local = {
  with: {
    database(options = {}) {
      return {
        port: "database",
        engine: options.engine ?? "postgres",
        name: options.name ?? "app",
        version: options.version ?? "16",
        fidelity: "local"
      };
    },
    objectStore(options = {}) {
      return {
        port: "objectStore",
        driver: "filesystem",
        name: options.name ?? "assets",
        fidelity: "local"
      };
    },
    compute(options = {}) {
      return {
        port: "compute",
        runtime: options.runtime ?? "container",
        image: options.image,
        fidelity: "local"
      };
    },
    queue(options = {}) {
      return {
        port: "queue",
        mode: options.mode ?? "inMemory",
        fidelity: "mock"
      };
    }
  }
};

export function createLocalProvider({ root = ".hobo-local" } = {}) {
  const provider = {
    id: PROVIDER_ID,
    apiVersion: PROVIDER_LOCAL_VERSION,
    root,
    capabilities: createCapabilities(),
    with: local.with,
    registerDefaultDefinitions(registry) {
      registry.push(...createDefaultDefinitions());
      return registry;
    },
    capabilityManifest() {
      return createCapabilityManifest(root);
    },
    realize(plan) {
      return realizeLocalPlan(plan, root);
    },
    client(port, outputs) {
      return createClient(port, outputs);
    }
  };

  return provider;
}

export function createProviderLocalFixturePlan() {
  return {
    id: "local-provider-fixture",
    context: {
      app: "gallery",
      env: "dev",
      envType: "ephemeral"
    },
    resources: [
      {
        id: "db",
        type: "database",
        className: "postgres",
        request: local.with.database({ name: "gallery", version: "16" })
      },
      {
        id: "assets",
        type: "objectStore",
        className: "filesystem",
        request: local.with.objectStore({ name: "gallery-assets" })
      },
      {
        id: "jobs",
        type: "queue",
        className: "inMemory",
        request: local.with.queue()
      },
      {
        id: "worker",
        type: "compute",
        className: "container",
        request: local.with.compute({ image: "local://gallery-worker:dev" }),
        binds: [
          {
            import: "wasi:sql/query",
            providerResourceId: "db",
            capability: "database"
          },
          {
            import: "wasi:blobstore/blobstore",
            providerResourceId: "assets",
            capability: "objectStore"
          },
          {
            import: "wasi:messaging/messaging",
            providerResourceId: "jobs",
            capability: "queue"
          }
        ]
      }
    ]
  };
}

export function runLocalProviderConformance(provider) {
  const manifest = provider.capabilityManifest();
  if (manifest.claimsCampFidelity) {
    throw new Error(`${provider.id} must not claim camp fidelity`);
  }

  for (const capability of manifest.capabilities ?? []) {
    if (!capability.conformance?.tags?.includes("local")) {
      throw new Error(`${capability.port} must carry local conformance tag`);
    }
    if (capability.conformance.tags.includes("camp") || capability.fidelity === "camp") {
      throw new Error(`${capability.port} must not claim camp fidelity`);
    }
  }

  const ports = new Set((manifest.capabilities ?? []).map((capability) => capability.port));
  for (const required of ["database", "objectStore", "compute", "queue"]) {
    if (!ports.has(required)) {
      throw new Error(`missing local provider capability ${required}`);
    }
  }

  const registry = [];
  provider.registerDefaultDefinitions(registry);
  for (const required of ["database", "objectStore", "compute", "queue"]) {
    if (!registry.some((definition) => definition.port === required)) {
      throw new Error(`missing default Resource Definition for ${required}`);
    }
  }

  return {
    ok: true,
    checked: [...ports]
  };
}

export function createLocalRuntime({ root }) {
  if (!root) throw new Error("createLocalRuntime requires a filesystem root");

  return {
    async provision(emission, options = {}) {
      const validation = validateEmission(emission);
      if (!validation.ok) {
        throw new Error(validation.errors.join("; "));
      }

      const deploymentId = emission.planId;
      const lockKey = `${root}::${deploymentId}`;
      if (activeLocalLocks.has(lockKey)) {
        throw new Error(`shared local backend lock already held for ${deploymentId}`);
      }

      activeLocalLocks.add(lockKey);
      try {
        if (options.holdMs) {
          await delay(options.holdMs);
        }

        const deploymentRoot = join(root, deploymentId);
        await mkdir(deploymentRoot, { recursive: true });

        const outputs = {};
        for (const node of emission.iac.nodes) {
          outputs[node.id] = await provisionNode({ deploymentId, deploymentRoot, node });
        }

        await writeFile(join(deploymentRoot, "emission.json"), JSON.stringify(emission, null, 2));
        return {
          deploymentId,
          outputs
        };
      } finally {
        activeLocalLocks.delete(lockKey);
      }
    },
    async destroy(deploymentId) {
      const deploymentRoot = join(root, deploymentId);
      await rm(deploymentRoot, { force: true, recursive: true });
      const remaining = await readdir(root).catch(() => []);
      return {
        deploymentId,
        residue: remaining.length > 0,
        remaining
      };
    }
  };
}

function createCapabilities() {
  return [
    {
      port: "database",
      backend: "containerized-postgres",
      fidelity: "local",
      conformance: { tags: ["local"] }
    },
    {
      port: "objectStore",
      backend: "filesystem-object-store",
      fidelity: "local",
      conformance: { tags: ["local"] }
    },
    {
      port: "compute",
      backend: "container",
      fidelity: "local",
      conformance: { tags: ["local"] }
    },
    {
      port: "queue",
      backend: "in-memory-queue",
      fidelity: "mock",
      conformance: { tags: ["local"] },
      limitations: ["in-memory queue is a local/mock seam and never proves camp delivery guarantees"]
    }
  ];
}

function createCapabilityManifest(root) {
  return {
    apiVersion: PROVIDER_LOCAL_VERSION,
    provider: PROVIDER_ID,
    root,
    fidelity: "local",
    claimsCampFidelity: false,
    capabilities: createCapabilities().map((capability) => ({
      port: capability.port,
      backend: capability.backend,
      fidelity: capability.fidelity,
      conformance: capability.conformance,
      limitations: capability.limitations ?? []
    }))
  };
}

function createDefaultDefinitions() {
  return [
    {
      id: "local.database.postgres",
      provider: PROVIDER_ID,
      port: "database",
      resourceClass: "postgres",
      fidelity: "local",
      driver: "container"
    },
    {
      id: "local.objectStore.filesystem",
      provider: PROVIDER_ID,
      port: "objectStore",
      resourceClass: "filesystem",
      fidelity: "local",
      driver: "filesystem"
    },
    {
      id: "local.compute.container",
      provider: PROVIDER_ID,
      port: "compute",
      resourceClass: "container",
      fidelity: "local",
      driver: "container"
    },
    {
      id: "local.queue.inMemory",
      provider: PROVIDER_ID,
      port: "queue",
      resourceClass: "inMemory",
      fidelity: "mock",
      driver: "in-memory"
    }
  ];
}

function realizeLocalPlan(plan, root) {
  const nodes = [];
  const edges = [];
  const links = [];
  const outputPlaceholders = [];
  const buildArtifacts = [];
  const resources = new Map(plan.resources.map((resource) => [resource.id, normalizeResource(resource)]));

  for (const resource of resources.values()) {
    const node = createIacNode(resource, root);

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
      const providerResource = resources.get(bind.providerResourceId);
      if (!providerResource) continue;

      const output = primaryOutputFor(providerResource.type);
      const placeholder = outputPlaceholder({
        type: providerResource.type,
        className: providerResource.className,
        id: providerResource.id,
        output
      });
      const inputName = `BINDING_${bind.providerResourceId.toUpperCase()}`;
      node.inputs.env ??= {};
      node.inputs.env[inputName] = placeholder;
      edges.push({ from: providerResource.id, to: resource.id, reason: "binding-output" });
      outputPlaceholders.push({
        placeholder,
        producerNode: providerResource.id,
        output,
        consumerNode: resource.id,
        inputPath: `inputs.env.${inputName}`
      });
      links.push({
        component: resource.id,
        import: bind.import,
        providerNode: providerResource.id,
        capability: bind.capability ?? providerResource.type
      });
    }

    nodes.push(node);
  }

  const emission = {
    apiVersion: REALIZE_EMISSION_VERSION,
    provider: PROVIDER_ID,
    planId: plan.id,
    iac: {
      apiVersion: IAC_PROGRAM_VERSION,
      intent: "local-zero-infra-resource-graph",
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

  return emission;
}

function normalizeResource(resource) {
  return {
    ...resource,
    className: resource.className ?? defaultClassNameFor(resource.type),
    request: resource.request ?? {}
  };
}

function createIacNode(resource, root) {
  const base = {
    id: resource.id,
    type: resource.type,
    className: resource.className,
    driverIntent: {
      capability: resource.type,
      operation: "create",
      fidelity: resource.type === "queue" ? "mock" : "local"
    }
  };

  if (resource.type === "database") {
    const request = { ...local.with.database(), ...resource.request };
    return {
      ...base,
      inputs: {
        engine: request.engine,
        databaseName: request.name,
        containerImage: `postgres:${request.version}`,
        storage: join(root, "${context.env}", resource.id)
      },
      outputs: ["connectionString", "host", "databaseName"]
    };
  }

  if (resource.type === "objectStore") {
    const request = { ...local.with.objectStore(), ...resource.request };
    return {
      ...base,
      inputs: {
        bucketName: request.name,
        root: join(root, "${context.env}", resource.id)
      },
      outputs: ["bucketName", "endpoint", "root"]
    };
  }

  if (resource.type === "compute") {
    const request = { ...local.with.compute(), ...resource.request };
    return {
      ...base,
      inputs: {
        runtime: request.runtime,
        image: request.image ?? `local://${resource.id}:dev`,
        env: {}
      },
      outputs: ["url", "containerId"]
    };
  }

  if (resource.type === "queue") {
    const request = { ...local.with.queue(), ...resource.request };
    return {
      ...base,
      inputs: {
        mode: request.mode,
        durability: "process-memory"
      },
      outputs: ["queueUrl"]
    };
  }

  throw new Error(`unsupported local provider resource type ${resource.type}`);
}

async function provisionNode({ deploymentId, deploymentRoot, node }) {
  const resourceRoot = join(deploymentRoot, node.id);
  await mkdir(resourceRoot, { recursive: true });

  if (node.type === "database") {
    const outputs = {
      kind: "database",
      engine: node.inputs.engine,
      fidelity: "local",
      connectionString: `local-postgres://${deploymentId}/${node.inputs.databaseName}`,
      host: "127.0.0.1",
      databaseName: node.inputs.databaseName,
      resourcePath: resourceRoot
    };
    await writeFile(join(resourceRoot, "database.json"), JSON.stringify(outputs, null, 2));
    return outputs;
  }

  if (node.type === "objectStore") {
    const bucketRoot = join(resourceRoot, "bucket");
    await mkdir(bucketRoot, { recursive: true });
    const outputs = {
      kind: "objectStore",
      fidelity: "local",
      bucketName: node.inputs.bucketName,
      endpoint: `file://${bucketRoot}`,
      root: bucketRoot
    };
    await writeFile(join(resourceRoot, "object-store.json"), JSON.stringify(outputs, null, 2));
    return outputs;
  }

  if (node.type === "compute") {
    const outputs = {
      kind: "compute",
      fidelity: "local",
      url: `http://127.0.0.1/${deploymentId}/${node.id}`,
      containerId: `local-container-${deploymentId}-${node.id}`,
      image: node.inputs.image
    };
    await writeFile(join(resourceRoot, "compute.json"), JSON.stringify(outputs, null, 2));
    return outputs;
  }

  if (node.type === "queue") {
    const outputs = {
      kind: "queue",
      fidelity: "mock",
      queueUrl: `memory://${deploymentId}/${node.id}`,
      messages: []
    };
    await writeFile(join(resourceRoot, "queue.json"), JSON.stringify(outputs, null, 2));
    return outputs;
  }

  throw new Error(`cannot provision unsupported node ${node.type}`);
}

function createClient(port, outputs) {
  if (port === "database") {
    return {
      describe() {
        return {
          kind: "database",
          engine: outputs.engine,
          fidelity: outputs.fidelity,
          connectionString: outputs.connectionString
        };
      }
    };
  }

  if (port === "objectStore") {
    return {
      async put(key, value) {
        const target = safeJoin(outputs.root, key);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, value);
      },
      async get(key) {
        return readFile(safeJoin(outputs.root, key), "utf8");
      }
    };
  }

  if (port === "queue") {
    const messages = outputs.messages ?? [];
    return {
      publish(message) {
        messages.push(message);
      },
      drain() {
        return messages.splice(0, messages.length);
      }
    };
  }

  if (port === "compute") {
    return {
      describe() {
        return outputs;
      }
    };
  }

  throw new Error(`unsupported client port ${port}`);
}

function safeJoin(root, key) {
  const target = join(root, key);
  const rel = relative(root, target);
  if (rel.startsWith("..")) {
    throw new Error(`object key escapes bucket root: ${key}`);
  }
  return target;
}

function defaultClassNameFor(type) {
  return {
    database: "postgres",
    objectStore: "filesystem",
    compute: "container",
    queue: "inMemory"
  }[type];
}

function primaryOutputFor(type) {
  return {
    database: "connectionString",
    objectStore: "bucketName",
    compute: "url",
    queue: "queueUrl"
  }[type];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
