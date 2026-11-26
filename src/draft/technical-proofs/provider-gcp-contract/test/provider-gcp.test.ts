import assert from "node:assert/strict";
import { test } from "vitest";

import { hoboVerify, runProviderCapabilitySuites } from "../../provider-capability-conformance-suites/src/provider-capability-conformance.js";
import { validateEmission } from "../../hobo-realize-emission-contract/src/realize-emission-contract.js";
import { createAwsMultiCloudShopPlan, createAwsProvider, realizeAwsPlan } from "../../provider-aws-contract/src/provider-aws.js";
import {
  GCP_PROVIDER_ID,
  createGcpMultiCloudShopPlan,
  createGcpProvider,
  evaluateGcpPlan,
  gcp,
  mergeGcpResolvedOptions,
  realizeGcpPlan,
  simulateGcpApply
} from "../src/provider-gcp.js";

test("factory publishes GCP seed capabilities, scoped option builders, defaults, and cost manifest", () => {
  const provider = createGcpProvider();
  const manifest = provider.capabilityManifest();
  const registry = [];

  provider.registerDefaultDefinitions(registry);

  assert.equal(provider.id, GCP_PROVIDER_ID);
  assert.deepEqual(
    provider.capabilities.map((capability) => capability.port),
    ["database", "objectStore", "compute", "queue", "cache"]
  );
  assert.deepEqual(
    Object.keys(provider.with).sort(),
    ["cloudRun", "cloudSql", "gcs", "memorystore", "pubSub"]
  );
  assert.deepEqual(
    registry.map((definition) => [definition.id, definition.port, definition.resourceClass]),
    [
      ["gcp.default.database.cloud-sql-postgres", "database", "gcp:cloud-sql-postgres"],
      ["gcp.default.objectStore.gcs", "objectStore", "gcp:gcs-bucket"],
      ["gcp.default.compute.cloud-run", "compute", "gcp:cloud-run-service"],
      ["gcp.default.queue.pubsub", "queue", "gcp:pubsub-topic"],
      ["gcp.default.cache.memorystore", "cache", "gcp:memorystore-redis"]
    ]
  );
  assert.equal(manifest.provider, GCP_PROVIDER_ID);
  assert.deepEqual(manifest.claimedCapabilities, ["database", "objectStore", "compute", "queue", "cache"]);
  assert.equal(manifest.auth.mode, "svid-federation");
  assert.equal(manifest.cost.currency, "USD");
  assert.equal(manifest.cost.facts.some((fact) => fact.sku === "gcp.cloud-sql.postgres.instance-hour"), true);
  assert.deepEqual(
    manifest.capabilities.find((capability) => capability.port === "compute").resourceClasses,
    ["gcp:cloud-run-service"]
  );
  assert.deepEqual(gcp.with.cloudSql({ tier: "db-custom-2-7680", storageGb: 50 }), {
    providerId: "gcp",
    port: "database",
    optionName: "cloudSql",
    negotiation: "prefer",
    options: {
      databaseVersion: "POSTGRES_16",
      tier: "db-custom-2-7680",
      storageGb: 50
    }
  });
});

test("GCP provider passes local and camp provider-capability conformance for every claimed port", () => {
  const provider = createGcpProvider({ campEvidence: "pass" });
  const capabilities = provider.capabilityManifest().claimedCapabilities;
  const report = runProviderCapabilitySuites(provider, {
    capabilities,
    tags: ["local", "camp"]
  });
  const verify = hoboVerify(provider, {
    capabilities,
    runTags: ["local", "camp"],
    claimProdReady: true
  });

  assert.equal(report.status, "pass");
  assert.deepEqual(report.coverage.local.capabilities, [...capabilities].sort());
  assert.deepEqual(report.coverage.camp.capabilities, [...capabilities].sort());
  assert.equal(verify.status, "pass");
  assert.equal(verify.prodReady.status, "pass");
});

test("multi-cloud-shop fixture realizes DB, bucket, compute, queue, and cache through Pulumi-shaped GCP nodes", () => {
  const provider = createGcpProvider();
  const plan = createGcpMultiCloudShopPlan({ region: "us-central1" });
  const emission = realizeGcpPlan(provider, plan);
  const validation = validateEmission(emission);

  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(emission.provider, GCP_PROVIDER_ID);
  assert.deepEqual(
    emission.iac.nodes.map((node) => [node.id, node.resourceClass, node.driverIntent.iacProvider]),
    [
      ["orders-db", "gcp:cloud-sql-postgres", "@hobo/iac-pulumi"],
      ["assets", "gcp:gcs-bucket", "@hobo/iac-pulumi"],
      ["jobs", "gcp:pubsub-topic", "@hobo/iac-pulumi"],
      ["session-cache", "gcp:memorystore-redis", "@hobo/iac-pulumi"],
      ["web", "gcp:cloud-run-service", "@hobo/iac-pulumi"]
    ]
  );
  assert.equal(emission.iac.links.length, 4);
  assert.equal(emission.build.artifacts[0].id, "web-image");
  assert.equal(emission.iac.nodes.find((node) => node.id === "web").inputs.env.ORDERS_DB_CONNECTION.startsWith("${resources.database"), true);
});

test("multi-cloud-shop fixture preserves topology and bindings against the existing AWS provider proof", () => {
  const awsEmission = realizeAwsPlan(createAwsProvider(), createAwsMultiCloudShopPlan());
  const gcpEmission = realizeGcpPlan(createGcpProvider(), createGcpMultiCloudShopPlan());

  assert.deepEqual(portableRecord(gcpEmission), portableRecord(awsEmission));
});

test("provider-scoped .with blocks only affect GCP-resolved resources and report GCP-only features", () => {
  const provider = createGcpProvider();
  const merged = mergeGcpResolvedOptions(provider, [
    gcp.with.cloudSql({ storageGb: 100, deletionProtection: true }),
    { providerId: "aws", port: "database", optionName: "rds", negotiation: "require", options: { multiAz: true } }
  ]);
  const emission = realizeGcpPlan(
    provider,
    createGcpMultiCloudShopPlan({
      resourceOptions: {
        "orders-db": [gcp.with.cloudSql({ storageGb: 100, deletionProtection: true })],
        assets: [gcp.with.gcs({ uniformBucketLevelAccess: true })],
        web: [gcp.with.cloudRun({ ingress: "internal-and-cloud-load-balancing", cpuAlwaysAllocated: true })]
      }
    })
  );

  assert.equal(merged.merged.database.optionName, "cloudSql");
  assert.equal(merged.dropped[0].providerId, "aws");
  assert.equal(emission.iac.nodes.find((node) => node.id === "orders-db").inputs.options.storageGb, 100);
  assert.equal(emission.iac.nodes.find((node) => node.id === "assets").inputs.options.uniformBucketLevelAccess, true);
  assert.equal(emission.iac.nodes.find((node) => node.id === "jobs").inputs.options.uniformBucketLevelAccess, undefined);
  assert.deepEqual(emission.portabilityReport.entries, [
    {
      id: "web.provider-option.gcp.cpuAlwaysAllocated",
      category: "provider-option",
      severity: "target-scoped",
      resourceId: "web",
      provider: "gcp",
      path: "resources.web.with.gcp.cpuAlwaysAllocated",
      detail: "GCP-only Cloud Run CPU allocation requires target provider support.",
      gateEffect: "target-provider-must-satisfy"
    }
  ]);
});

test("camp-only service-account IAM gaps do not hide behind local conformance", () => {
  const provider = createGcpProvider({ campEvidence: { database: { realProviderDrift: true, iam: false, mtls: true, quota: true } } });
  const local = runProviderCapabilitySuites(provider, {
    capabilities: ["database"],
    tags: ["local"]
  });
  const camp = runProviderCapabilitySuites(provider, {
    capabilities: ["database"],
    tags: ["camp"]
  });

  assert.equal(local.status, "pass");
  assert.equal(camp.status, "fail");
  assert.equal(camp.failures[0].checkId, "database.camp.iam-mtls-quota-evidence");
  assert.match(camp.failures[0].message, /IAM, mTLS, and quota/);
});

test("unsupported regions, missing require facts, and project quota exhaustion reject with precise reasons", () => {
  const provider = createGcpProvider();

  const badRegion = evaluateGcpPlan(
    provider,
    createGcpMultiCloudShopPlan({ region: "northamerica-northeast2" })
  );
  assert.equal(badRegion.type, "deployment.PlanRejected");
  assert.equal(badRegion.reason.code, "gcp-region-service-unavailable");
  assert.equal(badRegion.reason.resourceId, "orders-db");
  assert.match(badRegion.reason.message, /Cloud SQL PostgreSQL is not available/);

  const missingMemorystore = evaluateGcpPlan(
    createGcpProvider({
      serviceMatrix: {
        "us-central1": [
          "gcp:cloud-sql-postgres",
          "gcp:gcs-bucket",
          "gcp:cloud-run-service",
          "gcp:pubsub-topic"
        ]
      }
    }),
    createGcpMultiCloudShopPlan()
  );
  assert.equal(missingMemorystore.type, "deployment.PlanRejected");
  assert.equal(missingMemorystore.reason.code, "gcp-region-service-unavailable");
  assert.equal(missingMemorystore.reason.resourceClass, "gcp:memorystore-redis");

  const unsupportedRequire = evaluateGcpPlan(
    provider,
    createGcpMultiCloudShopPlan({
      resources: [
        {
          id: "orders-db",
          type: "database",
          className: "postgres",
          require: ["postgres", "alloydb"]
        }
      ]
    })
  );
  assert.equal(unsupportedRequire.reason.code, "gcp-capability-require-unsatisfied");
  assert.deepEqual(unsupportedRequire.reason.missing, ["alloydb"]);

  const quota = simulateGcpApply(provider, createGcpMultiCloudShopPlan(), {
    projectQuota: { compute: 0 }
  });
  assert.equal(quota.type, "deployment.PlanRejected");
  assert.equal(quota.reason.code, "gcp-project-quota-exhausted");
  assert.equal(quota.reason.resourceId, "web");
});

function portableRecord(emission) {
  return {
    resources: emission.iac.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      className: node.className
    })),
    links: emission.iac.links.map((link) => ({
      component: link.component,
      import: link.import,
      providerNode: link.providerNode,
      capability: link.capability
    })),
    build: emission.build.artifacts.map((artifact) => ({
      id: artifact.id,
      source: artifact.source,
      target: artifact.target,
      outputKind: artifact.outputKind
    }))
  };
}
