/**
 * Executable step definitions for operators-sre-crew.feature.
 *
 * Drives the epic's real reference simulation
 * (services/crew-reference-architecture.ts) over its committed scenario
 * fixtures and asserts the incident event streams it produces. All service
 * boundaries stay mocked via the Pact-backed boundary recorder.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import { runCrewReferenceSimulation } from "../../services/crew-reference-architecture.js";

type Simulation = Awaited<ReturnType<typeof runCrewReferenceSimulation>>;
type CrewScenario = Simulation["scenarios"][number];

let baseSimulationPromise: Promise<Simulation> | undefined;
function baseSimulation(): Promise<Simulation> {
	baseSimulationPromise ??= runCrewReferenceSimulation();
	return baseSimulationPromise;
}

let approvedSimulationPromise: Promise<Simulation> | undefined;
function approvedSimulation(): Promise<Simulation> {
	approvedSimulationPromise ??= runCrewReferenceSimulation({
		humanDecisions: { "prod-contract-skew": "approve" },
	});
	return approvedSimulationPromise;
}

async function scenarioById(
	id: string,
	sim: Promise<Simulation>,
): Promise<CrewScenario> {
	const result = await sim;
	const scenario = result.scenarios.find((entry) => entry.id === id);
	assert.ok(scenario, `fixture scenario ${id} must exist`);
	return scenario;
}

function eventTypes(scenario: CrewScenario): string[] {
	return scenario.events.map((event: { type: string }) => event.type);
}

// --- Scenario: Provider degradation is remediated through a gated canary ---

let degraded: CrewScenario | undefined;

Given("the Crew endpoint monitor reports high API SLO burn", async () => {
	degraded = await scenarioById("provider-degraded-api", baseSimulation());
	assert.ok(eventTypes(degraded).includes("slo.BudgetBurned"));
});

When("the SRE Crew operator diagnoses provider degradation", () => {
	assert.ok(degraded);
	const diagnosed = degraded.events.find(
		(event: { type: string }) => event.type === "projection.Diagnosed",
	);
	assert.equal(diagnosed?.body.failureClass, "provider-degraded");
});

Then("one Crew incident opens and policy allows a canary remediation", () => {
	assert.ok(degraded);
	const opened = eventTypes(degraded).filter(
		(type) => type === "incident.Opened",
	);
	assert.equal(opened.length, 1, "exactly one incident opens");
	const policy = degraded.events.find(
		(event: { type: string }) => event.type === "policy.Decided",
	);
	assert.equal(policy?.body.decision, "allow_canary");
});

Then("the Crew live-fix completes and replay evidence publishes", () => {
	assert.ok(degraded);
	assert.equal(degraded.status, "resolved");
	const types = eventTypes(degraded);
	assert.ok(types.includes("liveFix.CanaryCompleted"));
	assert.ok(types.includes("postmortem.Generated"));
	assert.ok(types.includes("knowledge.PostmortemPublished"));
});

// --- Scenario: Production contract skew waits for approval -----------------

let skewPending: CrewScenario | undefined;
let skewApproved: CrewScenario | undefined;

Given(
	"a Crew compatibility gate failure between a producer and consumer",
	async () => {
		skewPending = await scenarioById("prod-contract-skew", baseSimulation());
		assert.ok(eventTypes(skewPending).includes("compat.GateFailed"));
	},
);

When("the SRE Crew operator proposes a dual-publish shim", () => {
	assert.ok(skewPending);
	const proposed = skewPending.events.find(
		(event: { type: string }) => event.type === "crew.actionProposed",
	);
	assert.equal(proposed?.body.action, "dual-publish-shim");
	assert.equal(proposed?.body.effect, "require_approval");
});

Then(
	"the Crew action waits for operator-console approval before any live-fix call",
	() => {
		assert.ok(skewPending);
		assert.equal(skewPending.status, "waiting_for_human_approval");
		assert.equal(
			eventTypes(skewPending).filter((type) => type.startsWith("liveFix."))
				.length,
			0,
			"no remediation gateway call happens before approval",
		);
	},
);

Then(
	"an approved Crew decision resumes the canary and resolves the incident",
	async () => {
		skewApproved = await scenarioById(
			"prod-contract-skew",
			approvedSimulation(),
		);
		assert.equal(skewApproved.status, "resolved_after_approval");
		const types = eventTypes(skewApproved);
		const approvalIndex = types.indexOf("console.ApprovalDecided");
		const canaryIndex = types.indexOf("liveFix.CanaryStarted");
		assert.ok(
			approvalIndex >= 0 && canaryIndex > approvalIndex,
			"canary starts only after approval",
		);
		assert.ok(types.includes("incident.Resolved"));
	},
);

// --- Scenario: Ambiguous self-caused drift escalates -----------------------

let runaway: CrewScenario | undefined;

Given("a Crew drift signal that may stem from prior remediation", async () => {
	runaway = await scenarioById(
		"ambiguous-runaway-remediation",
		baseSimulation(),
	);
	assert.ok(eventTypes(runaway).includes("resource.DriftDetected"));
});

When("the Crew taxonomy cannot classify the drift safely", () => {
	assert.ok(runaway);
	const diagnosed = runaway.events.find(
		(event: { type: string }) => event.type === "projection.Diagnosed",
	);
	assert.equal(diagnosed?.body.failureClass, "unknown");
});

Then("the Crew runaway guard opens a circuit and denies further writes", () => {
	assert.ok(runaway);
	const circuit = runaway.events.find(
		(event: { type: string }) => event.type === "runawayGuard.CircuitOpened",
	);
	assert.equal(circuit?.body.reason, "self-caused-remediation-loop");
	const policy = runaway.events.find(
		(event: { type: string }) => event.type === "policy.Decided",
	);
	assert.equal(policy?.body.decision, "deny_write_escalate");
});

Then(
	"the Crew requests human handoff without another remediation write",
	() => {
		assert.ok(runaway);
		assert.equal(runaway.status, "escalated");
		const types = eventTypes(runaway);
		assert.ok(types.includes("crew.handoffRequested"));
		assert.equal(
			types.filter(
				(type) => type.startsWith("liveFix.") || type === "crew.actionApplied",
			).length,
			0,
			"no further remediation writes after the circuit opens",
		);
	},
);

// --- Scenario: DR failover proves fencing and replay before traffic shift --

let drFailover: CrewScenario | undefined;

Given("a production region loss detected by the Crew", async () => {
	drFailover = await scenarioById("regional-dr-failover", baseSimulation());
	assert.ok(eventTypes(drFailover).includes("dr.RegionLossDetected"));
});

When("the Crew DR runbook evaluates regional failover", () => {
	assert.ok(drFailover);
	const policy = drFailover.events.find(
		(event: { type: string }) => event.type === "policy.Decided",
	);
	assert.equal(policy?.body.decision, "allow_failover");
});

Then(
	"Crew fencing, RPO honesty, and replicated log replay are certified",
	() => {
		assert.ok(drFailover);
		assert.equal(drFailover.status, "integrity_certified");
		const fencing = drFailover.events.find(
			(event: { type: string }) => event.type === "dr.FencingVerified",
		);
		assert.equal(fencing?.body.splitBrain, false);
		const rpo = drFailover.events.find(
			(event: { type: string }) => event.type === "dr.RpoReported",
		);
		assert.equal(rpo?.body.honesty, "bounded-staleness-disclosed");
	},
);

Then("the certified Crew evidence precedes the traffic shift", () => {
	assert.ok(drFailover);
	const types = eventTypes(drFailover);
	const replayIndex = types.indexOf("dr.ReplayVerified");
	const shiftIndex = types.indexOf("dr.TrafficShiftReady");
	assert.ok(replayIndex >= 0, "replay evidence is recorded");
	assert.ok(
		shiftIndex > replayIndex,
		"traffic shift readiness follows replay verification",
	);
});
