/**
 * Executable step definitions for gated-live-fix-loop.feature.
 *
 * Drives the epic's real loop (services/gated-live-fix-loop.ts) with the
 * committed simulation fixture — the staging scenario replays the fixture
 * as-is (its canary observation regresses); the production scenario reuses
 * the same incident with the environment flipped to prod and a healthy
 * canary observation, so only policy classification changes the outcome.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Given, Then, When } from "@cucumber/cucumber";

import {
	replayGatedLiveFixLoop,
	runGatedLiveFixLoop,
} from "../../services/gated-live-fix-loop.js";

const FIXTURE_URL = new URL(
	"../../simulation/fixtures/gated-live-fix-loop-fixture.json",
	import.meta.url,
);

function loadFixture() {
	return JSON.parse(readFileSync(FIXTURE_URL, "utf8"));
}

function healthyCanaryObservation() {
	return {
		snapshot: {
			sloId: "checkout-availability",
			seq: 26,
			status: "available",
			burnRate: 0.3,
			remainingBudgetRatio: 0.85,
		},
		windowSamples: [
			{
				seq: 25,
				status: "available",
				burnRate: 0.4,
				remainingBudgetRatio: 0.84,
			},
			{
				seq: 26,
				status: "available",
				burnRate: 0.3,
				remainingBudgetRatio: 0.85,
			},
		],
		goldenSuite: { suiteId: "checkout-golden", status: "passed", failures: [] },
	};
}

type LoopResult = ReturnType<typeof runGatedLiveFixLoop>;

type LiveFixWorld = {
	scenario?: ReturnType<typeof loadFixture>;
	result?: LoopResult;
};

// --- Scenario: low-risk fix through canary with auto-rollback ----------------------------

Given(
	"a staging SLO regression fixture with a captured failing trace",
	function (this: LiveFixWorld) {
		this.scenario = loadFixture();
		assert.equal(this.scenario.incident.environment, "staging");
		assert.equal(this.scenario.failingTrace.id, "trace-checkout-500");
	},
);

When(
	"the gated live-fix loop classifies the fix as low-risk and starts a canary",
	function (this: LiveFixWorld) {
		assert.ok(this.scenario);
		assert.equal(this.scenario.candidate.riskClass, "low");
		this.result = runGatedLiveFixLoop(this.scenario);
	},
);

Then(
	"canary SLO regression triggers auto-rollback and the failing trace persists as a permanent regression test",
	function (this: LiveFixWorld) {
		const result = this.result;
		assert.ok(result);
		assert.equal(result.status, "rolled-back");
		assert.equal(result.applied, false);
		assert.equal(result.canaryGate.outcome, "regression");
		assert.equal(result.regressionTests[0].sourceTraceId, "trace-checkout-500");
		assert.equal(result.regressionTests[0].permanent, true);
		const eventTypes = result.events.map(
			(event: { type: string }) => event.type,
		);
		assert.ok(eventTypes.includes("deployment.CanaryStarted"));
		assert.ok(eventTypes.includes("deployment.RolledBack"));
		assert.ok(eventTypes.includes("livefix.RegressionTestRetained"));
		const replay = replayGatedLiveFixLoop(result.events);
		assert.equal(
			replay.status,
			"rolled-back",
			"replay from events reaches the same status",
		);
		assert.equal(
			replay.retainedRegressionTests[0].id,
			"regression:trace-checkout-500",
		);
	},
);

// --- Scenario: production fix blocks until approved --------------------------------------

Given(
	"the same incident classified in the production environment",
	function (this: LiveFixWorld) {
		const fixture = loadFixture();
		this.scenario = {
			...fixture,
			incident: { ...fixture.incident, environment: "prod" },
			canaryObservation: healthyCanaryObservation(),
		};
	},
);

When(
	"the gated live-fix loop evaluates the production fix candidate",
	function (this: LiveFixWorld) {
		assert.ok(this.scenario);
		this.result = runGatedLiveFixLoop(this.scenario);
	},
);

Then(
	"human approval is required before any canary starts and the failing trace is retained",
	function (this: LiveFixWorld) {
		const result = this.result;
		assert.ok(result);
		assert.equal(result.status, "needs-approval");
		assert.equal(result.needsApproval, true);
		assert.equal(
			result.approvalRequest.reason,
			"production-or-high-risk-live-fix",
		);
		assert.ok(
			!result.events.some(
				(event: { type: string }) => event.type === "deployment.CanaryStarted",
			),
			"no canary starts before approval",
		);
		assert.equal(result.regressionTests[0].permanent, true);
		const replay = replayGatedLiveFixLoop(result.events);
		assert.equal(replay.needsApproval, true);
		assert.equal(replay.policyEffect, "require-approval");
	},
);
