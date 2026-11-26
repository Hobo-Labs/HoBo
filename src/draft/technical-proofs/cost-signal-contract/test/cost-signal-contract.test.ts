import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  COST_JSON_SCHEMA_VERSION,
  COST_SIGNAL_EVENT_SCHEMA_VERSION,
  CREDIT_LEDGER_VIEW_SCHEMA_VERSION,
  parseCostJson,
  parseCostSignalEvent,
  serializeCostSignalEvent,
  serializeCreditLedgerView,
  splitMeteringPeriodByResetWindow,
  validateCostCatalogSet,
  validatePlanCostCoverage,
} from "../src/cost-signal-contract.js";

const validCostJson = {
  schemaVersion: COST_JSON_SCHEMA_VERSION,
  providerId: "aws",
  currency: "USD",
  regions: ["us-east", "eu-west"],
  tiers: {
    "database.pg.flex.instance-hour": ["small", "medium"],
    "egress-gb": ["same-region", "cross-region", "internet"],
    "generation-runs": ["standard", "large"],
  },
  unitPrices: {
    "control-plane-ops": 0.0002,
    "runtime-compute-seconds": 0.000012,
    "database.pg.flex.instance-hour": {
      small: 0.06,
      medium: 0.12,
    },
    "storage-gb": {
      "us-east": 0.021,
      "eu-west": 0.024,
    },
    "egress-gb": {
      "same-region": 0,
      "cross-region": 0.02,
      internet: 0.09,
    },
    "generation-runs": {
      standard: 0.05,
      large: 0.2,
    },
  },
  freeTier: {
    "storage-gb": {
      amount: 5,
      resetWindow: "P1M",
    },
    "generation-runs": {
      amount: 100,
      resetWindow: "P1M",
    },
  },
};

describe("cost signal contract", () => {
  it("parses a versioned cost.json with tiered and region-keyed prices", () => {
    const parsed = parseCostJson(validCostJson);

    assert.equal(parsed.schemaVersion, COST_JSON_SCHEMA_VERSION);
    assert.equal(parsed.providerId, "aws");
    assert.equal(parsed.unitPrices["storage-gb"]["eu-west"], 0.024);
    assert.equal(parsed.unitPrices["database.pg.flex.instance-hour"].medium, 0.12);
    assert.equal(parsed.freeTier["generation-runs"].amount, 100);
  });

  it("round-trips meter, spend, and credit events through typed schemas", () => {
    const events = [
      parseCostSignalEvent({
        schemaVersion: COST_SIGNAL_EVENT_SCHEMA_VERSION,
        type: "meter.UsageRecorded",
        seq: 12,
        time: "2026-06-01T00:00:00.000Z",
        tenantId: "tenant-a",
        campId: "camp-prod",
        bindleId: "shop",
        providerId: "aws",
        dimension: "runtime-compute-seconds",
        quantity: 42,
        unit: "seconds",
      }),
      parseCostSignalEvent({
        schemaVersion: COST_SIGNAL_EVENT_SCHEMA_VERSION,
        type: "spend.Recorded",
        seq: 13,
        time: "2026-06-01T00:01:00.000Z",
        tenantId: "tenant-a",
        campId: "camp-prod",
        bindleId: "shop",
        providerId: "aws",
        dimension: "runtime-compute-seconds",
        quantity: 42,
        unit: "seconds",
        amount: 0.000504,
        currency: "USD",
        spendVelocityPerHour: 0.03,
      }),
      parseCostSignalEvent({
        schemaVersion: COST_SIGNAL_EVENT_SCHEMA_VERSION,
        type: "credit.Registered",
        seq: 14,
        time: "2026-06-01T00:02:00.000Z",
        providerId: "aws",
        dimension: "runtime-compute-seconds",
        creditId: "aws-free-june",
        amount: 1000,
        currency: "USD",
        resetWindowStart: "2026-06-01T00:00:00.000Z",
        resetWindowEnd: "2026-07-01T00:00:00.000Z",
      }),
      parseCostSignalEvent({
        schemaVersion: COST_SIGNAL_EVENT_SCHEMA_VERSION,
        type: "spend.CircuitTripped",
        seq: 15,
        time: "2026-06-01T00:03:00.000Z",
        tenantId: "tenant-a",
        campId: "camp-prod",
        bindleId: "shop",
        threshold: 25,
        currency: "USD",
        spendVelocityPerHour: 30,
        reason: "runaway-spend",
      }),
      parseCostSignalEvent({
        schemaVersion: COST_SIGNAL_EVENT_SCHEMA_VERSION,
        type: "spend.CircuitReset",
        seq: 16,
        time: "2026-06-01T00:04:00.000Z",
        tenantId: "tenant-a",
        campId: "camp-prod",
        bindleId: "shop",
        circuitId: "spend-circuit-1",
        acknowledgedBy: "sre-oncall",
      }),
      parseCostSignalEvent({
        schemaVersion: COST_SIGNAL_EVENT_SCHEMA_VERSION,
        type: "spend.DegradationRequired",
        seq: 17,
        time: "2026-06-01T00:05:00.000Z",
        tenantId: "tenant-a",
        campId: "camp-prod",
        bindleId: "shop",
        fromTier: "nominal",
        toTier: "reduced",
        budgetFraction: 0.8,
        currency: "USD",
        spendVelocityPerHour: 30,
      }),
      parseCostSignalEvent({
        schemaVersion: COST_SIGNAL_EVENT_SCHEMA_VERSION,
        type: "spend.DegradationApplied",
        seq: 18,
        time: "2026-06-01T00:06:00.000Z",
        tenantId: "tenant-a",
        campId: "camp-prod",
        bindleId: "shop",
        tier: "reduced",
        step: "shed-batch",
        appliedBy: "sre-operator",
      }),
      parseCostSignalEvent({
        schemaVersion: COST_SIGNAL_EVENT_SCHEMA_VERSION,
        type: "spend.DegradationRolledBack",
        seq: 19,
        time: "2026-06-01T00:07:00.000Z",
        tenantId: "tenant-a",
        campId: "camp-prod",
        bindleId: "shop",
        fromTier: "reduced",
        toTier: "nominal",
        reason: "velocity-normal",
      }),
    ];

    assert.deepEqual(events.map((event) => event.type), [
      "meter.UsageRecorded",
      "spend.Recorded",
      "credit.Registered",
      "spend.CircuitTripped",
      "spend.CircuitReset",
      "spend.DegradationRequired",
      "spend.DegradationApplied",
      "spend.DegradationRolledBack",
    ]);
    assert.equal(JSON.parse(serializeCostSignalEvent(events[1])).amount, 0.000504);
    assert.equal(JSON.parse(serializeCostSignalEvent(events[3])).threshold, 25);
    assert.equal(JSON.parse(serializeCostSignalEvent(events[6])).step, "shed-batch");
  });

  it("serializes a CreditLedgerView snapshot with a replay-pinned seq and digest", () => {
    const snapshot = {
      schemaVersion: CREDIT_LEDGER_VIEW_SCHEMA_VERSION,
      view: "CreditLedgerView",
      seq: 22,
      asOf: "2026-06-01T00:03:00.000Z",
      accounts: [
        {
          providerId: "aws",
          dimension: "runtime-compute-seconds",
          currency: "USD",
          freeAllotment: 1000,
          consumed: 42,
          freeHeadroom: 958,
          spendToDate: 0.000504,
          budgetCap: 50,
          resetWindowStart: "2026-06-01T00:00:00.000Z",
          resetWindowEnd: "2026-07-01T00:00:00.000Z",
        },
      ],
    };

    const first = serializeCreditLedgerView(snapshot);
    const second = serializeCreditLedgerView({ ...snapshot, accounts: [...snapshot.accounts] });

    assert.equal(first.seq, 22);
    assert.match(first.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(first.digest, second.digest);
    assert.equal(JSON.parse(first.serialized).seq, 22);
  });

  it("rejects mixed currencies across provider cost catalogs", () => {
    assert.throws(
      () =>
        validateCostCatalogSet([
          validCostJson,
          { ...validCostJson, providerId: "azure", currency: "EUR" },
        ]),
      /mixed currencies/i,
    );
  });

  it("splits a metering period that crosses a free-tier reset boundary", () => {
    const spans = splitMeteringPeriodByResetWindow(
      {
        start: "2026-06-30T12:00:00.000Z",
        end: "2026-07-01T12:00:00.000Z",
      },
      {
        start: "2026-07-01T00:00:00.000Z",
        end: "2026-08-01T00:00:00.000Z",
      },
    );

    assert.deepEqual(spans, [
      {
        start: "2026-06-30T12:00:00.000Z",
        end: "2026-07-01T00:00:00.000Z",
        resetWindow: "previous",
      },
      {
        start: "2026-07-01T00:00:00.000Z",
        end: "2026-07-01T12:00:00.000Z",
        resetWindow: "current",
      },
    ]);
  });

  it("rejects negative and unapproved zero unit prices", () => {
    assert.throws(
      () =>
        parseCostJson({
          ...validCostJson,
          unitPrices: { ...validCostJson.unitPrices, "runtime-compute-seconds": 0 },
        }),
      /zero unit price/i,
    );

    assert.throws(
      () =>
        parseCostJson({
          ...validCostJson,
          unitPrices: { ...validCostJson.unitPrices, "storage-gb": -1 },
        }),
      /negative unit price/i,
    );
  });

  it("rejects a cost catalog missing a region present in a plan", () => {
    assert.throws(
      () =>
        validatePlanCostCoverage(validCostJson, {
          regions: ["us-east", "ap-south"],
        }),
      /missing region/i,
    );
  });

  it("rejects tiered prices with keys outside the declared tier set", () => {
    assert.throws(
      () =>
        parseCostJson({
          ...validCostJson,
          unitPrices: {
            ...validCostJson.unitPrices,
            "database.pg.flex.instance-hour": {
              small: 0.06,
              xlarge: 0.5,
            },
          },
        }),
      /unknown tier/i,
    );
  });

  it("rejects region-keyed prices with keys outside the declared regions", () => {
    assert.throws(
      () =>
        parseCostJson({
          ...validCostJson,
          unitPrices: {
            ...validCostJson.unitPrices,
            "storage-gb": {
              "us-east": 0.021,
              mars: 0.024,
            },
          },
        }),
      /unknown region/i,
    );
  });

  it("rejects nested region keys outside the declared regions inside tiered prices", () => {
    assert.throws(
      () =>
        parseCostJson({
          ...validCostJson,
          unitPrices: {
            ...validCostJson.unitPrices,
            "database.pg.flex.instance-hour": {
              small: {
                "us-east": 0.06,
                mars: 0.08,
              },
              medium: 0.12,
            },
          },
        }),
      /unknown region/i,
    );
  });

  it("rejects spend control events without velocity and threshold context", () => {
    assert.throws(
      () =>
        parseCostSignalEvent({
          schemaVersion: COST_SIGNAL_EVENT_SCHEMA_VERSION,
          type: "spend.CircuitTripped",
          seq: 17,
          time: "2026-06-01T00:05:00.000Z",
          tenantId: "tenant-a",
          campId: "camp-prod",
          bindleId: "shop",
          currency: "USD",
          reason: "runaway-spend",
        }),
      /threshold/i,
    );
  });
});
