/**
 * Executable step definitions for finops-plane.feature.
 *
 * Drives the real s6-06 modules (plan-cost estimator, budget deploy gate,
 * showback projection) against the committed fixture scenario — no live
 * providers; every boundary is the same Pact/protobuf/CUE-backed fixture the
 * acceptance test uses.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import {
  estimatePlanCost,
  evaluateFinOpsDeployGate,
  loadFinOpsPlaneScenario,
  projectShowbackFromEvents,
  reconcileShowbackProjection,
  withinCostTolerance,
} from "../../src/index.js";

type Scenario = ReturnType<typeof loadFinOpsPlaneScenario>;

type FinOpsWorld = {
  scenario?: Scenario;
  planEstimate?: ReturnType<typeof estimatePlanCost>;
  actualUsd?: number;
  gate?: ReturnType<typeof evaluateFinOpsDeployGate>;
  reconciliation?: ReturnType<typeof reconcileShowbackProjection>;
  meteringTotal?: number;
};

const world: FinOpsWorld = {};

function scenario(): Scenario {
  world.scenario ??= loadFinOpsPlaneScenario();
  return world.scenario;
}

function costCatalog(fixture: Scenario) {
  return {
    currency: fixture.costJson.currency,
    unitPrices: fixture.costJson.unitPrices,
  };
}

// --- Scenario: hobo plan returns projected cost from provider cost.json -----

Given(
  "a capability manifest cost.json and a deployment plan usage profile",
  () => {
    const fixture = scenario();
    assert.ok(fixture.costJson.unitPrices, "fixture must carry unit prices");
    assert.ok(fixture.plan.resources.length > 0, "plan must carry resources");
  },
);

When("the FinOps plane estimates plan cost", () => {
  const fixture = scenario();
  world.planEstimate = estimatePlanCost({
    costJson: fixture.costJson,
    plan: fixture.plan,
  });
  const projection = projectShowbackFromEvents({
    events: fixture.meteringEvents,
    seq: fixture.meteringEvents.length,
    costCatalog: costCatalog(fixture),
    displayNames: fixture.displayNames,
  });
  world.actualUsd =
    Math.round(Number(projection.meteringView.totalCost) * 100) / 100;
});

Then(
  "the estimate lands within the tolerance of the recorded actual spend fixture",
  () => {
    const fixture = scenario();
    assert.ok(world.planEstimate, "estimate step must run first");
    assert.ok(world.actualUsd !== undefined, "actuals step must run first");
    assert.equal(
      withinCostTolerance(
        world.planEstimate.projectedMonthlyUsd,
        world.actualUsd,
        fixture.toleranceFraction,
      ),
      true,
    );
  },
);

// --- Scenario: Hard budget breach blocks deploy ------------------------------

Given("a camp hard budget below the projected plan cost", () => {
  const fixture = scenario();
  world.planEstimate = estimatePlanCost({
    costJson: fixture.costJson,
    plan: fixture.plan,
  });
  assert.ok(
    fixture.breachBudgetPolicy,
    "fixture must carry the breach budget policy",
  );
});

When("the deploy gate evaluates the plan estimate against policy", () => {
  const fixture = scenario();
  const projection = projectShowbackFromEvents({
    events: fixture.meteringEvents,
    seq: fixture.meteringEvents.length,
    costCatalog: costCatalog(fixture),
    displayNames: fixture.displayNames,
  });
  world.gate = evaluateFinOpsDeployGate({
    costEstimateUsd: world.planEstimate?.projectedMonthlyUsd,
    meteringView: projection.meteringView,
    policies: [fixture.breachBudgetPolicy],
    owner: {
      ...fixture.meteringEvents[0].owner,
      campId: "camp-staging",
    },
  });
});

Then("the gate denies the deployment", () => {
  assert.ok(world.gate, "gate step must run first");
  assert.equal(world.gate.effect, "deny");
  assert.equal(world.gate.blocksDeploy, true);
});

// --- Scenario: Showback reconciles against recorded spend --------------------

Given("meter.UsageRecorded events in the event log", () => {
  const fixture = scenario();
  assert.ok(
    fixture.meteringEvents.length > 0,
    "fixture must carry metering events",
  );
});

When("showback aggregates tenant, camp, and bindle actuals", () => {
  const fixture = scenario();
  world.reconciliation = reconcileShowbackProjection({
    events: fixture.meteringEvents,
    seq: fixture.meteringEvents.length,
    costCatalog: costCatalog(fixture),
    displayNames: fixture.displayNames,
  });
  const projection = projectShowbackFromEvents({
    events: fixture.meteringEvents,
    seq: fixture.meteringEvents.length,
    costCatalog: costCatalog(fixture),
    displayNames: fixture.displayNames,
  });
  world.meteringTotal = Number(projection.meteringView.totalCost);
});

Then("the showback total matches the MeteringView total cost", () => {
  assert.ok(world.reconciliation, "showback step must run first");
  assert.equal(world.reconciliation.reconciled, true);
  assert.ok(world.meteringTotal !== undefined);
});
