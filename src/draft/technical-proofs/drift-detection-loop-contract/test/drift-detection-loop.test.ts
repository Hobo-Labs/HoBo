import assert from "node:assert/strict";
import { test } from "vitest";

import { validateControlPlaneEvent } from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import {
  createDriftFixtureResource,
  createDriftObservedState,
  createStubRefreshDriver,
  runDriftResync
} from "../src/drift-detection-loop.js";

test("drift report runs through Updating and re-converges to Provisioned", async () => {
  const resourcePlan = createDriftFixtureResource();
  const driver = createStubRefreshDriver({
    reports: [
      {
        status: "drifted",
        providerStateHash: "sha256:actual-v2",
        desiredStateHash: "sha256:desired-v1",
        changes: [{ path: "instanceSize", expected: "small", actual: "large" }]
      }
    ]
  });

  const result = await runDriftResync({
    resourcePlan,
    observedState: createDriftObservedState({ lastResourceEvent: "resource.Provisioned" }),
    driver,
    reconciler: async () => ({
      status: "provisioned",
      outputs: { endpoint: "db.internal" },
      providerStateHash: "sha256:desired-v1"
    })
  });

  assert.equal(result.status, "reconverged");
  assert.deepEqual(result.events.map((event) => event.type), [
    "resource.DriftDetected",
    "resource.Updating",
    "resource.Provisioned"
  ]);
  assert.equal(result.observedState.lastResourceEvent, "resource.Provisioned");
  assert.equal(result.observedState.providerStateHash, "sha256:desired-v1");
  assert.equal(result.reconcileRequested, true);
  assertValidEvents(result.events);
});

test("clean refresh is a no-op and repeated converged resyncs stay idempotent", async () => {
  const resourcePlan = createDriftFixtureResource();
  const driver = createStubRefreshDriver({
    reports: [{ status: "converged", providerStateHash: "sha256:desired-v1" }]
  });

  const first = await runDriftResync({
    resourcePlan,
    observedState: createDriftObservedState({
      lastResourceEvent: "resource.Provisioned",
      providerStateHash: "sha256:desired-v1"
    }),
    driver,
    reconciler: failIfReconciled()
  });
  const second = await runDriftResync({
    resourcePlan,
    observedState: first.observedState,
    driver,
    reconciler: failIfReconciled()
  });

  assert.equal(first.status, "converged");
  assert.equal(second.status, "converged");
  assert.deepEqual(first.events, []);
  assert.deepEqual(second.events, []);
  assert.equal(driver.auditLog.length, 2);
});

test("drift detected during in-flight deploy is serialized by the single-writer lease", async () => {
  const result = await runDriftResync({
    resourcePlan: createDriftFixtureResource(),
    observedState: createDriftObservedState({ lease: { holder: "deploy-apply", mode: "write" } }),
    driver: createStubRefreshDriver({
      reports: [{ status: "drifted", providerStateHash: "sha256:actual-v2", changes: [{ path: "size" }] }]
    }),
    reconciler: failIfReconciled()
  });

  assert.equal(result.status, "serialized");
  assert.deepEqual(result.events.map((event) => event.type), ["resource.DriftQueued"]);
  assert.equal(result.reconcileRequested, false);
  assert.equal(result.observedState.pendingDrift.reason, "single-writer lease held by deploy-apply");
  assertValidEvents(result.events);
});

test("refresh failure is classified and scheduled for retry", async () => {
  const result = await runDriftResync({
    resourcePlan: createDriftFixtureResource(),
    observedState: createDriftObservedState({ nextSeq: 10 }),
    driver: createStubRefreshDriver({
      reports: [{ status: "failed", classification: "retryable", reason: "provider timeout", retryAfterMs: 30000 }]
    }),
    reconciler: failIfReconciled()
  });

  assert.equal(result.status, "refresh-failed");
  assert.equal(result.failure.classification, "retryable");
  assert.equal(result.observedState.retryAfterMs, 30000);
  assert.deepEqual(result.events.map((event) => event.type), ["resource.RefreshFailed"]);
  assertValidEvents(result.events);
});

test("flapping drift does not emit duplicate drift transitions for the same fingerprint", async () => {
  const resourcePlan = createDriftFixtureResource();
  const drift = {
    status: "drifted",
    providerStateHash: "sha256:actual-v2",
    desiredStateHash: "sha256:desired-v1",
    changes: [{ path: "replicas", expected: 2, actual: 3 }]
  };
  const driver = createStubRefreshDriver({ reports: [drift] });

  const first = await runDriftResync({
    resourcePlan,
    observedState: createDriftObservedState(),
    driver,
    reconciler: async () => ({ status: "provisioned", providerStateHash: "sha256:still-drifted" })
  });
  const second = await runDriftResync({
    resourcePlan,
    observedState: first.observedState,
    driver,
    reconciler: failIfReconciled()
  });

  assert.deepEqual(first.events.map((event) => event.type), [
    "resource.DriftDetected",
    "resource.Updating",
    "resource.Provisioned"
  ]);
  assert.equal(second.status, "flapping-drift-suppressed");
  assert.deepEqual(second.events.map((event) => event.type), ["resource.DriftSuppressed"]);
  assert.equal(second.reconcileRequested, false);
  assertValidEvents([...first.events, ...second.events]);
});

test("same fingerprint after confirmed reconverge is treated as a new drift", async () => {
  const resourcePlan = createDriftFixtureResource();
  const drift = {
    status: "drifted",
    providerStateHash: "sha256:actual-v2",
    desiredStateHash: "sha256:desired-v1",
    changes: [{ path: "replicas", expected: 2, actual: 3 }]
  };
  const driver = createStubRefreshDriver({ reports: [drift] });

  const first = await runDriftResync({
    resourcePlan,
    observedState: createDriftObservedState(),
    driver,
    reconciler: async () => ({ status: "provisioned", providerStateHash: "sha256:desired-v1" })
  });
  const second = await runDriftResync({
    resourcePlan,
    observedState: first.observedState,
    driver,
    reconciler: async () => ({ status: "provisioned", providerStateHash: "sha256:desired-v1" })
  });

  assert.equal(first.status, "reconverged");
  assert.equal(second.status, "reconverged");
  assert.deepEqual(second.events.map((event) => event.type), [
    "resource.DriftDetected",
    "resource.Updating",
    "resource.Provisioned"
  ]);
  assertValidEvents([...first.events, ...second.events]);
});

test("external or echo resources are drift-detect only and never re-applied", async () => {
  for (const kind of ["external", "echo"]) {
    const result = await runDriftResync({
      resourcePlan: createDriftFixtureResource({ kind }),
      observedState: createDriftObservedState(),
      driver: createStubRefreshDriver({
        reports: [{ status: "drifted", providerStateHash: "sha256:actual-v2", changes: [{ path: "tags" }] }]
      }),
      reconciler: failIfReconciled()
    });

    assert.equal(result.status, "drift-observed-readonly");
    assert.deepEqual(result.events.map((event) => event.type), ["resource.DriftDetected"]);
    assert.equal(result.reconcileRequested, false);
    assertValidEvents(result.events);
  }
});

function failIfReconciled() {
  return async () => {
    throw new Error("reconcile was not expected");
  };
}

function assertValidEvents(events) {
  for (const event of events) {
    const validation = validateControlPlaneEvent(event);
    assert.equal(validation.ok, true, validation.errors.join("\n"));
  }
}
