import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createMockExecutor,
  createOrchestratorReconciliation,
  fixtureDeploymentPlan,
  fixtureResource,
  replayOrchestration
} from "../src/orchestrator-reconciliation-fsm.js";

test("adversarial: duplicate event id is ignored on replay", async () => {
  const plan = fixtureDeploymentPlan({ resources: [fixtureResource("solo", [])] });
  const result = await createTestOrchestrator().run({ plan, correlationId: "corr-dup" });
  const duplicate = { ...result.events[0], id: result.events[0].id };
  const replayed = replayOrchestration({ plan, events: [...result.events, duplicate] });
  assert.equal(replayed.ignoredEvents.length, 1);
  assert.equal(replayed.ignoredEvents[0].reason, "duplicate-event-id");
});

test("adversarial: second writer rejected by ActorHost lease", async () => {
  const plan = fixtureDeploymentPlan({ resources: [fixtureResource("solo", [])] });
  const actorHost = createStrictActorHost();
  actorHost.acquire("resource:deploy-fixture-hobo-620:solo", "other-worker");

  await assert.rejects(
    () => createTestOrchestrator({ actorHost }).run({ plan, correlationId: "corr-lease" }),
    /lease held by other-worker/
  );
});

test("adversarial: destroy failure escalates to needs-human with compensation-failed reason", async () => {
  const plan = fixtureDeploymentPlan();
  const executor = createMockExecutor({
    failDestroy: { api: { reason: "provider-destroy-denied" } }
  });

  const result = await createTestOrchestrator({ executor }).run({
    plan,
    correlationId: "corr-destroy-fail",
    failApplyResourceIds: ["api"]
  });

  assert.equal(result.status, "needs-human");
  assert.ok(
    result.events.some(
      (event) => event.type === "resource.Failed" && event.data.reason?.startsWith("compensation-failed")
    )
  );
});

test("adversarial: stalled dependency blocks downstream without blocking independent subtrees", async () => {
  const plan = fixtureDeploymentPlan({
    deploymentId: "deploy-stalled",
    resources: [
      fixtureResource("network", []),
      fixtureResource("database", ["network"]),
      fixtureResource("cache", [])
    ],
    edges: [{ from: "network", to: "database", reason: "binding-output" }]
  });

  const result = await createTestOrchestrator().run({
    plan,
    correlationId: "corr-stall",
    stallResourceIds: ["network"]
  });

  assert.equal(result.status, "waiting");
  assert.ok(result.events.some((event) => event.type === "resource.Provisioning" && event.data.resourceId === "network"));
  assert.ok(!result.events.some((event) => event.type === "resource.Provisioned" && event.data.resourceId === "network"));
  assert.ok(result.events.some((event) => event.type === "resource.Provisioned" && event.data.resourceId === "cache"));
});

function createTestOrchestrator(overrides = {}) {
  let nextEvent = 1;
  return createOrchestratorReconciliation({
    now: () => "2026-07-01T00:00:00.000Z",
    idFactory: (_type, _data, seq) => `evt-${String(seq ?? nextEvent++).padStart(3, "0")}`,
    ...overrides
  });
}

function createStrictActorHost() {
  const leases = new Map();
  return {
    acquire(actorKey, ownerId) {
      const heldBy = leases.get(actorKey);
      if (heldBy && heldBy !== ownerId) {
        throw new Error(`resource actor lease held by ${heldBy} for ${actorKey}`);
      }
      leases.set(actorKey, ownerId);
      return { release() { if (leases.get(actorKey) === ownerId) leases.delete(actorKey); } };
    }
  };
}
