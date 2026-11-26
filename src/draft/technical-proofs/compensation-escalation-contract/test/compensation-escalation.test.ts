import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { runCompensationEscalation } from "../src/compensation-escalation.js";

const resources = [
  { id: "network", dependsOn: [] },
  { id: "database", dependsOn: ["network"] },
  { id: "api", dependsOn: ["database"] },
];

describe("HOBO-315 compensation-of-compensation escalation", () => {
  it("caps failed destroy retries and terminates needs-human with exact orphan inventory", async () => {
    const outcome = await runCompensationEscalation({
      deploymentId: "deploy-failed-destroy",
      resources,
      provisioned: ["network", "database", "api"],
      retryCap: 2,
      destroy: () => ({ status: "failed", reason: "permission-denied" }),
    });

    assert.equal(outcome.status, "needs-human");
    assert.deepEqual(
      outcome.events.map((event) => event.type),
      [
        "compensation.Started",
        "compensation.DestroyFailed",
        "compensation.RetryScheduled",
        "compensation.DestroyFailed",
        "compensation.EscalationPersisted",
        "compensation.Escalated",
      ],
    );
    assert.deepEqual(outcome.orphanInventory, [
      { resourceId: "api", state: "unreclaimed", reason: "permission-denied" },
      { resourceId: "database", state: "blocked-by-dependent", reason: "api" },
      { resourceId: "network", state: "blocked-by-dependent", reason: "database" },
    ]);
  });

  it("refreshes ambiguous destroy before escalating the unreclaimed slice", async () => {
    const refreshCalls = [];
    const outcome = await runCompensationEscalation({
      deploymentId: "deploy-ambiguous",
      resources,
      provisioned: ["network", "database"],
      retryCap: 1,
      destroy: ({ resourceId }) =>
        resourceId === "database"
          ? { status: "ambiguous", reason: "socket-closed" }
          : { status: "destroyed" },
      refresh: ({ resourceId }) => {
        refreshCalls.push(resourceId);
        return { exists: true, reason: "provider-object-still-present" };
      },
    });

    assert.deepEqual(refreshCalls, ["database"]);
    assert.equal(outcome.status, "needs-human");
    assert.deepEqual(outcome.orphanInventory, [
      { resourceId: "database", state: "unreclaimed", reason: "provider-object-still-present" },
      { resourceId: "network", state: "blocked-by-dependent", reason: "database" },
    ]);
  });

  it("awaits async refresh before deciding whether ambiguous destroy reclaimed the object", async () => {
    let refreshCalled = false;
    const outcome = await runCompensationEscalation({
      deploymentId: "deploy-async-refresh",
      resources,
      provisioned: ["network"],
      retryCap: 1,
      destroy: () => ({ status: "ambiguous", reason: "socket-closed" }),
      refresh: async ({ resourceId }) => {
        assert.equal(resourceId, "network");
        refreshCalled = true;
        return { exists: true, reason: "provider-object-still-present" };
      },
    });

    assert.equal(refreshCalled, true);
    assert.equal(outcome.status, "needs-human");
    assert.deepEqual(outcome.orphanInventory, [
      { resourceId: "network", state: "unreclaimed", reason: "provider-object-still-present" },
    ]);
  });

  it("treats ambiguous destroy as reclaimed when refresh proves the object is gone", async () => {
    const outcome = await runCompensationEscalation({
      deploymentId: "deploy-ambiguous-gone",
      resources,
      provisioned: ["network"],
      retryCap: 1,
      destroy: () => ({ status: "ambiguous", reason: "socket-closed" }),
      refresh: () => ({ exists: false }),
    });

    assert.equal(outcome.status, "rolled-back");
    assert.deepEqual(outcome.orphanInventory, []);
    assert.deepEqual(
      outcome.events.map((event) => event.type),
      [
        "compensation.Started",
        "compensation.ResourceDestroyed",
      ],
    );
  });

  it("does not double-destroy already reclaimed resources when compensation resumes", async () => {
    const destroyed = [];
    const first = await runCompensationEscalation({
      deploymentId: "deploy-resume",
      resources,
      provisioned: ["network", "database", "api"],
      retryCap: 1,
      destroy: ({ resourceId }) => {
        destroyed.push(resourceId);
        return resourceId === "database"
          ? { status: "failed", reason: "provider-500" }
          : { status: "destroyed" };
      },
    });

    const resumed = await runCompensationEscalation({
      deploymentId: "deploy-resume",
      resources,
      provisioned: ["network", "database", "api"],
      retryCap: 1,
      eventLog: first.events,
      destroy: ({ resourceId }) => {
        destroyed.push(resourceId);
        return { status: "destroyed" };
      },
    });

    assert.deepEqual(destroyed, ["api", "database", "database", "network"]);
    assert.equal(resumed.status, "rolled-back");
    assert.deepEqual(resumed.orphanInventory, []);
  });

  it("persists escalation before notify and retries notification without losing needs-human state", async () => {
    let notifyAttempts = 0;
    const outcome = await runCompensationEscalation({
      deploymentId: "deploy-notify",
      resources,
      provisioned: ["network"],
      retryCap: 1,
      destroy: () => ({ status: "failed", reason: "access-denied" }),
      notifyEscalation: () => {
        notifyAttempts += 1;
        return notifyAttempts === 1
          ? { status: "failed", reason: "pager-timeout" }
          : { status: "notified" };
      },
    });

    assert.equal(notifyAttempts, 2);
    assert.equal(outcome.status, "needs-human");
    assert.ok(outcome.events.find((event) => event.type === "compensation.EscalationPersisted"));
    assert.ok(outcome.events.find((event) => event.type === "compensation.EscalationNotifyFailed"));
    assert.ok(outcome.events.find((event) => event.type === "compensation.Escalated"));
  });

  it("awaits async escalation notification failure before retrying the human handoff", async () => {
    let notifyAttempts = 0;
    const outcome = await runCompensationEscalation({
      deploymentId: "deploy-async-notify",
      resources,
      provisioned: ["network"],
      retryCap: 1,
      destroy: () => ({ status: "failed", reason: "access-denied" }),
      notifyEscalation: async () => {
        notifyAttempts += 1;
        return notifyAttempts === 1
          ? { status: "failed", reason: "pager-timeout" }
          : { status: "notified" };
      },
    });

    assert.equal(notifyAttempts, 2);
    assert.equal(outcome.status, "needs-human");
    assert.equal(outcome.events.at(-1).notified, true);
    assert.ok(outcome.events.find((event) => event.type === "compensation.EscalationNotifyFailed"));
  });

  it("escalates hangs, retry storms, and compensation dependency deadlocks", async () => {
    const hang = await runCompensationEscalation({
      deploymentId: "deploy-hang",
      resources,
      provisioned: ["network"],
      retryCap: 1,
      deadlineMs: 1000,
      destroy: () => ({ status: "timeout", elapsedMs: 5000, reason: "deadline-exceeded" }),
    });
    assert.equal(hang.status, "needs-human");
    assert.equal(hang.orphanInventory[0].reason, "deadline-exceeded");

    const storm = await runCompensationEscalation({
      deploymentId: "deploy-storm",
      resources,
      provisioned: ["network"],
      retryCap: 10,
      retryBudget: 1,
      destroy: () => ({ status: "failed", reason: "provider-429" }),
    });
    assert.equal(storm.status, "needs-human");
    assert.equal(storm.escalation.reason, "retry-budget-exhausted");

    const deadlock = await runCompensationEscalation({
      deploymentId: "deploy-deadlock",
      resources: [
        { id: "a", dependsOn: ["b"] },
        { id: "b", dependsOn: ["a"] },
      ],
      provisioned: ["a", "b"],
      retryCap: 1,
      destroy: () => ({ status: "destroyed" }),
    });
    assert.equal(deadlock.status, "needs-human");
    assert.equal(deadlock.escalation.reason, "compensation-dependency-deadlock");
  });
});
