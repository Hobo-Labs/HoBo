import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  applyMeteringEvent,
  emitMeterRollups,
  snapshotMeteringView,
} from "../src/metering-view.js";

const COST_CATALOG = {
  currency: "USD",
  unitPrices: {
    "control-plane-ops": 0.02,
    "runtime-compute-seconds": 0.00004,
    "storage-GB": 0.021,
    "egress-GB": {
      same_region: 0,
      cross_region: 0.02,
      internet: 0.09,
    },
    "generation-runs": 0.12,
  },
};

function usage(seq, overrides = {}) {
  return {
    id: overrides.id ?? `evt-${seq}`,
    type: "meter.UsageRecorded",
    seq,
    dimension: overrides.dimension ?? "runtime-compute-seconds",
    quantity: overrides.quantity ?? 10,
    priceKey: overrides.priceKey,
    occurredAt: overrides.occurredAt ?? "2026-06-25T12:00:00.000Z",
    idempotencyKey: overrides.idempotencyKey ?? `usage-${seq}`,
    owner: {
      tenantId: overrides.tenantId ?? "tenant-a",
      campId: overrides.campId ?? "camp-prod",
      bindleId: overrides.bindleId ?? "checkout",
      runId: overrides.runId ?? "run-1",
      agentId: overrides.agentId ?? "agent-deploy",
      teamId: overrides.teamId ?? "team-platform",
      ...overrides.owner,
    },
  };
}

describe("MeteringView projection skeleton", () => {
  it("rebuilds and incrementally folds deterministic attributed counters with seq-pinned rollups", () => {
    const events = [
      usage(3, { dimension: "generation-runs", quantity: 2 }),
      usage(1, { quantity: 30 }),
      usage(2, { dimension: "egress-GB", priceKey: "internet", quantity: 4 }),
      usage(4, { quantity: 5 }),
    ];

    const replayed = snapshotMeteringView(events, { seq: 3, costCatalog: COST_CATALOG });
    const replayedAgain = snapshotMeteringView([...events].reverse(), {
      seq: 3,
      costCatalog: COST_CATALOG,
    });
    const incremental = events
      .filter((event) => event.seq <= 3)
      .reduce(
        (view, event) => applyMeteringEvent(view, event, { costCatalog: COST_CATALOG }),
        snapshotMeteringView([], { seq: 0, costCatalog: COST_CATALOG }),
      );

    assert.equal(replayed.digest, replayedAgain.digest);
    assert.equal(replayed.digest, incremental.digest);
    assert.equal(replayed.seq, 3);
    assert.equal(replayed.totals["runtime-compute-seconds"].quantity, 30);
    assert.equal(replayed.totals["runtime-compute-seconds"].cost, 0.0012);
    assert.equal(replayed.totals["egress-GB"].cost, 0.36);
    assert.equal(replayed.totals["generation-runs"].cost, 0.24);
    assert.equal(replayed.totalCost, 0.6012);

    assert.deepEqual(replayed.principalHierarchy, {
      tenants: ["tenant-a"],
      camps: ["tenant-a/camp-prod"],
      bindles: ["tenant-a/camp-prod/checkout"],
      runs: ["tenant-a/camp-prod/checkout/run-1"],
      agents: ["tenant-a/agent-deploy"],
      teams: ["tenant-a/team-platform"],
    });

    assert.equal(replayed.buckets[0].period, "2026-06-25");
    assert.equal(replayed.buckets[0].counters["runtime-compute-seconds"].quantity, 30);
    assert.deepEqual(
      emitMeterRollups(replayed).map((event) => event.type),
      ["meter.RollupEmitted", "meter.RollupEmitted", "meter.RollupEmitted"],
    );
  });

  it("records missing owning principal as an attribution gap instead of dropping or charging it", () => {
    const eventWithoutOwner = usage(1);
    delete eventWithoutOwner.owner;

    const snapshot = snapshotMeteringView([eventWithoutOwner], {
      seq: 1,
      costCatalog: COST_CATALOG,
    });

    assert.deepEqual(snapshot.totals, {});
    assert.deepEqual(snapshot.attributionGaps, [
      {
        eventId: "evt-1",
        seq: 1,
        dimension: "runtime-compute-seconds",
        reason: "missing-owning-principal",
      },
    ]);
  });

  it("fails closed before counters exceed the safe integer range", () => {
    assert.throws(
      () =>
        snapshotMeteringView(
          [
            usage(1, { quantity: Number.MAX_SAFE_INTEGER }),
            usage(2, { quantity: 1 }),
          ],
          { seq: 2, costCatalog: COST_CATALOG },
        ),
      /counter overflow/,
    );
  });

  it("deduplicates repeated usage events and keeps period-boundary buckets separate", () => {
    const snapshot = snapshotMeteringView(
      [
        usage(2, {
          id: "evt-duplicate",
          idempotencyKey: "same-runtime-usage",
          quantity: 99,
          occurredAt: "2026-06-26T00:00:00.000Z",
        }),
        usage(1, {
          id: "evt-original",
          idempotencyKey: "same-runtime-usage",
          quantity: 1,
          occurredAt: "2026-06-25T23:59:59.000Z",
        }),
        usage(3, {
          quantity: 2,
          occurredAt: "2026-06-26T00:00:01.000Z",
        }),
      ],
      { seq: 3, costCatalog: COST_CATALOG },
    );

    assert.equal(snapshot.totals["runtime-compute-seconds"].quantity, 3);
    assert.deepEqual(
      snapshot.buckets.map((bucket) => ({
        period: bucket.period,
        quantity: bucket.counters["runtime-compute-seconds"].quantity,
      })),
      [
        { period: "2026-06-25", quantity: 1 },
        { period: "2026-06-26", quantity: 2 },
      ],
    );
    assert.deepEqual(snapshot.deduplicatedEvents, [
      {
        eventId: "evt-duplicate",
        idempotencyKey: "same-runtime-usage",
        originalEventId: "evt-original",
      },
    ]);
  });

  it("fails closed when cost.json lacks the event dimension price", () => {
    assert.throws(
      () =>
        snapshotMeteringView(
          [usage(1, { dimension: "storage-GB" })],
          {
            seq: 1,
            costCatalog: {
              currency: "USD",
              unitPrices: {
                "runtime-compute-seconds": 0.00004,
              },
            },
          },
        ),
      /missing unit price for storage-GB/,
    );
  });
});
