import assert from "node:assert/strict";
import { create } from "@bufbuild/protobuf";
import { Given, Then, When } from "@cucumber/cucumber";
import {
	RoutingScenarioSchema,
	type RoutingScenario,
} from "../../src/_generated/finops_budget_routing_control_plane_pb.js";
import {
	evaluateRoutingScenario,
	routingInputHashes,
	runFinopsRoutingControlPlaneSimulation,
} from "../../services/finops-routing-control-plane.js";

type RoutingWorld = {
	input?: RoutingScenario;
	result?: ReturnType<typeof evaluateRoutingScenario>;
	replay?: ReturnType<typeof evaluateRoutingScenario>;
};

function input(world: RoutingWorld): RoutingScenario {
	assert.ok(world.input);
	return world.input;
}

function evaluate(world: RoutingWorld, repin = true) {
	const scenario = input(world);
	assert.ok(scenario.snapshot);
	if (repin)
		Object.assign(
			scenario.snapshot,
			routingInputHashes(scenario.candidates, scenario.metricContracts),
		);
	world.result = evaluateRoutingScenario(scenario);
}

Given("a pinned hosting scenario", async function (this: RoutingWorld) {
	const simulation = await runFinopsRoutingControlPlaneSimulation();
	const route = simulation.approvedRoute;
	assert.ok(route.decisionGraph);
	this.input = create(RoutingScenarioSchema, {
		id: "behavior-adversarial",
		intent: route.parse.intent.intent,
		candidates: route.constraints.allowed,
		metricContracts: route.parse.metrics.contracts,
		budgetState: route.budgetState,
		snapshot: {
			...route.decisionGraph.snapshot,
			...routingInputHashes(
				route.constraints.allowed,
				route.parse.metrics.contracts,
			),
		},
	});
});

When(
	"every candidate exceeds the declared latency ceiling",
	function (this: RoutingWorld) {
		input(this).candidates.forEach((candidate) => {
			candidate.latencyP95Ms = 160;
		});
		evaluate(this);
	},
);

Then(
	"the hosting decision denies before metric evaluation",
	function (this: RoutingWorld) {
		assert.equal(this.result?.status, "deny");
		assert.deepEqual(this.result?.metricVectors, []);
		assert.deepEqual(
			this.result?.decisionGraph.metricsEvaluated.systemMetrics,
			[],
		);
	},
);

When(
	"a one-dollar improvement dominates a recently selected incumbent",
	function (this: RoutingWorld) {
		const scenario = input(this);
		const incumbent = scenario.candidates.find(
			(candidate) => candidate.id === "candidate-balanced",
		);
		assert.ok(incumbent?.monthlyCost);
		scenario.candidates = [
			incumbent,
			{
				...incumbent,
				id: "one-dollar-cheaper",
				monthlyCost: incumbent.monthlyCost - 1,
			},
		];
		scenario.history = [
			{
				$typeName: "hobo.draft.finops.v1.RoutingDecisionHistory",
				candidateId: incumbent.id,
				decidedAt: "2026-07-01T15:59:59.000Z",
				flipsInWindow: 100,
				challengerCandidateId: "",
				challengerSince: "",
			},
		];
		evaluate(this);
	},
);

Then(
	"the hosting decision retains its feasible incumbent",
	function (this: RoutingWorld) {
		assert.equal(
			this.result?.routingDecision.selectedCandidateId,
			"candidate-balanced",
		);
		assert.equal(this.result?.stability.overridden, true);
	},
);

When(
	"a quoted cost changes without updating its catalog digest",
	function (this: RoutingWorld) {
		const candidate = input(this).candidates[0];
		assert.ok(candidate?.monthlyCost);
		candidate.monthlyCost -= 1;
		evaluate(this, false);
	},
);

Then(
	"the hosting parser rejects the stale evidence",
	function (this: RoutingWorld) {
		assert.equal(this.result?.status, "rejected");
		assert.match(this.result?.parse.errors?.join(" ") ?? "", /content hashes/);
	},
);

When("the hosting proposal is evaluated twice", function (this: RoutingWorld) {
	evaluate(this);
	this.replay = evaluateRoutingScenario(input(this));
});

Then(
	"the hosting replay is identical and external effects remain unauthorized",
	function (this: RoutingWorld) {
		assert.deepEqual(this.replay, this.result);
		assert.equal(this.result?.planningEffects.purity, "pure");
		assert.equal(
			this.result?.actionPlan.execution.effects.purity,
			"noRollback",
		);
		assert.equal(this.result?.actionPlan.execution.authorized, false);
		assert.equal(this.result?.actionPlan.execution.onUnknown, "reconcile");
	},
);
