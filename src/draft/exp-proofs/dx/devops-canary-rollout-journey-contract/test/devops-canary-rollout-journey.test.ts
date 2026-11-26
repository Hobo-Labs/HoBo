import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  DEVOPS_CANARY_ROLLOUT_JOURNEY_VERSION,
  reconstructRolloutState,
  runAbortedRolloutScenario,
  runFlappingSloScenario,
  runHealthyCanaryJourney,
  runSloBurnRollbackJourney,
  runUnhealthyFirstStepScenario,
} from "../src/devops-canary-rollout-journey.js";

describe("DevOps canary rollout journey contract", () => {
  it("runs hobo up --strategy canary through 10/50/100 with health checks, inspect, logs, and audit events", async () => {
    const result = await runHealthyCanaryJourney({
      targetRevision: "sha-good-20260628",
    });

    assert.equal(result.contractVersion, DEVOPS_CANARY_ROLLOUT_JOURNEY_VERSION);
    assert.equal(result.command, "hobo up --camp prod --strategy canary --to sha-good-20260628");
    assert.deepEqual(result.declaredRollout, {
      source: "delivery/rollout.ts",
      expression: 'rollout("api", { strategy: "canary", steps: ["10%", "50%", "100%"], rollbackOn: "slo:checkout.latency" })',
      strategy: "canary",
      steps: ["10%", "50%", "100%"],
      rollbackOn: "slo:checkout.latency",
    });

    assert.equal(result.up.status, "deployed");
    assert.equal(result.rollout.status.state, "promoted");
    assert.deepEqual(result.rollout.trafficSteps, [10, 50, 100]);
    assert.deepEqual(result.rollout.healthChecks.map((check) => check.step), [10, 50, 100]);
    assert.deepEqual(result.rollout.healthChecks.map((check) => check.decision), ["pass", "pass", "pass"]);
    assert.equal(result.rollout.gatewayState.activeVersion, "checkout@sha256:green");
    assert.deepEqual(result.rollout.gatewayState.split, {
      "checkout@sha256:blue": 0,
      "checkout@sha256:green": 100,
    });

    assert.equal(result.promotionGate.verdict, "promote");
    assert.equal(result.promotionGate.sameGateAsDeploy, true);
    assert.equal(result.inspect.exitCode, 0);
    assert.equal(result.inspect.view.status, "completed");
    assert.deepEqual(
      result.inspect.view.steps.map((step) => step.name),
      [
        "shift-canary-10",
        "health-canary-10",
        "shift-canary-50",
        "health-canary-50",
        "shift-canary-100",
        "health-canary-100",
      ],
    );
    assert.deepEqual(result.logs.map((line) => line.message), [
      "rollout canary-10 shifted traffic to 10%",
      "rollout canary-10 health pass: within-slo-budget",
      "rollout canary-50 shifted traffic to 50%",
      "rollout canary-50 health pass: within-slo-budget",
      "rollout canary-100 shifted traffic to 100%",
      "rollout canary-100 health pass: within-slo-budget",
      "rollout promoted checkout@sha256:green",
    ]);
    assert.ok(result.audit.events.every((event) => event.runId === "run_checkout_canary"));
    assert.equal(result.scopeOut.flagExperimentHarnessImplemented, false);
    assert.equal(result.scopeOut.sloMetricPipelineImplemented, false);
    assert.equal(result.scopeOut.rolloutControllerInternalsImplemented, false);
  });

  it("auto-rolls back to the exact prior revision on a guardrail SLO burn without human action", async () => {
    const result = await runSloBurnRollbackJourney({
      burnAtPercent: 50,
      fromRevision: "checkout@sha256:blue",
      targetRevision: "checkout@sha256:green",
    });

    assert.equal(result.command, "hobo up --camp prod --strategy canary --to checkout@sha256:green");
    assert.equal(result.rollout.status.state, "rolled-back");
    assert.equal(result.rollback.trigger, "slo-burn-rate-rollback-threshold");
    assert.equal(result.rollback.humanActionRequired, false);
    assert.equal(result.rollback.targetRevision, "checkout@sha256:blue");
    assert.deepEqual(result.rollback.gatewayState.split, {
      "checkout@sha256:blue": 100,
      "checkout@sha256:green": 0,
    });
    assert.equal(result.rollback.strandedTraffic, false);
    assert.deepEqual(result.rollout.trafficSteps, [10, 50]);
    assert.deepEqual(result.rollout.healthChecks.map((check) => check.decision), ["pass", "fail"]);
    assert.equal(result.inspect.view.partial, false);
    assert.ok(result.logs.some((line) => line.message === "rollout rolled back checkout@sha256:green to checkout@sha256:blue"));
  });

  it("uses hysteresis so a flapping SLO window does not thrash rollout state", async () => {
    const result = await runFlappingSloScenario();

    assert.equal(result.rollout.status.state, "rolled-back");
    assert.equal(result.hysteresis.minConsecutiveSamples, 2);
    assert.equal(result.hysteresis.minDwellSeconds, 120);
    assert.equal(result.hysteresis.rollbackCommands, 1);
    assert.equal(result.hysteresis.promoteCommands, 0);
    assert.deepEqual(result.gatewayCommands.map((command) => command.kind), [
      "gateway.shiftTraffic",
      "gateway.rollbackTraffic",
    ]);
    assert.equal(result.rollout.status.rollbackReason, "health-hysteresis-timeout");
  });

  it("aborts cleanly without half-promoting and can reconstruct state from the event log", async () => {
    const result = await runAbortedRolloutScenario({ abortAtPercent: 50 });

    assert.equal(result.rollout.status.state, "rolled-back");
    assert.equal(result.halfPromoted, false);
    assert.equal(result.rollback.targetRevision, "checkout@sha256:blue");
    assert.deepEqual(result.rollout.trafficSteps, [10, 50]);
    assert.deepEqual(result.reconstructed.gatewayState, result.rollback.gatewayState);
    assert.equal(result.reconstructed.status.state, "rolled-back");
    assert.equal(result.inspect.exitCode, 0);
  });

  it("fails fast when the first canary step cannot get healthy", async () => {
    const result = await runUnhealthyFirstStepScenario();

    assert.equal(result.rollout.status.state, "rolled-back");
    assert.deepEqual(result.rollout.trafficSteps, [10]);
    assert.deepEqual(result.gatewayCommands.map((command) => command.kind), [
      "gateway.shiftTraffic",
      "gateway.rollbackTraffic",
    ]);
    assert.ok(!result.rollout.trafficSteps.includes(50));
    assert.ok(!result.rollout.trafficSteps.includes(100));
    assert.equal(result.rollout.status.rollbackReason, "health-hysteresis-fail");
  });

  it("reconstructs promoted rollout state from auditable events only", async () => {
    const result = await runHealthyCanaryJourney();
    const reconstructed = reconstructRolloutState(result.audit.events);

    assert.deepEqual(reconstructed.status, result.rollout.status);
    assert.deepEqual(reconstructed.gatewayState, result.rollout.gatewayState);
    assert.deepEqual(reconstructed.trafficSteps, [10, 50, 100]);
  });
});
