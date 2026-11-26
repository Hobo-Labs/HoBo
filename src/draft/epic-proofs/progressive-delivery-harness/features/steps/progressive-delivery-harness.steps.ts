/**
 * Executable step definitions for progressive-delivery-harness.feature.
 *
 * Drives the epic's real reference module (src/harness-reference.ts) —
 * runHarnessScenario over the committed progressive-delivery fixture — and
 * asserts the rollout, SLO, experiment, and compensation outcomes it
 * produces. Flag, traffic, SLO, and policy providers stay mocked.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import {
	loadScenarioFixture,
	runHarnessScenario,
} from "../../src/harness-reference.js";

type Fixture = Awaited<ReturnType<typeof loadScenarioFixture>>;
type Outcome = Awaited<ReturnType<typeof runHarnessScenario>>;

let fixturePromise: Promise<Fixture> | undefined;
function fixture(): Promise<Fixture> {
	fixturePromise ??= loadScenarioFixture();
	return fixturePromise;
}

// --- Scenario: Healthy canary promotes checkout-v2 -------------------------

let healthyOutcome: Outcome | undefined;

Given(
	"the checkout-v2 Harness fixture with a fresh feature-flag ruleset",
	async () => {
		const fx = await fixture();
		assert.equal(fx.scenarios.healthyCanary.ruleset.freshness.status, "fresh");
	},
);

When("the Harness runs the healthy canary rollout", async () => {
	healthyOutcome = await runHarnessScenario(
		(await fixture()).scenarios.healthyCanary,
	);
});

Then(
	"the Harness ramps traffic through 10, 50, and 100 percent and promotes",
	() => {
		assert.equal(healthyOutcome?.status, "promoted");
		assert.deepEqual(healthyOutcome?.rollout.trafficSplits, [10, 50, 100]);
		assert.equal(healthyOutcome?.flag.evaluation.value, "treatment");
		assert.ok(healthyOutcome?.auditEvents.includes("rollout.Promoted"));
	},
);

Then(
	"the Harness experiment concludes ship within the same audit stream",
	() => {
		assert.equal(healthyOutcome?.experiment.verdict, "ship");
		assert.equal(healthyOutcome?.experiment.reason, "powered");
		assert.ok(healthyOutcome?.auditEvents.includes("experiment.Concluded"));
	},
);

// --- Scenario: SLO burn rolls the Harness canary back ----------------------

let burnOutcome: Outcome | undefined;

Given("the checkout-v2 Harness fixture with an SLO burn snapshot", async () => {
	const fx = await fixture();
	assert.equal(
		fx.scenarios.sloBurnRollback.slo.snapshots[0].verdict,
		"rollback",
	);
});

When("the Harness runs the burning canary rollout", async () => {
	burnOutcome = await runHarnessScenario(
		(await fixture()).scenarios.sloBurnRollback,
	);
});

Then(
	"the Harness resets traffic to zero and records the rollback obligation as satisfied",
	() => {
		assert.equal(burnOutcome?.status, "rolled_back");
		assert.deepEqual(burnOutcome?.rollout.trafficSplits, [10, 0]);
		assert.equal(burnOutcome?.rollback.obligation.status, "satisfied");
		assert.equal(burnOutcome?.rollback.reason, "slo-burn");
		assert.ok(burnOutcome?.auditEvents.includes("rollout.RolledBack"));
	},
);

// --- Scenario: Stale rulesets and underpowered experiments -----------------

let staleOutcome: Outcome | undefined;
let underpoweredOutcome: Outcome | undefined;

Given(
	"the checkout-v2 Harness fixtures for a stale ruleset and an underpowered experiment",
	async () => {
		const fx = await fixture();
		assert.equal(fx.scenarios.staleRuleset.ruleset.freshness.status, "stale");
		assert.ok(
			fx.scenarios.underpoweredExperiment.experiment.sampleSize <
				fx.scenarios.underpoweredExperiment.experiment.minSampleSize,
		);
	},
);

When("the Harness evaluates both degraded rollouts", async () => {
	const fx = await fixture();
	staleOutcome = await runHarnessScenario(fx.scenarios.staleRuleset);
	underpoweredOutcome = await runHarnessScenario(
		fx.scenarios.underpoweredExperiment,
	);
});

Then(
	"the stale ruleset holds the Harness rollout on the fail-safe default",
	() => {
		assert.equal(staleOutcome?.status, "held");
		assert.equal(staleOutcome?.holdReason, "stale-ruleset");
		assert.equal(staleOutcome?.flag.evaluation.reason, "fail-safe-default");
		assert.equal(staleOutcome?.flag.evaluation.value, "control");
	},
);

Then("the underpowered Harness experiment refuses to conclude", () => {
	assert.equal(underpoweredOutcome?.status, "promoted");
	assert.equal(underpoweredOutcome?.experiment.verdict, "do-not-conclude");
	assert.equal(underpoweredOutcome?.experiment.reason, "underpowered");
});

// --- Scenario: Stuck traffic and failed compensation escalate --------------

let stuckOutcome: Outcome | undefined;
let compensationOutcome: Outcome | undefined;

Given(
	"the checkout-v2 Harness fixtures for a stuck split and a failing compensator",
	async () => {
		const fx = await fixture();
		assert.equal(fx.scenarios.stuckRollout.traffic.observedByStep["50"], 35);
		assert.equal(
			fx.scenarios.rollbackCompensationFailure.rollback.mode,
			"fail",
		);
	},
);

When(
	"the Harness detects non-convergence and exhausted rollback compensation",
	async () => {
		const fx = await fixture();
		stuckOutcome = await runHarnessScenario(fx.scenarios.stuckRollout);
		compensationOutcome = await runHarnessScenario(
			fx.scenarios.rollbackCompensationFailure,
		);
	},
);

Then(
	"the Harness escalates both rollouts to needs-human instead of self-certifying",
	() => {
		assert.equal(stuckOutcome?.status, "needs-human");
		assert.equal(
			stuckOutcome?.rollout.convergence,
			"traffic-split-not-converged",
		);
		assert.equal(compensationOutcome?.status, "needs-human");
		assert.equal(compensationOutcome?.rollback.obligation.status, "escalated");
		assert.ok(compensationOutcome?.auditEvents.includes("rollout.NeedsHuman"));
	},
);
