import assert from "node:assert/strict";
import { test } from "vitest";

import { validateControlPlaneEvent } from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import {
  createFixtureIacProgram,
  createInProcessExecutor,
  createStubTokenBroker
} from "../../executor-skeleton-contract/src/executor-skeleton.js";
import { outputPlaceholder } from "../../deployment-plan-ir-contract/src/deployment-plan-ir.js";
import {
  createFixtureObservedState,
  createFixtureResourcePlan,
  createStubIacProvider,
  reconcileResource,
  recordExecSucceeded
} from "../src/resourceactor-reconcile-loop.js";

test("non-empty preview dispatches once and records provisioned outputs", async () => {
  const plan = createDatabasePlan();
  const program = createFixtureIacProgram({
    id: "iac-db-apply",
    provider: "aws",
    resourceId: "db",
    outputs: {
      connectionString: "postgres://db.internal/gallery",
      version: "v1"
    }
  });
  const iacProvider = createStubIacProvider({
    refresh: () => ({ outputs: {}, providerStateHash: "sha256:empty" }),
    preview: () => ({
      empty: false,
      action: "apply",
      changes: [{ op: "create", resourceId: "db" }],
      iacProgram: program
    })
  });
  const executor = createInProcessExecutor({ tokenBroker: createStubTokenBroker() });

  const result = await reconcileResource({
    resourcePlan: plan,
    observedState: createFixtureObservedState(),
    iacProvider,
    executor
  });

  assert.equal(result.status, "provisioned");
  assert.equal(result.dispatches.length, 1);
  assert.deepEqual(result.events.map((event) => event.type), [
    "resource.Provisioning",
    "exec.Started",
    "exec.Output",
    "exec.Output",
    "exec.Succeeded",
    "resource.Provisioned"
  ]);
  assert.deepEqual(result.outputs, {
    connectionString: "postgres://db.internal/gallery",
    version: "v1"
  });
  assert.deepEqual(iacProvider.auditLog.map((entry) => entry.type), ["refresh", "preview"]);
  assertValidEvents(result.events);
});

test("second loop on converged state emits nothing", async () => {
  const plan = createDatabasePlan();
  const outputs = {
    connectionString: "postgres://db.internal/gallery",
    version: "v1"
  };
  const iacProvider = createStubIacProvider({
    refresh: () => ({ outputs, providerStateHash: "sha256:v1" }),
    preview: () => ({ empty: true, changes: [] })
  });

  const result = await reconcileResource({
    resourcePlan: plan,
    observedState: createFixtureObservedState({
      lastResourceEvent: "resource.Provisioned",
      outputs
    }),
    iacProvider,
    executor: failIfDispatched()
  });

  assert.equal(result.status, "converged");
  assert.deepEqual(result.events, []);
  assert.deepEqual(result.dispatches, []);
});

test("exec.Failed yields resource.Failed with retryable and fatal classifications", async () => {
  for (const failure of [
    { classification: "retryable", reason: "provider timeout" },
    { classification: "fatal", reason: "invalid IacProgram" }
  ]) {
    const plan = createDatabasePlan();
    const iacProvider = createStubIacProvider({
      refresh: () => ({ outputs: {}, providerStateHash: "sha256:empty" }),
      preview: () => ({
        empty: false,
        action: "apply",
        changes: [{ op: "create", resourceId: "db" }],
        iacProgram: createFixtureIacProgram({
          id: `iac-db-${failure.classification}`,
          provider: "aws",
          resourceId: "db",
          failure
        })
      })
    });
    const executor = createInProcessExecutor({ tokenBroker: createStubTokenBroker() });

    const result = await reconcileResource({
      resourcePlan: plan,
      observedState: createFixtureObservedState(),
      iacProvider,
      executor
    });

    assert.equal(result.status, "failed");
    assert.equal(result.failure.classification, failure.classification);
    assert.equal(result.events.at(-1).type, "resource.Failed");
    assert.equal(result.events.at(-1).data.reason, `${failure.classification}: ${failure.reason}`);
    assertValidEvents(result.events);
  }
});

test("outputs resolve into a dependent binding before the dependent activates", async () => {
  const plan = createDatabasePlan();
  const iacProvider = createStubIacProvider({
    refresh: () => ({ outputs: {}, providerStateHash: "sha256:empty" }),
    preview: () => ({
      empty: false,
      action: "apply",
      changes: [{ op: "create", resourceId: "db" }],
      iacProgram: createFixtureIacProgram({
        id: "iac-db-apply",
        provider: "aws",
        resourceId: "db",
        outputs: {
          connectionString: "postgres://db.internal/gallery",
          version: "v1"
        }
      })
    })
  });
  const executor = createInProcessExecutor({ tokenBroker: createStubTokenBroker() });
  const dependent = {
    id: "api",
    activated: false,
    inputs: {
      env: {
        DB_URL: outputPlaceholder({
          type: "database",
          className: "standard",
          id: "db",
          output: "connectionString"
        }),
        SERVICE_MODE: "preview"
      }
    }
  };

  const result = await reconcileResource({
    resourcePlan: plan,
    observedState: createFixtureObservedState(),
    iacProvider,
    executor,
    dependents: [dependent]
  });

  assert.deepEqual(result.dependentBindings, {
    api: {
      inputs: {
        env: {
          DB_URL: "postgres://db.internal/gallery",
          SERVICE_MODE: "preview"
        }
      }
    }
  });
  assert.equal(
    result.events.some((event) => event.data.resourceId === "api"),
    false,
    "resolving bindings must not activate the dependent resource"
  );
});

test("preview clean but apply dirty fails closed without dispatching", async () => {
  const plan = createDatabasePlan();
  const iacProvider = createStubIacProvider({
    refresh: () => ({
      outputs: {},
      providerStateHash: "sha256:dirty",
      applyDirty: "last apply left unknown provider state"
    }),
    preview: () => ({ empty: true, changes: [] })
  });

  const result = await reconcileResource({
    resourcePlan: plan,
    observedState: createFixtureObservedState(),
    iacProvider,
    executor: failIfDispatched()
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(result.dispatches, []);
  assert.equal(result.events.at(-1).type, "resource.Failed");
  assert.equal(
    result.events.at(-1).data.reason,
    "ambiguous: preview clean but apply dirty; reconcile required"
  );
  assertValidEvents(result.events);
});

test("duplicate exec.Succeeded settlement is idempotent", () => {
  const plan = createDatabasePlan();
  const execResult = {
    status: "succeeded",
    execId: "exec-db-apply",
    outputs: {
      connectionString: "postgres://db.internal/gallery",
      version: "v1"
    },
    events: []
  };

  const first = recordExecSucceeded({
    resourcePlan: plan,
    execResult,
    observedState: createFixtureObservedState()
  });
  const second = recordExecSucceeded({
    resourcePlan: plan,
    execResult,
    observedState: first.observedState
  });

  assert.equal(first.status, "provisioned");
  assert.deepEqual(first.events.map((event) => event.type), ["resource.Provisioned"]);
  assert.equal(second.status, "duplicate-success");
  assert.deepEqual(second.events, []);
  assert.deepEqual(second.outputs, first.outputs);
  assertValidEvents(first.events);
});

function createDatabasePlan() {
  return createFixtureResourcePlan({
    id: "db",
    port: {
      interface: "hobo:resource/database",
      type: "database",
      className: "standard"
    },
    provider: {
      id: "aws",
      definitionId: "aws-rds-standard",
      driver: "pulumi"
    },
    outputs: ["connectionString", "version"]
  });
}

function failIfDispatched() {
  return {
    dispatch() {
      throw new Error("executor dispatch was not expected");
    }
  };
}

function assertValidEvents(events) {
  for (const event of events) {
    const validation = validateControlPlaneEvent(event);
    assert.equal(validation.ok, true, validation.errors.join("\n"));
  }
}
