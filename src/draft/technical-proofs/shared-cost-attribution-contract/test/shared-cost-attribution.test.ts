import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  allocateSharedResourceCost,
  showbackForTenant,
} from "../src/shared-cost-attribution.js";

function consumer(id, overrides = {}) {
  return {
    tenantId: `tenant-${id}`,
    campId: "camp-prod",
    bindleId: "orders",
    registrationEventId: `consumer.${id}.registered`,
    ...overrides,
  };
}

function usage(eventId, tenantId, units, overrides = {}) {
  const { consumer: consumerOverrides, ...eventOverrides } = overrides;
  return {
    eventId,
    idempotencyKey: eventId,
    seq: eventOverrides.seq ?? Number(eventId.replace(/\D/g, "")),
    resourceId: "shared-db",
    occurredAt: "2026-06-27T10:00:00.000Z",
    consumer: consumer(tenantId, consumerOverrides),
    usageUnits: units,
    ...eventOverrides,
  };
}

function allocate(overrides = {}) {
  return allocateSharedResourceCost({
    resourceId: "shared-db",
    period: "2026-06",
    currency: "USD",
    totalCostCents: 1000,
    ownerPrincipal: { kind: "tenant", tenantId: "platform-services" },
    policy: { strategy: "usage-share" },
    usageEvents: [
      usage("usage-1", "a", 50),
      usage("usage-2", "b", 30),
      usage("usage-3", "c", 20),
    ],
    ...overrides,
  });
}

function shareByTenant(allocation, tenantId) {
  return allocation.shares.find((share) => share.tenantId === tenantId);
}

describe("shared resource cost attribution contract", () => {
  it("splits a shared database across three tenants without double-counting or remainder", () => {
    const allocation = allocate();

    assert.equal(allocation.schemaVersion, "hobo.shared-cost-attribution/v1");
    assert.equal(allocation.rollupChecks.sharesSumToTotal, true);
    assert.equal(allocation.rollupChecks.unattributedRemainderCents, 0);
    assert.equal(allocation.totalCostCents, 1000);
    assert.deepEqual(
      allocation.shares.map((share) => ({
        tenantId: share.tenantId,
        usageUnits: share.usageUnits,
        costCents: share.costCents,
      })),
      [
        { tenantId: "tenant-a", usageUnits: 50, costCents: 500 },
        { tenantId: "tenant-b", usageUnits: 30, costCents: 300 },
        { tenantId: "tenant-c", usageUnits: 20, costCents: 200 },
      ],
    );
  });

  it("filters tenant showback so one tenant never sees another tenant cost or identity", () => {
    const tenantShowback = showbackForTenant(allocate(), "tenant-a");

    assert.equal(tenantShowback.tenantId, "tenant-a");
    assert.equal(tenantShowback.totalCostCents, 500);
    assert.equal(tenantShowback.shares.length, 1);
    const serialized = JSON.stringify(tenantShowback);
    assert.equal(serialized.includes("tenant-b"), false);
    assert.equal(serialized.includes("tenant-c"), false);
    assert.equal(serialized.includes("300"), false);
    assert.equal(serialized.includes("200"), false);
  });

  it("matches usage-weighted split to recorded per-consumer usage facts", () => {
    const allocation = allocate({
      totalCostCents: 999,
      usageEvents: [usage("usage-1", "a", 1), usage("usage-2", "b", 2), usage("usage-3", "c", 6)],
    });

    assert.deepEqual(
      allocation.shares.map((share) => [share.tenantId, share.costCents, share.usageEventIds]),
      [
        ["tenant-a", 111, ["usage-1"]],
        ["tenant-b", 222, ["usage-2"]],
        ["tenant-c", 666, ["usage-3"]],
      ],
    );
  });

  it("replays deterministically from out-of-order logs and ignores duplicate usage facts", () => {
    const events = [
      usage("usage-3", "c", 20, { seq: 3 }),
      usage("usage-1", "a", 50, { seq: 1 }),
      usage("usage-2", "b", 30, { seq: 2 }),
      usage("usage-2-copy", "b", 30, { seq: 99, idempotencyKey: "usage-2" }),
    ];

    const allocation = allocate({ usageEvents: events });
    const replayed = allocate({ usageEvents: [...events].reverse() });

    assert.equal(allocation.allocationId, replayed.allocationId);
    assert.deepEqual(allocation.shares, replayed.shares);
    assert.deepEqual(allocation.deduplicatedUsageEvents, [
      { eventId: "usage-2-copy", idempotencyKey: "usage-2", originalEventId: "usage-2" },
    ]);
  });

  it("gives zero-usage consumers fixed overhead only, not variable usage share", () => {
    const allocation = allocate({
      totalCostCents: 1000,
      fixedOverheadCents: 300,
      consumers: [consumer("a"), consumer("b"), consumer("c")],
      usageEvents: [usage("usage-1", "a", 70), usage("usage-2", "b", 30)],
    });

    assert.equal(shareByTenant(allocation, "tenant-a").costCents, 590);
    assert.equal(shareByTenant(allocation, "tenant-b").costCents, 310);
    assert.deepEqual(
      {
        costCents: shareByTenant(allocation, "tenant-c").costCents,
        fixedOverheadCents: shareByTenant(allocation, "tenant-c").fixedOverheadCents,
        variableCents: shareByTenant(allocation, "tenant-c").variableCents,
        usageUnits: shareByTenant(allocation, "tenant-c").usageUnits,
      },
      { costCents: 100, fixedOverheadCents: 100, variableCents: 0, usageUnits: 0 },
    );
  });

  it("canonicalizes consumer denominator so tenant churn cannot dilute others", () => {
    const churnedAllocation = allocate({
      totalCostCents: 300,
      fixedOverheadCents: 300,
      usageEvents: [
        usage("usage-1", "a", 1, { consumer: { runId: "run-a-1" } }),
        usage("usage-2", "a", 1, { consumer: { runId: "run-a-2" } }),
        usage("usage-3", "a", 1, { consumer: { runId: "run-a-3" } }),
        usage("usage-4", "b", 1, { consumer: { runId: "run-b-1" } }),
        usage("usage-5", "c", 1, { consumer: { runId: "run-c-1" } }),
      ],
    });

    assert.deepEqual(
      churnedAllocation.shares.map((share) => [share.tenantId, share.costCents]),
      [
        ["tenant-a", 100],
        ["tenant-b", 100],
        ["tenant-c", 100],
      ],
    );
    assert.equal(churnedAllocation.rollupChecks.denominatorConsumerCount, 3);
  });

  it("reconciles rounding so cents are neither lost nor duplicated", () => {
    const allocation = allocate({
      totalCostCents: 100,
      fixedOverheadCents: 100,
      policy: { strategy: "equal" },
      consumers: [consumer("a"), consumer("b"), consumer("c")],
      usageEvents: [],
    });

    assert.deepEqual(
      allocation.shares.map((share) => [share.tenantId, share.costCents]),
      [
        ["tenant-a", 34],
        ["tenant-b", 33],
        ["tenant-c", 33],
      ],
    );
    assert.equal(allocation.rollupChecks.sharesSumToTotal, true);
  });

  it("keeps platform-owned overhead in the system bucket when no consumer facts exist", () => {
    const allocation = allocate({
      ownerPrincipal: { kind: "platform", principalId: "hobo-platform" },
      totalCostCents: 417,
      usageEvents: [],
    });

    assert.deepEqual(allocation.shares, []);
    assert.deepEqual(allocation.systemOverheadBucket, {
      costCents: 417,
      currency: "USD",
      reason: "platform-owned-shared-resource-without-consumer-facts",
      auditFactIds: ["resource-cost:shared-db:2026-06"],
    });
    assert.equal(allocation.rollupChecks.sharesSumToTotal, true);
  });

  it("audits every share back to cost, consumer, and usage facts", () => {
    const allocation = allocate({
      fixedOverheadCents: 300,
      consumers: [consumer("a"), consumer("b"), consumer("c")],
      usageEvents: [usage("usage-1", "a", 70), usage("usage-2", "b", 30)],
    });

    for (const share of allocation.shares) {
      assert.match(share.auditFactIds[0], /^resource-cost:/);
      assert.ok(
        share.auditFactIds.some((factId) => factId === share.registrationEventId || share.usageEventIds.includes(factId)),
      );
    }
  });
});
