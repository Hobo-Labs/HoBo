/**
 * Executable step definitions for reliability-observability-cost-finops.feature.
 *
 * Drives the epic's real reference simulation
 * (services/reliability-reference-architecture.ts), which executes the
 * promoted telemetry, SLO, metering, saga, and golden-chaos technical proofs.
 * Every assertion reads a value the simulation computed; no live telemetry,
 * billing, or chaos backend is called.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import { runReliabilityObservabilityCostSimulation } from "../../services/reliability-reference-architecture.js";

type Simulation = Awaited<
	ReturnType<typeof runReliabilityObservabilityCostSimulation>
>;

let simulationPromise: Promise<Simulation> | undefined;
function simulation(): Promise<Simulation> {
	simulationPromise ??= runReliabilityObservabilityCostSimulation();
	return simulationPromise;
}

// --- Scenario: Deploy burn creates a rollback obligation -------------------

let telemetrySlice: Simulation["telemetry"] | undefined;
let negativeSlice: Simulation["negative"] | undefined;

Given(
	"a deployment emitting trace-correlated telemetry and SLO samples",
	async () => {
		const sim = await simulation();
		telemetrySlice = sim.telemetry;
		negativeSlice = sim.negative;
		assert.equal(telemetrySlice.traceRepair, "synthesized-root");
	},
);

When("the deploy success SLO exhausts its reliability error budget", () => {
	assert.equal(telemetrySlice?.sloStatus.status, "budget-exhausted");
	assert.equal(telemetrySlice?.sloStatus.healthy, false);
});

Then("the reliability policy gate returns rollback with an obligation", () => {
	assert.equal(telemetrySlice?.rollbackGate.effect, "rollback");
	assert.equal(
		telemetrySlice?.rollbackGate.reason,
		"slo-burn-rate-rollback-threshold",
	);
	assert.ok((telemetrySlice?.rollbackGate.obligationCount ?? 0) >= 1);
});

Then("missing SLI data keeps the reliability gate fail-closed", () => {
	assert.equal(negativeSlice?.noSliData.status, "no-data");
	assert.equal(
		negativeSlice?.malformedTraceparent.traceRepair,
		"regenerated-malformed-traceparent",
	);
});

// --- Scenario: Spend pressure degrades safely ------------------------------

let finopsSlice: Simulation["finops"] | undefined;

Given(
	"metered usage, credit headroom, and quota policy reliability fixtures",
	async () => {
		const sim = await simulation();
		finopsSlice = sim.finops;
		negativeSlice = sim.negative;
		assert.equal(finopsSlice.metering.totalCostUsd, 2.12);
		assert.equal(finopsSlice.creditQuote.totalCost, 0.25);
	},
);

When("projected period spend crosses a cost availability tier", () => {
	assert.ok(finopsSlice, "finops slice must have run");
});

Then("the reliability quota policy allows degraded execution", () => {
	assert.equal(finopsSlice?.quotaDecision.effect, "allow-degraded");
	assert.ok(
		finopsSlice?.quotaDecision.obligations.includes(
			"spend.degradation-required",
		),
	);
	assert.equal(negativeSlice?.quotaMissingContext.effect, "deny");
});

Then(
	"sustained spend velocity trips the runaway-spend breaker while app traffic is unaffected",
	() => {
		assert.equal(finopsSlice?.runawayBreaker.decision, "trip");
		assert.ok(
			finopsSlice?.runawayBreaker.eventTypes.includes("spend.CircuitTripped"),
		);
		assert.equal(finopsSlice?.costGuard.outcome, "degrade-observability");
		assert.equal(finopsSlice?.costGuard.appTraffic, "unaffected");
	},
);

// --- Scenario: Partial deploy failure compensates --------------------------

let recoverySlice: Simulation["recovery"] | undefined;

Given(
	"a deployment saga that provisioned network and database resources",
	async () => {
		const sim = await simulation();
		recoverySlice = sim.recovery;
		negativeSlice = sim.negative;
	},
);

When("the API resource fails across the saga no-go threshold", () => {
	assert.equal(recoverySlice?.failureClass, "partial-failure");
});

Then("reliability compensation destroys database before network", () => {
	assert.equal(recoverySlice?.saga.status, "rolled-back");
	assert.deepEqual(recoverySlice?.compensation.order, ["db", "network"]);
});

Then("the Run Inspector exposes completed reliability replay evidence", () => {
	assert.equal(recoverySlice?.runInspector.status, "completed");
	assert.equal(negativeSlice?.staleSagaLease, "stale saga lease");
});

// --- Scenario: Golden Suite and chaos evidence -----------------------------

let statusSlice: Simulation["status"] | undefined;

Given("passing runtime-local and Camp Golden Suite targets", async () => {
	const sim = await simulation();
	statusSlice = sim.status;
	negativeSlice = sim.negative;
	assert.ok(statusSlice.goldenChaos.eventTypes.includes("golden.Passed"));
});

When("node-loss chaos preserves the steady-state invariant", () => {
	assert.ok(
		statusSlice?.goldenChaos.eventTypes.includes("chaos.SteadyStateChecked"),
	);
	assert.ok(
		statusSlice?.goldenChaos.eventTypes.includes("chaos.ExperimentCompleted"),
	);
});

Then(
	"the reliability rollup keeps chaos evidence explicit and allows continue",
	() => {
		assert.equal(statusSlice?.goldenChaos.status, "passed");
		assert.equal(statusSlice?.goldenChaos.effect, "allow-continue");
		assert.equal(statusSlice?.rollup.environmentStatus, "degraded");
		assert.equal(statusSlice?.rollup.incidentCount, 1);
	},
);

Then("a chaos blast-radius leak aborts the reliability experiment", () => {
	assert.equal(statusSlice?.blastRadiusLeak.status, "aborted");
	assert.equal(
		statusSlice?.blastRadiusLeak.reason,
		"blast-radius-bound-leaked",
	);
	assert.equal(negativeSlice?.chaosBlastRadiusLeak.status, "aborted");
});
