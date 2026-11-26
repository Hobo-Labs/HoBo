import assert from "node:assert/strict";
import { test } from "vitest";

import { hoboVerify, runProviderCapabilitySuites } from "../../provider-capability-conformance-suites/src/provider-capability-conformance.js";
import { validateEmission } from "../../hobo-realize-emission-contract/src/realize-emission-contract.js";
import {
  AWS_PROVIDER_ID,
  aws,
  createAwsMultiCloudShopPlan,
  createAwsProvider,
  evaluateAwsPlan,
  mergeAwsResolvedOptions,
  realizeAwsPlan,
  simulateAwsApply
} from "../src/provider-aws.js";

test("factory publishes AWS seed capabilities, scoped option builders, defaults, and cost manifest", () => {
  const provider = createAwsProvider();
  const manifest = provider.capabilityManifest();
  const registry = [];

  provider.registerDefaultDefinitions(registry);

  assert.equal(provider.id, AWS_PROVIDER_ID);
  assert.deepEqual(
    provider.capabilities.map((capability) => capability.port),
    ["database", "objectStore", "compute", "queue", "cache"]
  );
  assert.deepEqual(
    Object.keys(provider.with).sort(),
    ["appRunner", "elasticache", "fargate", "rds", "s3", "sqs"]
  );
  assert.deepEqual(
    registry.map((definition) => [definition.id, definition.port, definition.resourceClass]),
    [
      ["aws.default.database.rds-aurora", "database", "aws:rds-aurora-postgres"],
      ["aws.default.objectStore.s3", "objectStore", "aws:s3-bucket"],
      ["aws.default.compute.fargate", "compute", "aws:fargate-service"],
      ["aws.default.compute.apprunner", "compute", "aws:apprunner-service"],
      ["aws.default.queue.sqs", "queue", "aws:sqs-queue"],
      ["aws.default.cache.elasticache", "cache", "aws:elasticache-redis"]
    ]
  );
  assert.equal(manifest.provider, AWS_PROVIDER_ID);
  assert.deepEqual(manifest.claimedCapabilities, ["database", "objectStore", "compute", "queue", "cache"]);
  assert.equal(manifest.auth.mode, "svid-federation");
  assert.equal(manifest.cost.currency, "USD");
  assert.equal(manifest.cost.facts.some((fact) => fact.sku === "aws.rds.aurora-postgres.acu-hour"), true);
  assert.deepEqual(
    manifest.capabilities.find((capability) => capability.port === "compute").resourceClasses,
    ["aws:fargate-service", "aws:apprunner-service"]
  );
  assert.deepEqual(aws.with.rds({ instanceClass: "db.t4g.medium", storageGb: 50 }), {
    providerId: "aws",
    port: "database",
    optionName: "rds",
    negotiation: "prefer",
    options: {
      engine: "postgres",
      instanceClass: "db.t4g.medium",
      storageGb: 50
    }
  });
});

test("AWS provider passes local and camp provider-capability conformance for every claimed port", () => {
  const provider = createAwsProvider({ campEvidence: "pass" });
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

test("multi-cloud-shop fixture realizes DB, bucket, compute, queue, and cache through Pulumi-shaped AWS nodes", () => {
  const provider = createAwsProvider();
  const plan = createAwsMultiCloudShopPlan({ region: "us-east-1" });
  const emission = realizeAwsPlan(provider, plan);
  const validation = validateEmission(emission);

  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(emission.provider, AWS_PROVIDER_ID);
  assert.deepEqual(
    emission.iac.nodes.map((node) => [node.id, node.resourceClass, node.driverIntent.iacProvider]),
    [
      ["orders-db", "aws:rds-aurora-postgres", "@hobo/iac-pulumi"],
      ["assets", "aws:s3-bucket", "@hobo/iac-pulumi"],
      ["jobs", "aws:sqs-queue", "@hobo/iac-pulumi"],
      ["session-cache", "aws:elasticache-redis", "@hobo/iac-pulumi"],
      ["web", "aws:fargate-service", "@hobo/iac-pulumi"]
    ]
  );
  assert.equal(emission.iac.links.length, 4);
  assert.equal(emission.build.artifacts[0].id, "web-image");
  assert.equal(emission.iac.nodes.find((node) => node.id === "web").inputs.env.ORDERS_DB_CONNECTION.startsWith("${resources.database"), true);
});

test("provider-scoped .with blocks only affect AWS-resolved resources", () => {
  const provider = createAwsProvider();
  const merged = mergeAwsResolvedOptions(provider, [
    aws.with.rds({ storageGb: 100, deletionProtection: true }),
    { providerId: "azure", port: "database", optionName: "postgres", negotiation: "require", options: { tier: "business" } }
  ]);
  const emission = realizeAwsPlan(
    provider,
    createAwsMultiCloudShopPlan({
      resourceOptions: {
        "orders-db": [aws.with.rds({ storageGb: 100, deletionProtection: true })],
        assets: [aws.with.s3({ versioning: true })],
        web: [aws.with.appRunner({ ingress: "public" })]
      }
    })
  );

  assert.equal(merged.merged.database.optionName, "rds");
  assert.equal(merged.dropped[0].providerId, "azure");
  assert.equal(emission.iac.nodes.find((node) => node.id === "orders-db").inputs.options.storageGb, 100);
  assert.equal(emission.iac.nodes.find((node) => node.id === "assets").inputs.options.versioning, true);
  assert.equal(emission.iac.nodes.find((node) => node.id === "jobs").inputs.options.versioning, undefined);
  assert.equal(emission.iac.nodes.find((node) => node.id === "web").resourceClass, "aws:apprunner-service");
  assert.equal(emission.iac.nodes.find((node) => node.id === "web").inputs.options.ingress, "public");
});

test("camp-only IAM, mTLS, and quota gaps do not hide behind local conformance", () => {
  const provider = createAwsProvider({ campEvidence: { database: { realProviderDrift: true, iam: false, mtls: true, quota: true } } });
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

test("unsupported regions, missing require facts, and quota exhaustion reject with precise reasons", () => {
  const provider = createAwsProvider();

  const badRegion = evaluateAwsPlan(
    provider,
    createAwsMultiCloudShopPlan({ region: "ap-south-2" })
  );
  assert.equal(badRegion.type, "deployment.PlanRejected");
  assert.equal(badRegion.reason.code, "aws-region-service-unavailable");
  assert.equal(badRegion.reason.resourceId, "orders-db");
  assert.match(badRegion.reason.message, /RDS\/Aurora is not available/);

  const appRunnerUnavailable = evaluateAwsPlan(
    createAwsProvider({
      serviceMatrix: {
        "us-east-1": [
          "aws:rds-aurora-postgres",
          "aws:s3-bucket",
          "aws:fargate-service",
          "aws:sqs-queue",
          "aws:elasticache-redis"
        ]
      }
    }),
    createAwsMultiCloudShopPlan({
      resourceOptions: {
        web: [aws.with.appRunner()]
      }
    })
  );
  assert.equal(appRunnerUnavailable.type, "deployment.PlanRejected");
  assert.equal(appRunnerUnavailable.reason.code, "aws-region-service-unavailable");
  assert.equal(appRunnerUnavailable.reason.resourceClass, "aws:apprunner-service");

  const unsupportedRequire = evaluateAwsPlan(
    provider,
    createAwsMultiCloudShopPlan({
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
  assert.equal(unsupportedRequire.reason.code, "aws-capability-require-unsatisfied");
  assert.deepEqual(unsupportedRequire.reason.missing, ["global-writes"]);

  const quota = simulateAwsApply(provider, createAwsMultiCloudShopPlan(), {
    quota: { compute: 0 }
  });
  assert.equal(quota.type, "deployment.PlanRejected");
  assert.equal(quota.reason.code, "aws-quota-exhausted");
  assert.equal(quota.reason.resourceId, "web");
});
