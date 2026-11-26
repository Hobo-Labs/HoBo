import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createStrategyOrchestrator,
  loadDeployFixture,
  runMultiCloudShopCanaryRegression,
  runReferenceAppGreen,
  selectStrategyForService,
  STRATEGY_KINDS,
} from "../services/deployment-strategy-orchestrator.js";

describe("deployment strategy saga orchestrator (HOBO-658)", () => {
  it("selects recreate, blue-green, canary, and progressive templates per service", async () => {
    const fixture = await loadDeployFixture();

    for (const [serviceId, serviceConfig] of Object.entries(fixture.referenceApp.services)) {
      const strategy = selectStrategyForService(serviceConfig);
      assert.equal(strategy.strategy, serviceConfig.strategy);
      assert.ok(strategy.steps.length > 0, `${serviceId} must compile saga steps`);
      assert.ok(STRATEGY_KINDS.includes(serviceConfig.strategy));
    }
  });

  it("deploys multi-cloud-shop reference app green for every strategy in CI", async () => {
    const result = await runReferenceAppGreen();

    assert.equal(result.app, "multi-cloud-shop");
    assert.equal(result.allPromoted, true);
    assert.equal(result.deployments.length, 4);

    const byStrategy = Object.fromEntries(
      result.deployments.map((deployment) => [deployment.strategy, deployment.status]),
    );
    assert.equal(byStrategy.recreate, "promoted");
    assert.equal(byStrategy["blue-green"], "promoted");
    assert.equal(byStrategy.canary, "promoted");
    assert.equal(byStrategy.progressive, "promoted");

    for (const deployment of result.deployments) {
      const active = deployment.gatewayState.activeVersion;
      assert.match(active, /@sha256:green$/, `${deployment.strategy} must route to green`);
    }
  });

  it("auto-rolls back seeded canary regression on multi-cloud-shop with event-sourced decision", async () => {
    const result = await runMultiCloudShopCanaryRegression();

    assert.equal(result.app, "multi-cloud-shop");
    assert.equal(result.service, "web");
    assert.equal(result.strategy, "canary");
    assert.equal(result.rolledBack, true);
    assert.equal(result.seededRegressionAtWeight, 50);
    assert.equal(result.eventSourced.metricDecision, "rollback");
    assert.ok(result.eventSourced.rollbackObligation, "rollback obligation must be event-sourced");
    assert.ok(result.eventSourced.rolloutEvents.includes("rollout.RolledBack"));
    assert.equal(result.gatewayState.activeVersion, "web@sha256:blue");
  });

  it("health-gates promotion from data-plane and provider health signals", async () => {
    const fixture = await loadDeployFixture();
    const orchestrator = createStrategyOrchestrator();
    const web = fixture.referenceApp.services.web;

    const healthy = await orchestrator.deployService({
      serviceId: "web",
      serviceConfig: web,
      scenario: fixture.scenarios.healthyPromotion,
      runId: "health-pass",
    });
    assert.equal(healthy.status, "promoted");

    const unhealthy = await orchestrator.deployService({
      serviceId: "web",
      serviceConfig: web,
      scenario: fixture.scenarios.providerUnhealthy,
      runId: "health-fail",
    });
    assert.equal(unhealthy.status, "rolled-back");
  });

  it("rolls back on golden-suite failure adversarial case", async () => {
    const fixture = await loadDeployFixture();
    const orchestrator = createStrategyOrchestrator();
    const web = fixture.referenceApp.services.web;

    const result = await orchestrator.deployService({
      serviceId: "web",
      serviceConfig: web,
      scenario: fixture.scenarios.goldenSuiteFailure,
      runId: "golden-fail",
    });

    assert.equal(result.status, "rolled-back");
    assert.equal(result.metricGate?.verdict, "rollback");
    assert.ok(
      result.events.some((event) => event.type === "policy.ObligationCreated"),
      "golden-suite failure must create auto-revert obligation",
    );
  });
});
