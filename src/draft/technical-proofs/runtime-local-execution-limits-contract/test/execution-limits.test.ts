import assert from "node:assert/strict";
import { test } from "vitest";

import {
  HostExecutionLimitError,
  createRuntimeLocalExecutionHost,
  guestFixtures,
} from "../src/execution-limits.js";

test("fuel exhaustion interrupts the guest with a typed error, releases leases, and leaves the host live", async () => {
  const host = createRuntimeLocalExecutionHost({
    limits: { fuel: 5, epochTicks: 50, memoryBytes: 1024 },
  });

  host.loadComponent({
    id: "fuel-loop",
    guest: guestFixtures.burnFuel({ steps: 10, fuelPerStep: 1 }),
    leases: ["memory:fuel-loop", "fd:fuel-loop"],
  });

  await assert.rejects(
    () => host.invoke("fuel-loop", { requestId: "req-fuel" }),
    (error) => {
      assert.equal(error instanceof HostExecutionLimitError, true);
      assert.equal(error.code, "host.execution_limit_exceeded");
      assert.equal(error.reason, "fuel-exhausted");
      assert.equal(error.componentId, "fuel-loop");
      return true;
    },
  );

  assert.equal(host.isLive(), true);
  assert.deepEqual(host.leaseState("fuel-loop"), {
    componentId: "fuel-loop",
    state: "released",
    leases: [],
    owner: null,
  });
  assert.deepEqual(host.auditEvents().at(-1), {
    type: "exec.ExecutionLimitTrapped",
    componentId: "fuel-loop",
    requestId: "req-fuel",
    reason: "fuel-exhausted",
    limit: { fuel: 5, epochTicks: 50, memoryBytes: 1024 },
    cleanupState: "released",
  });

  host.loadComponent({
    id: "healthy",
    guest: guestFixtures.healthy({ response: { status: 204, body: "" } }),
  });
  assert.deepEqual(await host.invoke("healthy", { requestId: "req-ok" }), { status: 204, body: "" });
});

test("epoch deadline interrupts an infinite-loop guest without poisoning later calls", async () => {
  const host = createRuntimeLocalExecutionHost({
    limits: { fuel: 100, epochTicks: 3, memoryBytes: 1024 },
  });
  host.loadComponent({
    id: "infinite-loop",
    guest: guestFixtures.infiniteLoop({ fuelPerTick: 1 }),
    leases: ["memory:infinite-loop"],
  });

  await assert.rejects(
    () => host.invoke("infinite-loop", { requestId: "req-epoch" }),
    (error) => {
      assert.equal(error instanceof HostExecutionLimitError, true);
      assert.equal(error.reason, "epoch-deadline-exceeded");
      return true;
    },
  );

  assert.equal(host.isLive(), true);
  assert.equal(host.activeLeases().length, 0);
  assert.equal(
    host.auditEvents().some(
      (event) => event.type === "exec.ExecutionLimitTrapped" && event.reason === "epoch-deadline-exceeded",
    ),
    true,
  );
});

test("allocation pressure maps to the same typed host error and cleanup fact", async () => {
  const host = createRuntimeLocalExecutionHost({
    limits: { fuel: 100, epochTicks: 50, memoryBytes: 32 },
  });
  host.loadComponent({
    id: "allocator",
    guest: guestFixtures.allocateUntilInterrupted({ bytesPerStep: 16, steps: 4 }),
    leases: ["memory:allocator"],
  });

  await assert.rejects(
    () => host.invoke("allocator", { requestId: "req-memory" }),
    (error) => {
      assert.equal(error instanceof HostExecutionLimitError, true);
      assert.equal(error.reason, "memory-limit-exceeded");
      assert.equal(error.limit.memoryBytes, 32);
      return true;
    },
  );

  assert.deepEqual(host.leaseState("allocator").state, "released");
  assert.equal(host.auditEvents().at(-1).cleanupState, "released");
});

test("cleanup traps after an execution-limit interruption leave leases safely owned for teardown", async () => {
  const host = createRuntimeLocalExecutionHost({
    limits: { fuel: 2, epochTicks: 50, memoryBytes: 1024 },
  });
  host.loadComponent({
    id: "cleanup-trap",
    guest: guestFixtures.burnFuel({ steps: 10, fuelPerStep: 1 }),
    leases: ["memory:cleanup-trap", "fd:cleanup-trap"],
    onLimitCleanup: () => {
      throw new Error("guest finalizer trap");
    },
  });

  await assert.rejects(
    () => host.invoke("cleanup-trap", { requestId: "req-cleanup" }),
    (error) => {
      assert.equal(error instanceof HostExecutionLimitError, true);
      assert.equal(error.reason, "fuel-exhausted");
      assert.equal(error.cleanup.state, "owned-for-teardown");
      assert.match(error.cleanup.message, /guest finalizer trap/);
      return true;
    },
  );

  assert.deepEqual(host.leaseState("cleanup-trap"), {
    componentId: "cleanup-trap",
    state: "owned-for-teardown",
    leases: ["memory:cleanup-trap", "fd:cleanup-trap"],
    owner: "runtime-local-teardown",
  });
  assert.equal(host.auditEvents().at(-1).cleanupState, "owned-for-teardown");
  assert.equal(host.isLive(), true);
});

test("repeated limit failures do not leak leases or poison the runtime-local host", async () => {
  const host = createRuntimeLocalExecutionHost({
    limits: { fuel: 1, epochTicks: 50, memoryBytes: 1024 },
  });

  for (let index = 0; index < 4; index += 1) {
    const componentId = `repeat-${index}`;
    host.loadComponent({
      id: componentId,
      guest: guestFixtures.burnFuel({ steps: 3, fuelPerStep: 1 }),
      leases: [`memory:${componentId}`],
    });

    await assert.rejects(() => host.invoke(componentId, { requestId: `req-${index}` }), HostExecutionLimitError);
  }

  host.loadComponent({
    id: "after-repeat",
    guest: guestFixtures.healthy({ response: { status: 200, body: "ok" } }),
  });

  assert.deepEqual(host.activeLeases(), []);
  assert.deepEqual(await host.invoke("after-repeat", { requestId: "req-after" }), { status: 200, body: "ok" });
  assert.equal(host.auditEvents().filter((event) => event.type === "exec.ExecutionLimitTrapped").length, 4);
});
