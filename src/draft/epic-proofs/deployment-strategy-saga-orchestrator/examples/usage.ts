import { strict as assert } from "node:assert";

import {
	createStrategyOrchestrator,
	loadDeployFixture,
	runMultiCloudShopCanaryRegression,
	runReferenceAppGreen,
	selectStrategyForService,
	STRATEGY_KINDS,
} from "../services/deployment-strategy-orchestrator.ts";

const fixture = await loadDeployFixture();

const services = Object.entries(fixture.referenceApp.services);
for (const [serviceId, serviceConfig] of services) {
	// SAFETY: assertion to `serviceConfig as { strategy: string }` is required at this boundary.
	const config = serviceConfig as { strategy: string };
	assert.ok(STRATEGY_KINDS.includes(config.strategy));
	const strategy = selectStrategyForService(config);
	assert.equal(strategy.strategy, config.strategy);
	assert.ok(strategy.steps.length > 0);
	console.log(
		`service=${serviceId} strategy=${config.strategy} sagaSteps=${strategy.steps.length}`,
	);
}

const green = await runReferenceAppGreen(fixture);
assert.equal(green.app, "multi-cloud-shop");
assert.equal(green.allPromoted, true);
assert.equal(green.deployments.length, 4);
for (const deployment of green.deployments) {
	assert.equal(deployment.status, "promoted");
	assert.match(deployment.gatewayState.activeVersion, /@sha256:green$/);
}
console.log(
	`green rollout app=${green.app} allPromoted=${green.allPromoted} deployments=${green.deployments.length}`,
);

const regression = await runMultiCloudShopCanaryRegression(fixture);
assert.equal(regression.service, "web");
assert.equal(regression.strategy, "canary");
assert.equal(regression.rolledBack, true);
assert.equal(regression.seededRegressionAtWeight, 50);
assert.equal(regression.eventSourced.metricDecision, "rollback");
assert.ok(regression.eventSourced.rolloutEvents.includes("rollout.RolledBack"));
assert.equal(regression.gatewayState.activeVersion, "web@sha256:blue");
console.log(
	`canary regression service=${regression.service} atWeight=${regression.seededRegressionAtWeight} decision=${regression.eventSourced.metricDecision} gateway=${regression.gatewayState.activeVersion}`,
);

const orchestrator = createStrategyOrchestrator();
const web = fixture.referenceApp.services.web;
const healthy = await orchestrator.deployService({
	serviceId: "web",
	serviceConfig: web,
	scenario: fixture.scenarios.healthyPromotion,
	runId: "example-health-pass",
});
const unhealthy = await orchestrator.deployService({
	serviceId: "web",
	serviceConfig: web,
	scenario: fixture.scenarios.providerUnhealthy,
	runId: "example-health-fail",
});
assert.equal(healthy.status, "promoted");
assert.equal(unhealthy.status, "rolled-back");
console.log(
	`health gate healthy=${healthy.status} providerUnhealthy=${unhealthy.status}`,
);

console.log(
	"EPIC HELD: strategies compile to sagas, promotion is health-gated, regressions roll back",
);
