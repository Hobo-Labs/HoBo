import assert from "node:assert/strict";
import { test } from "vitest";

import { hoboVerify, runProviderCapabilitySuites } from "../../provider-capability-conformance-suites/src/provider-capability-conformance.js";
import { validateEmission } from "../../hobo-realize-emission-contract/src/realize-emission-contract.js";
import { createAwsMultiCloudShopPlan, createAwsProvider, realizeAwsPlan } from "../../provider-aws-contract/src/provider-aws.js";
import {
  AZURE_PROVIDER_ID,
  IAC_PULUMI_DRIVER,
  azure,
  createAzureMultiCloudShopPlan,
  createAzureProvider,
  evaluateAzurePlan,
  mergeAzureResolvedOptions,
  realizeAzurePlan,
  simulateAzureApply
} from "../src/provider-azure.js";

test("factory publishes Azure seed capabilities, scoped option builders, defaults, and cost manifest", () => {
  const provider = createAzureProvider();
  const manifest = provider.capabilityManifest();
  const registry = [];

  provider.registerDefaultDefinitions(registry);

  assert.equal(provider.id, AZURE_PROVIDER_ID);
  assert.deepEqual(
    provider.capabilities.map((capability) => capability.port),
    ["database", "objectStore", "compute", "queue", "cache"]
  );
  assert.deepEqual(
    Object.keys(provider.with).sort(),
    ["blob", "cacheForRedis", "containerApp", "flexiblePostgres", "serviceBus"]
  );
  assert.deepEqual(
    registry.map((definition) => [definition.id, definition.port, definition.resourceClass]),
    [
      ["azure.default.database.flexible-postgres", "database", "azure:postgres-flexible-server"],
      ["azure.default.objectStore.blob", "objectStore", "azure:storage-blob-container"],
      ["azure.default.compute.container-app", "compute", "azure:container-app"],
      ["azure.default.queue.service-bus", "queue", "azure:service-bus-queue"],
      ["azure.default.cache.redis", "cache", "azure:cache-for-redis"]
    ]
  );
  assert.equal(manifest.provider, AZURE_PROVIDER_ID);
  assert.deepEqual(manifest.claimedCapabilities, ["database", "objectStore", "compute", "queue", "cache"]);
  assert.equal(manifest.auth.mode, "svid-federation");
  assert.equal(manifest.cost.currency, "USD");
  assert.equal(manifest.cost.facts.some((fact) => fact.sku === "azure.postgres.flexible.vcore-hour"), true);
  assert.deepEqual(
    manifest.capabilities.find((capability) => capability.port === "compute").resourceClasses,
    ["azure:container-app"]
  );
  assert.deepEqual(azure.with.flexiblePostgres({ sku: "GP_Standard_D2s_v3", storageGb: 64 }), {
    providerId: "azure",
    port: "database",
    optionName: "flexiblePostgres",
    negotiation: "prefer",
    options: {
      engine: "postgres",
      version: "16",
      sku: "GP_Standard_D2s_v3",
      storageGb: 64
    }
  });
});

test("Azure provider passes local and camp provider-capability conformance for every claimed port", () => {
  const provider = createAzureProvider({ campEvidence: "pass" });
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

test("multi-cloud-shop fixture realizes DB, blob, compute, queue, and cache through Pulumi-shaped Azure nodes", () => {
  const provider = createAzureProvider();
  const plan = createAzureMultiCloudShopPlan({ region: "eastus" });
  const emission = realizeAzurePlan(provider, plan);
  const validation = validateEmission(emission);

  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(emission.provider, AZURE_PROVIDER_ID);
  assert.deepEqual(
    emission.iac.nodes.map((node) => [node.id, node.resourceClass, node.driverIntent.iacProvider]),
    [
      ["orders-db", "azure:postgres-flexible-server", IAC_PULUMI_DRIVER],
      ["assets", "azure:storage-blob-container", IAC_PULUMI_DRIVER],
      ["jobs", "azure:service-bus-queue", IAC_PULUMI_DRIVER],
      ["session-cache", "azure:cache-for-redis", IAC_PULUMI_DRIVER],
      ["web", "azure:container-app", IAC_PULUMI_DRIVER]
    ]
  );
  assert.equal(emission.iac.links.length, 4);
  assert.equal(emission.build.artifacts[0].id, "web-image");
  assert.equal(emission.iac.nodes.find((node) => node.id === "web").inputs.env.ORDERS_DB_CONNECTION.startsWith("${resources.database"), true);
});

test("multi-cloud-shop fixture preserves topology and bindings against the existing AWS provider proof", () => {
  const awsEmission = realizeAwsPlan(createAwsProvider(), createAwsMultiCloudShopPlan());
  const azureEmission = realizeAzurePlan(createAzureProvider(), createAzureMultiCloudShopPlan());

  assert.deepEqual(portableRecord(azureEmission), portableRecord(awsEmission));
});

test("provider-scoped .with blocks only affect Azure-resolved resources and report Azure-only features", () => {
  const provider = createAzureProvider();
  const merged = mergeAzureResolvedOptions(provider, [
    azure.with.flexiblePostgres({ storageGb: 128, zoneRedundantHa: true }),
    { providerId: "aws", port: "database", optionName: "rds", negotiation: "require", options: { multiAz: true } }
  ]);
  const emission = realizeAzurePlan(
    provider,
    createAzureMultiCloudShopPlan({
      resourceOptions: {
        "orders-db": [azure.with.flexiblePostgres({ storageGb: 128, zoneRedundantHa: true })],
        assets: [azure.with.blob({ immutableStorage: true })],
        web: [azure.with.containerApp({ ingress: "external", daprEnabled: true })]
      }
    })
  );

  assert.equal(merged.merged.database.optionName, "flexiblePostgres");
  assert.equal(merged.dropped[0].providerId, "aws");
  assert.equal(emission.iac.nodes.find((node) => node.id === "orders-db").inputs.options.storageGb, 128);
  assert.equal(emission.iac.nodes.find((node) => node.id === "assets").inputs.options.immutableStorage, true);
  assert.equal(emission.iac.nodes.find((node) => node.id === "jobs").inputs.options.immutableStorage, undefined);
  assert.deepEqual(emission.portabilityReport.entries, [
    {
      id: "orders-db.provider-option.azure.zoneRedundantHa",
      category: "provider-option",
      severity: "target-scoped",
      resourceId: "orders-db",
      provider: "azure",
      path: "resources.orders-db.with.azure.zoneRedundantHa",
      detail: "Azure Flexible Server zone-redundant HA requires target provider support.",
      gateEffect: "target-provider-must-satisfy"
    },
    {
      id: "assets.provider-option.azure.immutableStorage",
      category: "provider-option",
      severity: "target-scoped",
      resourceId: "assets",
      provider: "azure",
      path: "resources.assets.with.azure.immutableStorage",
      detail: "Azure Blob immutable storage is provider-specific retention behavior.",
      gateEffect: "target-provider-must-satisfy"
    },
    {
      id: "web.provider-option.azure.daprEnabled",
      category: "provider-option",
      severity: "target-scoped",
      resourceId: "web",
      provider: "azure",
      path: "resources.web.with.azure.daprEnabled",
      detail: "Azure Container Apps Dapr sidecars require Azure Container Apps support.",
      gateEffect: "target-provider-must-satisfy"
    }
  ]);
});

test("provider-managed App Service certs are explicit portability findings, not hidden defaults", () => {
  const provider = createAzureProvider();
  const plan = createAzureMultiCloudShopPlan({
    resources: [
      {
        id: "web",
        type: "compute",
        className: "container",
        options: [azure.with.containerApp({ providerManagedCertificate: "app-service-managed" })]
      }
    ]
  });
  const evaluation = evaluateAzurePlan(provider, plan);
  const emission = realizeAzurePlan(provider, plan);

  assert.equal(evaluation.type, "deployment.Planned");
  assert.equal(emission.portabilityReport.entries[0].id, "web.provider-option.azure.providerManagedCertificate");
  assert.match(emission.portabilityReport.entries[0].detail, /ADR-0035/);
});

test("adversarial service availability, roles mismatch, and quota exhaustion reject with precise reasons", () => {
  const provider = createAzureProvider();

  const badRegion = evaluateAzurePlan(
    provider,
    createAzureMultiCloudShopPlan({ region: "centralindia" })
  );
  assert.equal(badRegion.type, "deployment.PlanRejected");
  assert.equal(badRegion.reason.code, "azure-region-service-unavailable");
  assert.equal(badRegion.reason.resourceId, "orders-db");
  assert.match(badRegion.reason.message, /Flexible Server is not available/);

  const missingRole = evaluateAzurePlan(
    provider,
    createAzureMultiCloudShopPlan({
      resources: [
        {
          id: "orders-db",
          type: "database",
          className: "postgres",
          require: ["postgres", "managed"],
          requiredRoles: ["Microsoft.DBforPostgreSQL/flexibleServers/write", "Owner"]
        }
      ]
    })
  );
  assert.equal(missingRole.reason.code, "azure-role-mapping-unsupported");
  assert.deepEqual(missingRole.reason.missingRoles, ["Owner"]);

  const unsupportedRequire = evaluateAzurePlan(
    provider,
    createAzureMultiCloudShopPlan({
      resources: [
        {
          id: "orders-db",
          type: "database",
          className: "postgres",
          require: ["postgres", "global-writes"]
        }
      ]
    })
  );
  assert.equal(unsupportedRequire.reason.code, "azure-capability-require-unsatisfied");
  assert.deepEqual(unsupportedRequire.reason.missing, ["global-writes"]);

  const quota = simulateAzureApply(provider, createAzureMultiCloudShopPlan(), {
    quota: { compute: 0 }
  });
  assert.equal(quota.type, "deployment.PlanRejected");
  assert.equal(quota.reason.code, "azure-quota-throttling");
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
