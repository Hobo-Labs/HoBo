import assert from "node:assert/strict";
import { test } from "vitest";

import {
  applyDeployment,
  createPartialRealizeHarness,
  inspectDeployment,
  resumePartialRollback,
  rollbackDeployment,
} from "../src/partial-realize-rollback.js";

const plan = {
  tenantId: "tenant-a",
  deploymentId: "deploy-376",
  resources: [
    resource("network"),
    resource("database", ["network"]),
    resource("api", ["database"]),
  ],
};

test("created-but-not-in-state failure rolls back recorded state plus the tagged orphan", () => {
  const harness = createPartialRealizeHarness();
  seedOtherDeployment(harness);

  const failed = applyDeployment({
    harness,
    plan,
    fault: { crashBeforeStateWriteFor: "api" },
  });

  assert.equal(failed.status, "failed");
  assert.deepEqual(logicalNames(inspectDeployment(harness, plan).orphans), ["api"]);

  const rolledBack = rollbackDeployment({ harness, plan });

  assert.equal(rolledBack.status, "rolled-back");
  assert.deepEqual(inspectDeployment(harness, plan).residue, []);
  assert.deepEqual(
    destroySources(rolledBack),
    [
      ["api", "orphan-sweep"],
      ["database", "recorded-state"],
      ["network", "recorded-state"],
    ],
  );
  assert.deepEqual(logicalNames(inspectDeployment(harness, otherPlan()).live), ["untouched"]);
});

test("ambiguous executor output is reconciled exactly once without duplicate create", () => {
  const harness = createPartialRealizeHarness();
  const single = { ...plan, resources: [resource("api")] };

  const ambiguous = applyDeployment({
    harness,
    plan: single,
    fault: { severOutputAfterCreateFor: "api" },
  });
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(harness.createAttemptsFor("api"), 1);

  const retry = applyDeployment({ harness, plan: single });

  assert.equal(retry.status, "applied");
  assert.equal(harness.createAttemptsFor("api"), 1);
  assert.deepEqual(logicalNames(inspectDeployment(harness, single).recorded), ["api"]);
  assert.equal(eventsOf(retry, "exec.AmbiguousResolved").length, 1);
});

test("destroy failure reaches CompensationFailed and emits incident escalation", () => {
  const harness = createPartialRealizeHarness();
  applyDeployment({ harness, plan });

  const result = rollbackDeployment({
    harness,
    plan,
    destroyFaults: { api: "provider-delete-denied" },
  });

  assert.equal(result.status, "needs-human");
  assert.deepEqual(eventsOf(result, "resource.CompensationFailed"), [
    {
      resourceId: "api",
      reason: "provider-delete-denied",
      source: "recorded-state",
    },
  ]);
  assert.deepEqual(eventsOf(result, "incident.EscalationRequested"), [
    {
      deploymentId: "deploy-376",
      reason: "compensation-failed",
      resourceId: "api",
    },
  ]);
});

test("dependency resources wait when a dependent destroy fails", () => {
  const harness = createPartialRealizeHarness();
  applyDeployment({ harness, plan });

  const result = rollbackDeployment({
    harness,
    plan,
    destroyFaults: { api: "provider-delete-denied" },
  });

  assert.deepEqual(eventsOf(result, "resource.CompensationBlocked"), [
    {
      resourceId: "database",
      reason: "waiting-for-dependent-destroyed",
      dependents: ["api"],
    },
    {
      resourceId: "network",
      reason: "waiting-for-dependent-destroyed",
      dependents: ["database"],
    },
  ]);
  assert.deepEqual(logicalNames(inspectDeployment(harness, plan).residue), [
    "network",
    "database",
    "api",
  ]);
});

test("rollback replay after crash re-derives desired Destroyed and completes cleanup", () => {
  const harness = createPartialRealizeHarness();
  applyDeployment({ harness, plan });

  const interrupted = rollbackDeployment({
    harness,
    plan,
    crashAfterEvent: "deployment.RolledBack",
  });

  assert.equal(interrupted.status, "interrupted");
  assert.deepEqual(desiredStates(interrupted), {
    network: "Destroyed",
    database: "Destroyed",
    api: "Destroyed",
  });

  const resumed = resumePartialRollback({
    plan,
    eventLog: interrupted.events,
  });

  assert.equal(resumed.status, "rolled-back");
  assert.equal(eventsOf(resumed, "deployment.RolledBack").length, 1);
  assert.deepEqual(inspectDeployment(resumed.harness, plan).residue, []);
});

test("two independent destroy failures both escalate without leaving the saga stuck", () => {
  const harness = createPartialRealizeHarness();
  const independent = {
    ...plan,
    resources: [resource("api"), resource("worker")],
  };
  applyDeployment({ harness, plan: independent });

  const result = rollbackDeployment({
    harness,
    plan: independent,
    destroyFaults: {
      api: "api-delete-denied",
      worker: "worker-delete-denied",
    },
  });

  assert.equal(result.status, "needs-human");
  assert.deepEqual(
    eventsOf(result, "resource.CompensationFailed").map((event) => event.resourceId).sort(),
    ["api", "worker"],
  );
  assert.deepEqual(
    eventsOf(result, "incident.EscalationRequested").map((event) => event.resourceId).sort(),
    ["api", "worker"],
  );
});

test("state-recorded-but-create-absent rollback does not recreate or report false destroy", () => {
  const harness = createPartialRealizeHarness();
  const single = { ...plan, resources: [resource("api")] };
  applyDeployment({
    harness,
    plan: single,
    fault: { stateRecordedButObjectMissingFor: "api" },
  });

  const result = rollbackDeployment({
    harness,
    plan: single,
  });

  assert.equal(result.status, "rolled-back");
  assert.equal(harness.createAttemptsFor("api"), 1);
  assert.deepEqual(eventsOf(result, "iac.RecordedStateAbsent"), [
    {
      resourceId: "api",
      reason: "state-recorded-but-create-absent",
    },
  ]);
  assert.deepEqual(inspectDeployment(harness, single).residue, []);
});

test("repeated rollback attempts are idempotent", () => {
  const harness = createPartialRealizeHarness();
  applyDeployment({ harness, plan });

  const first = rollbackDeployment({ harness, plan });
  const replayed = resumePartialRollback({
    plan,
    eventLog: first.events,
  });

  assert.equal(replayed.status, "rolled-back");
  assert.equal(
    eventsOf(replayed, "iac.ResourceDestroyed").length,
    eventsOf(first, "iac.ResourceDestroyed").length,
  );
  assert.deepEqual(inspectDeployment(replayed.harness, plan).residue, []);
});

function resource(id, deps = []) {
  return { id, deps };
}

function seedOtherDeployment(harness) {
  applyDeployment({
    harness,
    plan: otherPlan(),
  });
}

function otherPlan() {
  return {
    tenantId: "tenant-a",
    deploymentId: "other-deploy",
    resources: [resource("untouched")],
  };
}

function logicalNames(items) {
  return items.map((item) => item.logicalName);
}

function destroySources(result) {
  return eventsOf(result, "iac.ResourceDestroyed").map((event) => [
    event.resourceId,
    event.source,
  ]);
}

function desiredStates(result) {
  return Object.fromEntries(
    Object.entries(result.state.resources).map(([resourceId, state]) => [
      resourceId,
      state.desired,
    ]),
  );
}

function eventsOf(result, type) {
  return result.events
    .filter((event) => event.type === type)
    .map((event) => event.data);
}
