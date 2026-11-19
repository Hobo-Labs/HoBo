import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import {
  parseMetricContracts,
  runFinopsRoutingControlPlaneSimulation,
} from "../../services/finops-routing-control-plane.js";

type Simulation = Awaited<ReturnType<typeof runFinopsRoutingControlPlaneSimulation>>;

let simulationPromise: Promise<Simulation> | undefined;
function simulation(): Promise<Simulation> {
  simulationPromise ??= runFinopsRoutingControlPlaneSimulation();
  return simulationPromise;
}

type RoutingWorld = {
  route?: Simulation["approvedRoute"];
  metricParse?: ReturnType<typeof parseMetricContracts>;
  stabilityRoute?: Simulation["stabilityCooldown"];
};

Given("a ResourceIntent with budget, capability, and routing objective", async function (this: RoutingWorld) {
  const sim = await simulation();
  this.route = sim.approvedRoute;
  assert.equal(sim.approvedRoute.parse.intent.ok, true, "fixture intent must parse");
});

When("the control plane evaluates abstract candidates", function (this: RoutingWorld) {
  assert.ok(this.route, "routing scenario must have run");
});

Then("it emits a DecisionGraph and backend-neutral ActionPlan", function (this: RoutingWorld) {
  const route = this.route;
  assert.ok(route?.decisionGraph?.id, "decision graph is emitted");
  assert.ok(route?.actionPlan, "action plan is emitted");
  assert.doesNotMatch(
    JSON.stringify(route.actionPlan),
    /terraform|pulumi|crossplane|kubernetes/iu,
    "action plan stays backend-neutral; provider detail lives in adapter fixtures",
  );
});

Given("a user metric contract", function (this: RoutingWorld) {
  this.metricParse = parseMetricContracts([
    {
      name: "team-preference",
      tier: "user",
      version: "v1.0.0",
      requiresApproval: true,
      compositionSources: ["raw:otel.cpu.seconds"],
    },
  ]);
});

When("it references raw telemetry directly", function (this: RoutingWorld) {
  assert.ok(this.metricParse, "metric contract must have been parsed");
});

Then("parsing fails before routing begins", function (this: RoutingWorld) {
  assert.equal(this.metricParse?.ok, false);
  assert.ok(
    this.metricParse?.errors.some((error: string) => error.includes("raw telemetry")),
    "rejection names the raw-telemetry reference",
  );
  assert.deepEqual(this.metricParse?.contracts, [], "no contracts reach routing");
});

Given("valid, invalid, and dominated candidates", async function (this: RoutingWorld) {
  const sim = await simulation();
  this.route = sim.approvedRoute;
  assert.ok(sim.approvedRoute.constraints.rejected.length > 0, "fixture includes invalid candidates");
});

When("the router filters and ranks them", function (this: RoutingWorld) {
  assert.ok(this.route?.pareto, "pareto evaluation must have run");
});

Then("invalid candidates receive no metric vectors", function (this: RoutingWorld) {
  const route = this.route;
  assert.ok(route);
  const vectorIds = new Set(route.metricVectors.map((vector: { candidateId: string }) => vector.candidateId));
  for (const rejected of route.constraints.rejected) {
    assert.equal(vectorIds.has(rejected.id ?? rejected.candidateId), false, "rejected candidates are never scored");
  }
});

Then("preference weights select only within the Pareto frontier", function (this: RoutingWorld) {
  const route = this.route;
  assert.ok(route);
  assert.ok(
    route.pareto.candidateIds.includes(route.preference.selectedCandidateId),
    "preference selection stays inside the frontier",
  );
});

Given("recent routing history", async function (this: RoutingWorld) {
  const sim = await simulation();
  this.stabilityRoute = sim.stabilityCooldown;
});

When("a new candidate improves by less than the stability threshold", function (this: RoutingWorld) {
  assert.ok(this.stabilityRoute?.stability, "stability controller must have run");
});

Then("the current placement is retained", function (this: RoutingWorld) {
  const stability = this.stabilityRoute?.stability;
  assert.ok(stability);
  assert.equal(stability.selectedCandidateId, "candidate-economy", "prior placement is retained");
});

Then("feedback produces a proposal rather than mutating metrics or policy", async function (this: RoutingWorld) {
  const sim = await simulation();
  assert.ok(sim.feedbackGovernance.proposals.length > 0, "feedback lands as proposals");
  assert.ok(
    sim.feedbackGovernance.proposals.every((proposal: { id: string }) => proposal.id.startsWith("feedback-proposal:")),
    "proposals are first-class, gated artifacts",
  );
});
