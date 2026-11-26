/**
 * Runnable example for s6-06-finops-plane (HOBO-661). The draft-artifact gate EXECUTES
 * this with `node --import tsx` and diffs stdout against usage.expected.txt — keep both
 * honest.
 *
 * Demonstrates the real FinOps plane draft contract on the committed NFR-012 scenario
 * fixture: plan cost estimation priced from cost.json (fail-closed on missing region
 * coverage), showback projected from metering events and reconciled against the
 * MeteringView, and the budget deploy gate — allow under budget, deny past a hard
 * limit, require-approval on agent spend-cap soft breaches.
 */
import { strict as assert } from "node:assert";

import {
	estimatePlanCost,
	evaluateFinOpsDeployGate,
	loadFinOpsPlaneScenario,
	projectShowbackFromEvents,
	runFinOpsPlaneScenario,
	withinCostTolerance,
} from "../src/index.ts";
import { type JsonObject } from "../src/json.js";


// 1) The committed end-to-end scenario runs with every acceptance bullet green.
const scenario = loadFinOpsPlaneScenario();
console.log(`scenario: ${scenario.id} (${scenario.meteringEvents.length} metering events)`);
const result = runFinOpsPlaneScenario(scenario);
for (const [bullet, held] of Object.entries(result.acceptance)) {
	assert.equal(held, true, `acceptance bullet ${bullet}`);
	console.log(`acceptance ${bullet}: ${held}`);
}

// 2) NFR-012: the plan estimate lands within +/-20% of recorded actual spend.
console.log(
	`plan vs actual: projected=$${result.planEstimate.projectedMonthlyUsd} actual=$${result.actualUsd} withinTolerance=${result.estimateWithinTolerance}`,
);
assert.equal(withinCostTolerance(result.planEstimate.projectedMonthlyUsd, scenario.expectedActualUsd, scenario.toleranceFraction), true);

// 3) Estimation fails closed when the plan targets a region cost.json does not cover.
const uncoveredResources = scenario.plan.resources.map(
	({ region: _region, ...resource }: JsonObject & { region?: string }) => resource,
);
assert.throws(
	() =>
		estimatePlanCost({
			costJson: scenario.costJson,
			plan: { ...scenario.plan, regions: ["eu-west-1"], resources: uncoveredResources },
		}),
	/missing from cost\.json coverage/,
);
console.log("uncovered region rejected: eu-west-1 missing from cost.json coverage");

// 4) Showback reconciles exactly against the MeteringView projection.
const reconciliation = result.showbackReconciliation;
console.log(
	`showback reconciled=${reconciliation.reconciled} showbackTotal=$${reconciliation.showbackTotalUsd} meteringTotal=$${reconciliation.meteringTotalUsd}`,
);
assert.equal(reconciliation.showbackTotalUsd, reconciliation.meteringTotalUsd);

// 5) Budget gate: under budget deploys; a hard-limit crossing denies with a violation.
console.log(`gate under budget: effect=${result.allowGate.effect} blocksDeploy=${result.allowGate.blocksDeploy}`);
const projection = projectShowbackFromEvents({
	events: scenario.meteringEvents,
	seq: scenario.meteringEvents.length,
	costCatalog: { currency: scenario.costJson.currency, unitPrices: scenario.costJson.unitPrices },
	displayNames: scenario.displayNames,
});
const denyGate = evaluateFinOpsDeployGate({
	costEstimateUsd: 15,
	meteringView: {
		...projection.meteringView,
		scopeCosts: { "camp:tenant-a/camp-prod": { cost: 190, currency: "USD" } },
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
assert.equal(denyGate.blocksDeploy, true);
assert.match(denyGate.violations.join("\n"), /projected spend 205 exceeds hard budget 200/);
console.log(`gate over hard limit: effect=${denyGate.effect} violation="${denyGate.violations[0]}"`);

// 6) Agent spend-cap soft breach routes to approval instead of a hard deny.
const softGate = evaluateFinOpsDeployGate({
	costEstimateUsd: 5,
	meteringView: {
		...projection.meteringView,
		scopeCosts: { "agent:tenant-a/agent-deploy": { cost: 28, currency: "USD" } },
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
console.log(`gate agent soft cap: effect=${softGate.effect} requiresApproval=${softGate.requiresApproval}`);

console.log("CONTRACT HELD: finops estimates within tolerance, reconciles showback, and gates deploys on budget");
