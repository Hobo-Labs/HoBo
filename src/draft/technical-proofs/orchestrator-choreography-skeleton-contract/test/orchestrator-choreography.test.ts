import assert from "node:assert/strict";
import { test } from "vitest";

import { validateControlPlaneEvent } from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import { validateDeploymentPlan } from "../../deployment-plan-ir-contract/src/deployment-plan-ir.js";
import {
  createControlPlaneEvent,
  createOrchestrator,
  replayDeployment
} from "../src/orchestrator-choreography.js";

const CORRELATION_ID = "corr-hobo-73";

test("three-node DeploymentPlan provisions by dependency order and converges to deployment.Deployed", () => {
  const plan = threeNodeDeploymentPlan();
  assert.deepEqual(validateDeploymentPlan(plan), { ok: true, errors: [] });

  const orchestrator = createTestOrchestrator();

  const result = orchestrator.runDeployment({ plan, correlationId: CORRELATION_ID });

  assertEventContract(result.events);
  assert.equal(result.state.status, "deployed");
  assert.equal(result.events.at(-1).type, "deployment.Deployed");
  assert.deepEqual(result.events.at(-1).data.resourceIds, ["api", "db", "metrics"]);

  const dbProvisioned = eventIndex(result.events, "resource.Provisioned", "db");
  const apiProvisioning = eventIndex(result.events, "resource.Provisioning", "api");
  assert.ok(dbProvisioned < apiProvisioning);

  assert.equal(activationWave(result, "db"), 0);
  assert.equal(activationWave(result, "metrics"), 0);
  assert.equal(activationWave(result, "api"), 1);
  assert.ok(eventIndex(result.events, "resource.Provisioned", "metrics") < eventIndex(result.events, "deployment.Deployed"));
  assert.ok(result.events.every((event) => event.correlationId === CORRELATION_ID));

  assert.equal(eventsFor(result.events, "resource.Pending", "db").length, 1);
  assert.equal(eventsFor(result.events, "resource.Pending", "api").length, 1);
  assert.equal(eventsFor(result.events, "resource.Pending", "metrics").length, 1);
  assert.deepEqual(actorFor(result, "api").subscriptions, ["resource.Provisioned:db"]);
});

test("missing dependency Provisioned event leaves downstream waiting without blocking independent subtrees", () => {
  const plan = {
    apiVersion: "hobo.deployment-plan/v1",
    deploymentId: "deploy-stalled-db",
    resources: [
      resource("db", []),
      resource("api", ["db"]),
      resource("cache", [])
    ],
    edges: [
      { from: "db", to: "api", reason: "binding-output" }
    ],
    meta: { objective: "cost" }
  };

  const result = createTestOrchestrator().runDeployment({
    plan,
    correlationId: CORRELATION_ID,
    stallResourceIds: ["db"]
  });

  assertEventContract(result.events);
  assert.equal(result.state.status, "waiting");
  assert.ok(hasEvent(result.events, "resource.Provisioning", "db"));
  assert.ok(!hasEvent(result.events, "resource.Provisioned", "db"));
  assert.ok(!hasEvent(result.events, "resource.Provisioning", "api"));
  assert.ok(hasEvent(result.events, "resource.Provisioned", "cache"));
  assert.ok(!hasEvent(result.events, "deployment.Deployed"));
  assert.deepEqual(result.state.waitingResourceIds, ["api", "db"]);
});

test("duplicate Provisioned events are idempotent and do not activate dependents twice", () => {
  const plan = {
    apiVersion: "hobo.deployment-plan/v1",
    deploymentId: "deploy-duplicate",
    resources: [
      resource("db", []),
      resource("api", ["db"])
    ],
    edges: [
      { from: "db", to: "api", reason: "binding-output" }
    ],
    meta: { objective: "cost" }
  };
  const duplicateDbProvisioned = createControlPlaneEvent("resource.Provisioned", {
    resourceId: "db",
    outputs: { endpoint: "db-output-endpoint" }
  }, {
    id: "evt-duplicate-db",
    seq: 10,
    tenant: "tenant-hobo",
    correlationId: CORRELATION_ID,
    causationId: "evt-db-provisioning"
  });

  const duplicateRetry = {
    ...duplicateDbProvisioned,
    id: "evt-duplicate-db-retry",
    seq: 11
  };

  const result = createTestOrchestrator().runDeployment({
    plan,
    correlationId: CORRELATION_ID,
    eventLog: [duplicateDbProvisioned, duplicateRetry]
  });

  assertEventContract(result.events);
  assert.equal(result.state.status, "deployed");
  assert.equal(activationCount(result, "api"), 1);
  assert.equal(eventsFor(result.events, "resource.Provisioning", "api").length, 1);
  assert.equal(replayDeployment({ plan, events: result.events }).ignoredEvents.length, 1);
});

test("root actors self-activate immediately and diamond joins wait for every dependency once", () => {
  const plan = {
    apiVersion: "hobo.deployment-plan/v1",
    deploymentId: "deploy-diamond",
    resources: [
      resource("root", []),
      resource("left", ["root"]),
      resource("right", ["root"]),
      resource("join", ["left", "right"])
    ],
    edges: [
      { from: "root", to: "left", reason: "binding-output" },
      { from: "root", to: "right", reason: "binding-output" },
      { from: "left", to: "join", reason: "binding-output" },
      { from: "right", to: "join", reason: "binding-output" }
    ],
    meta: { objective: "cost" }
  };

  const result = createTestOrchestrator().runDeployment({ plan, correlationId: CORRELATION_ID });

  assertEventContract(result.events);
  assert.equal(result.state.status, "deployed");
  assert.equal(activationWave(result, "root"), 0);
  assert.equal(activationWave(result, "left"), 1);
  assert.equal(activationWave(result, "right"), 1);
  assert.equal(activationWave(result, "join"), 2);
  assert.equal(activationCount(result, "join"), 1);
  assert.ok(eventIndex(result.events, "resource.Provisioned", "left") < eventIndex(result.events, "resource.Provisioning", "join"));
  assert.ok(eventIndex(result.events, "resource.Provisioned", "right") < eventIndex(result.events, "resource.Provisioning", "join"));
});

function createTestOrchestrator() {
  let nextEvent = 1;
  return createOrchestrator({
    now: () => "2026-06-25T00:00:00.000Z",
    idFactory: () => `evt-${String(nextEvent++).padStart(3, "0")}`
  });
}

function threeNodeDeploymentPlan() {
  return {
    apiVersion: "hobo.deployment-plan/v1",
    deploymentId: "deploy-three-node",
    resources: [
      resource("db", []),
      resource("api", ["db"]),
      resource("metrics", [])
    ],
    edges: [
      { from: "db", to: "api", reason: "binding-output" }
    ],
    meta: { objective: "cost" }
  };
}

function resource(id, deps) {
  return {
    id,
    name: id,
    port: {
      interface: "hobo:test/resource",
      type: "service",
      className: "standard"
    },
    provider: {
      id: "test-provider",
      definitionId: `test-${id}`,
      driver: "test-driver"
    },
    context: {
      envType: "ephemeral",
      app: "test-app",
      env: "preview",
      tenant: "tenant-hobo",
      resourceType: "service",
      resourceClass: "standard",
      resourceId: id
    },
    options: {},
    deps,
    strategy: "reconcile",
    replication: "single-region",
    workloadProfile: "managed-resource",
    outputs: ["endpoint"]
  };
}

function assertEventContract(events) {
  for (const event of events) {
    const result = validateControlPlaneEvent(event);
    assert.equal(result.ok, true, `${event.type}: ${result.errors.join(", ")}`);
  }
}

function activationWave(result, resourceId) {
  return result.activationLog.find((entry) => entry.resourceId === resourceId)?.wave;
}

function activationCount(result, resourceId) {
  return result.activationLog.filter((entry) => entry.resourceId === resourceId).length;
}

function actorFor(result, resourceId) {
  return result.state.actors.find((actor) => actor.resourceId === resourceId);
}

function eventIndex(events, type, resourceId) {
  const index = events.findIndex((event) => event.type === type && (!resourceId || event.data.resourceId === resourceId));
  assert.notEqual(index, -1, `${type} ${resourceId ?? ""} was not emitted`);
  return index;
}

function hasEvent(events, type, resourceId) {
  return events.some((event) => event.type === type && (!resourceId || event.data.resourceId === resourceId));
}

function eventsFor(events, type, resourceId) {
  return events.filter((event) => event.type === type && event.data.resourceId === resourceId);
}
