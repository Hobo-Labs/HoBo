/**
 * Runnable example for finops-budget-routing-control-plane. The draft-artifact gate
 * EXECUTES this with `node --import tsx` and diffs stdout against usage.expected.txt.
 *
 * Runs the same offline routing simulation the cucumber steps drive
 * (services/finops-routing-control-plane.ts): provider-neutral dry runs,
 * governed metric contracts, constraint-first Pareto routing, stability
 * cooldown, and proposal-gated feedback.
 */
import { strict as assert } from "node:assert";

import {
	parseMetricContracts,
	runFinopsRoutingControlPlaneSimulation,
} from "../services/finops-routing-control-plane.ts";

const sim = await runFinopsRoutingControlPlaneSimulation();
const route = sim.approvedRoute;

// 1) Provider-neutral dry run: DecisionGraph + backend-neutral ActionPlan.
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

// 2) Governed metrics: user metrics referencing raw telemetry fail before routing.
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

// 3) Constraint-first Pareto routing: rejected candidates are never scored;
//    preference weights select only inside the frontier.
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

// 4) Stability cooldown: sub-threshold improvements keep the current placement.
const stability = sim.stabilityCooldown.stability;
assert.equal(stability.selectedCandidateId, "candidate-economy");
console.log(`stability cooldown retains=${stability.selectedCandidateId}`);

// 5) Feedback lands as gated proposals, never as direct metric/policy mutation.
assert.ok(sim.feedbackGovernance.proposals.length > 0);
assert.ok(
	sim.feedbackGovernance.proposals.every((proposal: { id: string }) =>
		proposal.id.startsWith("feedback-proposal:"),
	),
);
console.log(
	`feedback proposals=${sim.feedbackGovernance.proposals.length} allGated=true`,
);

// Planning is pure; the proposal describes an external noRollback boundary.
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
