import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  parseMetricContracts,
  parseResourceIntent,
  runFinopsRoutingControlPlaneSimulation,
} from "../services/finops-routing-control-plane.js";

describe("FinOps budget routing control-plane epic proof", () => {
  it("runs an offline epic-scoped simulation across standards, metrics, routing, stability, and surfaces", async () => {
    const result = await runFinopsRoutingControlPlaneSimulation();

    assert.equal(result.epic.slug, "finops-budget-routing-control-plane");
    assert.deepEqual(
      result.verticalSlices.map((slice) => slice.id),
      [
        "standards-first-intent-routing",
        "governed-metric-routing",
        "constraint-first-selection",
        "stability-controlled-feedback",
      ],
    );
    assert.ok(result.standards.some((standard) => standard.name === "FOCUS" && standard.version === "1.4"));
    assert.ok(
      result.verticalSlices.every((slice) => slice.boundaries.every((boundary) => boundary.mocked === true)),
      "epic proof must not require live providers",
    );
  });

  it("rejects provider, sku, concrete region, account, and backend leakage at parse time", () => {
    const result = parseResourceIntent({
      schemaVersion: "hobo.finops.resource-intent/v1",
      owner: { tenant: "tenant-a", workspace: "payments", environment: "production" },
      capability: { category: "compute" },
      budget: { amount: 5000, currency: "USD" },
      routing: { provider: "aws", region: "us-east-1", backendApi: "terraform apply" },
    });

    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /provider/);
    assert.match(result.errors.join("\n"), /region/);
    assert.match(result.errors.join("\n"), /backendApi/);
  });

  it("rejects raw telemetry user metrics, missing units, unapproved transforms, and unversioned changes", async () => {
    const result = await runFinopsRoutingControlPlaneSimulation();

    assert.equal(result.invalidMetricContracts.ok, false);
    assert.match(result.invalidMetricContracts.errors.join("\n"), /unit is required/);
    assert.match(result.invalidMetricContracts.errors.join("\n"), /unapproved transform arbitrary-js/);
    assert.match(result.invalidMetricContracts.errors.join("\n"), /raw telemetry/);
    assert.match(result.invalidMetricContracts.errors.join("\n"), /semantic and explicit/);

    assert.equal(
      parseMetricContracts([
        {
          name: "business.quality",
          tier: "user",
          version: "v1.0.0",
          compositionSources: ["experienced.reliability"],
          requiresApproval: true,
        },
      ]).ok,
      false,
    );
  });

  it("filters invalid candidates before metric vectors or Pareto selection exist", async () => {
    const result = await runFinopsRoutingControlPlaneSimulation();
    const rejectedIds = new Set(result.approvedRoute.constraints.rejected.map((candidate) => candidate.candidateId));
    const metricIds = new Set(result.approvedRoute.metricVectors.map((vector) => vector.candidateId));

    assert.ok(rejectedIds.has("candidate-ineligible"));
    assert.equal(metricIds.has("candidate-ineligible"), false);
    assert.equal(result.approvedRoute.decisionGraph.rationale[0], "constraint-filter-before-metrics");
  });

  it("builds a Pareto frontier before applying preference weights", async () => {
    const result = await runFinopsRoutingControlPlaneSimulation();

    assert.deepEqual(result.approvedRoute.pareto.dominatedCandidateIds, ["candidate-wasteful"]);
    assert.ok(result.approvedRoute.pareto.candidateIds.includes("candidate-economy"));
    assert.ok(result.approvedRoute.pareto.candidateIds.includes("candidate-balanced"));
    assert.equal(result.approvedRoute.preference.appliedOnlyWithinPareto, true);
    assert.equal(result.approvedRoute.preference.selectedCandidateId, "candidate-balanced");
    assert.equal(result.approvedRoute.routingDecision.selectedCandidateId, "candidate-balanced");
  });

  it("routes approval and deny outcomes without bypassing the decision graph", async () => {
    const result = await runFinopsRoutingControlPlaneSimulation();

    assert.equal(result.approvalRequired.routingDecision.effect, "requireApproval");
    assert.equal(result.approvalRequired.routingDecision.decisionGraphId, result.approvalRequired.decisionGraph.id);
    assert.equal(result.budgetDeny.routingDecision.effect, "deny");
    assert.equal(result.budgetDeny.actionPlan.actions[0].type, "freeze");
  });

  it("blocks a preferred reroute during cooldown when improvement is below threshold", async () => {
    const result = await runFinopsRoutingControlPlaneSimulation();

    assert.equal(result.stabilityCooldown.preference.selectedCandidateId, "candidate-balanced");
    assert.equal(result.stabilityCooldown.stability.overridden, true);
    assert.equal(result.stabilityCooldown.routingDecision.selectedCandidateId, "candidate-economy");
    assert.equal(result.stabilityCooldown.decisionGraph.stabilityOverride, true);
  });

  it("emits a complete decision graph for accepted, denied, approval, and stability decisions", async () => {
    const result = await runFinopsRoutingControlPlaneSimulation();

    for (const route of [
      result.approvedRoute,
      result.approvalRequired,
      result.budgetDeny,
      result.stabilityCooldown,
    ]) {
      assert.ok(route.decisionGraph.generatedCandidateIds.length > 0);
      assert.ok(route.decisionGraph.constraintResults.length > 0);
      assert.ok(Array.isArray(route.decisionGraph.metricVectors));
      assert.ok(Array.isArray(route.decisionGraph.paretoSet));
      assert.ok(route.decisionGraph.rationale.includes("pareto-frontier-before-preference"));
      assert.ok(route.decisionGraph.auditRefs.includes("cloud-event:routing.Decided"));
    }
  });

  it("turns actuals and overrides into proposals instead of mutating metrics or policy", async () => {
    const result = await runFinopsRoutingControlPlaneSimulation();

    assert.equal(result.feedbackGovernance.metricsMutatedDirectly, false);
    assert.equal(result.feedbackGovernance.policyMutatedDirectly, false);
    assert.deepEqual(
      result.feedbackGovernance.proposals.map((proposal) => proposal.effect),
      ["propose-metric-change", "propose-policy-review"],
    );
    assert.equal(result.feedbackGovernance.metricVersionChange.approvalState, "requires-approval");
  });

  it("renders DX, OpsX, and FinX surfaces from the same decision graph id", async () => {
    const result = await runFinopsRoutingControlPlaneSimulation();
    const ids = [
      result.experienceSurfaces.dx.decisionGraphId,
      result.experienceSurfaces.opsx.decisionGraphId,
      result.experienceSurfaces.finx.decisionGraphId,
    ];

    assert.deepEqual([...new Set(ids)], [result.approvedRoute.decisionGraph.id]);
  });

  it("keeps ActionPlan backend-neutral and adapter fixtures below the execution boundary", async () => {
    const result = await runFinopsRoutingControlPlaneSimulation();
    const actionPlanText = JSON.stringify(result.approvedRoute.actionPlan);

    assert.equal(result.approvedRoute.actionPlan.backendNeutral, true);
    assert.doesNotMatch(actionPlanText, /aws|azure|gcp|terraform|pulumi|crossplane|kubernetes|us-east|sku|account/iu);
    assert.ok(result.adapterFixtures.every((adapter) => adapter.boundary === "ExecutionAdapterPort"));
    assert.ok(result.adapterFixtures.every((adapter) => adapter.routingLogic === false));
  });

  it("replays deterministically at pinned fixture sequence", async () => {
    const first = await runFinopsRoutingControlPlaneSimulation();
    const second = await runFinopsRoutingControlPlaneSimulation();

    assert.deepEqual(second.approvedRoute.routingDecision, first.approvedRoute.routingDecision);
    assert.deepEqual(second.approvedRoute.decisionGraph, first.approvedRoute.decisionGraph);
    assert.deepEqual(second.approvedRoute.actionPlan, first.approvedRoute.actionPlan);
  });
});
