import assert from "node:assert/strict";
import { test } from "vitest";

import { hoboVerify } from "../../provider-capability-conformance-suites/src/provider-capability-conformance.js";
import { validatePortabilityReport } from "../../portability-report-contract/src/portability-report-contract.js";
import {
  createFlyProvider,
  createPortableFlyBindle,
  provisionFlyFixture,
  runFlyVolumeConformance
} from "../src/provider-fly-contract.js";

test("provider-fly passes shared provider conformance for seed ports and local volume conformance", () => {
  const provider = createFlyProvider();

  const report = hoboVerify(provider, {
    capabilities: ["compute", "database", "objectStore", "queue", "cache"],
    runTags: ["local"]
  });
  const volume = runFlyVolumeConformance(provider);
  const volumeResource = provider.provision("volume", { require: { region: "local" } });

  assert.equal(report.status, "pass");
  assert.deepEqual(report.coverage.requestedCapabilities, ["cache", "compute", "database", "objectStore", "queue"]);
  assert.deepEqual(report.coverage.missingSuites, []);
  assert.equal(report.coverage.local.total, 20);
  assert.equal(volume.status, "pass");
  assert.equal(provider.client("volume", volumeResource).ping(), "volume:ok");
  assert.deepEqual(
    provider.capabilityManifest().claimedCapabilities,
    ["compute", "volume", "database", "objectStore", "queue", "cache"]
  );
  assert.equal(provider.defaultDefinitions.some((definition) => definition.type === "volume"), true);
});

test("fixture realizes a Fly Machine, regional volume, and Fly Postgres without executing IaC", () => {
  const provider = createFlyProvider();

  const fixture = provisionFlyFixture(provider, {
    app: "orders",
    region: "iad",
    resources: [
      { id: "web", type: "compute", image: "registry.example/orders:web" },
      { id: "orders-data", type: "volume", sizeGb: 10, attachedTo: "web" },
      { id: "orders-db", type: "database", engine: "postgres" }
    ]
  });

  assert.equal(fixture.status, "planned");
  assert.deepEqual(
    fixture.iacProgram.nodes.map((node) => [node.id, node.resourceClass, node.providerResource]),
    [
      ["web", "fly.machine", "machines"],
      ["orders-data", "fly.volume", "volumes"],
      ["orders-db", "fly.postgres", "postgres"]
    ]
  );
  assert.equal(fixture.iacProgram.execution, "declarative-only");
  assert.equal("apply" in fixture.iacProgram, false);
});

test("fixture realizes Tigris object store, NATS queue, and Upstash cache defaults", () => {
  const provider = createFlyProvider();

  const fixture = provisionFlyFixture(provider, {
    app: "supporting-services",
    region: "iad",
    resources: [
      { id: "assets", type: "objectStore" },
      { id: "events", type: "queue" },
      { id: "sessions", type: "cache" }
    ]
  });

  assert.deepEqual(
    fixture.iacProgram.nodes.map((node) => [node.id, node.resourceClass, node.providerResource]),
    [
      ["assets", "tigris.bucket", "tigris"],
      ["events", "nats.stream", "nats"],
      ["sessions", "upstash.redis", "upstash"]
    ]
  );
});

test("same Bindle fixture deploys to Fly and surfaces Fly-only options in PortabilityReport", () => {
  const provider = createFlyProvider();
  const bindle = createPortableFlyBindle("orders");

  const planned = provider
    .with.machines({ vmSize: "shared-cpu-1x", minMachinesRunning: 1 })
    .with.postgres({ organization: "prod-org" })
    .realize({
      bindle,
      target: "fly",
      region: "iad",
      resources: bindle.resources
    });

  assert.equal(planned.status, "planned");
  assert.equal(planned.bindle.digest, bindle.digest);
  assert.equal(planned.iacProgram.provider, "fly");

  const validation = validatePortabilityReport(planned);
  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.deepEqual(
    planned.deploymentPlanned.portabilityReport.entries.map((entry) => [entry.category, entry.provider, entry.resourceId]),
    [
      ["provider-option", "fly", "web"],
      ["provider-option", "fly", "orders-db"]
    ]
  );
});

test("machine cold-start and region placement are explicit portability facts", () => {
  const provider = createFlyProvider();

  const planned = provider.with.machines({ minMachinesRunning: 0 }).realize({
    target: "fly",
    region: "iad",
    resources: [{ id: "web", type: "compute", image: "registry.example/web" }]
  });

  assert.equal(planned.status, "planned");
  assert.deepEqual(planned.iacProgram.nodes[0].placement, {
    region: "iad",
    coldStart: "allowed",
    minMachinesRunning: 0
  });
  assert.equal(
    planned.deploymentPlanned.portabilityReport.entries.some((entry) =>
      entry.detail.includes("cold-start")
    ),
    true
  );
});

test("Fly Postgres does not silently satisfy managed Postgres HA requirements", () => {
  const provider = createFlyProvider();

  assert.throws(
    () =>
      provider.realize({
        target: "fly",
        region: "iad",
        resources: [
          {
            id: "orders-db",
            type: "database",
            engine: "postgres",
            require: { ha: true }
          }
        ]
      }),
    /fly-postgres-ha-not-equivalent/
  );
});

test("database realization rejects non-Postgres engines", () => {
  const provider = createFlyProvider();

  assert.throws(
    () =>
      provider.realize({
        target: "fly",
        region: "iad",
        resources: [{ id: "orders-db", type: "database", engine: "mysql" }]
      }),
    /fly-database-engine-unsupported/
  );
});

test("compute realization rejects non-container runtimes", () => {
  const provider = createFlyProvider();

  assert.throws(
    () =>
      provider.realize({
        target: "fly",
        region: "iad",
        resources: [{ id: "worker", type: "compute", runtime: "wasm-component" }]
      }),
    /fly-compute-runtime-unsupported/
  );
});

test("Tigris S3 compatibility divergence is fail-closed for strict S3 features", () => {
  const provider = createFlyProvider();

  assert.throws(
    () =>
      provider.realize({
        target: "fly",
        region: "iad",
        resources: [
          {
            id: "assets",
            type: "objectStore",
            require: { strictS3Features: ["object-lock"] }
          }
        ]
      }),
    /tigris-s3-compat-divergence/
  );
});

test("regional volume cannot be planned where the attached Machine cannot reach it", () => {
  const provider = createFlyProvider();

  assert.throws(
    () =>
      provisionFlyFixture(provider, {
        app: "orders",
        region: "iad",
        resources: [
          { id: "web", type: "compute", image: "registry.example/orders:web", region: "iad" },
          { id: "orders-data", type: "volume", attachedTo: "web", region: "fra" }
        ]
      }),
    /fly-volume-region-unreachable/
  );
});

test("regional volume attachment fails closed when the target Machine is absent", () => {
  const provider = createFlyProvider();

  assert.throws(
    () =>
      provisionFlyFixture(provider, {
        app: "orders",
        region: "iad",
        resources: [{ id: "orders-data", type: "volume", attachedTo: "web", region: "iad" }]
      }),
    /fly-volume-attachment-missing/
  );
});
