import assert from "node:assert/strict";
import { test } from "vitest";

import { hoboVerify, runProviderCapabilitySuites } from "../../provider-capability-conformance-suites/src/provider-capability-conformance.js";
import { validateEmission } from "../../hobo-realize-emission-contract/src/realize-emission-contract.js";
import {
  AZURE_PROVIDER_ID,
  FULL_CAPABILITY_PORTS,
  IAC_PULUMI_DRIVER,
  azureFull,
  createAzureFullMultiCloudShopPlan,
  createAzureFullProvider,
  createConformanceAdapter,
  evaluateAzureFullPlan,
  ingestAzureCapabilityManifest,
  mergeAzureFullResolvedOptions,
  realizeAzureFullPlan,
  runExtendedPortConformance,
  simulateAzureFullApply
} from "../src/provider-azure-full.js";

test("factory publishes full S4 capability catalog, equivalence classes, builders, and workload-identity auth", () => {
  const provider = createAzureFullProvider();
  const manifest = provider.capabilityManifest();
  const bundle = provider.publishManifestBundle();
  const registry = [];

  provider.registerDefaultDefinitions(registry);

  assert.equal(provider.id, AZURE_PROVIDER_ID);
  assert.deepEqual(provider.manifest.claimedCapabilities, [...FULL_CAPABILITY_PORTS]);
  assert.deepEqual(
    Object.keys(provider.with).sort(),
    ["blob", "containerApp", "flexiblePostgres", "keyVault", "serviceBusQueue", "serviceBusTopic", "staticWebApp", "tableStorage"]
  );
  assert.equal(registry.length, FULL_CAPABILITY_PORTS.length);
  assert.equal(manifest.auth.mode, "workload-identity-federation");
  assert.equal(manifest.auth.staticSecrets, false);
  assert.equal(bundle["auth.json"].staticSecrets, false);
  assert.equal(
    bundle["auth.json"].flows.some((flow) => flow.type === "workload-identity-federation"),
    true
  );
  assert.equal(bundle["capabilities.json"].equivalence["sql{postgres}"], "azure.postgres.flexible");
  assert.equal(bundle["capabilities.json"].ports.length, FULL_CAPABILITY_PORTS.length);
});

test("registry ingest accepts signed manifest bundle with brokered workload-identity auth only", () => {
  const provider = createAzureFullProvider();
  const registry = new Map();
  const result = ingestAzureCapabilityManifest(registry, provider.publishManifestBundle());

  assert.equal(result.ok, true, result.reasons?.join("\n"));
  assert.equal(result.includes.includes("auth.json"), true);
  assert.equal(registry.get(AZURE_PROVIDER_ID).authMode, "workload-identity-federation");
  assert.deepEqual(registry.get(AZURE_PROVIDER_ID).claimedPorts, [...FULL_CAPABILITY_PORTS]);
});

test("registry ingest rejects static-secret auth manifests", () => {
  const provider = createAzureFullProvider();
  const bundle = provider.publishManifestBundle();
  bundle["auth.json"] = { ...bundle["auth.json"], staticSecrets: true };
  const result = ingestAzureCapabilityManifest(new Map(), bundle);

  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ["auth.staticSecrets.forbidden"]);
});

test("registry ingest rejects manifests missing workload-identity-federation", () => {
  const provider = createAzureFullProvider();
  const bundle = provider.publishManifestBundle();
  bundle["auth.json"] = { ...bundle["auth.json"], flows: [] };
  const result = ingestAzureCapabilityManifest(new Map(), bundle);

  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ["auth.workload-identity-federation.required"]);
});

test("bridged provider-capability conformance passes local and camp for seed-mapped ports", () => {
  const provider = createAzureFullProvider({ campEvidence: "pass" });
  const adapter = createConformanceAdapter(provider);
  const capabilities = adapter.manifest.claimedCapabilities;
  const report = runProviderCapabilitySuites(adapter, {
    capabilities,
    tags: ["local", "camp"]
  });
  const verify = hoboVerify(adapter, {
    capabilities,
    runTags: ["local", "camp"],
    claimProdReady: true
  });

  assert.equal(report.status, "pass", report.failures.map((failure) => failure.message).join("\n"));
  assert.equal(verify.status, "pass");
  assert.equal(verify.prodReady.status, "pass");
});

test("extended conformance covers web, topic, and secret ports without seed suites", () => {
  const provider = createAzureFullProvider();
  const report = runExtendedPortConformance(provider);

  assert.equal(report.status, "pass", report.failures.map((failure) => failure.message).join("\n"));
});

test("multi-cloud-shop full fixture realizes all eight ports through Pulumi-shaped Azure nodes", () => {
  const provider = createAzureFullProvider();
  const plan = createAzureFullMultiCloudShopPlan({ region: "eastus" });
  const emission = realizeAzureFullPlan(provider, plan);
  const validation = validateEmission(emission);

  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(emission.provider, AZURE_PROVIDER_ID);
  assert.equal(emission.iac.nodes.length, 8);
  assert.deepEqual(
    emission.iac.nodes.map((node) => [node.id, node.resourceClass, node.driverIntent.iacProvider]),
    [
      ["shop-web", "azure:static-web-app", IAC_PULUMI_DRIVER],
      ["orders-db", "azure:postgres-flexible-server", IAC_PULUMI_DRIVER],
      ["assets", "azure:storage-blob-container", IAC_PULUMI_DRIVER],
      ["jobs", "azure:service-bus-queue", IAC_PULUMI_DRIVER],
      ["events", "azure:service-bus-topic", IAC_PULUMI_DRIVER],
      ["session-kv", "azure:table-storage", IAC_PULUMI_DRIVER],
      ["api-keys", "azure:key-vault-secret", IAC_PULUMI_DRIVER],
      ["api", "azure:container-app", IAC_PULUMI_DRIVER]
    ]
  );
  assert.equal(emission.iac.links.length, 6);
  assert.equal(emission.build.artifacts[0].id, "api-image");
});

test("provider-scoped .with blocks only affect Azure-resolved resources and report Azure-only features", () => {
  const provider = createAzureFullProvider();
  const merged = mergeAzureFullResolvedOptions(provider, [
    azureFull.with.flexiblePostgres({ storageGb: 128, zoneRedundantHa: true }),
    { providerId: "aws", port: "sql", optionName: "rds", negotiation: "require", options: { multiAz: true } }
  ]);
  const emission = realizeAzureFullPlan(
    provider,
    createAzureFullMultiCloudShopPlan({
      resourceOptions: {
        "orders-db": [azureFull.with.flexiblePostgres({ storageGb: 128, zoneRedundantHa: true })],
        assets: [azureFull.with.blob({ immutableStorage: true })],
        api: [azureFull.with.containerApp({ ingress: "external", daprEnabled: true })]
      }
    })
  );

  assert.equal(merged.merged.sql.optionName, "flexiblePostgres");
  assert.equal(merged.dropped[0].providerId, "aws");
  assert.equal(emission.portabilityReport.entries.some((entry) => entry.id.includes("zoneRedundantHa")), true);
  assert.equal(emission.portabilityReport.entries.some((entry) => entry.id.includes("immutableStorage")), true);
  assert.equal(emission.portabilityReport.entries.some((entry) => entry.id.includes("daprEnabled")), true);
});

test("adversarial availability, role mismatch, require miss, and quota exhaustion reject precisely", () => {
  const provider = createAzureFullProvider();

  const badRegion = evaluateAzureFullPlan(
    provider,
    createAzureFullMultiCloudShopPlan({ region: "centralindia" })
  );
  assert.equal(badRegion.type, "deployment.PlanRejected");
  assert.equal(badRegion.reason.code, "azure-region-service-unavailable");
  assert.equal(badRegion.reason.resourceId, "shop-web");

  const missingRole = evaluateAzureFullPlan(
    provider,
    createAzureFullMultiCloudShopPlan({
      resources: [
        {
          id: "orders-db",
          type: "sql",
          className: "postgres",
          require: ["postgres", "managed"],
          requiredRoles: ["Microsoft.DBforPostgreSQL/flexibleServers/write", "Owner"]
        }
      ]
    })
  );
  assert.equal(missingRole.reason.code, "azure-role-mapping-unsupported");
  assert.deepEqual(missingRole.reason.missingRoles, ["Owner"]);

  const unsupportedRequire = evaluateAzureFullPlan(
    provider,
    createAzureFullMultiCloudShopPlan({
      resources: [
        {
          id: "orders-db",
          type: "sql",
          className: "postgres",
          require: ["postgres", "global-writes"]
        }
      ]
    })
  );
  assert.equal(unsupportedRequire.reason.code, "azure-capability-require-unsatisfied");
  assert.deepEqual(unsupportedRequire.reason.missing, ["global-writes"]);

  const quota = simulateAzureFullApply(provider, createAzureFullMultiCloudShopPlan(), {
    quota: { service: 0 }
  });
  assert.equal(quota.type, "deployment.PlanRejected");
  assert.equal(quota.reason.code, "azure-quota-throttling");
  assert.equal(quota.reason.resourceId, "api");
});

test("non-resolved provider .with options are inert for Azure planning", () => {
  const provider = createAzureFullProvider();
  const merged = mergeAzureFullResolvedOptions(provider, [
    { providerId: "aws", port: "bucket", optionName: "s3", options: { versioning: true } },
    azureFull.with.blob({ versioning: true })
  ]);

  assert.equal(Object.keys(merged.merged).length, 1);
  assert.equal(merged.merged.bucket.optionName, "blob");
  assert.equal(merged.dropped.length, 1);
});
