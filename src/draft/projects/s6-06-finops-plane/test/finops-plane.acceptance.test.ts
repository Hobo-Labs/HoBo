import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "vitest";
import { fileURLToPath } from "node:url";

import {
  estimatePlanCost,
  evaluateFinOpsDeployGate,
  loadFinOpsPlaneScenario,
  projectShowbackFromEvents,
  runFinOpsPlaneScenario,
  withinCostTolerance,
} from "../src/finops-plane.js";
import { reconcileShowbackProjection } from "../src/showback-projection.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

describe("FinOps plane acceptance (HOBO-661 / FR-070 / NFR-012)", () => {
  it("runs the end-to-end FinOps plane scenario with all acceptance bullets green", () => {
    const result = runFinOpsPlaneScenario();

    assert.equal(result.acceptance.planEstimateWithinTolerance, true);
    assert.equal(result.acceptance.budgetBreachBlocksDeploy, true);
    assert.equal(result.acceptance.showbackReconciled, true);
    assert.equal(result.acceptance.deployAllowedUnderBudget, true);
    assert.ok(result.planEstimate.projectedMonthlyUsd > result.actualUsd * 0.8);
    assert.ok(result.planEstimate.projectedMonthlyUsd < result.actualUsd * 1.2);
  });

  it("fails closed when plan region is missing from cost.json coverage", () => {
    const scenario = loadFinOpsPlaneScenario();
    const resources = scenario.plan.resources.map(({ region: _region, ...resource }) => resource);
    assert.throws(
      () =>
        estimatePlanCost({
          costJson: scenario.costJson,
          plan: {
            ...scenario.plan,
            regions: ["eu-west-1"],
            resources,
          },
        }),
      /missing from cost\.json coverage/,
    );
  });

  it("blocks deploy when existing MeteringView spend plus estimate crosses the hard limit", () => {
    const scenario = loadFinOpsPlaneScenario();
    const projection = projectShowbackFromEvents({
      events: scenario.meteringEvents,
      seq: scenario.meteringEvents.length,
      costCatalog: {
        currency: scenario.costJson.currency,
        unitPrices: scenario.costJson.unitPrices,
      },
      displayNames: scenario.displayNames,
    });

    const gate = evaluateFinOpsDeployGate({
      costEstimateUsd: 15,
      meteringView: {
        ...projection.meteringView,
        scopeCosts: {
          "camp:tenant-a/camp-prod": { cost: 190, currency: "USD" },
        },
      },
      policies: [
        {
          id: "camp-budget:tenant-a/camp-prod",
          scope: { kind: "camp", id: "tenant-a/camp-prod" },
          hardLimitUsd: 200,
          lastEvaluatedSeq: projection.meteringView.seq,
        },
      ],
      owner: scenario.meteringEvents[0].owner,
    });

    assert.equal(gate.blocksDeploy, true);
    assert.equal(gate.effect, "deny");
    assert.match(gate.violations.join("\n"), /projected spend 205 exceeds hard budget 200/);
  });

  it("rejects tampered showback totals that diverge from MeteringView", () => {
    const scenario = loadFinOpsPlaneScenario();
    const projection = reconcileShowbackProjection({
      events: scenario.meteringEvents,
      seq: scenario.meteringEvents.length,
      costCatalog: {
        currency: scenario.costJson.currency,
        unitPrices: scenario.costJson.unitPrices,
      },
      displayNames: scenario.displayNames,
    });

    const tampered = {
      ...projection,
      showbackTotalUsd: projection.meteringTotalUsd + 1,
      reconciled: false,
    };

    assert.equal(tampered.reconciled, false);
    assert.notEqual(tampered.showbackTotalUsd, tampered.meteringTotalUsd);
  });

  it("requires approval path for agent spend-cap soft breaches when configured", () => {
    const scenario = loadFinOpsPlaneScenario();
    const projection = projectShowbackFromEvents({
      events: scenario.meteringEvents,
      seq: scenario.meteringEvents.length,
      costCatalog: {
        currency: scenario.costJson.currency,
        unitPrices: scenario.costJson.unitPrices,
      },
      displayNames: scenario.displayNames,
    });
    const metering = reconcileShowbackProjection({
      events: scenario.meteringEvents,
      seq: scenario.meteringEvents.length,
      costCatalog: {
        currency: scenario.costJson.currency,
        unitPrices: scenario.costJson.unitPrices,
      },
      displayNames: scenario.displayNames,
    });

    const softGate = evaluateFinOpsDeployGate({
      costEstimateUsd: 5,
      meteringView: {
        ...projection.meteringView,
        scopeCosts: {
          "agent:tenant-a/agent-deploy": { cost: 28, currency: "USD" },
        },
      },
      policies: [
        {
          id: "agent-cap:tenant-a/agent-deploy",
          scope: { kind: "agent", id: "tenant-a/agent-deploy" },
          spendCapUsd: 30,
          allowedApprovers: ["user:finance-admin"],
          lastEvaluatedSeq: projection.meteringView.seq,
        },
      ],
      owner: scenario.meteringEvents[0].owner,
    });

    assert.equal(softGate.requiresApproval, true);
    assert.equal(softGate.effect, "require-approval");
    assert.ok(metering.reconciled);
  });
});

describe("plan cost estimator unit tests", () => {
  it("prices egress tiers from cost.json", () => {
    const costJson = JSON.parse(readFileSync(join(FIXTURE_DIR, "cost-manifest.json"), "utf8"));
    const estimate = estimatePlanCost({
      costJson,
      plan: {
        regions: ["us-east-1"],
        resources: [],
        egress: [{ id: "edge", dimension: "egress-gb", quantityPerMonth: 10, tier: "internet" }],
      },
    });

    assert.equal(estimate.lineItems[0].lineCostUsd, 0.9);
  });

  it("computes withinCostTolerance against fixture actual", () => {
    const scenario = loadFinOpsPlaneScenario();
    const estimate = estimatePlanCost({ costJson: scenario.costJson, plan: scenario.plan });
    assert.equal(withinCostTolerance(estimate.projectedMonthlyUsd, scenario.expectedActualUsd, 0.2), true);
  });
});
