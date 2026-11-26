import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateFinOpsDeployGate } from "./budget-gate.js";
import { estimatePlanCost, withinCostTolerance } from "./plan-cost-estimator.js";
import { projectShowbackFromEvents, reconcileShowbackProjection } from "./showback-projection.js";

export { estimatePlanCost, withinCostTolerance } from "./plan-cost-estimator.js";
export { evaluateFinOpsDeployGate } from "./budget-gate.js";
export { projectShowbackFromEvents, reconcileShowbackProjection } from "./showback-projection.js";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../test/fixtures");

export function loadFinOpsPlaneScenario(id = "nfr-012-plan-vs-actual") {
  const scenarios = JSON.parse(readFileSync(join(FIXTURE_DIR, "finops-plane-scenarios.json"), "utf8"));
  if (scenarios.id !== id) {
    throw new RangeError(`fixture id mismatch: expected ${id}, found ${scenarios.id}`);
  }
  return scenarios;
}

export function runFinOpsPlaneScenario(scenario = loadFinOpsPlaneScenario()) {
  const planEstimate = estimatePlanCost({
    costJson: scenario.costJson,
    plan: scenario.plan,
  });

  const showbackProjection = projectShowbackFromEvents({
    events: scenario.meteringEvents,
    seq: scenario.meteringEvents.length,
    costCatalog: toCostCatalog(scenario.costJson),
    displayNames: scenario.displayNames,
  });

  const actualUsd = roundUsd(showbackProjection.meteringView.totalCost);
  const estimateWithinTolerance = withinCostTolerance(
    planEstimate.projectedMonthlyUsd,
    actualUsd,
    scenario.toleranceFraction,
  );

  const allowGate = evaluateFinOpsDeployGate({
    costEstimateUsd: planEstimate.projectedMonthlyUsd,
    meteringView: showbackProjection.meteringView,
    policies: [scenario.budgetPolicy],
    owner: scenario.meteringEvents[0].owner,
  });

  const breachGate = evaluateFinOpsDeployGate({
    costEstimateUsd: planEstimate.projectedMonthlyUsd,
    meteringView: showbackProjection.meteringView,
    policies: [scenario.breachBudgetPolicy],
    owner: {
      ...scenario.meteringEvents[0].owner,
      campId: "camp-staging",
    },
  });

  const showbackReconciliation = reconcileShowbackProjection({
    events: scenario.meteringEvents,
    seq: scenario.meteringEvents.length,
    costCatalog: toCostCatalog(scenario.costJson),
    displayNames: scenario.displayNames,
  });

  return {
    scenarioId: scenario.id,
    planEstimate,
    actualUsd,
    estimateWithinTolerance,
    allowGate,
    breachGate,
    showbackReconciliation,
    acceptance: {
      planEstimateWithinTolerance: estimateWithinTolerance,
      budgetBreachBlocksDeploy: breachGate.blocksDeploy === true,
      showbackReconciled: showbackReconciliation.reconciled === true,
      deployAllowedUnderBudget: allowGate.blocksDeploy === false,
    },
  };
}

function toCostCatalog(costJson) {
  return {
    currency: costJson.currency,
    unitPrices: costJson.unitPrices,
  };
}

function roundUsd(value) {
  return Math.round(Number(value) * 100) / 100;
}
