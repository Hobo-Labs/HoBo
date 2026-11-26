/**
 * Executable step definitions for deployment-strategy-saga-orchestrator.feature.
 *
 * Drives the epic's real saga orchestrator
 * (services/deployment-strategy-orchestrator.ts) against the committed
 * multi-cloud-shop fixture and asserts the rollout outcomes it produces.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import {
	createStrategyOrchestrator,
	loadDeployFixture,
	runMultiCloudShopCanaryRegression,
	runReferenceAppGreen,
	selectStrategyForService,
	STRATEGY_KINDS,
} from "../../services/deployment-strategy-orchestrator.js";

type Fixture = Awaited<ReturnType<typeof loadDeployFixture>>;
type GreenRun = Awaited<ReturnType<typeof runReferenceAppGreen>>;
type RegressionRun = Awaited<
	ReturnType<typeof runMultiCloudShopCanaryRegression>
>;
type Orchestrator = ReturnType<typeof createStrategyOrchestrator>;
type Deployment = Awaited<ReturnType<Orchestrator["deployService"]>>;

type SagaWorld = {
	fixture?: Fixture;
	green?: GreenRun;
	regression?: RegressionRun;
	healthy?: Deployment;
	unhealthy?: Deployment;
};

// --- Scenario: Deploy multi-cloud-shop with mixed strategies to green --------------------

Given(
	"each multi-cloud-shop service declares recreate, blue-green, canary, or progressive",
	async function (this: SagaWorld) {
		this.fixture = await loadDeployFixture();
		for (const [serviceId, serviceConfig] of Object.entries(
			this.fixture.referenceApp.services,
		)) {
			// SAFETY: assertion to `serviceConfig as { strategy: string }` is required at this boundary.
			const config = serviceConfig as { strategy: string };
			assert.ok(
				STRATEGY_KINDS.includes(config.strategy),
				`${serviceId} declares a known strategy`,
			);
			const strategy = selectStrategyForService(config);
			assert.equal(strategy.strategy, config.strategy);
			assert.ok(strategy.steps.length > 0, `${serviceId} compiles saga steps`);
		}
	},
);

When(
	"the saga orchestrator runs health-gated promotion for every service",
	async function (this: SagaWorld) {
		this.green = await runReferenceAppGreen(this.fixture);
	},
);

Then(
	"every strategy promotes the reference app to green",
	function (this: SagaWorld) {
		const green = this.green;
		assert.ok(green);
		assert.equal(green.app, "multi-cloud-shop");
		assert.equal(green.allPromoted, true);
		assert.equal(green.deployments.length, 4);
		for (const deployment of green.deployments) {
			assert.equal(
				deployment.status,
				"promoted",
				`${deployment.strategy} promotes`,
			);
			assert.match(
				deployment.gatewayState.activeVersion,
				/@sha256:green$/,
				`${deployment.strategy} routes traffic to green`,
			);
		}
	},
);

// --- Scenario: Auto-roll back a seeded canary regression ---------------------------------

Given(
	"a seeded canary SLO regression on the multi-cloud-shop web service",
	async function (this: SagaWorld) {
		this.fixture = await loadDeployFixture();
		assert.ok(this.fixture.scenarios, "fixture carries signal scenarios");
	},
);

When(
	"the canary saga observes the regression at fifty percent traffic",
	async function (this: SagaWorld) {
		this.regression = await runMultiCloudShopCanaryRegression(this.fixture);
	},
);

Then(
	"the rollout auto-rolls back with an event-sourced decision and the gateway returns to blue",
	function (this: SagaWorld) {
		const regression = this.regression;
		assert.ok(regression);
		assert.equal(regression.service, "web");
		assert.equal(regression.strategy, "canary");
		assert.equal(regression.rolledBack, true);
		assert.equal(regression.seededRegressionAtWeight, 50);
		assert.equal(regression.eventSourced.metricDecision, "rollback");
		assert.ok(
			regression.eventSourced.rolloutEvents.includes("rollout.RolledBack"),
		);
		assert.equal(regression.gatewayState.activeVersion, "web@sha256:blue");
	},
);

// --- Scenario: Health-gate promotion from data-plane and provider signals ----------------

Given(
	"healthy and provider-unhealthy signal scenarios for the web service",
	async function (this: SagaWorld) {
		this.fixture = await loadDeployFixture();
		assert.ok(
			this.fixture.scenarios.healthyPromotion,
			"healthy scenario exists",
		);
		assert.ok(
			this.fixture.scenarios.providerUnhealthy,
			"provider-unhealthy scenario exists",
		);
	},
);

When(
	"the saga orchestrator deploys the web service under each signal scenario",
	async function (this: SagaWorld) {
		assert.ok(this.fixture);
		const orchestrator = createStrategyOrchestrator();
		const web = this.fixture.referenceApp.services.web;
		this.healthy = await orchestrator.deployService({
			serviceId: "web",
			serviceConfig: web,
			scenario: this.fixture.scenarios.healthyPromotion,
			runId: "behavior-health-pass",
		});
		this.unhealthy = await orchestrator.deployService({
			serviceId: "web",
			serviceConfig: web,
			scenario: this.fixture.scenarios.providerUnhealthy,
			runId: "behavior-health-fail",
		});
	},
);

Then(
	"healthy signals promote the rollout and unhealthy provider signals roll it back",
	function (this: SagaWorld) {
		assert.equal(this.healthy?.status, "promoted");
		assert.equal(this.unhealthy?.status, "rolled-back");
	},
);
