import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createCompensationEngine,
  replayCompensationEvents,
} from "../src/saga-compensation-engine.js";

function deterministicEngine(options = {}) {
  let nextId = 1;

  return createCompensationEngine({
    now: () => "2026-06-26T00:00:00.000Z",
    idFactory: (prefix) => `${prefix}-${nextId++}`,
    ...options,
  });
}

const fiveResourcePlan = Object.freeze([
  { id: "network", dependsOn: [] },
  { id: "db", dependsOn: ["network"] },
  { id: "api", dependsOn: ["db"] },
  { id: "worker", dependsOn: ["db"] },
  { id: "edge", dependsOn: ["api"] },
]);

describe("saga compensation engine contract", () => {
  it("rolls back a partial deploy by compensating provisioned resources in reverse topological order", async () => {
    const destroyOrder = [];
    const engine = deterministicEngine();

    const outcome = await engine.compensate({
      deploymentId: "deploy-1",
      tenantId: "tenant-a",
      correlationId: "corr-rollback",
      resources: fiveResourcePlan,
      eventLog: [
        provisioned("network", 1),
        provisioned("db", 2),
        failed("api", "poison", 3),
      ],
      failedResourceId: "api",
      failure: { class: "poison", reason: "provider-rejected-plan" },
      noGoThreshold: { kind: "any-fatal" },
      destroy: async ({ resourceId }) => {
        if (resourceId === "network") {
          assert.deepEqual(destroyOrder, ["db"], "dependency waited for dependent first");
        }
        destroyOrder.push(resourceId);
        return { destroyed: true };
      },
    });

    assert.equal(outcome.state.status, "rolled-back");
    assert.deepEqual(destroyOrder, ["db", "network"]);
    assert.deepEqual(outcome.state.provisionedResourceIds, []);
    assert.deepEqual(
      outcome.events.map((event) => event.type),
      [
        "resource.Provisioned",
        "resource.Provisioned",
        "resource.Failed",
        "deployment.RolledBack",
        "resource.Compensating",
        "resource.Compensated",
        "resource.Compensating",
        "resource.Compensated",
      ],
    );
    assert.deepEqual(outcome.state.compensationOrder, ["db", "network"]);
    assert.equal(outcome.state.rollback.reason.failedResourceId, "api");
    assert.equal(outcome.state.rollback.reason.failureClass, "poison");

    const replayed = replayCompensationEvents(outcome.events, fiveResourcePlan);
    assert.equal(replayed.state.status, "rolled-back");
    assert.deepEqual(replayed.state.provisionedResourceIds, []);
  });

  it("retries compensation idempotently without double-destroying resources", async () => {
    const destroyCalls = [];
    const engine = deterministicEngine();

    const first = await engine.compensate({
      deploymentId: "deploy-1",
      tenantId: "tenant-a",
      correlationId: "corr-retry",
      resources: fiveResourcePlan,
      eventLog: [provisioned("network", 1), provisioned("db", 2), failed("api", "poison", 3)],
      failedResourceId: "api",
      failure: { class: "poison", reason: "provider-rejected-plan" },
      destroy: async ({ resourceId }) => {
        destroyCalls.push(resourceId);
        return { destroyed: true };
      },
    });

    const retry = await engine.compensate({
      deploymentId: "deploy-1",
      tenantId: "tenant-a",
      correlationId: "corr-retry",
      resources: fiveResourcePlan,
      eventLog: first.events,
      failedResourceId: "api",
      failure: { class: "poison", reason: "provider-rejected-plan" },
      destroy: async ({ resourceId }) => {
        destroyCalls.push(`retry:${resourceId}`);
        return { destroyed: true };
      },
    });

    assert.deepEqual(destroyCalls, ["db", "network"]);
    assert.equal(retry.state.status, "rolled-back");
    assert.deepEqual(retry.state.provisionedResourceIds, []);
  });

  it("does not roll back required resources when an optional resource fails", async () => {
    const engine = deterministicEngine();
    const destroyCalls = [];

    const outcome = await engine.compensate({
      deploymentId: "deploy-optional",
      tenantId: "tenant-a",
      correlationId: "corr-optional",
      resources: [
        { id: "network", dependsOn: [] },
        { id: "db", dependsOn: ["network"] },
        { id: "analytics", dependsOn: ["db"], optional: true },
      ],
      eventLog: [
        provisioned("network", 1),
        provisioned("db", 2),
        failed("analytics", "poison", 3),
      ],
      failedResourceId: "analytics",
      failure: { class: "poison", reason: "optional-resource-failed" },
      destroy: async ({ resourceId }) => {
        destroyCalls.push(resourceId);
        return { destroyed: true };
      },
    });

    assert.equal(outcome.state.status, "continued-after-optional-failure");
    assert.deepEqual(destroyCalls, []);
    assert.deepEqual(outcome.state.provisionedResourceIds, ["network", "db"]);
    assert.equal(outcome.events.at(-1).type, "deployment.OptionalResourceFailed");
  });

  it("refreshes ambiguous provider state before destroying and skips never-provisioned resources", async () => {
    const calls = [];
    const engine = deterministicEngine();

    const outcome = await engine.compensate({
      deploymentId: "deploy-ambiguous",
      tenantId: "tenant-a",
      correlationId: "corr-ambiguous",
      resources: [
        { id: "network", dependsOn: [] },
        { id: "db", dependsOn: ["network"], ambiguousCommit: true },
        { id: "cache", dependsOn: ["network"] },
        { id: "api", dependsOn: ["db", "cache"] },
      ],
      eventLog: [provisioned("network", 1), provisioned("db", 2), failed("api", "partial-failure", 3)],
      failedResourceId: "api",
      failure: { class: "partial-failure", reason: "ambiguous-provider-return" },
      refresh: async ({ resourceId }) => {
        calls.push(`refresh:${resourceId}`);
        return { exists: true };
      },
      destroy: async ({ resourceId }) => {
        calls.push(`destroy:${resourceId}`);
        return { destroyed: true };
      },
    });

    assert.deepEqual(calls, ["refresh:db", "destroy:db", "destroy:network"]);
    assert.equal(
      outcome.events.some(
        (event) => event.type === "resource.Compensating" && event.resourceId === "cache",
      ),
      false,
      "never-provisioned cache is skipped",
    );
  });

  it("fails closed on a cyclic resource graph", async () => {
    const engine = deterministicEngine();

    await assert.rejects(
      () =>
        engine.compensate({
          deploymentId: "deploy-cycle",
          tenantId: "tenant-a",
          correlationId: "corr-cycle",
          resources: [
            { id: "a", dependsOn: ["b"] },
            { id: "b", dependsOn: ["a"] },
          ],
          eventLog: [provisioned("a", 1), failed("b", "poison", 2)],
          failedResourceId: "b",
          failure: { class: "poison", reason: "cyclic-plan" },
        }),
      /cyclic resource graph/i,
    );
  });
});

function provisioned(resourceId, seq) {
  return {
    id: `evt-${seq}`,
    type: "resource.Provisioned",
    seq,
    deploymentId: "deploy-1",
    resourceId,
    data: { resourceId },
  };
}

function failed(resourceId, failureClass, seq) {
  return {
    id: `evt-${seq}`,
    type: "resource.Failed",
    seq,
    deploymentId: "deploy-1",
    resourceId,
    data: { resourceId, failureClass },
  };
}
