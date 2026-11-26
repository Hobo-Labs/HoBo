import { readFile } from "node:fs/promises";

import {
  blueGreenStrategy,
  canaryStrategy,
  createDeploymentStrategySaga,
  progressiveStrategy,
  recreateStrategy,
  replayGatewayState,
} from "../../../technical-proofs/deployment-strategy-saga-templates-contract/src/deployment-strategy-saga-templates.js";
import {
  evaluateRolloutMetricGate,
  replayMetricGateEvents,
} from "../../../technical-proofs/slo-gated-rollback-analysis-contract/src/slo-gated-rollback-analysis.js";
const FIXTURE_URL = new URL("../simulation/fixtures/multi-cloud-shop-deploy-fixture.json", import.meta.url);

export const STRATEGY_KINDS = Object.freeze(["recreate", "blue-green", "canary", "progressive"]);

export async function loadDeployFixture(url = FIXTURE_URL) {
  return JSON.parse(await readFile(url, "utf8"));
}

export function selectStrategyForService(serviceConfig) {
  const strategy = serviceConfig.strategy;
  if (!STRATEGY_KINDS.includes(strategy)) {
    throw new Error(`unsupported strategy ${strategy}`);
  }

  const healthGate = { id: `${serviceConfig.routeId}-health`, timeoutMs: 300000 };

  switch (strategy) {
    case "recreate":
      return recreateStrategy({ routeId: serviceConfig.routeId, healthGate });
    case "blue-green":
      return blueGreenStrategy({
        routeId: serviceConfig.routeId,
        healthGate,
        soakSeconds: 120,
      });
    case "canary":
      return canaryStrategy({
        routeId: serviceConfig.routeId,
        percentages: [10, 50, 100],
        healthGate,
        autoRollbackSignals: ["slo-burn", "golden-suite"],
      });
    case "progressive":
      return progressiveStrategy({
        routeId: serviceConfig.routeId,
        stages: [
          { name: "one-percent", toWeight: 1, timeoutMs: 60000 },
          { name: "ten-percent", toWeight: 10, timeoutMs: 120000 },
          { name: "half", toWeight: 50, timeoutMs: 180000 },
          { name: "full", toWeight: 100, timeoutMs: 300000 },
        ],
        autoRollbackSignals: ["slo-burn", "golden-suite"],
      });
    default:
      throw new Error(`unsupported strategy ${strategy}`);
  }
}

export function createStrategyOrchestrator({ now = defaultClock() } = {}) {
  const saga = createDeploymentStrategySaga({ now });

  return {
    async deployService({ serviceId, serviceConfig, scenario, tenant = "yard-demo", runId = "run-1" }) {
      const strategy = selectStrategyForService(serviceConfig);
      const gateway = createMockGateway(serviceConfig);
      const signals = createHealthSignalProvider({ scenario, serviceConfig });
      let stepIndex = 0;
      const eventLog = [];

      const result = await saga.run({
        rollout: {
          rolloutId: `rollout-${serviceId}-${runId}`,
          runId,
          tenant,
          target: {
            service: serviceId,
            routeId: serviceConfig.routeId,
            fromVersion: serviceConfig.fromVersion,
            toVersion: serviceConfig.toVersion,
          },
          strategy,
        },
        eventLog,
        gateway,
        gateSignal: async ({ step }) => {
          const current = stepIndex;
          stepIndex += 1;
          return signals.evaluateGate({ step, stepIndex: current });
        },
      });

      const metricEvents = signals.metricEvents();
      const allEvents = [...result.events, ...metricEvents];

      return {
        serviceId,
        strategy: serviceConfig.strategy,
        status: result.status.state,
        gatewayState: replayGatewayState(result.events),
        events: allEvents,
        metricGate: signals.lastMetricGate(),
      };
    },
  };
}

export async function runReferenceAppGreen(fixture = null) {
  const deployFixture = fixture ?? await loadDeployFixture();
  const scenario = deployFixture.scenarios.healthyPromotion;
  const deployments = [];

  for (const [serviceId, serviceConfig] of Object.entries(deployFixture.referenceApp.services)) {
    const orchestrator = createStrategyOrchestrator();
    const deployment = await orchestrator.deployService({
      serviceId,
      serviceConfig,
      scenario,
      runId: `green-${serviceId}`,
    });
    deployments.push(deployment);
  }

  return {
    app: deployFixture.referenceApp.id,
    bindleDigest: deployFixture.referenceApp.bindleDigest,
    deployments,
    allPromoted: deployments.every((deployment) => deployment.status === "promoted"),
  };
}

export async function runMultiCloudShopCanaryRegression(fixture = null) {
  const deployFixture = fixture ?? await loadDeployFixture();
  const web = deployFixture.referenceApp.services.web;
  const scenario = deployFixture.scenarios.canaryRegression;
  const orchestrator = createStrategyOrchestrator();
  const deployment = await orchestrator.deployService({
    serviceId: "web",
    serviceConfig: web,
    scenario,
    runId: "canary-regression-seed",
  });

  const rolloutEvents = deployment.events.filter((event) => event.type?.startsWith("rollout."));
  const metricEvents = deployment.events.filter((event) =>
    event.type?.startsWith("delivery.") || event.type?.startsWith("policy."));
  const obligationReplay = replayMetricGateEvents(metricEvents);

  return {
    app: deployFixture.referenceApp.id,
    service: "web",
    strategy: "canary",
    status: deployment.status,
    seededRegressionAtWeight: scenario.injectRegressionAtWeight,
    rolledBack: deployment.status === "rolled-back",
    eventSourced: {
      rolloutEvents: rolloutEvents.map((event) => event.type),
      metricDecision: deployment.metricGate?.verdict,
      obligationOpen: obligationReplay.openObligations.length > 0,
      rollbackObligation: metricEvents.find((event) => event.type === "policy.ObligationCreated"),
    },
    gatewayState: deployment.gatewayState,
    events: deployment.events,
  };
}

function createHealthSignalProvider({ scenario, serviceConfig }) {
  let snapshotIndex = 0;
  let lastMetricGate = null;
  const metricEvents = [];
  const windowSamples = [];
  const sloId = `${serviceConfig.routeId}-availability`;
  const policy = {
    analysisWindow: "5m",
    holdBurnRate: 1,
    rollbackBurnRate: 4,
    minRemainingBudgetRatio: 0.08,
    holdRemainingBudgetRatio: 0.2,
    sustainedBreachCount: 1,
    sustainedHealthyCount: 1,
  };

  return {
    metricEvents: () => metricEvents,
    lastMetricGate: () => lastMetricGate,
    async evaluateGate({ step, stepIndex }) {
      const providerHealth = scenario.providerHealth ?? "healthy";
      const dataPlaneHealth = scenario.dataPlaneHealth ?? "healthy";

      if (providerHealth === "unhealthy" || dataPlaneHealth === "unhealthy") {
        return {
          decision: "fail",
          reason: providerHealth === "unhealthy" ? "provider-health-unhealthy" : "data-plane-unhealthy",
          signals: { providerHealth, dataPlaneHealth },
        };
      }

      const snapshot = scenario.sloSnapshots?.[Math.min(snapshotIndex, scenario.sloSnapshots.length - 1)];
      snapshotIndex += 1;

      const sloSample = toSloSample(snapshot, sloId, stepIndex);
      windowSamples.push(sloSample);

      const metricGate = evaluateRolloutMetricGate({
        rollout: {
          rolloutId: `rollout-${serviceConfig.routeId}`,
          stepId: step.name,
          routeId: serviceConfig.routeId,
          fromVersion: serviceConfig.fromVersion,
          toVersion: serviceConfig.toVersion,
          tenant: "yard-demo",
        },
        policy,
        sloSnapshot: sloSample,
        windowSamples: [...windowSamples],
        goldenSuite: {
          suiteId: `${serviceConfig.routeId}-golden`,
          status: scenario.goldenSuite?.status ?? "passed",
          failures: scenario.goldenSuite?.failures ?? [],
          runId: scenario.goldenSuite?.runId,
        },
        now: sloSample.observedAt,
      });

      lastMetricGate = metricGate;
      metricEvents.push(...metricGate.events);

      if (metricGate.verdict === "rollback") {
        return metricGate.gateSignal;
      }

      if (metricGate.verdict === "hold") {
        return {
          decision: "fail",
          reason: metricGate.reason ?? "metric-gate-hold",
          signals: metricGate.gateSignal.signals,
        };
      }

      return metricGate.gateSignal;
    },
  };
}

function toSloSample(snapshot, sloId, stepIndex) {
  const observedAt = `2026-07-02T10:${String(stepIndex).padStart(2, "0")}:00.000Z`;

  if (!snapshot) {
    return {
      sloId,
      seq: stepIndex + 1,
      status: "available",
      burnRate: 0.2,
      remainingBudgetRatio: 0.9,
      observedAt,
    };
  }

  if (snapshot.verdict === "rollback") {
    return {
      sloId,
      seq: snapshot.seq,
      status: "available",
      burnRate: snapshot.burnRate ?? 14,
      remainingBudgetRatio: 0.04,
      observedAt,
    };
  }

  return {
    sloId,
    seq: snapshot.seq,
    status: "available",
    burnRate: snapshot.burnRate ?? 0.3,
    remainingBudgetRatio: 0.85,
    observedAt,
  };
}

function createMockGateway(serviceConfig) {
  const state = {
    routeId: serviceConfig.routeId,
    activeVersion: serviceConfig.fromVersion,
    split: {
      [serviceConfig.fromVersion]: 100,
      [serviceConfig.toVersion]: 0,
    },
  };

  return {
    state,
    commands: [],
    async apply(command) {
      this.commands.push(command);

      if (command.kind === "gateway.shiftTraffic") {
        state.routeId = command.routeId;
        state.activeVersion = command.toWeight === 100 ? command.toVersion : command.fromVersion;
        state.split = {
          [command.fromVersion]: 100 - command.toWeight,
          [command.toVersion]: command.toWeight,
        };
        return { status: "applied", state: { ...state, split: { ...state.split } } };
      }

      if (command.kind === "gateway.rollbackTraffic") {
        state.routeId = command.routeId;
        state.activeVersion = command.restoredVersion;
        state.split = {
          [command.restoredVersion]: command.restoredWeight,
          [command.revertedVersion]: 0,
        };
        return { status: "applied", state: { ...state, split: { ...state.split } } };
      }

      if (command.kind === "gateway.flipRoute") {
        state.routeId = command.routeId;
        state.activeVersion = command.toVersion;
        state.retainedVersion = command.fromVersion;
        state.split = {
          [command.fromVersion]: 0,
          [command.toVersion]: 100,
        };
        return { status: "applied", state: { ...state, split: { ...state.split } } };
      }

      if (command.kind === "deployment.prepareGreen") {
        state.preparedVersion = command.toVersion;
        return { status: "applied", state: { ...state } };
      }

      if (command.kind === "deployment.retainBlue") {
        state.retainedVersion = command.retainedVersion;
        state.reapAfter = command.reapAfter;
        return { status: "applied", state: { ...state } };
      }

      if (command.kind === "deployment.stopVersion" || command.kind === "deployment.startVersion") {
        return { status: "applied", state: { ...state } };
      }

      throw new Error(`unexpected gateway command ${command.kind}`);
    },
  };
}

function defaultClock() {
  let tick = 0;
  return () => `2026-07-02T10:${String(tick++).padStart(2, "0")}:00.000Z`;
}
