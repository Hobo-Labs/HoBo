import assert from "node:assert/strict";

import {
  contentAddressDeploymentSet,
  diffDeploymentSet,
  foldDeploymentProjections,
  validateEnvGroup,
  type DeploymentProjectionEvent,
  type ResourceMap,
} from "./projection-model.js";

const baseResources: ResourceMap = {
  "shop.api": {
    id: "shop.api",
    type: "service",
    port: "hobo:runtime/workflow",
    workload: { image: "registry.example/shop-api:v1" },
    match: {
      decisionId: "match-api-v1",
      definitionId: "service-prod-aws",
      catalogHash: "sha256:catalog-a",
    },
    replication: { topology: "pinned-single-camp", campId: "prod-aws" },
  },
  "shop.cache": {
    id: "shop.cache",
    type: "kv",
    port: "wasi:keyvalue/store",
    match: {
      decisionId: "match-cache-v1",
      definitionId: "elasticache-prod",
      catalogHash: "sha256:catalog-a",
    },
    replication: { topology: "single-writer-camp", ownerCampId: "prod-aws" },
  },
  "shop.db": {
    id: "shop.db",
    type: "database",
    port: "wasi:sql/postgres",
    match: {
      decisionId: "match-db-v1",
      definitionId: "rds-prod-ha",
      catalogHash: "sha256:catalog-a",
    },
    replication: { topology: "single-writer-camp", ownerCampId: "prod-aws" },
  },
};

const updatedApi = {
  ...baseResources["shop.api"]!,
  workload: { image: "registry.example/shop-api:v2" },
  match: { ...baseResources["shop.api"]!.match!, decisionId: "match-api-v2" },
};

const workerResource = {
  id: "shop.worker",
  type: "service",
  port: "hobo:runtime/workflow",
  workload: { image: "registry.example/shop-worker:v1" },
  match: {
    decisionId: "match-worker-v1",
    definitionId: "worker-prod-aws",
    catalogHash: "sha256:catalog-b",
  },
  replication: { topology: "pinned-single-camp", campId: "prod-aws" },
};

const envGroup = {
  id: "production",
  environmentType: "production",
  members: [
    { campId: "prod-aws", provider: "aws", optional: false },
    { campId: "prod-azure", provider: "azure", optional: true },
  ],
};

const fixtureEvents: DeploymentProjectionEvent[] = [
  {
    seq: 1,
    type: "set.Created",
    id: "evt-1",
    body: {
      setId: "set-prod-aws-v1",
      campId: "prod-aws",
      environmentType: "production",
      deploymentPlanId: "plan-1",
      manifestDigest: "sha256:manifest-v1",
      resources: baseResources,
      envGroup,
    },
  },
  {
    seq: 2,
    type: "delta.Opened",
    id: "evt-2",
    body: {
      deltaId: "delta-prod-aws-1",
      baseSetId: "set-prod-aws-v1",
      campId: "prod-aws",
    },
  },
  {
    seq: 3,
    type: "delta.Updated",
    id: "evt-3",
    body: {
      deltaId: "delta-prod-aws-1",
      changes: [
        { op: "update", resourceId: "shop.api", resource: updatedApi },
        { op: "remove", resourceId: "shop.cache" },
        { op: "add", resourceId: "shop.worker", resource: workerResource },
      ],
    },
  },
  {
    seq: 4,
    type: "delta.Applied",
    id: "evt-4",
    body: {
      deltaId: "delta-prod-aws-1",
      newSetId: "set-prod-aws-v2",
      deploymentPlanId: "plan-2",
      manifestDigest: "sha256:manifest-v2",
    },
  },
];

test("folds set.Created and delta.* into Set and Delta projections", () => {
  const projection = foldDeploymentProjections(fixtureEvents);

  assert.equal(projection.currentSetsByCamp["prod-aws"]!.id, "set-prod-aws-v2");
  assert.equal(projection.currentSetsByCamp["prod-aws"]!.previousSetId, "set-prod-aws-v1");
  assert.deepEqual(Object.keys(projection.currentSetsByCamp["prod-aws"]!.resources).sort(), [
    "shop.api",
    "shop.db",
    "shop.worker",
  ]);
  assert.equal(
    projection.currentSetsByCamp["prod-aws"]!.resources["shop.api"]!.workload!.image,
    "registry.example/shop-api:v2",
  );
  assert.equal(projection.deltas["delta-prod-aws-1"]!.status, "applied");
  assert.equal(projection.deltas["delta-prod-aws-1"]!.appliedSetId, "set-prod-aws-v2");
  assert.equal(projection.currentSetsByCamp["prod-aws"]!.envGroup!.id, "production");
});

test("computes a stable Set content address independent of object key order", () => {
  const first = foldDeploymentProjections(fixtureEvents).currentSetsByCamp["prod-aws"]!;
  const reordered = {
    environmentType: first.environmentType,
    id: first.id,
    resources: {
      "shop.worker": first.resources["shop.worker"]!,
      "shop.db": first.resources["shop.db"]!,
      "shop.api": first.resources["shop.api"]!,
    },
    manifestDigest: first.manifestDigest,
    campId: first.campId,
    deploymentPlanId: first.deploymentPlanId,
    previousSetId: first.previousSetId,
    envGroup: first.envGroup,
  };

  assert.equal(contentAddressDeploymentSet(first), contentAddressDeploymentSet(reordered));
});

test("computes add/update/remove changes between two Sets", () => {
  const before = foldDeploymentProjections([fixtureEvents[0]!]).currentSetsByCamp["prod-aws"]!;
  const after = foldDeploymentProjections(fixtureEvents).currentSetsByCamp["prod-aws"]!;

  assert.deepEqual(diffDeploymentSet(before, after), [
    { op: "update", resourceId: "shop.api", resource: updatedApi },
    { op: "remove", resourceId: "shop.cache" },
    { op: "add", resourceId: "shop.worker", resource: workerResource },
  ]);
});

test("rejects overlapping open Deltas for the same Camp and base Set", () => {
  assert.throws(
    () =>
      foldDeploymentProjections([
        fixtureEvents[0]!,
        fixtureEvents[1]!,
        {
          seq: 3,
          type: "delta.Opened",
          id: "evt-overlap",
          body: {
            deltaId: "delta-prod-aws-2",
            baseSetId: "set-prod-aws-v1",
            campId: "prod-aws",
          },
        },
      ]),
    /overlapping open delta/i,
  );
});

test("rejects opening a Delta against a stale non-current Set", () => {
  assert.throws(
    () =>
      foldDeploymentProjections([
        fixtureEvents[0]!,
        {
          seq: 2,
          type: "set.Created",
          id: "evt-new-current",
          body: {
            setId: "set-prod-aws-v2",
            campId: "prod-aws",
            environmentType: "production",
            deploymentPlanId: "plan-2",
            manifestDigest: "sha256:manifest-v2",
            resources: {
              "shop.api": updatedApi,
              "shop.db": baseResources["shop.db"]!,
            },
            envGroup,
          },
        },
        {
          seq: 3,
          type: "delta.Opened",
          id: "evt-stale",
          body: {
            deltaId: "delta-prod-aws-stale",
            baseSetId: "set-prod-aws-v1",
            campId: "prod-aws",
          },
        },
      ]),
    /current Set/i,
  );
});

test("rejects Delta changes that reference a resource absent from the current Set", () => {
  assert.throws(
    () =>
      foldDeploymentProjections([
        fixtureEvents[0]!,
        fixtureEvents[1]!,
        {
          seq: 3,
          type: "delta.Updated",
          id: "evt-missing",
          body: {
            deltaId: "delta-prod-aws-1",
            changes: [{ op: "remove", resourceId: "shop.ghost" }],
          },
        },
      ]),
    /absent resource/i,
  );
});

test("rejects out-of-order delta events", () => {
  assert.throws(
    () =>
      foldDeploymentProjections([
        fixtureEvents[0]!,
        {
          seq: 2,
          type: "delta.Updated",
          id: "evt-out-of-order",
          body: {
            deltaId: "delta-prod-aws-1",
            changes: [{ op: "remove", resourceId: "shop.cache" }],
          },
        },
      ]),
    /before delta.Opened/i,
  );
});

test("validates env-group membership as a Yard-level orchestration type", () => {
  assert.deepEqual(validateEnvGroup(envGroup), envGroup);

  assert.throws(
    () =>
      validateEnvGroup({
        id: "production",
        environmentType: "production",
        members: [{ campId: "prod-aws", provider: "aws" }, { campId: "prod-aws", provider: "aws" }],
      }),
    /duplicate camp/i,
  );
});

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}
