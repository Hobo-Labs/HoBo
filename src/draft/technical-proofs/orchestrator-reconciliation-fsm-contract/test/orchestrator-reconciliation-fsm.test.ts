import assert from "node:assert/strict";
import { test } from "vitest";

import { validateControlPlaneEvent } from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import { validateDeploymentPlan } from "../../deployment-plan-ir-contract/src/deployment-plan-ir.js";
import {
  createMockExecutor,
  createOrchestratorReconciliation,
  fixtureDeploymentPlan,
  fixtureResource,
  replayOrchestration
} from "../src/orchestrator-reconciliation-fsm.js";

const CORRELATION_ID = "corr-hobo-620";

test("Given fixture DeploymentPlan When orchestrator runs Then resources converge in DAG order through mocked executor", async () => {
  const plan = fixtureDeploymentPlan();
  assert.deepEqual(validateDeploymentPlan(plan), { ok: true, errors: [] });

  const executor = createMockExecutor();
  const orchestrator = createTestOrchestrator({ executor });
  const result = await orchestrator.run({ plan, correlationId: CORRELATION_ID });

  assertEventContract(result.events);
  assert.equal(result.status, "deployed");
  assert.equal(result.events.at(-1)?.type, "deployment.Deployed");
  assert.deepEqual(
    result.executorAuditLog.map((entry) => entry.resourceId),
    ["network", "database", "api"]
  );

  const networkProvisioned = eventIndex(result.events, "resource.Provisioned", "network");
  const databaseProvisioning = eventIndex(result.events, "resource.Provisioning", "database");
  const apiProvisioning = eventIndex(result.events, "resource.Provisioning", "api");
  assert.ok(networkProvisioned < databaseProvisioning);
  assert.ok(eventIndex(result.events, "resource.Provisioned", "database") < apiProvisioning);
  assert.ok(result.events.every((event) => event.correlationId === CORRELATION_ID));
});

test("Given mid-DAG apply failure When orchestrator compensates Then provisioned resources destroy in reverse dependency order", async () => {
  const plan = fixtureDeploymentPlan();
  const executor = createMockExecutor();
  const orchestrator = createTestOrchestrator({ executor });

  const result = await orchestrator.run({
    plan,
    correlationId: CORRELATION_ID,
    failApplyResourceIds: ["api"]
  });

  assertEventContract(result.events);
  assert.equal(result.status, "rolled-back");
  assert.ok(result.events.some((event) => event.type === "deployment.RolledBack"));
  assert.deepEqual(
    destroyOrder(result.events),
    ["api", "database", "network"]
  );
  assert.deepEqual(
    result.executorAuditLog.filter((entry) => entry.op === "destroy").map((entry) => entry.resourceId),
    ["api", "database", "network"]
  );
});

test("Given full event transcript When replayed Then state matches live orchestration (NFR-011)", async () => {
  const plan = fixtureDeploymentPlan();
  const orchestrator = createTestOrchestrator();
  const live = await orchestrator.run({ plan, correlationId: CORRELATION_ID });
  const replayed = replayOrchestration({ plan, events: live.events });

  assert.deepEqual(
    replayed.actors.map((actor) => actor.state),
    live.state.actors.map((actor) => actor.state)
  );
  assert.equal(replayed.status, "deployed");
});

test("Given rolled-back event transcript When replayed Then actor states match live compensation (NFR-011)", async () => {
  const plan = fixtureDeploymentPlan();
  const orchestrator = createTestOrchestrator();
  const live = await orchestrator.run({
    plan,
    correlationId: CORRELATION_ID,
    failApplyResourceIds: ["api"]
  });
  const replayed = replayOrchestration({ plan, events: live.events });

  assert.deepEqual(
    replayed.actors.map((actor) => actor.state),
    live.state.actors.map((actor) => actor.state)
  );
  assert.equal(replayed.status, "rolled-back");
});

test("Given crash after deployment.RolledBack When events replay and orchestrator resumes Then compensation completes without duplicate rollback", async () => {
  const plan = fixtureDeploymentPlan();
  const orchestrator = createTestOrchestrator();

  const firstPass = await orchestrator.run({
    plan,
    correlationId: CORRELATION_ID,
    failApplyResourceIds: ["api"]
  });

  const rollbackEvents = firstPass.events.filter((event) => event.type !== "resource.Destroyed");
  const resumed = await createTestOrchestrator().run({
    plan,
    correlationId: CORRELATION_ID,
    eventLog: rollbackEvents
  });

  assert.equal(resumed.events.filter((event) => event.type === "deployment.RolledBack").length, 1);
  assert.deepEqual(destroyOrder(resumed.events), ["api", "database", "network"]);
});

test("Each ResourceActor holds ActorHost lease during Provisioning transition", async () => {
  const plan = fixtureDeploymentPlan({ resources: [fixtureResource("solo", [])] });
  const leaseLog = [];
  const actorHost = {
    acquire(actorKey, ownerId) {
      leaseLog.push({ action: "acquire", actorKey, ownerId });
      return { release() { leaseLog.push({ action: "release", actorKey }); } };
    }
  };

  await createTestOrchestrator({ actorHost }).run({ plan, correlationId: CORRELATION_ID });

  assert.equal(leaseLog.filter((entry) => entry.action === "acquire").length, 1);
  assert.equal(leaseLog.filter((entry) => entry.action === "release").length, 1);
  assert.match(leaseLog[0].actorKey, /^resource:deploy-fixture-hobo-620:solo$/);
});

function createTestOrchestrator(overrides = {}) {
  let nextEvent = 1;
  return createOrchestratorReconciliation({
    now: () => "2026-07-01T00:00:00.000Z",
    idFactory: (_type, _data, seq) => `evt-${String(seq ?? nextEvent++).padStart(3, "0")}`,
    ...overrides
  });
}

function assertEventContract(events) {
  for (const event of events) {
    const result = validateControlPlaneEvent(event);
    assert.equal(result.ok, true, `${event.type}: ${result.errors.join(", ")}`);
  }
}

function eventIndex(events, type, resourceId) {
  const index = events.findIndex((event) => event.type === type && event.data.resourceId === resourceId);
  assert.notEqual(index, -1, `${type} ${resourceId} was not emitted`);
  return index;
}

function destroyOrder(events) {
  return events.filter((event) => event.type === "resource.Destroying").map((event) => event.data.resourceId);
}
