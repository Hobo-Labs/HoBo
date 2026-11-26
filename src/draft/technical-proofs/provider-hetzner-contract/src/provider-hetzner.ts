export const HETZNER_PROVIDER_VERSION = "hobo.provider-hetzner/v1";
export const HETZNER_REALIZE_VERSION = "hobo.provider-hetzner.realize/v1";

const PROVIDER_ID = "@hobo/provider-hetzner";
const CLAIMED_CONFORMANCE_PORTS = Object.freeze(["compute", "networking", "volume", "objectStore"]);
const IAC_ADAPTERS = Object.freeze(["terraform:hcloud", "pulumi:hcloud"]);

export function createHetznerProvider({ tenant = "default" } = {}) {
  const provider = {
    id: PROVIDER_ID,
    apiVersion: HETZNER_PROVIDER_VERSION,
    tenant,
    claimedConformancePorts: [...CLAIMED_CONFORMANCE_PORTS],
    with: Object.freeze({
      server: createOptionBuilder("compute", "server", {
        size: "cx22",
        region: "fsn1",
        image: "ubuntu-24.04"
      }),
      network: createOptionBuilder("networking", "network", {
        region: "fsn1",
        cidr: "10.42.0.0/16"
      }),
      volume: createOptionBuilder("volume", "volume", {
        sizeGb: 20,
        region: "fsn1",
        filesystem: "ext4"
      }),
      objectStore: createOptionBuilder("objectStore", "objectStore", {
        region: "fsn1",
        s3Compatibility: "strict"
      }),
      database: createOptionBuilder("database", "database", {
        engine: "postgres",
        mode: "container"
      }),
      kubernetes: createOptionBuilder("kubernetes", "kubernetes", {
        distribution: "k3s",
        ready: false
      })
    }),
    registerDefaultDefinitions(registry) {
      registry.push(...createDefaultDefinitions());
      return registry;
    },
    capabilityManifest() {
      return createCapabilityManifest({ tenant });
    },
    realize(plan) {
      return realizeHetznerPlan(plan, { tenant });
    },
    client(port, outputs) {
      return createClient(port, outputs);
    }
  };

  return provider;
}

export function createHetznerFixturePlan() {
  return {
    id: "hetzner-provider-fixture",
    context: {
      tenant: "tenant-a",
      app: "shop",
      env: "prod",
      provider: "hetzner",
      region: "fsn1"
    },
    resources: [
      {
        id: "network",
        type: "networking",
        className: "private-network",
        request: { cidr: "10.42.0.0/16", region: "fsn1" }
      },
      {
        id: "firewall",
        type: "networking",
        className: "firewall",
        request: { allow: ["tcp/443"], region: "fsn1" }
      },
      {
        id: "app-volume",
        type: "volume",
        className: "hcloud-volume",
        request: { sizeGb: 20, filesystem: "ext4", region: "fsn1" }
      },
      {
        id: "assets",
        type: "objectStore",
        className: "s3-compatible-bucket",
        request: { bucketName: "shop-assets", region: "fsn1" }
      },
      {
        id: "app-server",
        type: "compute",
        className: "hcloud-server",
        request: { size: "cx22", image: "ubuntu-24.04", region: "fsn1" },
        dependsOn: ["network", "firewall", "app-volume"]
      }
    ]
  };
}

export function createKubernetesWorkloadPlan({ substrateReady }) {
  return {
    id: "hetzner-k8s-workload",
    context: {
      tenant: "tenant-a",
      app: "worker",
      env: "prod",
      provider: "hetzner",
      region: "fsn1"
    },
    resources: [
      {
        id: "hke-eu",
        type: "kubernetes",
        className: "hke-substrate",
        request: { distribution: "k3s", ready: substrateReady, region: "fsn1" }
      },
      {
        id: "worker",
        type: "compute",
        className: "hcloud-server",
        request: {
          size: "cx22",
          image: "ghcr.io/acme/worker:sha256-abc",
          region: "fsn1",
          substrateId: "hke-eu"
        },
        dependsOn: ["hke-eu"]
      }
    ]
  };
}

export function planHetznerDatabase(provider, request) {
  if (!provider || provider.id !== PROVIDER_ID) {
    throw new Error("planHetznerDatabase requires the Hetzner provider");
  }
  if (request.engine !== "postgres") {
    throw new Error(`Hetzner fallback only supports postgres, received ${request.engine}`);
  }

  const wantsManaged = request.features?.managed === true;
  if (wantsManaged && request.negotiation === "require") {
    throw new Error("database{postgres,managed} requires managed Postgres, but managed Postgres is unavailable on Hetzner");
  }

  if (wantsManaged) {
    return {
      resource: {
        id: request.id,
        type: "database",
        className: "container-postgres",
        provider: PROVIDER_ID,
        degradedFrom: "database{postgres,managed}",
        request: {
          engine: "postgres",
          mode: "container",
          managed: false
        }
      },
      warnings: [
        {
          code: "HETZNER_MANAGED_POSTGRES_UNAVAILABLE",
          severity: "warning",
          message: "database{postgres,managed} degraded to container Postgres on Hetzner because managed Postgres is unavailable."
        }
      ],
      portabilityReport: {
        nonPortableSurface: [
          {
            id: `${request.id}.provider-degrade.hetzner.managed-postgres`,
            category: "provider-degrade",
            provider: PROVIDER_ID,
            detail: "Managed Postgres request degraded to container Postgres.",
            gateEffect: "target-provider-must-satisfy-or-degrade"
          }
        ]
      }
    };
  }

  return {
    resource: {
      id: request.id,
      type: "database",
      className: "container-postgres",
      provider: PROVIDER_ID,
      request: {
        engine: "postgres",
        mode: "container",
        managed: false
      }
    },
    warnings: [],
    portabilityReport: { nonPortableSurface: [] }
  };
}

export function runHetznerProviderConformance(provider) {
  const manifest = provider.capabilityManifest();
  const errors = [];
  const capabilities = new Map((manifest.capabilities ?? []).map((capability) => [capability.port, capability]));

  for (const port of CLAIMED_CONFORMANCE_PORTS) {
    if (!capabilities.has(port)) {
      errors.push(`missing claimed Hetzner capability ${port}`);
    }
  }

  const objectStore = capabilities.get("objectStore");
  if (!objectStore?.s3Compatibility ||
    objectStore.s3Compatibility.api !== "s3-compatible" ||
    objectStore.s3Compatibility.pathStyle !== true ||
    objectStore.s3Compatibility.etagSemantics !== true ||
    objectStore.s3Compatibility.multipartUpload !== true) {
    errors.push("objectStore must declare S3-compatible API, ETag, and multipart guarantees");
  }

  const database = capabilities.get("database");
  if (database?.managed === true) {
    errors.push("Hetzner database capability must not claim managed Postgres");
  }

  const registry = [];
  provider.registerDefaultDefinitions(registry);
  for (const definitionId of createDefaultDefinitions().map((definition) => definition.id)) {
    if (!registry.some((definition) => definition.id === definitionId)) {
      errors.push(`missing default Resource Definition ${definitionId}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  return {
    ok: true,
    checked: [...CLAIMED_CONFORMANCE_PORTS]
  };
}

export function validateHetznerEmission(emission) {
  const errors = [];
  if (emission?.apiVersion !== HETZNER_REALIZE_VERSION) {
    errors.push("emission apiVersion must be hobo.provider-hetzner.realize/v1");
  }
  if (emission?.provider !== PROVIDER_ID) {
    errors.push("emission provider must be @hobo/provider-hetzner");
  }
  if (!Array.isArray(emission?.iac?.nodes)) {
    errors.push("iac.nodes must be an array");
  }
  for (const node of emission?.iac?.nodes ?? []) {
    if (!node.id || !node.type || !node.className) {
      errors.push(`node ${node.id ?? "<missing>"} must include id, type, and className`);
    }
    if (node.type === "objectStore") {
      const profile = node.inputs?.s3Compatibility;
      if (!profile || profile.api !== "s3-compatible" || profile.pathStyle !== true) {
        errors.push(`${node.id} objectStore must carry the S3-compatible profile`);
      }
    }
  }

  const ordering = assertHetznerOrdering(emission);
  errors.push(...ordering.errors);

  return {
    ok: errors.length === 0,
    errors
  };
}

export function assertHetznerOrdering(emission) {
  const errors = [];
  const nodes = emission?.iac?.nodes ?? [];
  const edges = emission?.iac?.edges ?? [];
  const index = new Map(nodes.map((node, nodeIndex) => [node.id, nodeIndex]));
  const server = nodes.find((node) => node.id === "app-server");

  if (server) {
    for (const dependency of ["network", "firewall", "app-volume"]) {
      const hasEdge = edges.some((edge) => edge.from === dependency && edge.to === "app-server");
      if (!hasEdge) {
        errors.push(`app-server must depend on ${dependency} before attach`);
      }
      if (index.has(dependency) && index.get(dependency) > index.get("app-server")) {
        errors.push(`${dependency} must be realized before app-server`);
      }
    }
  }

  for (const edge of edges) {
    if (index.has(edge.from) && index.has(edge.to) && index.get(edge.from) > index.get(edge.to)) {
      errors.push(`${edge.from} must be listed before ${edge.to}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors
  };
}

export function createHetznerRuntime() {
  return {
    async provision(emission) {
      const validation = validateHetznerEmission(emission);
      if (!validation.ok) {
        throw new Error(validation.errors.join("; "));
      }

      const outputs = {};
      for (const node of emission.iac.nodes) {
        outputs[node.id] = provisionNode(node, outputs);
      }

      return {
        deploymentId: emission.planId,
        outputs
      };
    }
  };
}

function createOptionBuilder(port, optionName, defaults) {
  return ({ negotiation = "prefer", ...options } = {}) => ({
    providerId: PROVIDER_ID,
    port,
    optionName,
    negotiation,
    options: {
      ...defaults,
      ...options
    }
  });
}

function createCapabilityManifest({ tenant }) {
  return {
    apiVersion: HETZNER_PROVIDER_VERSION,
    provider: PROVIDER_ID,
    tenant,
    auth: { mode: "brokered-svid" },
    iacAdapters: [...IAC_ADAPTERS],
    capabilities: [
      {
        port: "compute",
        backend: "hcloud-server",
        conformance: { suite: "@hobo/conformance/provider-capability/compute", tags: ["local", "provider-contract"] },
        regions: ["fsn1", "nbg1", "hel1"]
      },
      {
        port: "networking",
        backend: "hcloud-load-balancer-firewall-vswitch",
        conformance: { suite: "@hobo/conformance/provider-capability/networking", tags: ["local", "provider-contract"] },
        privateNetwork: true
      },
      {
        port: "volume",
        backend: "hcloud-volume",
        conformance: { suite: "@hobo/conformance/provider-capability/volume", tags: ["local", "provider-contract"] }
      },
      {
        port: "objectStore",
        backend: "hetzner-s3-compatible",
        conformance: { suite: "@hobo/conformance/provider-capability/objectStore", tags: ["local", "provider-contract"] },
        s3Compatibility: {
          api: "s3-compatible",
          pathStyle: true,
          etagSemantics: true,
          multipartUpload: true
        }
      },
      {
        port: "database",
        backend: "container-postgres-fallback",
        managed: false,
        degradation: "database{postgres,managed} can degrade to container Postgres only for prefer requests"
      },
      {
        port: "kubernetes",
        backend: "hke-k3s-talos-substrate",
        substrates: ["HKE", "k3s", "Talos"],
        readinessGate: "substrate must be Ready before workload placement"
      }
    ]
  };
}

function createDefaultDefinitions() {
  return [
    {
      id: "hetzner.compute.server",
      provider: PROVIDER_ID,
      port: "compute",
      equivalence: "compute.server.vps",
      resourceClass: "hcloud-server",
      driver: "terraform:hcloud"
    },
    {
      id: "hetzner.networking.private-network",
      provider: PROVIDER_ID,
      port: "networking",
      equivalence: "networking.private-network.vswitch",
      resourceClass: "private-network",
      driver: "terraform:hcloud"
    },
    {
      id: "hetzner.volume.hcloud-volume",
      provider: PROVIDER_ID,
      port: "volume",
      equivalence: "volume.block.hcloud",
      resourceClass: "hcloud-volume",
      driver: "terraform:hcloud"
    },
    {
      id: "hetzner.objectStore.s3-compatible",
      provider: PROVIDER_ID,
      port: "objectStore",
      equivalence: "objectStore.s3-compatible.bucket",
      resourceClass: "s3-compatible-bucket",
      driver: "terraform:hcloud"
    },
    {
      id: "hetzner.database.container-postgres-fallback",
      provider: PROVIDER_ID,
      port: "database",
      equivalence: "database.postgres.container",
      resourceClass: "container-postgres",
      driver: "terraform:hcloud",
      warnings: ["managed Postgres unsupported"]
    },
    {
      id: "hetzner.kubernetes.substrate",
      provider: PROVIDER_ID,
      port: "kubernetes",
      equivalence: "kubernetes.substrate.hke-k3s-talos",
      resourceClass: "hke-k3s-talos-substrate",
      driver: "terraform:hcloud"
    }
  ];
}

function realizeHetznerPlan(plan, { tenant }) {
  const resources = new Map(plan.resources.map((resource) => [resource.id, normalizeResource(resource)]));
  for (const resource of resources.values()) {
    if (resource.type === "compute" && resource.request.substrateId) {
      const substrate = resources.get(resource.request.substrateId);
      if (!substrate || substrate.type !== "kubernetes") {
        throw new Error(`k8s substrate ${resource.request.substrateId} is not declared`);
      }
      if (substrate.request.ready !== true) {
        throw new Error(`k8s substrate ${substrate.id} must be ready before workload placement`);
      }
    }
  }

  const nodes = [...resources.values()].map(createIacNode);
  const edges = [];
  for (const resource of resources.values()) {
    for (const dependency of resource.dependsOn ?? []) {
      edges.push({ from: dependency, to: resource.id, reason: edgeReason(resource.id, dependency) });
    }
  }

  return {
    apiVersion: HETZNER_REALIZE_VERSION,
    provider: PROVIDER_ID,
    planId: plan.id,
    iac: {
      apiVersion: "hobo.iac-program/v1",
      intent: "hetzner-provider-resource-graph",
      adapters: [...IAC_ADAPTERS],
      context: { tenant, ...plan.context },
      nodes,
      edges
    }
  };
}

function normalizeResource(resource) {
  return {
    ...resource,
    request: resource.request ?? {},
    dependsOn: resource.dependsOn ?? []
  };
}

function createIacNode(resource) {
  const base = {
    id: resource.id,
    type: resource.type,
    className: resource.className,
    driverIntent: {
      provider: PROVIDER_ID,
      driver: "terraform:hcloud",
      operation: "create"
    }
  };

  if (resource.type === "networking" && resource.className === "private-network") {
    return {
      ...base,
      inputs: {
        region: resource.request.region ?? "fsn1",
        cidr: resource.request.cidr ?? "10.42.0.0/16"
      },
      outputs: ["networkId", "vSwitchId"]
    };
  }

  if (resource.type === "networking" && resource.className === "firewall") {
    return {
      ...base,
      inputs: {
        region: resource.request.region ?? "fsn1",
        allow: resource.request.allow ?? ["tcp/443"]
      },
      outputs: ["firewallId"]
    };
  }

  if (resource.type === "volume") {
    return {
      ...base,
      inputs: {
        region: resource.request.region ?? "fsn1",
        sizeGb: resource.request.sizeGb ?? 20,
        filesystem: resource.request.filesystem ?? "ext4"
      },
      outputs: ["volumeId", "mountPath"]
    };
  }

  if (resource.type === "objectStore") {
    return {
      ...base,
      inputs: {
        region: resource.request.region ?? "fsn1",
        bucketName: resource.request.bucketName ?? resource.id,
        s3Compatibility: {
          api: "s3-compatible",
          pathStyle: true,
          etagSemantics: true,
          multipartUpload: true
        }
      },
      outputs: ["bucketName", "endpoint", "accessScope"]
    };
  }

  if (resource.type === "compute") {
    return {
      ...base,
      inputs: {
        region: resource.request.region ?? "fsn1",
        size: resource.request.size ?? "cx22",
        image: resource.request.image ?? "ubuntu-24.04",
        privateNetworkId: "${outputs.network.networkId}",
        firewallId: "${outputs.firewall.firewallId}",
        volumeId: resource.dependsOn.includes("app-volume") ? "${outputs.app-volume.volumeId}" : undefined,
        substrateId: resource.request.substrateId
      },
      outputs: ["serverId", "privateIpv4", "publicIpv4"]
    };
  }

  if (resource.type === "kubernetes") {
    return {
      ...base,
      inputs: {
        region: resource.request.region ?? "fsn1",
        distribution: resource.request.distribution ?? "k3s",
        ready: resource.request.ready === true
      },
      outputs: ["substrateId", "kubeconfigRef"]
    };
  }

  throw new Error(`unsupported Hetzner resource type ${resource.type}`);
}

function edgeReason(resourceId, dependency) {
  if (resourceId === "app-server" && dependency === "network") return "vSwitch-before-server";
  if (resourceId === "app-server" && dependency === "firewall") return "firewall-before-server";
  if (resourceId === "app-server" && dependency === "app-volume") return "volume-before-attach";
  return "declared-dependency";
}

function provisionNode(node, outputs) {
  if (node.type === "networking" && node.className === "private-network") {
    return {
      kind: "hcloud-network",
      networkId: `hcloud-network-${node.id}`,
      vSwitchId: `hcloud-vswitch-${node.id}`,
      cidr: node.inputs.cidr
    };
  }

  if (node.type === "networking" && node.className === "firewall") {
    return {
      kind: "hcloud-firewall",
      firewallId: `hcloud-firewall-${node.id}`,
      allow: node.inputs.allow
    };
  }

  if (node.type === "volume") {
    return {
      kind: "hcloud-volume",
      volumeId: `hcloud-volume-${node.id}`,
      mountPath: `/mnt/${node.id}`,
      filesystem: node.inputs.filesystem
    };
  }

  if (node.type === "objectStore") {
    return {
      kind: "hetzner-s3-compatible-bucket",
      bucketName: node.inputs.bucketName,
      endpoint: `s3+https://fsn1.your-objectstorage.com/${node.inputs.bucketName}`,
      accessScope: "tenant-bucket",
      objects: new Map()
    };
  }

  if (node.type === "compute") {
    return {
      kind: "hcloud-server",
      serverId: `hcloud-server-${node.id}`,
      privateNetwork: outputs.network?.networkId ?? null,
      firewallId: outputs.firewall?.firewallId ?? null,
      volumeId: outputs["app-volume"]?.volumeId ?? null,
      publicIpv4: "203.0.113.42",
      privateIpv4: "10.42.0.10",
      image: node.inputs.image
    };
  }

  if (node.type === "kubernetes") {
    return {
      kind: "hcloud-kubernetes-substrate",
      substrateId: node.id,
      kubeconfigRef: `secret://kubeconfig/${node.id}`,
      ready: node.inputs.ready
    };
  }

  throw new Error(`cannot provision unsupported node ${node.id}`);
}

function createClient(port, outputs) {
  if (port === "compute") {
    return {
      describe() {
        return {
          providerId: PROVIDER_ID,
          port,
          serverId: outputs.serverId,
          privateNetwork: outputs.privateNetwork
        };
      }
    };
  }

  if (port === "objectStore") {
    const objects = outputs.objects ?? new Map();
    return {
      async put(key, value) {
        objects.set(key, value);
      },
      async get(key) {
        return objects.get(key);
      }
    };
  }

  if (port === "networking") {
    return {
      describe() {
        return {
          providerId: PROVIDER_ID,
          port,
          networkId: outputs.networkId,
          vSwitchId: outputs.vSwitchId
        };
      }
    };
  }

  if (port === "volume") {
    return {
      describe() {
        return { providerId: PROVIDER_ID, port, volumeId: outputs.volumeId };
      }
    };
  }

  throw new Error(`unsupported Hetzner client port ${port}`);
}
