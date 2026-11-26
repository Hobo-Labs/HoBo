/**
 * Executable step definitions for control-plane-planner-matching-orchestrator.feature.
 *
 * Drives the epic's real reference simulation
 * (services/control-plane-reference-architecture.ts) and asserts the planning,
 * reconciliation, drift, and bootstrap artifacts it actually produces.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import { runControlPlaneReferenceSimulation } from "../../services/control-plane-reference-architecture.js";

type Simulation = Awaited<
	ReturnType<typeof runControlPlaneReferenceSimulation>
>;

let simulationPromise: Promise<Simulation> | undefined;
function simulation(): Promise<Simulation> {
	simulationPromise ??= runControlPlaneReferenceSimulation();
	return simulationPromise;
}

type ControlPlaneWorld = {
	result?: Simulation;
};

// --- Scenario: Plan a Bindle into replayable provider decisions --------------------------

Given(
	"a collected manifest and registered Resource Definitions in the planner fixture",
	async function (this: ControlPlaneWorld) {
		this.result = await simulation();
		assert.equal(
			this.result.epic.slug,
			"control-plane-planner-matching-orchestrator",
		);
	},
);

When(
	"the Planner resolves the checkout Bindle for prod",
	function (this: ControlPlaneWorld) {
		assert.ok(this.result?.plan, "planner must have produced a plan");
	},
);

Then(
	"it emits a deterministic DeploymentPlan with matching decisions and zero live network calls",
	function (this: ControlPlaneWorld) {
		const result = this.result;
		assert.ok(result);
		assert.equal(result.plan.contentHash, "sha256:control-plane-reference-001");
		assert.deepEqual(result.plan.dependencyOrder, [
			"orders-db",
			"checkout-api",
			"web-edge",
			"receipt-worker",
		]);
		assert.equal(
			result.matching.decisions.every(
				(decision: { catalogHash: string }) =>
					decision.catalogHash === "sha256:catalog-control-plane-001",
			),
			true,
			"every match decision pins the catalog hash",
		);
		assert.equal(result.liveNetworkCalls.length, 0);
	},
);

// --- Scenario: Promote a Delta into a Set and converge resources -------------------------

Given(
	"an approved deployment Delta for the checkout Set",
	async function (this: ControlPlaneWorld) {
		this.result = await simulation();
		assert.equal(
			this.result.delta.appliedSetRef,
			"set:checkout-prod@sha256:002",
		);
	},
);

When(
	"the Orchestrator applies the Set through resource actors",
	function (this: ControlPlaneWorld) {
		assert.ok(this.result?.orchestrator, "orchestrator must have run");
	},
);

Then(
	"ResourceActors reconcile in dependency order through mocked executor and driver boundaries",
	function (this: ControlPlaneWorld) {
		const result = this.result;
		assert.ok(result);
		assert.deepEqual(result.orchestrator.actorOrder, [
			"orders-db",
			"checkout-api",
			"web-edge",
			"receipt-worker",
		]);
		assert.equal(
			result.orchestrator.events.includes("resource.Provisioned:checkout-api"),
			true,
		);
		assert.equal(result.executor.sandbox, "firecracker");
		assert.equal(
			result.executor.ambientCredentials,
			false,
			"executor never sees ambient credentials",
		);
		assert.equal(
			result.driverDispatch.selectedDrivers.includes("terraform"),
			true,
		);
	},
);

// --- Scenario: Recover from drift and partial realization --------------------------------

Given(
	"provider drift and a created-but-not-in-state partial failure",
	async function (this: ControlPlaneWorld) {
		this.result = await simulation();
		assert.equal(
			this.result.drift.loopDetected,
			true,
			"fixture surfaces drift",
		);
	},
);

When(
	"the level-triggered reconcile loop runs against the drifted resources",
	function (this: ControlPlaneWorld) {
		assert.ok(
			this.result?.partialRealize,
			"partial-realize recovery must have run",
		);
	},
);

Then(
	"the reference rolls back with the orphan recorded and blocks double-spend dispatch",
	function (this: ControlPlaneWorld) {
		const result = this.result;
		assert.ok(result);
		assert.equal(result.drift.actions.includes("orphan-sweep"), true);
		assert.equal(
			result.partialRealize.compensation.status,
			"rolled_back_with_orphan_recorded",
		);
		assert.equal(result.partialRealize.createdButNotInState.safe, true);
		assert.equal(result.dispatcher.firstReservation.status, "reserved");
		assert.equal(
			result.dispatcher.secondReservation.status,
			"cas_rejected",
			"double spend is CAS-rejected",
		);
	},
);

// --- Scenario: Seed a Yard and hand over identity ----------------------------------------

Given(
	"a local seed Yard with one short-lived operator credential",
	async function (this: ControlPlaneWorld) {
		this.result = await simulation();
		assert.equal(
			this.result.bootstrap.seedCredentialUse,
			"single_use_operator_svid",
		);
	},
);

When(
	"the real Yard identity broker becomes ready",
	function (this: ControlPlaneWorld) {
		assert.equal(
			this.result?.bootstrap.handoverPoint,
			"real_identity_broker_ready",
		);
	},
);

Then(
	"the seed event log imports, the seed credential retires, and duplicate bootstrap is blocked",
	function (this: ControlPlaneWorld) {
		const bootstrap = this.result?.bootstrap;
		assert.ok(bootstrap);
		assert.equal(bootstrap.replayImported, true);
		assert.equal(bootstrap.secondBootstrapBlocked, true);
	},
);
