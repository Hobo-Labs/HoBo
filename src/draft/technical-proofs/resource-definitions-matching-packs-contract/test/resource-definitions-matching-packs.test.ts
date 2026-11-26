import assert from "node:assert/strict";
import { test } from "vitest";

import {
  contentAddressDeploymentSet,
} from "../../../../../docs/design/proofs/hobo-50-deployment-set-delta/projection-model.ts";
import {
  createAwsResourcePack,
  createAzureResourcePack,
  createFixtureTrustBoundary,
  defaultMultiCloudCamps,
  defaultShopManifest,
  installResourcePacks,
  matchResourceWithEvidence,
  planMultiCloudShop,
  promoteDeltaToSet,
  yardToMatchingCatalog,
} from "../src/resource-definitions-matching-packs.ts";
import { createResourceCatalog } from "../../resource-definition-driver-contract/src/resource-definition-driver-contract.js";
import { createYard } from "../../resource-pack-distribution-contract/src/resource-pack-distribution.js";

const { signingKey, trustBoundary } = createFixtureTrustBoundary();

const productionShopDbContext = Object.freeze({
  resourceType: "database",
  resourceClass: "ha",
  resourceId: "shop.db",
  app: "shop",
  tenant: "acme",
  env: "prod-us",
  envType: "production",
});

test("matching selects the expected definition with its specificity score and match.Decided evidence", () => {
  const catalog = createResourceCatalog({ id: "platform-defaults" });
  for (const definition of [
    { id: "provider.default", type: "database", provider: "aws", driver: "terraform", match: {} },
    {
      id: "prod.ha",
      type: "database",
      provider: "aws",
      driver: "terraform",
      match: { envType: "production", resourceClass: "ha" },
    },
    {
      id: "shop.prod.ha",
      type: "database",
      provider: "aws",
      driver: "terraform",
      match: { envType: "production", app: "shop", resourceClass: "ha" },
    },
  ]) {
    catalog.register(definition);
  }

  const matched = matchResourceWithEvidence({
    catalog,
    context: productionShopDbContext,
  });

  assert.equal(matched.ok, true);
  assert.equal(matched.decision.winner.id, "shop.prod.ha");
  assert.equal(matched.winnerScore, 3);
  assert.deepEqual(
    matched.ranking.map((entry) => ({ id: entry.definitionId, score: entry.specificity })),
    [
      { id: "shop.prod.ha", score: 3 },
      { id: "prod.ha", score: 2 },
      { id: "provider.default", score: 0 },
    ],
  );
  assert.equal(matched.eventValid, true);
  assert.equal(matched.event.type, "match.Decided");
  assert.equal(matched.event.data.winner, "shop.prod.ha");
  assert.equal(matched.event.data.catalogContentHash, matched.decision.catalogContentHash);
});

test("promoting a delta yields the expected immutable Set with incremental reconcile nodes", () => {
  const replication = { topology: "pinned-single-camp", campId: "prod-aws" };
  const baseResources = {
    "shop.api": {
      id: "shop.api",
      type: "api",
      port: "service.http",
      workload: { image: "registry.example/shop-api:v1" },
      match: { decisionId: "match-api-v1", definitionId: "aws.shop.api", catalogHash: "sha256:catalog-a" },
      replication,
    },
    "shop.db": {
      id: "shop.db",
      type: "database",
      port: "wasi:sql/postgres",
      match: { decisionId: "match-db-v1", definitionId: "aws.shop.database", catalogHash: "sha256:catalog-a" },
      replication: { topology: "single-writer-camp", ownerCampId: "prod-aws" },
    },
    "shop.cache": {
      id: "shop.cache",
      type: "kv",
      port: "wasi:keyvalue/store",
      match: { decisionId: "match-cache-v1", definitionId: "aws.default.kv", catalogHash: "sha256:catalog-a" },
      replication,
    },
  };
  const updatedApi = {
    ...baseResources["shop.api"],
    workload: { image: "registry.example/shop-api:v2" },
    match: { ...baseResources["shop.api"].match, decisionId: "match-api-v2" },
  };
  const workerResource = {
    id: "shop.worker",
    type: "service",
    port: "hobo:runtime/workflow",
    workload: { image: "registry.example/shop-worker:v1" },
    match: { decisionId: "match-worker-v1", definitionId: "aws.shop.worker", catalogHash: "sha256:catalog-b" },
    replication,
  };

  const result = promoteDeltaToSet({
    baseSet: {
      setId: "set-shop-prod-v1",
      campId: "prod-aws",
      environmentType: "production",
      deploymentPlanId: "plan-1",
      manifestDigest: "sha256:manifest-v1",
      resources: baseResources,
    },
    deltaId: "delta-shop-prod-1",
    newSetId: "set-shop-prod-v2",
    deploymentPlanId: "plan-2",
    manifestDigest: "sha256:manifest-v2",
    deltaChanges: [
      { op: "update", resourceId: "shop.api", resource: updatedApi },
      { op: "remove", resourceId: "shop.cache" },
      { op: "add", resourceId: "shop.worker", resource: workerResource },
    ],
  });

  assert.equal(result.delta.status, "applied");
  assert.equal(result.appliedEvent.type, "delta.Applied");
  assert.equal(result.appliedEvent.data.deltaId, "delta-shop-prod-1");
  assert.equal(result.appliedEvent.data.resultingSetId, "set-shop-prod-v2");
  assert.equal(result.appliedEventValid, true);
  assert.equal(result.newSet.id, "set-shop-prod-v2");
  assert.equal(result.newSet.previousSetId, "set-shop-prod-v1");
  assert.deepEqual(Object.keys(result.newSet.resources).sort(), ["shop.api", "shop.db", "shop.worker"]);
  assert.equal(result.newSet.resources["shop.api"].workload.image, "registry.example/shop-api:v2");
  assert.ok(result.contentAddress.startsWith("sha256:"));
  assert.deepEqual(result.incrementalNodes.sort(), ["shop.api", "shop.cache", "shop.worker"]);
  assert.deepEqual(result.changes.map((change) => change.op + ":" + change.resourceId), [
    "update:shop.api",
    "remove:shop.cache",
    "add:shop.worker",
  ]);

  const reordered = {
    ...result.newSet,
    resources: {
      "shop.worker": result.newSet.resources["shop.worker"],
      "shop.db": result.newSet.resources["shop.db"],
      "shop.api": result.newSet.resources["shop.api"],
    },
  };
  assert.equal(contentAddressDeploymentSet(result.newSet), contentAddressDeploymentSet(reordered));
});

test("installed pack definitions are selected in a multi-cloud shop plan", () => {
  const awsPack = createAwsResourcePack(signingKey);
  const azurePack = createAzureResourcePack(signingKey);
  const installed = installResourcePacks({
    yard: createYard({ yardId: "yard.multi-cloud-shop" }),
    packs: [awsPack, azurePack],
    trustBoundary,
  });

  assert.equal(installed.ok, true, installed.reasons?.join("\n"));
  assert.deepEqual(installed.installed, ["@hobo/aws-shop-defaults", "@hobo/azure-shop-defaults"]);

  const plan = planMultiCloudShop({
    yard: installed.yard,
    camps: defaultMultiCloudCamps(),
    manifest: defaultShopManifest(),
  });

  assert.equal(plan.ok, true);
  const awsPlan = plan.plans.find((entry) => entry.campId === "prod-aws");
  const azurePlan = plan.plans.find((entry) => entry.campId === "prod-azure");

  assert.equal(awsPlan.resources.find((resource) => resource.id === "shop.db")?.definitionId, "aws.shop.database");
  assert.equal(awsPlan.resources.find((resource) => resource.id === "shop.api")?.definitionId, "aws.shop.api");
  assert.equal(azurePlan.resources.find((resource) => resource.id === "shop.db")?.definitionId, "azure.shop.database");
  assert.equal(azurePlan.resources.find((resource) => resource.id === "shop.api")?.definitionId, "azure.shop.api");

  assert.ok(awsPlan.resources.every((resource) => resource.winnerScore >= 2));
  assert.ok(azurePlan.resources.every((resource) => resource.winnerScore >= 2));
  assert.ok(awsPlan.matchEvents.every((event) => event.type === "match.Decided"));
  assert.ok(azurePlan.matchEvents.every((event) => event.type === "match.Decided"));

  const awsCatalog = yardToMatchingCatalog(installed.yard, { providerFilter: "aws" });
  const azureCatalog = yardToMatchingCatalog(installed.yard, { providerFilter: "azure" });
  assert.ok(awsCatalog.snapshot().definitions.length >= 4);
  assert.ok(azureCatalog.snapshot().definitions.length >= 4);
});
