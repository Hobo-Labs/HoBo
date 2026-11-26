import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  analyzeCompensationInterleaving,
  buildCompensationPlan,
  measureAccuracyBound,
  reconcileBillingPeriod,
} from "../src/spike.js";

const deploymentDag = [
  { id: "network", dependsOn: [] },
  { id: "database", dependsOn: ["network"] },
  { id: "api", dependsOn: ["database"] },
  { id: "metrics", dependsOn: ["network"], optional: true },
];

describe("HOBO-339 saga compensation spike", () => {
  it("compensates provisioned required resources in reverse topological order", () => {
    const plan = buildCompensationPlan({
      resources: deploymentDag,
      provisioned: ["network", "database", "api"],
      failure: { resourceId: "api", crossesNoGoThreshold: true },
    });

    assert.equal(plan.terminal, "rollback-required");
    assert.deepEqual(
      plan.actions.map((action) => action.resourceId),
      ["api", "database", "network"],
    );
    assert.deepEqual(plan.constraints, [
      "destroy-only-provisioned-resources",
      "reverse-topological-order",
      "idempotent-destroy-required",
    ]);
  });

  it("keeps optional failures out of rollback when required resources are still healthy", () => {
    const plan = buildCompensationPlan({
      resources: deploymentDag,
      provisioned: ["network", "database"],
      failure: { resourceId: "metrics", crossesNoGoThreshold: false },
    });

    assert.equal(plan.terminal, "partial-success");
    assert.deepEqual(plan.actions, []);
  });

  it("surfaces an ambiguous provider create as no consistent terminal state without an orphan oracle", () => {
    const finding = analyzeCompensationInterleaving({
      events: [
        { type: "provider.created", resourceId: "database", providerObjectId: "db-123", tagged: false },
        { type: "worker.crashed", phase: "record-state", resourceId: "database" },
        { type: "rollback.started", resourceId: "database" },
      ],
    });

    assert.equal(finding.terminal, "blocked");
    assert.equal(finding.failingExample, "provider-created-before-state-recorded");
    assert.deepEqual(finding.requiredConstraints, [
      "provider-object-tags-required",
      "orphan-sweep-before-terminal-rollback-success",
      "rollback-must-escalate-needs-human-when-orphan-identity-is-unknown",
    ]);
  });

  it("escalates failed compensation instead of reporting rollback success", () => {
    const finding = analyzeCompensationInterleaving({
      events: [
        { type: "state.recorded", resourceId: "database" },
        { type: "compensation.failed", resourceId: "database", providerError: "permission-denied" },
      ],
    });

    assert.equal(finding.terminal, "needs-human");
    assert.equal(finding.failingExample, "compensation-destroy-failed");
    assert.deepEqual(finding.requiredConstraints, [
      "failed-compensation-must-not-report-rollback-success",
    ]);
  });
});

describe("HOBO-339 CreditLedger reconciliation spike", () => {
  it("measures estimate-vs-actual accuracy and emits deterministic delta events", () => {
    const samples = [
      { provider: "aws", meter: "runtime-compute-seconds", estimated: 100, actual: 112 },
      { provider: "aws", meter: "storage-gb", estimated: 40, actual: 38 },
      { provider: "azure", meter: "egress-gb", estimated: 80, actual: 100 },
    ];

    const accuracy = measureAccuracyBound(samples);
    assert.equal(accuracy.sampleCount, 3);
    assert.equal(accuracy.maxAbsolutePercentError, 25);
    assert.equal(accuracy.meanAbsolutePercentError, 14);

    const reconciliation = reconcileBillingPeriod({
      provider: "aws",
      period: "2026-06",
      ledgerSeq: 481,
      tolerancePercent: 10,
      lines: [
        { meter: "runtime-compute-seconds", estimated: 100, actual: 112 },
        { meter: "storage-gb", estimated: 40, actual: 38 },
      ],
    });

    assert.equal(reconciliation.totalEstimated, 140);
    assert.equal(reconciliation.totalActual, 150);
    assert.equal(reconciliation.percentError, 7.14);
    assert.equal(reconciliation.category, "within-bound");
    assert.deepEqual(
      reconciliation.deltaEvents.map((event) => [event.idempotencyKey, event.deltaAmount]),
      [
        ["spend-delta:aws:2026-06:runtime-compute-seconds", 12],
        ["spend-delta:aws:2026-06:storage-gb", -2],
      ],
    );
  });

  it("classifies larger divergence so policy can require investigation before trusting routing cost", () => {
    const reconciliation = reconcileBillingPeriod({
      provider: "azure",
      period: "2026-06",
      ledgerSeq: 482,
      tolerancePercent: 10,
      lines: [{ meter: "egress-gb", estimated: 80, actual: 100 }],
    });

    assert.equal(reconciliation.percentError, 25);
    assert.equal(reconciliation.category, "pricing-or-usage-drift");
    assert.deepEqual(reconciliation.risks, [
      "actual-cost-outside-estimate-bound",
      "dispatcher-should-lower-confidence-for-this-provider-meter",
    ]);
  });

  it("marks providers without actual billing APIs as estimate-only instead of inventing accuracy", () => {
    const reconciliation = reconcileBillingPeriod({
      provider: "local-dev",
      period: "2026-06",
      ledgerSeq: 483,
      tolerancePercent: 10,
      lines: [{ meter: "runtime-compute-seconds", estimated: 12, actual: null }],
    });

    assert.equal(reconciliation.mode, "estimate-only");
    assert.equal(reconciliation.category, "actual-unavailable");
    assert.deepEqual(reconciliation.deltaEvents, []);
    assert.deepEqual(reconciliation.risks, [
      "provider-billing-api-unavailable",
      "dispatcher-must-treat-cost-as-uncertain",
    ]);
  });

  it("does not double-count deterministic deltas on replay", () => {
    const priorDeltas = new Set(["spend-delta:aws:2026-06:runtime-compute-seconds"]);
    const reconciliation = reconcileBillingPeriod({
      provider: "aws",
      period: "2026-06",
      ledgerSeq: 484,
      tolerancePercent: 10,
      priorDeltas,
      lines: [
        { meter: "runtime-compute-seconds", estimated: 100, actual: 112 },
        { meter: "storage-gb", estimated: 40, actual: 38 },
      ],
    });

    assert.deepEqual(
      reconciliation.deltaEvents.map((event) => event.idempotencyKey),
      ["spend-delta:aws:2026-06:storage-gb"],
    );
    assert.deepEqual(reconciliation.skippedDeltas, [
      "spend-delta:aws:2026-06:runtime-compute-seconds",
    ]);
  });
});
