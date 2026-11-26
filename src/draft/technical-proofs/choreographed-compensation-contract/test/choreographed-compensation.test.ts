import assert from "node:assert/strict";
import { test } from "vitest";

import {
  resumeChoreographedCompensation,
  runChoreographedCompensation
} from "../src/choreographed-compensation.js";

const plan = {
  deploymentId: "deploy-hobo-109",
  targetSetId: "set-stable-001",
  resources: [
    resource("network"),
    resource("database", ["network"]),
    resource("api", ["database"])
  ]
};

test("fatal failure rolls back provisioned resources in reverse dependency order", () => {
  const result = runChoreographedCompensation({
    plan,
    eventLog: provisioned("network", "database", "api"),
    failure: failed("database", { crossedNoGoThreshold: true })
  });

  assert.equal(result.status, "rolled-back");
  assert.deepEqual(eventsOf(result, "deployment.RolledBack"), [
    {
      deploymentId: "deploy-hobo-109",
      targetSetId: "set-stable-001",
      reason: "resource database crossed no-go threshold"
    }
  ]);
  assert.deepEqual(destroyOrder(result), ["api", "database", "network"]);
  assert.deepEqual(desiredStates(result), {
    network: "Destroyed",
    database: "Destroyed",
    api: "Destroyed"
  });
});

test("crash after deployment.RolledBack replays desired Destroyed state and resumes rollback", () => {
  const firstPass = runChoreographedCompensation({
    plan,
    eventLog: provisioned("network", "database", "api"),
    failure: failed("api", { crossedNoGoThreshold: true }),
    crashAfterEvents: ["deployment.RolledBack"]
  });

  assert.equal(firstPass.status, "interrupted");
  assert.deepEqual(desiredStates(firstPass), {
    network: "Destroyed",
    database: "Destroyed",
    api: "Destroyed"
  });

  const resumed = resumeChoreographedCompensation({
    plan,
    eventLog: firstPass.events
  });

  assert.equal(resumed.status, "rolled-back");
  assert.deepEqual(destroyOrder(resumed), ["api", "database", "network"]);
  assert.equal(eventsOf(resumed, "deployment.RolledBack").length, 1);
});

test("dependencies do not destroy while a dependent still exists", () => {
  const result = runChoreographedCompensation({
    plan,
    eventLog: provisioned("network", "database", "api"),
    failure: failed("api", { crossedNoGoThreshold: true }),
    stuckResources: ["api"]
  });

  assert.equal(result.status, "blocked");
  assert.deepEqual(destroyOrder(result), ["api"]);
  assert.equal(result.state.resources.api.status, "Destroying");
  assert.deepEqual(result.blocked, [
    {
      resourceId: "database",
      reason: "waiting-for-dependent-destroyed",
      dependents: ["api"]
    },
    {
      resourceId: "network",
      reason: "waiting-for-dependent-destroyed",
      dependents: ["database"]
    }
  ]);
});

test("destroy failure reaches CompensationFailed and emits incident escalation", () => {
  const result = runChoreographedCompensation({
    plan,
    eventLog: provisioned("network", "database", "api"),
    failure: failed("api", { crossedNoGoThreshold: true }),
    destroyResults: {
      api: { status: "failed", reason: "provider-destroy-denied" }
    }
  });

  assert.equal(result.status, "needs-human");
  assert.deepEqual(eventsOf(result, "resource.CompensationFailed"), [
    {
      resourceId: "api",
      reason: "provider-destroy-denied"
    }
  ]);
  assert.deepEqual(eventsOf(result, "incident.EscalationRequested"), [
    {
      deploymentId: "deploy-hobo-109",
      reason: "compensation-failed",
      resourceId: "api"
    }
  ]);
});

test("two failures racing emit one rollback and compensate each provisioned resource once", () => {
  const result = runChoreographedCompensation({
    plan,
    eventLog: [
      ...provisioned("network", "database", "api"),
      failed("database", { crossedNoGoThreshold: true }),
      failed("api", { crossedNoGoThreshold: true })
    ]
  });

  assert.equal(result.status, "rolled-back");
  assert.equal(eventsOf(result, "deployment.RolledBack").length, 1);
  assert.deepEqual(destroyOrder(result), ["api", "database", "network"]);
});

test("failure before a resource was provisioned does not compensate that resource", () => {
  const result = runChoreographedCompensation({
    plan,
    eventLog: [
      ...provisioned("network", "database"),
      failed("api", { crossedNoGoThreshold: true })
    ]
  });

  assert.equal(result.status, "rolled-back");
  assert.deepEqual(destroyOrder(result), ["database", "network"]);
  assert.equal(result.state.resources.api.status, "FailedBeforeProvisioned");
});

function resource(id, deps = []) {
  return { id, deps };
}

function provisioned(...resourceIds) {
  return resourceIds.map((resourceId, index) => ({
    id: `seed-${resourceId}-provisioned`,
    type: "resource.Provisioned",
    seq: index + 1,
    data: { resourceId }
  }));
}

function failed(resourceId, options = {}) {
  return {
    id: `seed-${resourceId}-failed`,
    type: "resource.Failed",
    data: {
      resourceId,
      reason: options.reason ?? "fatal-provider-error",
      crossedNoGoThreshold: options.crossedNoGoThreshold ?? false
    }
  };
}

function destroyOrder(result) {
  return eventsOf(result, "resource.Destroying").map((event) => event.resourceId);
}

function desiredStates(result) {
  return Object.fromEntries(
    Object.entries(result.state.resources).map(([resourceId, state]) => [resourceId, state.desired])
  );
}

function eventsOf(result, type) {
  return result.events
    .filter((event) => event.type === type)
    .map((event) => event.data);
}
