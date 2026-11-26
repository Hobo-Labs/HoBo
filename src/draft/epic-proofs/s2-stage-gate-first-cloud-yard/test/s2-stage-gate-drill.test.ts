import assert from "node:assert/strict";
import { test } from "vitest";

import {
  HELLO_BINDLE_FIXTURE,
  NFR_009_RESUME_BUDGET_MS,
  S2StageGateError,
  assertStageGateDrill,
  assertTimelineMonotonic,
  createS2StageGateDrillContract,
  reconstructDeploymentTimeline,
  runStageGateDrill,
  simulateCompensationRollback,
  simulateGatekeeperBlock,
  simulateGovernedDeploy,
  simulateYardRestartResume,
  validateS2StageGateDrillContract,
} from "../src/s2-stage-gate-drill.js";

test("governed deploy lands hello-bindle on Cloudflare and serves traffic", () => {
  const result = simulateGovernedDeploy({
    liveUrl: "https://hello-bindle.run-42.sandbox.hobo.dev",
  });

  assert.equal(result.status, "passed");
  assert.equal(result.trafficServed, true);
  assert.equal(result.liveUrl, "https://hello-bindle.run-42.sandbox.hobo.dev");
  assert.deepEqual(
    result.events.map((event) => event.type),
    [
      "policy.Decided",
      "deployment.PlanAccepted",
      "exec.Started",
      "deployment.ResourceRealized",
      "deployment.TrafficReady",
    ],
  );
  assert.equal(result.events[0]?.payload?.decision, "allow");
});

test("Yard killed mid-deploy resumes from event log within NFR-009 budget", () => {
  const result = simulateYardRestartResume({ resumeDelayMs: 4_000 });

  assert.equal(result.status, "passed");
  assert.equal(result.withinBudget, true);
  assert.ok(result.resumeMs <= NFR_009_RESUME_BUDGET_MS);
  assert.equal(result.replayedFromLog, true);
  assert.ok(result.events.some((event) => event.type === "yard.ProcessTerminated"));
  assert.ok(result.events.some((event) => event.type === "yard.ResumedFromEventLog"));
  assert.ok(result.events.some((event) => event.type === "deployment.DeployCompleted"));
});

test("seeded provisioning failure compensates in reverse-dependency order", () => {
  const result = simulateCompensationRollback();

  assert.equal(result.status, "compensated");
  assert.equal(result.reverseDependency, true);
  assert.deepEqual(result.compensationOrder, [
    "kv.hello-cache",
    "objectStore.hello-bucket",
  ]);
  assert.deepEqual(
    result.events.filter((event) => event.type === "saga.Compensated").map((event) => event.payload?.resource),
    ["kv.hello-cache", "objectStore.hello-bucket"],
  );
});

test("Gatekeeper blocks unsafe change with explainable event-sourced reason", () => {
  const compat = simulateGatekeeperBlock({ reason: "compat" });
  assert.equal(compat.status, "blocked");
  assert.equal(compat.blocked, true);
  assert.match(compat.explainableReason, /skew/i);

  const policy = simulateGatekeeperBlock({ reason: "policy" });
  assert.equal(policy.status, "blocked");
  assert.match(policy.explainableReason, /approval/i);
});

test("deployment timeline projection reconstructs the full run", () => {
  const deploy = simulateGovernedDeploy();
  const resume = simulateYardRestartResume({ eventLog: deploy.events });
  const timeline = reconstructDeploymentTimeline(resume.events);

  assert.equal(timeline.status, "reconstructed");
  assert.ok(timeline.eventCount > 0);
  assert.equal(timeline.coversFullRun, true);
  assert.ok(timeline.timeline.every((entry, index, all) => index === 0 || entry.atMs >= all[index - 1]!.atMs));
});

test("stage gate drill contract pins hello-bindle fixture and acceptance record", () => {
  const contract = createS2StageGateDrillContract();
  const report = validateS2StageGateDrillContract(contract);

  assert.equal(report.passed, true);
  assert.equal(contract.fixture, HELLO_BINDLE_FIXTURE);
  assert.equal(contract.resumeBudgetMs, NFR_009_RESUME_BUDGET_MS);
  assert.match(contract.acceptanceRecord, /stage-2-first-cloud-yard/);
});

test("runStageGateDrill passes all five gate arms", () => {
  const report = assertStageGateDrill(runStageGateDrill());

  assert.equal(report.status, "passed");
  assert.equal(report.arms.governedDeploy?.status, "passed");
  assert.equal(report.arms.yardRestartResume?.status, "passed");
  assert.equal(report.arms.compensationRollback?.status, "compensated");
  assert.equal(report.arms.gatekeeperBlock?.status, "blocked");
  assert.equal(report.arms.timelineProjection?.status, "reconstructed");
});

test("adversarial: deploy without Gatekeeper is rejected", () => {
  assert.throws(
    () => simulateGovernedDeploy({ skipGatekeeper: true }),
    (error: Error) => error instanceof S2StageGateError && error.code === "gatekeeper.bypassed",
  );
});

test("adversarial: resume exceeding NFR-009 budget fails closed", () => {
  assert.throws(
    () => simulateYardRestartResume({ resumeDelayMs: NFR_009_RESUME_BUDGET_MS + 1 }),
    (error: Error) => error instanceof S2StageGateError && error.code === "resume.budget-exceeded",
  );
});

test("adversarial: wrong compensation order fails closed", () => {
  assert.throws(
    () =>
      simulateCompensationRollback({
        compensationOrder: ["objectStore.hello-bucket", "kv.hello-cache"],
      }),
    (error: Error) => error instanceof S2StageGateError && error.code === "compensation.order-wrong",
  );
});

test("adversarial: timeline with temporal gap fails closed", () => {
  const gappedLog = [
    { type: "deployment.DeployStarted", atMs: 500 },
    { type: "deployment.DeployCompleted", atMs: 100 },
  ];

  assert.throws(
    () => assertTimelineMonotonic(gappedLog),
    (error: Error) => error instanceof S2StageGateError && error.code === "timeline.gap",
  );
  assert.throws(
    () => reconstructDeploymentTimeline(gappedLog),
    (error: Error) => error instanceof S2StageGateError && error.code === "timeline.gap",
  );
});
