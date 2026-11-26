import assert from "node:assert/strict";
import { test } from "vitest";

import {
  assertHetznerOrdering,
  createHetznerFixturePlan,
  createHetznerProvider,
  createHetznerRuntime,
  createKubernetesWorkloadPlan,
  planHetznerDatabase,
  runHetznerProviderConformance,
  validateHetznerEmission
} from "../src/provider-hetzner.js";

test("factory publishes Hetzner capabilities, scoped builders, manifest, and defaults", () => {
  const provider = createHetznerProvider({ tenant: "tenant-a" });

  assert.equal(provider.id, "@hobo/provider-hetzner");
  assert.deepEqual(provider.claimedConformancePorts, ["compute", "networking", "volume", "objectStore"]);
  assert.deepEqual(Object.keys(provider.with).sort(), [
    "database",
    "kubernetes",
    "network",
    "objectStore",
    "server",
    "volume"
  ]);

  const manifest = provider.capabilityManifest();
  assert.equal(manifest.provider, "@hobo/provider-hetzner");
  assert.deepEqual(manifest.iacAdapters, ["terraform:hcloud", "pulumi:hcloud"]);
  assert.deepEqual(
    manifest.capabilities.map((capability) => [capability.port, capability.backend]),
    [
      ["compute", "hcloud-server"],
      ["networking", "hcloud-load-balancer-firewall-vswitch"],
      ["volume", "hcloud-volume"],
      ["objectStore", "hetzner-s3-compatible"],
      ["database", "container-postgres-fallback"],
      ["kubernetes", "hke-k3s-talos-substrate"]
    ]
  );
  assert.deepEqual(
    manifest.capabilities.find((capability) => capability.port === "kubernetes").substrates,
    ["HKE", "k3s", "Talos"]
  );

  const registry = [];
  provider.registerDefaultDefinitions(registry);
  assert.deepEqual(
    registry.map((definition) => [definition.id, definition.equivalence]),
    [
      ["hetzner.compute.server", "compute.server.vps"],
      ["hetzner.networking.private-network", "networking.private-network.vswitch"],
      ["hetzner.volume.hcloud-volume", "volume.block.hcloud"],
      ["hetzner.objectStore.s3-compatible", "objectStore.s3-compatible.bucket"],
      ["hetzner.database.container-postgres-fallback", "database.postgres.container"],
      ["hetzner.kubernetes.substrate", "kubernetes.substrate.hke-k3s-talos"]
    ]
  );

  assert.deepEqual(provider.with.server({ size: "cx22", region: "fsn1" }), {
    providerId: "@hobo/provider-hetzner",
    port: "compute",
    optionName: "server",
    negotiation: "prefer",
    options: { size: "cx22", region: "fsn1", image: "ubuntu-24.04" }
  });

  assert.deepEqual(runHetznerProviderConformance(provider), {
    ok: true,
    checked: ["compute", "networking", "volume", "objectStore"]
  });
});

test("fixture plan realizes server, volume, S3-compatible bucket, and networking in dependency order", async () => {
  const provider = createHetznerProvider({ tenant: "tenant-a" });
  const runtime = createHetznerRuntime();
  const emission = provider.realize(createHetznerFixturePlan());

  assert.equal(validateHetznerEmission(emission).ok, true);
  assert.deepEqual(
    emission.iac.nodes.map((node) => [node.id, node.type]),
    [
      ["network", "networking"],
      ["firewall", "networking"],
      ["app-volume", "volume"],
      ["assets", "objectStore"],
      ["app-server", "compute"]
    ]
  );
  assert.equal(assertHetznerOrdering(emission).ok, true);
  assert.deepEqual(emission.iac.adapters, ["terraform:hcloud", "pulumi:hcloud"]);

  const provisioned = await runtime.provision(emission);
  assert.equal(provisioned.outputs["app-server"].kind, "hcloud-server");
  assert.equal(provisioned.outputs["app-volume"].kind, "hcloud-volume");
  assert.equal(provisioned.outputs.assets.kind, "hetzner-s3-compatible-bucket");

  const server = provider.client("compute", provisioned.outputs["app-server"]);
  assert.deepEqual(server.describe(), {
    providerId: "@hobo/provider-hetzner",
    port: "compute",
    serverId: "hcloud-server-app-server",
    privateNetwork: "hcloud-network-network"
  });

  const network = provider.client("networking", provisioned.outputs.network);
  assert.deepEqual(network.describe(), {
    providerId: "@hobo/provider-hetzner",
    port: "networking",
    networkId: "hcloud-network-network",
    vSwitchId: "hcloud-vswitch-network"
  });

  const bucket = provider.client("objectStore", provisioned.outputs.assets);
  await bucket.put("hello.txt", "s3-compatible");
  assert.equal(await bucket.get("hello.txt"), "s3-compatible");
});

test("managed Postgres require rejects while prefer degrades with PlanWarning and PortabilityReport", () => {
  const provider = createHetznerProvider({ tenant: "tenant-a" });

  assert.throws(
    () =>
      planHetznerDatabase(provider, {
        id: "db",
        engine: "postgres",
        features: { managed: true },
        negotiation: "require"
      }),
    /managed Postgres is unavailable on Hetzner/
  );

  const planned = planHetznerDatabase(provider, {
    id: "db",
    engine: "postgres",
    features: { managed: true },
    negotiation: "prefer"
  });

  assert.equal(planned.resource.className, "container-postgres");
  assert.deepEqual(planned.warnings, [
    {
      code: "HETZNER_MANAGED_POSTGRES_UNAVAILABLE",
      severity: "warning",
      message: "database{postgres,managed} degraded to container Postgres on Hetzner because managed Postgres is unavailable."
    }
  ]);
  assert.deepEqual(planned.portabilityReport.nonPortableSurface, [
    {
      id: "db.provider-degrade.hetzner.managed-postgres",
      category: "provider-degrade",
      provider: "@hobo/provider-hetzner",
      detail: "Managed Postgres request degraded to container Postgres.",
      gateEffect: "target-provider-must-satisfy-or-degrade"
    }
  ]);
});

test("S3-compatible object store divergence fails conformance instead of certifying", () => {
  const provider = createHetznerProvider({ tenant: "tenant-a" });
  const dishonest = {
    ...provider,
    capabilityManifest() {
      const manifest = provider.capabilityManifest();
      const objectStore = manifest.capabilities.find((capability) => capability.port === "objectStore");
      objectStore.s3Compatibility = {
        api: "partial",
        pathStyle: true,
        etagSemantics: false,
        multipartUpload: false
      };
      return manifest;
    }
  };

  assert.throws(
    () => runHetznerProviderConformance(dishonest),
    /objectStore must declare S3-compatible API, ETag, and multipart guarantees/
  );
});

test("k8s substrate is explicit and refuses workloads until ready", () => {
  const provider = createHetznerProvider({ tenant: "tenant-a" });

  assert.throws(
    () => provider.realize(createKubernetesWorkloadPlan({ substrateReady: false })),
    /k8s substrate hke-eu must be ready before workload placement/
  );

  const emission = provider.realize(createKubernetesWorkloadPlan({ substrateReady: true }));
  assert.equal(validateHetznerEmission(emission).ok, true);
  assert.equal(emission.iac.nodes.find((node) => node.id === "worker").inputs.substrateId, "hke-eu");
});

test("server realization must depend on vSwitch, firewall, and volume before attach", () => {
  const provider = createHetznerProvider({ tenant: "tenant-a" });
  const emission = provider.realize(createHetznerFixturePlan());
  const broken = structuredClone(emission);
  broken.iac.edges = broken.iac.edges.filter(
    (edge) => !(edge.from === "firewall" && edge.to === "app-server")
  );

  const order = assertHetznerOrdering(broken);
  assert.equal(order.ok, false);
  assert.match(order.errors.join("\n"), /app-server must depend on firewall before attach/);
});
