import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { snapshotMeteringView } from "../../metering-view-projection-contract/src/metering-view.js";

import {
  annotateRunInspector,
  createShowbackReport,
  selectShowbackRow,
} from "../src/showback-attribution.js";

const COST_CATALOG = {
  currency: "USD",
  unitPrices: {
    "runtime-compute-seconds": 0.01,
    "egress-GB": 0.25,
    "generation-runs": 0.333333333333,
  },
};

function usage(seq, overrides = {}) {
  return {
    id: overrides.id ?? `usage-${seq}`,
    type: "meter.UsageRecorded",
    seq,
    dimension: overrides.dimension ?? "runtime-compute-seconds",
    quantity: overrides.quantity ?? 1,
    priceKey: overrides.priceKey,
    occurredAt: overrides.occurredAt ?? "2026-06-25T12:00:00.000Z",
    idempotencyKey: overrides.idempotencyKey ?? `usage-${seq}`,
    owner: {
      tenantId: "tenant-a",
      campId: "camp-prod",
      bindleId: "checkout",
      runId: "run-checkout",
      agentId: "agent-deploy",
      teamId: "team-platform-stable-id",
      ...overrides.owner,
    },
  };
}

function viewFrom(events, seq = events.at(-1)?.seq ?? 0) {
  return snapshotMeteringView(events, { seq, costCatalog: COST_CATALOG });
}

describe("showback attribution contract", () => {
  it("rolls MeteringView costs up tenant -> Camp -> Bindle -> run and traces source events", () => {
    const meteringView = viewFrom([
      usage(1, { quantity: 50, id: "run-1-compute" }),
      usage(2, {
        id: "run-1-egress",
        dimension: "egress-GB",
        quantity: 2,
        owner: { runId: "run-checkout" },
      }),
      usage(3, {
        id: "run-2-compute",
        quantity: 20,
        owner: { runId: "run-import", agentId: "agent-import" },
      }),
    ]);

    const report = createShowbackReport({ meteringView, costCatalog: COST_CATALOG });

    assert.equal(report.schemaVersion, "hobo.showback/v1");
    assert.equal(report.source.meteringViewSeq, 3);
    assert.equal(report.source.meteringViewDigest, meteringView.digest);
    assert.equal(selectShowbackRow(report, { kind: "tenant", id: "tenant-a" }).cost, 1.2);
    assert.equal(selectShowbackRow(report, { kind: "camp", id: "tenant-a/camp-prod" }).cost, 1.2);
    assert.equal(selectShowbackRow(report, { kind: "bindle", id: "tenant-a/camp-prod/checkout" }).cost, 1.2);

    assert.deepEqual(
      report.levels.runs.map((row) => ({ id: row.id, cost: row.cost, sourceEventIds: row.sourceEventIds })),
      [
        {
          id: "tenant-a/camp-prod/checkout/run-checkout",
          cost: 1,
          sourceEventIds: ["run-1-compute", "run-1-egress"],
        },
        {
          id: "tenant-a/camp-prod/checkout/run-import",
          cost: 0.2,
          sourceEventIds: ["run-2-compute"],
        },
      ],
    );
    assert.equal(report.rollupChecks.tenantToCampBalanced, true);
    assert.equal(report.rollupChecks.tenantToRunBalanced, true);
  });

  it("isolates per-agent showback without hiding tenant totals", () => {
    const report = createShowbackReport({
      meteringView: viewFrom([
        usage(1, { id: "deploy-compute", quantity: 10, owner: { agentId: "agent-deploy" } }),
        usage(2, { id: "review-compute", quantity: 7, owner: { agentId: "agent-reviewer" } }),
      ]),
      costCatalog: COST_CATALOG,
    });

    const deployAgent = selectShowbackRow(report, {
      kind: "agent",
      id: "tenant-a/agent-deploy",
    });

    assert.equal(selectShowbackRow(report, { kind: "tenant", id: "tenant-a" }).cost, 0.17);
    assert.equal(deployAgent.cost, 0.1);
    assert.deepEqual(deployAgent.sourceEventIds, ["deploy-compute"]);
  });

  it("attaches cost annotations to run-inspector rows with MeteringView evidence", () => {
    const meteringView = viewFrom([usage(1, { id: "run-cost", quantity: 12 })]);
    const report = createShowbackReport({ meteringView, costCatalog: COST_CATALOG });

    const inspector = annotateRunInspector(report, {
      runs: [{ runId: "run-checkout", title: "checkout deploy" }],
    });

    assert.deepEqual(inspector.runs[0].costAnnotation, {
      cost: 0.12,
      presentationCost: 0.12,
      currency: "USD",
      meteringViewSeq: 1,
      meteringViewDigest: meteringView.digest,
      sourceEventIds: ["run-cost"],
    });
  });

  it("uses full run hierarchy when annotating duplicate run ids", () => {
    const meteringView = viewFrom([
      usage(1, { id: "tenant-a-run", quantity: 1, owner: { runId: "shared-run" } }),
      usage(2, {
        id: "tenant-b-run",
        quantity: 7,
        owner: {
          tenantId: "tenant-b",
          campId: "camp-prod",
          bindleId: "checkout",
          runId: "shared-run",
        },
      }),
    ]);
    const report = createShowbackReport({ meteringView, costCatalog: COST_CATALOG });

    const inspector = annotateRunInspector(report, {
      runs: [
        { runId: "shared-run" },
        {
          tenantId: "tenant-b",
          campId: "camp-prod",
          bindleId: "checkout",
          runId: "shared-run",
        },
      ],
    });

    assert.equal(inspector.runs[0].costAnnotation, undefined);
    assert.equal(inspector.runs[1].costAnnotation.cost, 0.07);
    assert.deepEqual(inspector.runs[1].costAnnotation.sourceEventIds, ["tenant-b-run"]);
  });

  it("rejects showback catalogs that diverge from the source MeteringView", () => {
    const meteringView = viewFrom([usage(1, { id: "run-cost", quantity: 10 })]);

    assert.throws(
      () =>
        createShowbackReport({
          meteringView,
          costCatalog: {
            ...COST_CATALOG,
            unitPrices: { ...COST_CATALOG.unitPrices, "runtime-compute-seconds": 0.02 },
          },
        }),
      /recomputed showback total must match MeteringView totalCost/,
    );
    assert.throws(
      () =>
        createShowbackReport({
          meteringView,
          costCatalog: { ...COST_CATALOG, currency: "EUR" },
        }),
      /costCatalog.currency must match MeteringView currency/,
    );
  });

  it("turns MeteringView attribution gaps into explicit showback rules", () => {
    const missingOwner = usage(1, { id: "missing-owner" });
    delete missingOwner.owner;
    const meteringView = viewFrom([missingOwner]);
    const report = createShowbackReport({ meteringView, costCatalog: COST_CATALOG });

    assert.equal(report.totalCost, 0);
    assert.deepEqual(report.levels.tenants, []);
    assert.deepEqual(report.attributionRules, [
      {
        eventId: "missing-owner",
        rule: "missing-owning-principal",
        resolution: "exclude from showback attribution until owning principal is corrected",
      },
    ]);
  });

  it("keeps ambiguous owner facts at the known hierarchy and records the attribution rule", () => {
    const ambiguous = usage(1, {
      id: "ambiguous-owner",
      quantity: 10,
      owner: {
        runId: "run-checkout",
        agentId: undefined,
        teamId: undefined,
      },
    });
    delete ambiguous.owner.agentId;
    delete ambiguous.owner.teamId;

    const report = createShowbackReport({
      meteringView: viewFrom([
        ambiguous,
        usage(2, {
          id: "known-agent",
          quantity: 5,
          owner: { agentId: "agent-deploy" },
        }),
      ]),
      costCatalog: COST_CATALOG,
    });

    assert.equal(selectShowbackRow(report, { kind: "tenant", id: "tenant-a" }).cost, 0.15);
    assert.equal(selectShowbackRow(report, { kind: "agent", id: "tenant-a/agent-deploy" }).presentationCost, 0.05);
    assert.deepEqual(report.attributionRules, [
      {
        eventId: "ambiguous-owner",
        rule: "agent-or-team-ambiguous",
        resolution: "attribute to tenant/camp/bindle/run only",
      },
    ]);
  });

  it("defers shared-resource cost across Bindles instead of inventing a split", () => {
    const report = createShowbackReport({
      meteringView: viewFrom([
        usage(1, {
          id: "shared-egress",
          dimension: "egress-GB",
          quantity: 1,
          owner: {
            sharedBindleIds: ["checkout", "search"],
          },
        }),
      ]),
      costCatalog: COST_CATALOG,
    });

    assert.equal(selectShowbackRow(report, { kind: "tenant", id: "tenant-a" }).cost, 0.25);
    assert.equal(report.levels.bindles.length, 0);
    assert.deepEqual(report.deferredAllocations, [
      {
        eventId: "shared-egress",
        cost: 0.25,
        reason: "shared-resource-attribution-deferred",
        bindleIds: ["checkout", "search"],
      },
    ]);
  });

  it("uses stable historical team identifiers across team rename metadata", () => {
    const report = createShowbackReport({
      meteringView: viewFrom([
        usage(1, {
          id: "team-before-rename",
          owner: {
            teamId: "team-platform-stable-id",
            teamDisplayName: "Platform",
          },
        }),
        usage(2, {
          id: "team-after-rename",
          owner: {
            teamId: "team-platform-stable-id",
            teamDisplayName: "Platform Engineering",
          },
        }),
      ]),
      costCatalog: COST_CATALOG,
      displayNames: {
        teams: {
          "tenant-a/team-platform-stable-id": "Platform Engineering",
        },
      },
    });

    const team = selectShowbackRow(report, {
      kind: "team",
      id: "tenant-a/team-platform-stable-id",
    });

    assert.equal(team.cost, 0.02);
    assert.equal(team.displayName, "Platform Engineering");
    assert.deepEqual(team.sourceEventIds, ["team-before-rename", "team-after-rename"]);
  });

  it("rounds each tenant presentation total independently of unrelated tenants", () => {
    const report = createShowbackReport({
      meteringView: viewFrom([
        usage(1, {
          id: "tenant-a-third",
          dimension: "generation-runs",
          owner: { runId: "run-a" },
        }),
        usage(2, {
          id: "tenant-b-third",
          dimension: "generation-runs",
          owner: {
            tenantId: "tenant-b",
            campId: "camp-prod",
            bindleId: "checkout",
            runId: "run-b",
          },
        }),
      ]),
      costCatalog: COST_CATALOG,
    });

    assert.equal(selectShowbackRow(report, { kind: "tenant", id: "tenant-a" }).presentationCost, 0.33);
    assert.equal(selectShowbackRow(report, { kind: "camp", id: "tenant-a/camp-prod" }).presentationCost, 0.33);
    assert.equal(selectShowbackRow(report, { kind: "tenant", id: "tenant-b" }).presentationCost, 0.33);
    assert.equal(selectShowbackRow(report, { kind: "camp", id: "tenant-b/camp-prod" }).presentationCost, 0.33);
  });

  it("reconciles rounded presentation costs so children sum to the parent", () => {
    const report = createShowbackReport({
      meteringView: viewFrom([
        usage(1, {
          id: "third-a",
          dimension: "generation-runs",
          owner: { runId: "run-a" },
        }),
        usage(2, {
          id: "third-b",
          dimension: "generation-runs",
          owner: { runId: "run-b" },
        }),
        usage(3, {
          id: "third-c",
          dimension: "generation-runs",
          owner: { runId: "run-c" },
        }),
        usage(4, {
          id: "third-d",
          dimension: "generation-runs",
          owner: {
            tenantId: "tenant-b",
            campId: "camp-prod",
            bindleId: "checkout",
            runId: "run-d",
          },
        }),
        usage(5, {
          id: "third-e",
          dimension: "generation-runs",
          owner: {
            tenantId: "tenant-b",
            campId: "camp-prod",
            bindleId: "checkout",
            runId: "run-e",
          },
        }),
        usage(6, {
          id: "third-f",
          dimension: "generation-runs",
          owner: {
            tenantId: "tenant-b",
            campId: "camp-prod",
            bindleId: "checkout",
            runId: "run-f",
          },
        }),
      ]),
      costCatalog: COST_CATALOG,
    });

    assert.equal(selectShowbackRow(report, { kind: "tenant", id: "tenant-a" }).presentationCost, 1);
    assert.equal(selectShowbackRow(report, { kind: "tenant", id: "tenant-b" }).presentationCost, 1);
    assert.equal(
      report.levels.runs
        .filter((row) => row.id.startsWith("tenant-a/"))
        .reduce((total, row) => Number((total + row.presentationCost).toFixed(2)), 0),
      1,
    );
    assert.equal(
      report.levels.runs
        .filter((row) => row.id.startsWith("tenant-b/"))
        .reduce((total, row) => Number((total + row.presentationCost).toFixed(2)), 0),
      1,
    );
    assert.deepEqual(
      report.levels.runs
        .filter((row) => row.id.startsWith("tenant-a/"))
        .map((row) => ({ id: row.id, presentationCost: row.presentationCost })),
      [
        { id: "tenant-a/camp-prod/checkout/run-a", presentationCost: 0.34 },
        { id: "tenant-a/camp-prod/checkout/run-b", presentationCost: 0.33 },
        { id: "tenant-a/camp-prod/checkout/run-c", presentationCost: 0.33 },
      ],
    );
  });
});
