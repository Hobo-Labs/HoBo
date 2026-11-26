import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  runReliabilityObservabilityCostSimulation,
} from "../services/reliability-reference-architecture.js";

describe("Reliability, Observability & Cost epic reference architecture", () => {
  it("runs one epic-scoped simulation across telemetry, SLO, saga, FinOps, and status slices", async () => {
    const result = await runReliabilityObservabilityCostSimulation();

    assert.equal(result.epic.id, "b36b40c8-059f-4d29-8aa1-0a80c852761a");
    assert.equal(result.epic.slug, "reliability-observability-cost-finops");
    assert.deepEqual(
      result.verticalSlices.map((slice) => slice.id),
      [
        "telemetry-slo-gate",
        "finops-budget-guard",
        "saga-compensation-recovery",
        "golden-chaos-status-rollup",
      ],
    );
    assert.ok(
      result.verticalSlices.every((slice) => slice.boundaries.every((boundary) => boundary.mocked === true)),
      "reference architecture must not require live providers",
    );
  });

  it("keeps SRE-facing observability fail-closed when telemetry or SLI inputs are stale", async () => {
    const result = await runReliabilityObservabilityCostSimulation();

    assert.equal(result.telemetry.sloStatus.status, "budget-exhausted");
    assert.equal(result.telemetry.rollbackGate.effect, "rollback");
    assert.equal(result.telemetry.traceRepair, "synthesized-root");
    assert.equal(result.negative.noSliData.status, "no-data");
    assert.equal(result.negative.malformedTraceparent.traceRepair, "regenerated-malformed-traceparent");
  });

  it("ties FinOps controls to metering, credits, quota policy, showback, and degradation", async () => {
    const result = await runReliabilityObservabilityCostSimulation();

    assert.equal(result.finops.metering.totalCostUsd, 2.12);
    assert.equal(result.finops.creditQuote.totalCost, 0.25);
    assert.equal(result.finops.quotaDecision.effect, "allow-degraded");
    assert.equal(result.finops.runawayBreaker.decision, "trip");
    assert.equal(result.finops.costGuard.outcome, "degrade-observability");
    assert.equal(result.negative.quotaMissingContext.effect, "deny");
  });

  it("compensates partial saga failures and exposes deterministic replay evidence", async () => {
    const result = await runReliabilityObservabilityCostSimulation();

    assert.equal(result.recovery.failureClass, "partial-failure");
    assert.equal(result.recovery.saga.status, "rolled-back");
    assert.deepEqual(result.recovery.compensation.order, ["db", "network"]);
    assert.equal(result.recovery.runInspector.status, "completed");
    assert.equal(result.negative.staleSagaLease, "stale saga lease");
  });

  it("publishes contract decisions for every mocked service boundary", async () => {
    const result = await runReliabilityObservabilityCostSimulation();

    assert.deepEqual(result.contracts.missing, []);
    assert.deepEqual(result.contracts.covered, [
      "TelemetryBoundaryExport",
      "TraceContextQueue",
      "SloPolicyGate",
      "MeteringCreditLedger",
      "BudgetQuotaPolicyGate",
      "SagaCompensationBoundary",
      "GoldenChaosBoundary",
      "ReliabilityStatusRollup",
    ]);
  });
});
