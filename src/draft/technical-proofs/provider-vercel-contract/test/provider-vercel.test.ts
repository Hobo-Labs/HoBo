import assert from "node:assert/strict";
import { test } from "vitest";

import {
  hoboVerify,
  runProviderCapabilitySuites
} from "../../provider-capability-conformance-suites/src/provider-capability-conformance.js";

import {
  createRecordedVercelCampEvidence,
  createVercelFixturePlan,
  createVercelProvider,
  runVercelProviderContract,
  validateVercelPlanReadiness,
  validateVercelPortabilityReport,
  vercel
} from "../src/provider-vercel.js";

test("factory publishes Vercel capabilities, scoped .with builders, manifest, and defaults", () => {
  const provider = createVercelProvider({
    projectPrefix: "shop",
    campEvidence: createRecordedVercelCampEvidence()
  });
  const registry = [];
  provider.registerDefaultDefinitions(registry);

  assert.equal(provider.id, "@hobo/provider-vercel");
  assert.deepEqual(Object.keys(provider.with).sort(), [
    "blob",
    "edgeConfig",
    "function",
    "neonPostgres",
    "upstashKv",
    "web"
  ]);

  assert.deepEqual(
    provider.capabilities.map((capability) => capability.port),
    ["compute", "objectStore", "database", "kv"]
  );
  assert.deepEqual(
    provider.capabilityManifest().claimedCapabilities,
    ["compute", "objectStore", "database"]
  );
  assert.equal(
    provider.capabilityManifest().capabilities.find((capability) => capability.port === "database").integrationBacked,
    true
  );

  assert.deepEqual(
    registry.map((definition) => definition.id),
    [
      "vercel.compute.web-ssr",
      "vercel.compute.edge-function",
      "vercel.compute.serverless-function",
      "vercel.objectStore.blob",
      "vercel.database.neon-postgres",
      "vercel.kv.upstash"
    ]
  );

  assert.deepEqual(vercel.with.web({ project: "shop-web", framework: "nextjs" }), {
    providerId: "@hobo/provider-vercel",
    port: "compute",
    resourceClass: "web-ssr",
    optionName: "web",
    project: "shop-web",
    framework: "nextjs",
    runtime: "nodejs20.x",
    regions: ["iad1"],
    service: "vercel:web"
  });
});

test("realize emits Vercel CLI/Terraform intents for SSR web, edge function, Blob, and marketplace DB/KV", () => {
  const provider = createVercelProvider({
    projectPrefix: "shop",
    campEvidence: createRecordedVercelCampEvidence()
  });

  const emission = provider.realize(createVercelFixturePlan());

  assert.equal(emission.provider, "@hobo/provider-vercel");
  assert.deepEqual(
    emission.iac.nodes.map((node) => [node.id, node.driver, node.resourceClass]),
    [
      ["web", "vercel-cli:project", "web-ssr"],
      ["api", "vercel-cli:function", "edge-function"],
      ["assets", "terraform:vercel_blob_store", "vercel-blob"],
      ["db", "marketplace:neon", "neon-postgres"],
      ["kv", "marketplace:upstash", "upstash-kv"]
    ]
  );
  assert.deepEqual(emission.iac.links, [
    { component: "web", providerNode: "api", capability: "compute", reason: "same-vercel-project" },
    { component: "web", providerNode: "assets", capability: "objectStore", reason: "runtime-binding" },
    { component: "web", providerNode: "db", capability: "database", reason: "marketplace-binding" },
    { component: "api", providerNode: "kv", capability: "kv", reason: "marketplace-binding" }
  ]);

  const reportValidation = validateVercelPortabilityReport(emission.deploymentPlanned.portabilityReport);
  assert.equal(reportValidation.ok, true, reportValidation.errors.join("\n"));
  assert.deepEqual(
    emission.deploymentPlanned.portabilityReport.entries.map((entry) => [
      entry.resourceId,
      entry.category,
      entry.integration
    ]),
    [
      ["db", "integration-backed", "neon"],
      ["kv", "integration-backed", "upstash"]
    ]
  );
});

test("realize emits serverless function intents as a Vercel function class", () => {
  const provider = createVercelProvider({
    projectPrefix: "shop",
    campEvidence: createRecordedVercelCampEvidence()
  });

  const emission = provider.realize(
    createVercelFixturePlan({
      overrides: {
        api: {
          className: "serverless-function",
          request: vercel.with.function({
            runtime: "nodejs20.x",
            entrypoint: "api/serverless.ts",
            maxDurationSeconds: 60
          })
        }
      }
    })
  );

  assert.deepEqual(
    emission.iac.nodes.find((node) => node.id === "api"),
    {
      id: "api",
      type: "compute",
      resourceClass: "serverless-function",
      provider: "@hobo/provider-vercel",
      service: "vercel:serverless-function",
      driver: "vercel-cli:function",
      inputs: {
        entrypoint: "api/serverless.ts",
        runtime: "nodejs20.x",
        regions: ["iad1"],
        maxDurationSeconds: 60
      },
      outputs: ["url", "functionId", "region"]
    }
  );
});

test("provider-specific .with blocks only affect Vercel-resolved resources", () => {
  const provider = createVercelProvider();
  const plan = createVercelFixturePlan({
    extraOptionBlocks: [
      vercel.with.blob({ store: "media" }),
      { providerId: "@hobo/provider-aws", port: "objectStore", optionName: "s3", bucket: "media" }
    ]
  });

  const resolved = provider.resolveProviderOptions(plan.extraOptionBlocks);

  assert.deepEqual(Object.keys(resolved.merged).sort(), ["objectStore"]);
  assert.deepEqual(resolved.dropped, [
    {
      providerId: "@hobo/provider-aws",
      port: "objectStore",
      optionName: "s3",
      reason: "option block belongs to unresolved provider @hobo/provider-aws"
    }
  ]);
});

test("Vercel provider passes shared local plus recorded camp conformance for seed claims", () => {
  const provider = createVercelProvider({
    campEvidence: createRecordedVercelCampEvidence()
  });
  const capabilities = provider.capabilityManifest().claimedCapabilities;

  const local = runProviderCapabilitySuites(provider, { capabilities, tags: ["local"] });
  assert.equal(local.status, "pass", JSON.stringify(local.failures, null, 2));

  const full = hoboVerify(provider, {
    capabilities,
    runTags: ["local", "camp"],
    claimProdReady: true
  });
  assert.equal(full.status, "pass", JSON.stringify(full.failures, null, 2));

  assert.deepEqual(runVercelProviderContract(provider), {
    ok: true,
    checked: ["compute", "objectStore", "database", "kv"]
  });
});

test("marketplace integrations and camp evidence fail closed when absent", () => {
  const provider = createVercelProvider();
  const emission = provider.realize(createVercelFixturePlan());

  const readiness = validateVercelPlanReadiness(emission, {
    registeredIntegrations: ["upstash"]
  });
  assert.equal(readiness.ok, false);
  assert.match(readiness.errors.join("\n"), /marketplace integration neon is not registered/);

  const full = hoboVerify(provider, {
    capabilities: provider.capabilityManifest().claimedCapabilities,
    runTags: ["local", "camp"],
    claimProdReady: true
  });
  assert.equal(full.status, "fail");
  assert.match(
    full.failures.map((failure) => failure.message).join("\n"),
    /camp evidence must prove real-provider drift detection/
  );
  assert.match(
    full.failures.map((failure) => failure.message).join("\n"),
    /camp evidence must include IAM, mTLS, and quota checks/
  );
});

test("unsupported Vercel requirements and provider divergences produce precise denials", () => {
  const provider = createVercelProvider();

  assert.deepEqual(provider.negotiate("database", { require: { native: true } }), {
    requireSatisfied: false,
    preferHonored: [],
    missing: ["native-database"],
    reason: "database is integration-backed through Neon, not native Vercel"
  });
  assert.deepEqual(provider.negotiate("objectStore", { require: { s3Compatible: true } }), {
    requireSatisfied: false,
    preferHonored: [],
    missing: ["s3-compatible-api"],
    reason: "Vercel Blob does not expose the full S3-compatible API"
  });

  assert.throws(
    () =>
      provider.realize(
        createVercelFixturePlan({
          overrides: {
            api: {
              request: vercel.with.function({ runtime: "edge", regions: ["fra1"], maxDurationSeconds: 120 })
            }
          }
        })
      ),
    /edge functions support maxDurationSeconds <= 30/
  );
  assert.throws(
    () =>
      provider.realize(
        createVercelFixturePlan({
          overrides: {
            web: {
              request: vercel.with.web({ project: "shop-web", regions: ["antarctica1"] })
            }
          }
        })
      ),
    /unsupported Vercel region antarctica1/
  );
});
