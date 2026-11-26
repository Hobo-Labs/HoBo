import assert from "node:assert/strict";
import { test } from "vitest";

import { hoboVerify, runProviderCapabilitySuites } from "../../provider-capability-conformance-suites/src/provider-capability-conformance.js";
import { validateEmission } from "../../hobo-realize-emission-contract/src/realize-emission-contract.js";
import {
  CLOUDFLARE_PROVIDER_ID,
  CLOUDFLARE_TERRAFORM_DRIVER,
  CLOUDFLARE_WRANGLER_DRIVER,
  cloudflare,
  createCloudflareEdgeShopPlan,
  createCloudflareProvider,
  evaluateCloudflarePlan,
  mergeCloudflareResolvedOptions,
  realizeCloudflarePlan,
  simulateCloudflareApply
} from "../src/provider-cloudflare.js";

test("factory publishes Cloudflare seed capabilities, scoped option builders, defaults, and cost manifest", () => {
  const provider = createCloudflareProvider();
  const manifest = provider.capabilityManifest();
  const registry = [];

  provider.registerDefaultDefinitions(registry);

  assert.equal(provider.id, CLOUDFLARE_PROVIDER_ID);
  assert.deepEqual(
    provider.capabilities.map((capability) => capability.port),
    ["compute", "objectStore", "database", "kv", "queue", "dns"]
  );
  assert.deepEqual(
    Object.keys(provider.with).sort(),
    ["d1", "dns", "hyperdrivePostgres", "kv", "queues", "r2", "worker"]
  );
  assert.deepEqual(
    registry.map((definition) => [definition.id, definition.port, definition.resourceClass]),
    [
      ["cloudflare.default.compute.workers", "compute", "cloudflare:workers-script"],
      ["cloudflare.default.objectStore.r2", "objectStore", "cloudflare:r2-bucket"],
      ["cloudflare.default.database.d1", "database", "cloudflare:d1-database"],
      ["cloudflare.default.database.hyperdrive-postgres", "database", "cloudflare:hyperdrive-postgres"],
      ["cloudflare.default.kv.namespace", "kv", "cloudflare:kv-namespace"],
      ["cloudflare.default.queue.queues", "queue", "cloudflare:queue"],
      ["cloudflare.default.dns.record", "dns", "cloudflare:dns-record"]
    ]
  );
  assert.equal(manifest.provider, CLOUDFLARE_PROVIDER_ID);
  assert.deepEqual(manifest.claimedCapabilities, ["compute", "objectStore", "database", "kv", "queue", "dns"]);
  assert.equal(manifest.auth.mode, "svid-federation");
  assert.equal(manifest.hostRuntime.providerNativeWasm, "opt-in");
  assert.equal(manifest.cost.currency, "USD");
  assert.equal(manifest.cost.facts.some((fact) => fact.sku === "cloudflare.workers.request"), true);
  assert.deepEqual(
    manifest.capabilities.find((capability) => capability.port === "compute").drivers,
    [CLOUDFLARE_WRANGLER_DRIVER, CLOUDFLARE_TERRAFORM_DRIVER]
  );
  assert.deepEqual(cloudflare.with.worker({ cpuMs: 15_000, smartPlacement: true }), {
    providerId: "cloudflare",
    port: "compute",
    optionName: "worker",
    negotiation: "prefer",
    options: {
      compatibilityDate: "2026-01-01",
      cpuMs: 15_000,
      memoryMb: 128,
      scriptSizeMb: 3,
      smartPlacement: true
    }
  });
});

test("Cloudflare provider passes provider-capability conformance for every claimed standard port plus explicit kv evidence", () => {
  const provider = createCloudflareProvider({ campEvidence: "pass" });
  const capabilities = provider.capabilityManifest().claimedCapabilities;
  const standardCapabilities = capabilities.filter((capability) => capability !== "kv");
  const report = runProviderCapabilitySuites(provider, {
    capabilities: standardCapabilities,
    tags: ["local", "camp"]
  });
  const verify = hoboVerify(provider, {
    capabilities: standardCapabilities,
    runTags: ["local", "camp"],
    claimProdReady: true
  });
  const kv = provider.verifyKvEvidence({ tags: ["local", "camp"] });

  assert.equal(report.status, "pass");
  assert.deepEqual(report.coverage.local.capabilities, [...standardCapabilities].sort());
  assert.deepEqual(report.coverage.camp.capabilities, [...standardCapabilities].sort());
  assert.equal(verify.status, "pass");
  assert.equal(verify.prodReady.status, "pass");
  assert.equal(kv.status, "pass");
  assert.deepEqual(kv.tags, ["local", "camp"]);
});

test("edge-shop fixture realizes Worker, R2, D1, KV, Queues, and DNS through Wrangler/Terraform-shaped nodes", () => {
  const provider = createCloudflareProvider();
  const plan = createCloudflareEdgeShopPlan({ colo: "WNAM" });
  const emission = realizeCloudflarePlan(provider, plan);
  const validation = validateEmission(emission);

  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(emission.provider, CLOUDFLARE_PROVIDER_ID);
  assert.deepEqual(
    emission.iac.nodes.map((node) => [node.id, node.resourceClass, node.driverIntent.iacProvider]),
    [
      ["worker", "cloudflare:workers-script", CLOUDFLARE_WRANGLER_DRIVER],
      ["assets", "cloudflare:r2-bucket", CLOUDFLARE_TERRAFORM_DRIVER],
      ["app-db", "cloudflare:d1-database", CLOUDFLARE_TERRAFORM_DRIVER],
      ["sessions", "cloudflare:kv-namespace", CLOUDFLARE_TERRAFORM_DRIVER],
      ["jobs", "cloudflare:queue", CLOUDFLARE_TERRAFORM_DRIVER],
      ["app-domain", "cloudflare:dns-record", CLOUDFLARE_TERRAFORM_DRIVER]
    ]
  );
  assert.equal(emission.iac.links.length, 5);
  assert.equal(emission.build.artifacts[0].id, "worker-wasm");
  assert.equal(emission.build.artifacts[0].target, "wasm-component");
  assert.equal(emission.iac.nodes.find((node) => node.id === "worker").inputs.bindings.ASSETS_BUCKET.startsWith("${resources.objectStore"), true);
});

test("provider-scoped .with blocks only affect Cloudflare resources and report Cloudflare-only features", () => {
  const provider = createCloudflareProvider();
  const merged = mergeCloudflareResolvedOptions(provider, [
    cloudflare.with.worker({ cpuMs: 20_000, smartPlacement: true }),
    { providerId: "aws", port: "compute", optionName: "fargate", negotiation: "require", options: { cpu: 2 } }
  ]);
  const emission = realizeCloudflarePlan(
    provider,
    createCloudflareEdgeShopPlan({
      resourceOptions: {
        worker: [cloudflare.with.worker({ smartPlacement: true, cpuMs: 20_000 })],
        assets: [cloudflare.with.r2({ jurisdiction: "eu", s3Compatibility: "aws-sdk-v3-basic" })],
        "app-domain": [cloudflare.with.dns({ proxied: true })]
      }
    })
  );

  assert.equal(merged.merged.compute.optionName, "worker");
  assert.equal(merged.dropped[0].providerId, "aws");
  assert.equal(emission.iac.nodes.find((node) => node.id === "worker").inputs.options.smartPlacement, true);
  assert.equal(emission.iac.nodes.find((node) => node.id === "assets").inputs.options.jurisdiction, "eu");
  assert.equal(emission.iac.nodes.find((node) => node.id === "jobs").inputs.options.jurisdiction, undefined);
  assert.deepEqual(
    emission.portabilityReport.entries.map((entry) => [entry.id, entry.category, entry.severity]),
    [
      ["worker.provider-option.cloudflare.smartPlacement", "provider-option", "target-scoped"],
      ["assets.provider-option.cloudflare.r2S3Compatibility", "provider-option", "target-scoped"],
      ["app-domain.provider-option.cloudflare.proxiedDns", "provider-option", "target-scoped"]
    ]
  );
});

test("postgres managed require rejects while prefer degrades through Hyperdrive or Neon", () => {
  const provider = createCloudflareProvider();
  const required = evaluateCloudflarePlan(
    provider,
    createCloudflareEdgeShopPlan({
      resources: [
        {
          id: "orders-db",
          type: "database",
          className: "postgres",
          require: ["postgres", "managed"]
        }
      ]
    })
  );
  const preferredPlan = createCloudflareEdgeShopPlan({
    resources: [
      {
        id: "orders-db",
        type: "database",
        className: "postgres",
        prefer: ["postgres", "managed"],
        options: [cloudflare.with.hyperdrivePostgres({ backingProvider: "neon" })]
      }
    ]
  });
  const preferred = evaluateCloudflarePlan(provider, preferredPlan);
  const emission = realizeCloudflarePlan(provider, preferredPlan);

  assert.equal(required.type, "deployment.PlanRejected");
  assert.equal(required.reason.code, "cloudflare-postgres-require-partial");
  assert.equal(preferred.type, "deployment.Planned");
  assert.equal(preferred.warnings[0].code, "cloudflare-postgres-prefer-degraded");
  assert.equal(emission.portabilityReport.entries[0].category, "degradation");
  assert.equal(emission.portabilityReport.entries[0].resourceId, "orders-db");
});

test("adversarial capability gaps reject with precise Cloudflare reasons", () => {
  const provider = createCloudflareProvider();

  const strongSql = evaluateCloudflarePlan(
    provider,
    createCloudflareEdgeShopPlan({
      resources: [
        {
          id: "ledger",
          type: "database",
          className: "d1",
          require: ["sql", "strong-consistency"]
        }
      ]
    })
  );
  assert.equal(strongSql.reason.code, "cloudflare-d1-strong-consistency-partial");

  const strictS3 = evaluateCloudflarePlan(
    provider,
    createCloudflareEdgeShopPlan({
      resources: [
        {
          id: "assets",
          type: "objectStore",
          className: "bucket",
          require: ["durable", "s3-etag-md5", "s3-read-after-overwrite"]
        }
      ]
    })
  );
  assert.equal(strictS3.reason.code, "cloudflare-r2-s3-compat-divergence");
  assert.deepEqual(strictS3.reason.missing, ["s3-etag-md5", "s3-read-after-overwrite"]);

  const workerLimit = evaluateCloudflarePlan(
    provider,
    createCloudflareEdgeShopPlan({
      resourceOptions: {
        worker: [cloudflare.with.worker({ cpuMs: 60_000, scriptSizeMb: 12 })]
      }
    })
  );
  assert.equal(workerLimit.reason.code, "cloudflare-worker-limit-exceeded");
  assert.equal(workerLimit.reason.limits.cpuMs, 30_000);

  const unsafeDns = evaluateCloudflarePlan(
    provider,
    createCloudflareEdgeShopPlan({
      resources: [
        {
          id: "app-domain",
          type: "dns",
          className: "record",
          require: ["authoritative"]
        }
      ]
    })
  );
  assert.equal(unsafeDns.reason.code, "cloudflare-dns-safe-rollout-required");
  assert.match(unsafeDns.reason.message, /ADR-0035/);
});

test("apply simulation reports Cloudflare account quota before pretending to execute drivers", () => {
  const provider = createCloudflareProvider();
  const result = simulateCloudflareApply(provider, createCloudflareEdgeShopPlan(), {
    accountQuota: { compute: 0 }
  });

  assert.equal(result.type, "deployment.PlanRejected");
  assert.equal(result.reason.code, "cloudflare-account-quota-exhausted");
  assert.equal(result.reason.resourceId, "worker");
});
