import assert from "node:assert/strict";
import { test } from "vitest";

import {
  applyDeltaToSet,
  buildReconcilePlan,
  createDeploymentSet,
  planEnvGroupPromote,
  planRollbackToSet,
} from "../src/delta-set-apply-reconcile.js";

const baseResources = {
  "shop.api": resource("shop.api", "service", {
    deps: ["shop.db", "shop.cache"],
    workload: { image: "registry.example/shop-api:v1" },
  }),
  "shop.cache": resource("shop.cache", "kv"),
  "shop.db": resource("shop.db", "database"),
};

const baseSet = createDeploymentSet({
  id: "set-prod-aws-v1",
  campId: "prod-aws",
  environmentType: "production",
  manifestDigest: "sha256:manifest-v1",
  resources: baseResources,
});

test("applying a Delta produces a content-addressed Set and reconciles only changed nodes", () => {
  const result = applyDeltaToSet({
    baseSet,
    delta: {
      id: "delta-prod-aws-1",
      changes: [
        {
          op: "update",
          resourceId: "shop.api",
          resource: resource("shop.api", "service", {
            deps: ["shop.db", "shop.worker"],
            workload: { image: "registry.example/shop-api:v2" },
          }),
        },
        { op: "remove", resourceId: "shop.cache" },
        {
          op: "add",
          resourceId: "shop.worker",
          resource: resource("shop.worker", "worker", { deps: ["shop.db"] }),
        },
      ],
    },
  });

  assert.equal(result.status, "applied");
  assert.match(result.set.contentAddress, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.events.at(-1).type, "set.Created");
  assert.deepEqual(Object.keys(result.set.resources).sort(), ["shop.api", "shop.db", "shop.worker"]);

  const reconcile = buildReconcilePlan({ currentSet: baseSet, desiredSet: result.set });

  assert.deepEqual(
    reconcile.actions.map((action) => `${action.action}:${action.resourceId}`),
    ["provision:shop.worker", "update:shop.api", "destroy:shop.cache"],
  );
  assert.equal(
    reconcile.actions.some((action) => action.resourceId === "shop.db"),
    false,
    "unchanged resource emits no reconcile action",
  );
});

test("empty Delta applies as a no-op without minting a new Set or reconcile actions", () => {
  const result = applyDeltaToSet({
    baseSet,
    delta: { id: "delta-empty", changes: [] },
  });

  assert.equal(result.status, "noop");
  assert.equal(result.set.id, baseSet.id);
  assert.deepEqual(result.events.map((event) => event.type), ["delta.Applied"]);
  assert.deepEqual(buildReconcilePlan({ currentSet: baseSet, desiredSet: result.set }).actions, []);
});

test("removed dependents are destroyed before the resources they depended on", () => {
  const desiredSet = createDeploymentSet({
    id: "set-prod-aws-empty",
    campId: "prod-aws",
    environmentType: "production",
    manifestDigest: "sha256:manifest-empty",
    resources: {},
  });

  const reconcile = buildReconcilePlan({ currentSet: baseSet, desiredSet });

  assert.deepEqual(
    reconcile.actions.map((action) => `${action.action}:${action.resourceId}`),
    ["destroy:shop.api", "destroy:shop.cache", "destroy:shop.db"],
  );
});

test("desired Set retaining a dependent after removing its dependency fails closed", () => {
  assert.throws(
    () =>
      createDeploymentSet({
        id: "set-prod-aws-broken",
        campId: "prod-aws",
        environmentType: "production",
        manifestDigest: "sha256:manifest-broken",
        resources: {
          "shop.api": resource("shop.api", "service", { deps: ["shop.db"] }),
        },
      }),
    /missing dependency shop\.db/,
  );
});

test("rollback re-applies a prior Set when the external compat gate passes", () => {
  const next = applyDeltaToSet({
    baseSet,
    delta: {
      id: "delta-v2",
      changes: [
        {
          op: "update",
          resourceId: "shop.api",
          resource: resource("shop.api", "service", {
            deps: ["shop.db", "shop.cache"],
            workload: { image: "registry.example/shop-api:v2" },
          }),
        },
      ],
    },
  }).set;

  const rollback = planRollbackToSet({
    currentSet: next,
    targetSet: baseSet,
    compatGate: { status: "passed", gateId: "compat-gate-1" },
  });

  assert.equal(rollback.status, "planned");
  assert.equal(rollback.delta.kind, "rollback");
  assert.deepEqual(rollback.delta.changes, [
    {
      op: "update",
      resourceId: "shop.api",
      resource: baseSet.resources["shop.api"],
    },
  ]);
});

test("rollback past a completed contract boundary surfaces compat block instead of applying", () => {
  const rollback = planRollbackToSet({
    currentSet: baseSet,
    targetSet: createDeploymentSet({
      id: "set-prod-aws-pre-contract",
      campId: "prod-aws",
      environmentType: "production",
      manifestDigest: "sha256:manifest-pre-contract",
      resources: {
        "shop.api": resource("shop.api", "service", {
          deps: ["shop.db"],
          schemaExpectation: "orders.v1",
        }),
        "shop.db": resource("shop.db", "database", { schemaPhase: "contract-completed" }),
      },
    }),
    compatGate: {
      status: "failed",
      gateId: "compat-gate-contract-boundary",
      reason: "target Set expects orders.v1 after contract phase completed",
    },
  });

  assert.equal(rollback.status, "blocked");
  assert.equal(rollback.delta, null);
  assert.deepEqual(rollback.events.map((event) => event.type), ["compat.GateFailed"]);
  assert.match(rollback.reason, /contract phase completed/);
});

test("env-group promote rolls forward, partially promotes optional failures, and compensates required failures", () => {
  const allGreen = planEnvGroupPromote({
    envGroupId: "production",
    members: [
      { campId: "prod-aws", optional: false, result: "promoted" },
      { campId: "prod-azure", optional: true, result: "promoted" },
    ],
  });
  assert.equal(allGreen.status, "promoted");
  assert.equal(allGreen.events.at(-1).type, "env.Promoted");

  const optionalFailure = planEnvGroupPromote({
    envGroupId: "production",
    members: [
      { campId: "prod-aws", optional: false, result: "promoted" },
      { campId: "prod-azure", optional: true, result: "failed", reason: "quota" },
    ],
  });
  assert.equal(optionalFailure.status, "partially-promoted");
  assert.equal(optionalFailure.events.at(-1).type, "env.PartiallyPromoted");

  const requiredFailure = planEnvGroupPromote({
    envGroupId: "production",
    members: [
      { campId: "prod-aws", optional: false, result: "promoted" },
      { campId: "prod-azure", optional: false, result: "failed", reason: "gate failed" },
    ],
  });
  assert.equal(requiredFailure.status, "rolled-back");
  assert.deepEqual(
    requiredFailure.events.map((event) => event.type),
    [
      "env.PromoteRequested",
      "camp.PromoteRequested",
      "camp.Promoted",
      "camp.PromoteRequested",
      "camp.PromoteFailed",
      "camp.RollbackRequested",
      "env.PromoteRolledBack",
    ],
  );
});

function resource(id, type, overrides = {}) {
  return {
    id,
    type,
    port: `hobo:${type}`,
    deps: overrides.deps ?? [],
    match: {
      decisionId: `match-${id}`,
      definitionId: `${type}-definition`,
      catalogHash: "sha256:catalog",
    },
    replication: { topology: "single-writer-camp", ownerCampId: "prod-aws" },
    ...overrides,
  };
}
