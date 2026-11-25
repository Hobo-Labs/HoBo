/**
 * Executable step definitions for s2-stage-gate-first-cloud-yard.feature.
 *
 * Drives the epic's real drill module (src/s2-stage-gate-drill.ts): governed
 * deploy, Yard restart/resume under NFR-009, saga compensation ordering,
 * Gatekeeper block, and the composed five-arm drill. All boundaries are
 * mocked in the module itself — no live Cloudflare, Yard, or event store.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import {
  createS2StageGateDrillContract,
  NFR_009_RESUME_BUDGET_MS,
  runStageGateDrill,
  S2StageGateError,
  simulateCompensationRollback,
  simulateGatekeeperBlock,
  simulateGovernedDeploy,
  simulateYardRestartResume,
  validateS2StageGateDrillContract,
  type StageGateEvent,
} from "../../src/s2-stage-gate-drill.js";

type S2World = {
  contract?: ReturnType<typeof createS2StageGateDrillContract>;
  deploy?: ReturnType<typeof simulateGovernedDeploy>;
  killedLog?: StageGateEvent[];
  resume?: ReturnType<typeof simulateYardRestartResume>;
  failAtResource?: string;
  compensation?: ReturnType<typeof simulateCompensationRollback>;
  gatekeeper?: ReturnType<typeof simulateGatekeeperBlock>;
};

const world: S2World = {};

// --- Scenario: Governed deploy lands hello-bindle and serves traffic ---------

Given("the pinned S2 hello-bindle stage-gate drill contract", () => {
  world.contract = createS2StageGateDrillContract();
  const validation = validateS2StageGateDrillContract(world.contract);
  assert.equal(validation.passed, true, "the pinned drill contract validates");
  assert.equal(world.contract.resumeBudgetMs, NFR_009_RESUME_BUDGET_MS);
});

When("the governed hello-bindle deploy runs through the Gatekeeper", () => {
  world.deploy = simulateGovernedDeploy();
});

Then("hello-bindle serves live traffic at the drill's sandbox URL", () => {
  const deploy = world.deploy;
  assert.ok(deploy, "governed deploy must have run");
  assert.equal(deploy.status, "passed");
  assert.equal(deploy.trafficServed, true);
  assert.equal(deploy.liveUrl, "https://hello-bindle.sandbox.hobo.dev");
  assert.ok(
    deploy.events.some((event) => event.type === "policy.Decided"),
    "the deploy passes through a Gatekeeper policy decision",
  );
  assert.ok(
    deploy.events.some((event) => event.type === "deployment.TrafficReady"),
    "the deploy records deployment.TrafficReady",
  );
});

Then("the full five-arm S2 stage-gate drill closes green", () => {
  assert.ok(world.contract, "the drill contract must be given");
  const report = runStageGateDrill(world.contract);
  assert.equal(report.status, "passed");
  assert.deepEqual(Object.keys(report.arms).sort(), [
    "compensationRollback",
    "gatekeeperBlock",
    "governedDeploy",
    "timelineProjection",
    "yardRestartResume",
  ]);
  assert.equal(report.evidencePath, "docs/design/stage-2-first-cloud-yard-acceptance.md");
});

// --- Scenario: Yard killed mid-deploy resumes within the NFR-009 budget ------

Given("a hello-bindle deploy event log with the Yard killed mid-deploy", () => {
  world.killedLog = [
    { type: "deployment.DeployStarted", atMs: 0, payload: { fixture: "examples/hello-bindle" } },
    { type: "deployment.ResourceRealizing", atMs: 100, payload: { resource: "kv.hello-cache" } },
  ];
});

When("the Yard resumes the deploy from the append-only event log", () => {
  world.resume = simulateYardRestartResume({ eventLog: world.killedLog });
});

Then("the hello-bindle resume completes within the 30 second NFR-009 budget", () => {
  const resume = world.resume;
  assert.ok(resume, "the resume drill must have run");
  assert.equal(resume.status, "passed");
  assert.equal(resume.replayedFromLog, true);
  assert.equal(resume.withinBudget, true);
  assert.ok(
    resume.resumeMs <= NFR_009_RESUME_BUDGET_MS,
    `resume took ${resume.resumeMs}ms; NFR-009 budget is ${NFR_009_RESUME_BUDGET_MS}ms`,
  );
  assert.ok(
    resume.events.some((event) => event.type === "yard.ResumedFromEventLog"),
    "resume replays from the append-only event log",
  );
  assert.ok(
    resume.events.some((event) => event.type === "deployment.DeployCompleted"),
    "the resumed deploy completes",
  );
});

// --- Scenario: Seeded provisioning failure compensates in reverse order ------

Given("a seeded provisioning failure at resource {string}", (resource: string) => {
  world.failAtResource = resource;
});

When("the hello-bindle deployment saga compensates the failure", () => {
  world.compensation = simulateCompensationRollback({
    failAtResource: world.failAtResource,
  });
});

Then("realized hello-bindle resources are destroyed in reverse-dependency order", () => {
  const compensation = world.compensation;
  assert.ok(compensation, "compensation must have run");
  assert.equal(compensation.status, "compensated");
  assert.equal(compensation.reverseDependency, true);
  assert.deepEqual(
    compensation.compensationOrder,
    ["kv.hello-cache", "objectStore.hello-bucket"],
    "compensation reverses the objectStore -> kv realization order",
  );
  const compensated = compensation.events
    .filter((event) => event.type === "saga.Compensated")
    .map((event) => event.payload?.resource);
  assert.deepEqual(compensated, compensation.compensationOrder);
});

// --- Scenario: Gatekeeper blocks an unsafe promotion -------------------------

Given("an unsafe hello-bindle Delta promotion with consumer-producer skew", () => {
  world.gatekeeper = undefined;
});

When("the S2 Gatekeeper evaluates the unsafe promotion", () => {
  world.gatekeeper = simulateGatekeeperBlock({ reason: "compat" });
});

Then("the unsafe promotion is blocked with an event-sourced explainable reason", () => {
  const gatekeeper = world.gatekeeper;
  assert.ok(gatekeeper, "the Gatekeeper drill must have run");
  assert.equal(gatekeeper.status, "blocked");
  assert.equal(gatekeeper.blocked, true);
  assert.equal(
    gatekeeper.explainableReason,
    "consumer-producer skew blocks Delta→Set promotion",
  );
  assert.ok(
    gatekeeper.events.some(
      (event) => event.type === "compat.GateFailed" && event.payload?.explainable === true,
    ),
    "the block carries explainable compat.GateFailed evidence",
  );
});

Then(
  "a hello-bindle deploy that bypasses the Gatekeeper is rejected with code {string}",
  (code: string) => {
    let thrown: unknown;
    try {
      simulateGovernedDeploy({ skipGatekeeper: true });
    } catch (error) {
      thrown = error;
    }
    assert.ok(thrown instanceof S2StageGateError, "bypass must throw the typed drill error");
    assert.equal(thrown.code, code);
  },
);
