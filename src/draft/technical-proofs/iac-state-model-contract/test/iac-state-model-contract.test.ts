import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  IAC_STATE_MODEL_VERSION,
  createIacStateModel,
  createInMemoryLeaseAuthority,
  createInMemoryStateBackend,
  createResourceRef,
  resourceStackKey,
} from "../src/iac-state-model-contract.js";

describe("per-resource IaC state model contract", () => {
  it("isolates two resources in one deployment by tenant/deployment/resource stack key", async () => {
    const stateBackend = createInMemoryStateBackend();
    const model = createIacStateModel({
      stateBackend,
      leaseAuthority: createInMemoryLeaseAuthority(),
    });
    const db = createResourceRef({ resourceId: "db" });
    const api = createResourceRef({ resourceId: "api" });

    await model.applyResource(db, {
      writerId: "resource-actor:db",
      outputs: { endpoint: "postgres://db", resourceId: "db-001" },
    });
    await model.applyResource(api, {
      writerId: "resource-actor:api",
      outputs: { endpoint: "https://api.internal", resourceId: "api-001" },
    });
    await model.destroyResource(db, { writerId: "resource-actor:db" });

    assert.equal(resourceStackKey(db), "tenant-acme/deployment-prod/db");
    assert.equal(resourceStackKey(api), "tenant-acme/deployment-prod/api");
    assert.equal(stateBackend.getStack(resourceStackKey(db)), undefined);
    assert.deepEqual(stateBackend.getStack(resourceStackKey(api)).outputs, {
      endpoint: "https://api.internal",
      resourceId: "api-001",
    });
  });

  it("captures stack outputs into resource.Provisioned and resolves dependent binding refs", async () => {
    const model = createIacStateModel({
      stateBackend: createInMemoryStateBackend(),
      leaseAuthority: createInMemoryLeaseAuthority(),
    });
    const db = createResourceRef({ resourceId: "db" });
    const api = createResourceRef({ resourceId: "api" });

    const apply = await model.applyResource(db, {
      writerId: "resource-actor:db",
      outputs: { endpoint: "postgres://db", passwordRef: "secret://db/password" },
    });
    const bindings = model.resolveBindings(api, [
      { from: db, output: "endpoint", as: "DATABASE_URL" },
      { from: db, output: "passwordRef", as: "DATABASE_PASSWORD_REF" },
    ]);

    assert.equal(apply.events.at(-1).type, "resource.Provisioned");
    assert.equal(apply.events.at(-1).schema, IAC_STATE_MODEL_VERSION);
    assert.deepEqual(apply.events.at(-1).data.outputs, {
      endpoint: "postgres://db",
      passwordRef: "secret://db/password",
    });
    assert.deepEqual(bindings, {
      DATABASE_URL: "postgres://db",
      DATABASE_PASSWORD_REF: "secret://db/password",
    });
  });

  it("rejects a second concurrent writer on the same resource through the ActorHost lease", async () => {
    const stateBackend = createInMemoryStateBackend();
    const leaseAuthority = createInMemoryLeaseAuthority();
    const model = createIacStateModel({ stateBackend, leaseAuthority });
    const db = createResourceRef({ resourceId: "db" });

    const first = model.beginResourceOperation(db, {
      operation: "apply",
      writerId: "resource-actor:db#1",
    });
    stateBackend.simulateLostBackendLock(resourceStackKey(db));

    await assert.rejects(
      () =>
        model.applyResource(db, {
          writerId: "resource-actor:db#2",
          outputs: { endpoint: "postgres://racing-db" },
        }),
      {
        name: "IacStateModelError",
        code: "lease-held",
      },
    );

    first.release();
  });

  it("surfaces orphaned stacks after a crashed apply without deleting them", () => {
    const stateBackend = createInMemoryStateBackend();
    const model = createIacStateModel({
      stateBackend,
      leaseAuthority: createInMemoryLeaseAuthority(),
    });
    const db = createResourceRef({ resourceId: "db" });

    stateBackend.recordOrphanedStack(resourceStackKey(db), {
      outputs: { endpoint: "postgres://orphaned-db" },
      reason: "executor-crashed-after-apply",
    });

    assert.deepEqual(model.inspectResourceState(db), {
      stackKey: "tenant-acme/deployment-prod/db",
      status: "orphaned",
      reconcileRequired: true,
      reason: "executor-crashed-after-apply",
      outputs: { endpoint: "postgres://orphaned-db" },
    });
    assert.equal(stateBackend.getStack(resourceStackKey(db)).status, "orphaned");
  });

  it("rejects output key collisions across co-provisioned resources", async () => {
    const model = createIacStateModel({
      stateBackend: createInMemoryStateBackend(),
      leaseAuthority: createInMemoryLeaseAuthority(),
    });
    const db = createResourceRef({ resourceId: "db" });
    const cache = createResourceRef({ resourceId: "cache" });
    const api = createResourceRef({ resourceId: "api" });

    await model.applyResource(db, {
      writerId: "resource-actor:db",
      outputs: { endpoint: "postgres://db" },
    });
    await model.applyResource(cache, {
      writerId: "resource-actor:cache",
      outputs: { endpoint: "memory://cache" },
    });

    assert.throws(
      () =>
        model.resolveBindings(api, [
          { from: db, output: "endpoint", as: "SERVICE_ENDPOINT" },
          { from: cache, output: "endpoint", as: "SERVICE_ENDPOINT" },
        ]),
      {
        name: "IacStateModelError",
        code: "binding-output-collision",
      },
    );
  });

  it("fails closed when the state backend becomes unavailable mid-apply", async () => {
    const stateBackend = createInMemoryStateBackend();
    const model = createIacStateModel({
      stateBackend,
      leaseAuthority: createInMemoryLeaseAuthority(),
    });
    const db = createResourceRef({ resourceId: "db" });

    stateBackend.failNextWrite("state backend unavailable");

    await assert.rejects(
      () =>
        model.applyResource(db, {
          writerId: "resource-actor:db",
          outputs: { endpoint: "postgres://db" },
        }),
      {
        name: "IacStateModelError",
        code: "state-backend-unavailable",
      },
    );
    assert.equal(stateBackend.getStack(resourceStackKey(db)), undefined);
    assert.equal(model.currentLease(resourceStackKey(db)), undefined);
  });
});
