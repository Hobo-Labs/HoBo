import assert from "node:assert/strict";
import { test } from "vitest";

import { createDownLifecycle } from "../src/down-lifecycle.js";

function lifecycle(options = {}) {
  let nextId = 1;
  return createDownLifecycle({
    now: () => "2026-06-26T00:00:00.000Z",
    idFactory: (prefix) => `${prefix}-${nextId++}`,
    ...options,
  });
}

const deployedSnapshot = {
  deploymentId: "dep-snapshop",
  tenantId: "tenant-a",
  camps: [
    { id: "pr-123", environmentType: "preview" },
    { id: "prod", environmentType: "production" },
  ],
  resources: [
    { id: "catalog", campId: "pr-123", deps: [], state: "Provisioned" },
    { id: "images", campId: "pr-123", deps: [], state: "Provisioned" },
    { id: "api", campId: "pr-123", deps: ["catalog", "images"], state: "Provisioned" },
    { id: "domain", campId: "pr-123", deps: ["api"], state: "Provisioned" },
  ],
};

test("tears down a Camp in reverse dependency order and proves it through events", async () => {
  const down = lifecycle();
  const destroyed = [];

  const result = await down.run({
    topology: deployedSnapshot,
    campId: "pr-123",
    destroyResource: async (resource) => {
      destroyed.push(resource.id);
      return { providerId: "fake-iac", externalId: `${resource.id}-external` };
    },
  });

  assert.equal(result.status, "destroyed");
  assert.deepEqual(result.removedResources.map((resource) => resource.id), [
    "domain",
    "api",
    "catalog",
    "images",
  ]);
  assert.deepEqual(destroyed, ["domain", "api", "catalog", "images"]);
  assert.deepEqual(
    result.events.map((event) => event.type),
    [
      "deployment.DownStarted",
      "resource.DestroyRequested",
      "resource.Destroyed",
      "resource.DestroyRequested",
      "resource.Destroyed",
      "resource.DestroyRequested",
      "resource.Destroyed",
      "resource.DestroyRequested",
      "resource.Destroyed",
      "deployment.DownCompleted",
    ],
  );
  assert.ok(
    result.events.every(
      (event) => event.correlationId === "down:dep-snapshop:pr-123",
    ),
  );
});

test("second down is an idempotent success with nothing left to destroy", async () => {
  const down = lifecycle();
  const first = await down.run({
    topology: deployedSnapshot,
    campId: "pr-123",
    destroyResource: async () => ({}),
  });

  const second = await down.run({
    topology: deployedSnapshot,
    campId: "pr-123",
    eventLog: first.events,
    destroyResource: async () => {
      throw new Error("idempotent down must not call providers again");
    },
  });

  assert.equal(second.status, "noop");
  assert.deepEqual(second.removedResources, []);
  assert.deepEqual(second.pendingResources, []);
  assert.equal(
    second.events.filter((event) => event.type === "resource.DestroyRequested").length,
    0,
  );
  assert.equal(second.events.at(-1).type, "deployment.DownNoop");
});

test("prod-typed Camp requires explicit confirmation or approval before destroy", async () => {
  const down = lifecycle();
  const topology = {
    ...deployedSnapshot,
    resources: [
      { id: "api", campId: "prod", deps: [], state: "Provisioned" },
    ],
  };

  await assert.rejects(
    () =>
      down.run({
        topology,
        campId: "prod",
        destroyResource: async () => {
          throw new Error("must not destroy without approval");
        },
      }),
    /approval required.*prod/i,
  );

  const approved = await down.run({
    topology,
    campId: "prod",
    approval: { decision: "approved", approver: "role:platform-admin" },
    destroyResource: async () => ({}),
  });

  assert.equal(approved.status, "destroyed");
  assert.equal(approved.events[0].data.approval.approver, "role:platform-admin");
});

test("partial teardown is resumable and never reports success while resources remain", async () => {
  const eventLog = [];
  const down = lifecycle();

  const first = await down.run({
    topology: deployedSnapshot,
    campId: "pr-123",
    eventLog,
    appendEvent: (event) => {
      eventLog.push(event);
      return { appended: true };
    },
    destroyResource: async (resource) => {
      if (resource.id === "api") {
        throw new Error("provider timeout while destroying api");
      }
      return {};
    },
  });

  assert.equal(first.status, "partial");
  assert.deepEqual(first.removedResources.map((resource) => resource.id), ["domain"]);
  assert.deepEqual(first.pendingResources.map((resource) => resource.id), [
    "api",
    "catalog",
    "images",
  ]);
  assert.equal(first.events.at(-1).type, "resource.DestroyFailed");

  const retry = await down.run({
    topology: deployedSnapshot,
    campId: "pr-123",
    eventLog,
    appendEvent: (event) => {
      eventLog.push(event);
      return { appended: true };
    },
    destroyResource: async () => ({}),
  });

  assert.equal(retry.status, "destroyed");
  assert.deepEqual(retry.removedResources.map((resource) => resource.id), [
    "api",
    "catalog",
    "images",
  ]);
});

test("refuses to destroy a resource still depended on by another live Camp", async () => {
  const down = lifecycle();
  const topology = {
    deploymentId: "dep-shared",
    tenantId: "tenant-a",
    camps: [
      { id: "staging", environmentType: "staging" },
      { id: "prod", environmentType: "production" },
    ],
    resources: [
      { id: "shared-db", campId: "staging", deps: [], state: "Provisioned" },
      { id: "prod-api", campId: "prod", deps: ["shared-db"], state: "Provisioned" },
    ],
  };

  await assert.rejects(
    () =>
      down.run({
        topology,
        campId: "staging",
        destroyResource: async () => {
          throw new Error("must refuse before provider call");
        },
      }),
    /prod-api.*depends on shared-db/i,
  );
});

test("unknown Camp errors clearly before any destroy attempt", async () => {
  const down = lifecycle();

  await assert.rejects(
    () =>
      down.run({
        topology: deployedSnapshot,
        campId: "does-not-exist",
        destroyResource: async () => {
          throw new Error("must not call provider for unknown camp");
        },
      }),
    /unknown camp "does-not-exist"/i,
  );
});

test("destroying an empty Camp is success, not an error", async () => {
  const down = lifecycle();
  const topology = {
    deploymentId: "dep-empty",
    tenantId: "tenant-a",
    camps: [{ id: "pr-456", environmentType: "preview" }],
    resources: [],
  };

  const result = await down.run({
    topology,
    campId: "pr-456",
    destroyResource: async () => {
      throw new Error("empty camp must not call providers");
    },
  });

  assert.equal(result.status, "noop");
  assert.deepEqual(result.removedResources, []);
  assert.equal(result.events.at(-1).type, "deployment.DownNoop");
});
