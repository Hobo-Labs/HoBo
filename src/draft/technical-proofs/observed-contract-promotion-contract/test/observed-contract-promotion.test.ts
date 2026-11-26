import assert from "node:assert/strict";
import { test } from "vitest";

import { parseContract } from "../../hobo-contract-ir/src/contract-ir.js";
import {
  OBSERVED_CONTRACT_PROMOTION_SCHEMA,
  evaluatePromotedContractGate,
  mineObservedContract,
  promoteObservedContract,
} from "../src/observed-contract-promotion.js";

const orderEdge = {
  kind: "event",
  producer: "orders-api@1.8.0",
  consumer: "worker@1.4.2",
  operation: "order.created",
};

test("mines an observed contract with sample coverage and excludes lane-origin traces", () => {
  const baselineCorpus = [
    trace("tr-1", { orderId: "ord_1", tenantId: "tenant_a" }),
    trace("tr-2", { orderId: "ord_2", tenantId: "tenant_a" }),
    trace("tr-3", { orderId: "ord_3", tenantId: "tenant_b" }),
  ];
  const withLaneBurst = [
    ...baselineCorpus,
    trace("lane-1", { orderId: "ord_lane", tenantId: "tenant_a", couponCode: "FORK" }, { lane: "fork-pr-42" }),
    trace("lane-2", { orderId: "ord_lane_2", couponCode: "EXPERIMENT" }, { lane: "fork-pr-42" }),
  ];

  const mined = mineObservedContract({
    contractId: "contract-observed-order-created",
    version: "1.0.0",
    edge: orderEdge,
    corpus: withLaneBurst,
    traceWindow: "P14D",
  });
  const laneFree = mineObservedContract({
    contractId: "contract-observed-order-created",
    version: "1.0.0",
    edge: orderEdge,
    corpus: baselineCorpus,
    traceWindow: "P14D",
  });

  assert.equal(mined.ok, true, mined.errors.join("\n"));
  assert.deepEqual(mined.contract, laneFree.contract);
  assert.equal(mined.contract.mode, "observed");
  assert.equal(mined.contract.provenance.source, "trace-mined");
  assert.equal(mined.contract.provenance.verifiedByConstruction, false);
  assert.deepEqual(mined.contract.requiredRecord.requiredFields, ["orderId", "tenantId"]);
  assert.deepEqual(mined.contract.provenance.sampleCoverage, {
    samples: 3,
    coveragePct: 100,
    traceWindow: "P14D",
  });
  assert.equal(mined.contract.provenance.fieldCoverage.tenantId.coveragePct, 100);
  assert.equal(parseContract(mined.contract).ok, true);
});

test("promotion produces a versioned gate carrying coverage and a migration window", () => {
  const observed = mineObservedContract({
    contractId: "contract-observed-order-created",
    version: "1.0.0",
    edge: orderEdge,
    corpus: [
      trace("tr-1", { orderId: "ord_1", tenantId: "tenant_a" }),
      trace("tr-2", { orderId: "ord_2", tenantId: "tenant_a" }),
      trace("tr-3", { orderId: "ord_3", tenantId: "tenant_b" }),
    ],
  }).contract;

  const promoted = promoteObservedContract(observed, {
    gateId: "gate-order-created-v2",
    promotedVersion: "2.0.0",
    migrationWindowDays: 14,
    minSamples: 3,
    minCoveragePct: 95,
    startedAt: "2026-06-26T00:00:00.000Z",
  });

  assert.equal(promoted.contract.mode, "promoted");
  assert.equal(promoted.contract.version, "2.0.0");
  assert.equal(promoted.contract.provenance.source, "promotion-gate");
  assert.equal(promoted.contract.provenance.verifiedByConstruction, false);
  assert.deepEqual(promoted.contract.provenance.sampleCoverage, observed.provenance.sampleCoverage);
  assert.deepEqual(promoted.contract.provenance.migrationWindow, {
    days: 14,
    startedAt: "2026-06-26T00:00:00.000Z",
  });
  assert.equal(promoted.gate.schema, OBSERVED_CONTRACT_PROMOTION_SCHEMA);
  assert.equal(promoted.gate.confidence, "enforceable");
  assert.equal(promoted.gate.effect, "enforce");
  assert.deepEqual(promoted.gate.coverage, observed.provenance.sampleCoverage);
  assert.equal(promoted.events[0].type, "contract.Promoted");
  assert.equal(parseContract(promoted.contract).ok, true);
});

test("unobserved producer variants during the migration window emit compat failure", () => {
  const promoted = promoteObservedContract(
    mineObservedContract({
      contractId: "contract-observed-order-created",
      version: "1.0.0",
      edge: orderEdge,
      corpus: [
        trace("tr-1", { orderId: "ord_1", tenantId: "tenant_a" }),
        trace("tr-2", { orderId: "ord_2", tenantId: "tenant_a" }),
        trace("tr-3", { orderId: "ord_3", tenantId: "tenant_b" }),
      ],
    }).contract,
    {
      gateId: "gate-order-created-v2",
      promotedVersion: "2.0.0",
      migrationWindowDays: 14,
      startedAt: "2026-06-26T00:00:00.000Z",
    },
  );

  const validButUnobserved = evaluatePromotedContractGate(promoted.gate, {
    producer: "orders-api@1.9.0",
    fields: ["orderId", "tenantId", "couponCode"],
    observedAt: "2026-06-27T00:00:00.000Z",
  });
  const observedGate = evaluatePromotedContractGate(promoted.gate, {
    producer: "orders-api@1.9.0",
    fields: ["tenantId", "orderId"],
    observedAt: "2026-06-27T00:00:00.000Z",
  });

  assert.equal(validButUnobserved.ok, false);
  assert.equal(validButUnobserved.events[0].type, "compat.GateFailed");
  assert.equal(validButUnobserved.failures[0].reason, "unobserved-variant-during-migration");
  assert.deepEqual(validButUnobserved.failures[0].unexpectedFields, ["couponCode"]);
  assert.match(validButUnobserved.summary, /unobserved producer variant/);
  assert.ok(validButUnobserved.suggestedFixes.includes("dual-publish through the migration window"));

  assert.equal(observedGate.ok, true);
  assert.equal(observedGate.events[0].type, "compat.GatePassed");
});

test("thin sample promotion carries weak confidence instead of over-claiming proven status", () => {
  const observed = mineObservedContract({
    contractId: "contract-observed-thin",
    version: "1.0.0",
    edge: orderEdge,
    corpus: [trace("tr-1", { orderId: "ord_1", tenantId: "tenant_a" })],
  }).contract;

  const promoted = promoteObservedContract(observed, {
    gateId: "gate-thin",
    promotedVersion: "1.1.0",
    minSamples: 50,
    minCoveragePct: 99,
    migrationWindowDays: 7,
  });

  assert.equal(promoted.contract.provenance.verifiedByConstruction, false);
  assert.equal(promoted.gate.confidence, "low-confidence");
  assert.equal(promoted.gate.effect, "require-review");
  assert.deepEqual(promoted.gate.warnings, [
    "sample count 1 below promotion floor 50",
  ]);
  assert.equal(parseContract(promoted.contract).ok, true);
});

test("poisoned trace samples fail closed instead of shifting the observed shape", () => {
  const poisoned = mineObservedContract({
    contractId: "contract-poisoned-order-created",
    version: "1.0.0",
    edge: orderEdge,
    corpus: [
      trace("tr-1", { orderId: "ord_1", tenantId: "tenant_a" }),
      trace("tr-poison", null),
      trace("tr-2", { orderId: "ord_2", tenantId: "tenant_a" }),
    ],
  });

  assert.equal(poisoned.ok, false);
  assert.equal(poisoned.contract, null);
  assert.match(poisoned.errors.join("\n"), /poisoned trace tr-poison/);
});

function trace(traceId, payload, overrides = {}) {
  return {
    type: "contract.TraceObserved",
    traceId,
    edge: orderEdge,
    payload,
    time: "2026-06-26T00:00:00.000Z",
    ...overrides,
  };
}
