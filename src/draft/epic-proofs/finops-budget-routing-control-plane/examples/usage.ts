import { strict as assert } from "node:assert";

import {
	parseMetricContracts,
	runFinopsRoutingControlPlaneSimulation,
} from "../services/finops-routing-control-plane.ts";

const sim = await runFinopsRoutingControlPlaneSimulation();
const route = sim.approvedRoute;

assert.equal(route.parse.intent.ok, true);
assert.ok(route.decisionGraph.id);
assert.ok(route.actionPlan);
assert.doesNotMatch(
	JSON.stringify(route.actionPlan),
	/terraform|pulumi|crossplane|kubernetes/iu,
);
console.log(
	`dry run intentParsed=${route.parse.intent.ok} decisionGraph=${route.decisionGraph.id} actionPlanNeutral=true`,
);

const metricParse = parseMetricContracts([
	{
		name: "team-preference",
		tier: "user",
		version: "v1.0.0",
		requiresApproval: true,
		compositionSources: ["raw:otel.cpu.seconds"],
	},
]);
assert.equal(metricParse.ok, false);
assert.ok(
	metricParse.errors.some((error: string) => error.includes("raw telemetry")),
);
assert.deepEqual(metricParse.contracts, []);
console.log(
	`metric governance ok=${metricParse.ok} errors=${metricParse.errors.length} contractsReachingRouting=${metricParse.contracts.length}`,
);

assert.ok(route.constraints.rejected.length > 0);
const vectorIds = new Set(
	route.metricVectors.map(
		(vector: { candidateId: string }) => vector.candidateId,
	),
);
for (const rejected of route.constraints.rejected) {
	assert.equal(vectorIds.has(rejected.id ?? rejected.candidateId), false);
}
assert.ok(route.pareto.candidateIds.includes(route.preference.selectedCandidateId));
console.log(
	`routing rejected=${route.constraints.rejected.length} scored=${route.metricVectors.length} frontier=${route.pareto.candidateIds.length} selected=${route.preference.selectedCandidateId}`,
);

const stability = sim.stabilityCooldown.stability;
assert.equal(stability.selectedCandidateId, "candidate-economy");
console.log(`stability cooldown retains=${stability.selectedCandidateId}`);

assert.ok(sim.feedbackGovernance.proposals.length > 0);
assert.ok(
	sim.feedbackGovernance.proposals.every((proposal: { id: string }) =>
		proposal.id.startsWith("feedback-proposal:"),
	),
);
console.log(
	`feedback proposals=${sim.feedbackGovernance.proposals.length} allGated=true`,
);

assert.equal(route.planningEffects.purity, "pure");
assert.equal(route.actionPlan.execution.effects.purity, "noRollback");
assert.equal(route.actionPlan.execution.authorized, false);
assert.equal(route.actionPlan.execution.onUnknown, "reconcile");
assert.ok(route.actionPlan.execution.mutationResilience.strategies.every(
	(strategy) => strategy.kind !== "retry" && strategy.kind !== "hedging",
));
console.log("effects planning=pure mutation=noRollback unknown=reconcile executionAuthorized=false");

console.log(
	"EPIC HELD: routing is constraint-first, provider-neutral, stability-damped, and proposal-gated",
);
