import assert from "node:assert/strict";
import { test } from "vitest";

import { validateEmission } from "../../hobo-realize-emission-contract/src/realize-emission-contract.js";
import {
  AWS_FULL_CATALOG_PORTS,
  AWS_PROVIDER_ID,
  awsFull,
  createAwsFullCatalogProvider,
  createAwsFullCatalogShopPlan,
  evaluateAwsFullCatalogPlan,
  ingestAwsCapabilityManifest,
  mergeAwsFullResolvedOptions,
  realizeAwsFullCatalogPlan,
  runAwsFullCatalogConformance,
  simulateBrokeredKeylessApply,
  verifyAwsFullCatalog
} from "../src/provider-aws-full-catalog.js";

test("factory publishes full catalog ports, equivalence mappings, typed builders, and OIDC auth.json", () => {
  const provider = createAwsFullCatalogProvider();
  const manifest = provider.capabilityManifest();
  const authJson = provider.publishAuthJson();
  const registry = [];

  provider.registerDefaultDefinitions(registry);

  assert.equal(provider.id, AWS_PROVIDER_ID);
  assert.deepEqual(provider.catalogPorts, [...AWS_FULL_CATALOG_PORTS]);
  assert.deepEqual(
    Object.keys(provider.with).sort(),
    ["appRunner", "dynamodb", "elasticache", "fargate", "rds", "s3", "secretsmanager", "sns", "sqs"]
  );
  assert.equal(manifest.auth.staticSecrets, false);
  assert.equal(manifest.auth.authJson.flows[0].type, "oidc-federation");
  assert.equal(authJson.brokerTargets.bucket.flow, "oidc-federation");
  assert.equal(manifest.equivalence.bucket.providerService, "S3");
  assert.equal(manifest.equivalence.sql.witPort, "wasi:sql/database");
  assert.deepEqual(
    registry.map((definition) => [definition.id, definition.port, definition.resourceClass]),
    [
      ["aws.default.web-service.fargate", "web/service", "aws:fargate-service"],
      ["aws.default.web-service.apprunner", "web/service", "aws:apprunner-service"],
      ["aws.default.kv.dynamodb", "kv", "aws:dynamodb-table"],
      ["aws.default.kv.elasticache", "kv", "aws:elasticache-redis"],
      ["aws.default.bucket.s3", "bucket", "aws:s3-bucket"],
      ["aws.default.queue.sqs", "queue", "aws:sqs-queue"],
      ["aws.default.topic.sns", "topic", "aws:sns-topic"],
      ["aws.default.sql.rds-aurora", "sql", "aws:rds-aurora-postgres"],
      ["aws.default.secret.secretsmanager", "secret", "aws:secretsmanager-secret"]
    ]
  );
});

test("registry ingest accepts signed manifest bundle with brokered OIDC-federation auth only", () => {
  const provider = createAwsFullCatalogProvider();
  const registry = new Map();
  const result = ingestAwsCapabilityManifest(registry, provider.publishManifestBundle());

  assert.equal(result.ok, true, result.reasons?.join("\n"));
  assert.equal(result.includes.includes("auth.json"), true);
  assert.equal(registry.get(AWS_PROVIDER_ID).authMode, "brokered-oidc");
  assert.deepEqual(registry.get(AWS_PROVIDER_ID).claimedPorts, [...AWS_FULL_CATALOG_PORTS]);
});

test("registry ingest rejects static-secret auth manifests", () => {
  const provider = createAwsFullCatalogProvider();
  const bundle = provider.publishManifestBundle();
  bundle["auth.json"] = { ...bundle["auth.json"], staticSecrets: true };
  const result = ingestAwsCapabilityManifest(new Map(), bundle);

  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ["auth.staticSecrets.forbidden"]);
});

test("registry ingest rejects manifests missing OIDC-federation", () => {
  const provider = createAwsFullCatalogProvider();
  const bundle = provider.publishManifestBundle();
  bundle["auth.json"] = { ...bundle["auth.json"], flows: [] };
  const result = ingestAwsCapabilityManifest(new Map(), bundle);

  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ["auth.oidc-federation.required"]);
});

test("registry ingest rejects S3 broker manifests without OIDC-federation target", () => {
  const provider = createAwsFullCatalogProvider();
  const bundle = provider.publishManifestBundle();
  bundle["auth.json"] = {
    ...bundle["auth.json"],
    brokerTargets: { bucket: { flow: "api-key" } }
  };
  const result = ingestAwsCapabilityManifest(new Map(), bundle);

  assert.equal(result.ok, false);
  assert.deepEqual(result.reasons, ["auth.broker.bucket.oidc-federation.required"]);
});

test("AWS full catalog provider passes provider-capability conformance for every claimed port", () => {
  const provider = createAwsFullCatalogProvider({ campEvidence: "pass" });
  const report = runAwsFullCatalogConformance(provider, { tags: ["local", "camp"] });
  const verify = verifyAwsFullCatalog(provider, { tags: ["local", "camp"], claimProdReady: true });

  assert.equal(report.status, "pass", report.failures.map((failure) => failure.message).join("\n"));
  assert.equal(verify.status, "pass");
  assert.equal(verify.seedVerify.prodReady.status, "pass");
});

test("multi-cloud-shop fixture realizes all seven catalog ports through Pulumi-shaped AWS nodes", () => {
  const provider = createAwsFullCatalogProvider();
  const plan = createAwsFullCatalogShopPlan({ region: "us-east-1" });
  const emission = realizeAwsFullCatalogPlan(provider, plan);
  const validation = validateEmission(emission);

  assert.equal(validation.ok, true, validation.errors.join("\n"));
  assert.equal(emission.provider, AWS_PROVIDER_ID);
  assert.deepEqual(
    emission.iac.nodes.map((node) => [node.id, node.type, node.resourceClass, node.driverIntent.iacProvider]),
    [
      ["orders-db", "sql", "aws:rds-aurora-postgres", "@hobo/iac-pulumi"],
      ["assets", "bucket", "aws:s3-bucket", "@hobo/iac-pulumi"],
      ["jobs", "queue", "aws:sqs-queue", "@hobo/iac-pulumi"],
      ["events", "topic", "aws:sns-topic", "@hobo/iac-pulumi"],
      ["sessions", "kv", "aws:dynamodb-table", "@hobo/iac-pulumi"],
      ["app-secrets", "secret", "aws:secretsmanager-secret", "@hobo/iac-pulumi"],
      ["web", "web/service", "aws:fargate-service", "@hobo/iac-pulumi"]
    ]
  );
  assert.equal(emission.iac.links.length, 6);
  assert.equal(emission.build.artifacts[0].id, "web-image");
});

test("provider-scoped .with blocks only affect AWS-resolved resources", () => {
  const provider = createAwsFullCatalogProvider();
  const merged = mergeAwsFullResolvedOptions(provider, [
    awsFull.with.rds({ storageGb: 100 }),
    { providerId: "azure", port: "sql", optionName: "postgres", negotiation: "require", options: { tier: "business" } }
  ]);
  const emission = realizeAwsFullCatalogPlan(
    provider,
    createAwsFullCatalogShopPlan({
      resourceOptions: {
        "orders-db": [awsFull.with.rds({ storageGb: 100 })],
        assets: [awsFull.with.s3({ versioning: true })],
        web: [awsFull.with.appRunner({ ingress: "public" })]
      }
    })
  );

  assert.equal(merged.merged.sql.optionName, "rds");
  assert.equal(merged.dropped[0].providerId, "azure");
  assert.equal(emission.iac.nodes.find((node) => node.id === "orders-db").inputs.options.storageGb, 100);
  assert.equal(emission.iac.nodes.find((node) => node.id === "web").resourceClass, "aws:apprunner-service");
});

test("brokered keyless apply succeeds with OIDC-federation S3 broker and no static secrets", () => {
  const provider = createAwsFullCatalogProvider();
  const plan = createAwsFullCatalogShopPlan();
  const applied = simulateBrokeredKeylessApply(provider, plan);

  assert.equal(applied.type, "deployment.Applied");
  assert.equal(applied.auth.mode, "brokered-oidc");
  assert.equal(applied.auth.staticSecrets, false);
  assert.equal(applied.auth.flow, "oidc-federation");
  assert.deepEqual(applied.auth.auditEvents, ["token.Granted", "token.Used", "token.Revoked"]);
});

test("adversarial cases reject api-key-only auth, unsupported regions, and unsatisfied require facts", () => {
  const provider = createAwsFullCatalogProvider();

  const badRegion = evaluateAwsFullCatalogPlan(
    provider,
    createAwsFullCatalogShopPlan({ region: "ap-south-2" })
  );
  assert.equal(badRegion.type, "deployment.PlanRejected");
  assert.equal(badRegion.reason.code, "aws-region-service-unavailable");

  const unsupportedRequire = evaluateAwsFullCatalogPlan(
    provider,
    createAwsFullCatalogShopPlan({
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
  assert.equal(unsupportedRequire.reason.code, "aws-capability-require-unsatisfied");
  assert.deepEqual(unsupportedRequire.reason.missing, ["global-writes"]);

  const apiKeyProvider = createAwsFullCatalogProvider();
  const originalPublish = apiKeyProvider.publishAuthJson.bind(apiKeyProvider);
  apiKeyProvider.publishAuthJson = () => ({
    ...originalPublish(),
    flows: [{ type: "api-key", header: "X-Api-Key" }]
  });
  const rejected = simulateBrokeredKeylessApply(apiKeyProvider, createAwsFullCatalogShopPlan());
  assert.equal(rejected.type, "deployment.PlanRejected");
  assert.equal(rejected.reason.code, "aws-broker-static-secret");

  const quota = simulateBrokeredKeylessApply(provider, createAwsFullCatalogShopPlan(), {
    quota: { "web/service": 0 }
  });
  assert.equal(quota.reason.code, "aws-quota-exhausted");
});
