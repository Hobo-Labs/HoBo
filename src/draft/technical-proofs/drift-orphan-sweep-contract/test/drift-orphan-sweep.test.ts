import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  assertProviderTagContract,
  resolveReconcileConflict,
  runDriftOrphanSweep,
} from "../src/drift-orphan-sweep.js";

const scope = {
  tenantId: "tenant-a",
  deploymentId: "deploy-1",
};

const fixtureObjects = [
  object("vm-recorded", "web"),
  object("bucket-orphan", "logs"),
];

describe("HOBO-373 drift reconciliation conflict and orphan sweep contract", () => {
  it("asserts the tenant/deployment/resource tag contract on every provisioned object", () => {
    assert.doesNotThrow(() => assertProviderTagContract(fixtureObjects));

    assert.throws(
      () =>
        assertProviderTagContract([
          object("vm-recorded", "web"),
          { providerId: "untagged", tags: { tenant: "tenant-a", deployment: "deploy-1" } },
        ]),
      /missing required provider tags: resource/,
    );
  });

  it("sweeps a created-but-not-in-state orphan instead of creating a duplicate on refresh", async () => {
    const destroyed = [];
    const outcome = await runDriftOrphanSweep({
      ...scope,
      desiredResources: [{ resourceId: "logs" }],
      stateResources: [],
      providerObjects: [object("bucket-orphan", "logs")],
      destroyProviderObject: ({ providerId }) => {
        destroyed.push(providerId);
        return { status: "destroyed" };
      },
    });

    assert.deepEqual(destroyed, ["bucket-orphan"]);
    assert.equal(outcome.status, "reconciled");
    assert.deepEqual(outcome.actions.map((action) => action.type), ["sweep-orphan"]);
    assert.equal(outcome.actions.some((action) => action.type === "create"), false);
    assert.ok(outcome.events.find((event) => event.type === "drift.OrphanSwept"));
  });

  it("sweeps two interrupted-apply orphans and does not sweep another deployment's tag", async () => {
    const destroyed = [];
    const outcome = await runDriftOrphanSweep({
      ...scope,
      stateResources: [{ resourceId: "web" }],
      providerObjects: [
        object("vm-recorded", "web"),
        object("bucket-orphan", "logs"),
        object("queue-orphan", "jobs"),
        object("other-deploy-object", "logs", { deployment: "deploy-2" }),
      ],
      destroyProviderObject: ({ providerId }) => {
        destroyed.push(providerId);
        return { status: "destroyed" };
      },
    });

    assert.deepEqual(destroyed, ["bucket-orphan", "queue-orphan"]);
    assert.deepEqual(
      outcome.actions.map((action) => [action.type, action.providerId, action.resourceId]),
      [
        ["sweep-orphan", "bucket-orphan", "logs"],
        ["sweep-orphan", "queue-orphan", "jobs"],
      ],
    );
  });

  it("resolves desired-change racing detected drift through one deterministic lease outcome", () => {
    const first = resolveReconcileConflict({
      contenders: [
        { writer: "drift-detection", leasePriority: 20, sequence: 7 },
        { writer: "desired-change", leasePriority: 10, sequence: 8 },
      ],
    });
    const reversed = resolveReconcileConflict({
      contenders: [
        { writer: "desired-change", leasePriority: 10, sequence: 8 },
        { writer: "drift-detection", leasePriority: 20, sequence: 7 },
      ],
    });

    assert.equal(first.winner, "desired-change");
    assert.equal(reversed.winner, "desired-change");
    assert.deepEqual(
      first.events.map((event) => [event.type, event.writer]),
      [
        ["reconcile.ConflictWinnerRecorded", "desired-change"],
        ["reconcile.ConflictLoserRecorded", "drift-detection"],
      ],
    );
  });

  it("records default revert for out-of-band manual change, and adopt only when policy says adopt", async () => {
    const reverted = await runDriftOrphanSweep({
      ...scope,
      stateResources: [{ resourceId: "web", desired: { size: "small" } }],
      providerObjects: [object("vm-recorded", "web", {}, { size: "large" })],
      applyProviderObject: () => ({ status: "applied" }),
    });

    assert.deepEqual(reverted.actions, [
      {
        type: "revert-manual-change",
        providerId: "vm-recorded",
        resourceId: "web",
        desired: { size: "small" },
      },
    ]);
    assert.ok(
      reverted.events.find(
        (event) =>
          event.type === "drift.ManualChangeDecisionRecorded" &&
          event.decision === "revert",
      ),
    );

    const adopted = await runDriftOrphanSweep({
      ...scope,
      manualChangePolicy: "adopt",
      stateResources: [{ resourceId: "web", desired: { size: "small" } }],
      providerObjects: [object("vm-recorded", "web", {}, { size: "large" })],
    });

    assert.deepEqual(adopted.actions, [
      {
        type: "adopt-manual-change",
        providerId: "vm-recorded",
        resourceId: "web",
        observed: { size: "large" },
      },
    ]);
  });

  it("lets rollback win drift interleaving by destroying recorded state and sweeping absent objects", async () => {
    const destroyed = [];
    const outcome = await runDriftOrphanSweep({
      ...scope,
      rollback: true,
      stateResources: [{ resourceId: "web" }],
      providerObjects: [object("vm-recorded", "web"), object("bucket-orphan", "logs")],
      destroyProviderObject: ({ providerId }) => {
        destroyed.push(providerId);
        return { status: "destroyed" };
      },
    });

    assert.deepEqual(destroyed, ["vm-recorded", "bucket-orphan"]);
    assert.deepEqual(
      outcome.actions.map((action) => action.type),
      ["destroy-recorded-state", "sweep-orphan"],
    );
    assert.ok(outcome.events.find((event) => event.type === "reconcile.RollbackWon"));
  });

  it("resumes a mid-sweep failure without re-destroying already swept objects", async () => {
    const firstDestroyed = [];
    const first = await runDriftOrphanSweep({
      ...scope,
      stateResources: [],
      providerObjects: [object("bucket-orphan", "logs"), object("queue-orphan", "jobs")],
      destroyProviderObject: ({ providerId }) => {
        firstDestroyed.push(providerId);
        return providerId === "queue-orphan"
          ? { status: "failed", reason: "provider-500" }
          : { status: "destroyed" };
      },
    });

    assert.equal(first.status, "partial");
    assert.deepEqual(firstDestroyed, ["bucket-orphan", "queue-orphan"]);

    const resumedDestroyed = [];
    const resumed = await runDriftOrphanSweep({
      ...scope,
      stateResources: [],
      providerObjects: [object("bucket-orphan", "logs"), object("queue-orphan", "jobs")],
      eventLog: first.events,
      destroyProviderObject: ({ providerId }) => {
        resumedDestroyed.push(providerId);
        return { status: "destroyed" };
      },
    });

    assert.equal(resumed.status, "reconciled");
    assert.deepEqual(resumedDestroyed, ["queue-orphan"]);
    assert.equal(
      resumed.events.filter((event) => event.type === "drift.OrphanSwept").length,
      2,
    );
  });
});

function object(providerId, resource, tags = {}, observed = {}) {
  return {
    providerId,
    tags: {
      tenant: "tenant-a",
      deployment: "deploy-1",
      resource,
      ...tags,
    },
    observed,
  };
}
