/**
 * Executable step definitions for stage-gate-s3-agent-mcp-brokered-deploy.feature.
 *
 * Drives the epic's real drill service (services/stage-gate-s3-drill.ts),
 * which composes the MCP server, token broker, guardrail, and credential
 * hardening technical-proof contracts into one offline J2 drill. The drill
 * runs once; every scenario asserts against its recorded outputs.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import { runStageGateS3Drill } from "../../services/stage-gate-s3-drill.js";

type S3Drill = Awaited<ReturnType<typeof runStageGateS3Drill>>;

let drillPromise: Promise<S3Drill> | undefined;
function drill(): Promise<S3Drill> {
  drillPromise ??= runStageGateS3Drill();
  return drillPromise;
}

type S3World = {
  scenarios?: S3Drill["scenarios"];
};

const world: S3World = {};

// --- Scenario: J2 journey completes with brokered tokens only ----------------

Given("the SVID-bound MCP drill session scoped by the agent's allow ceiling", async () => {
  const result = await drill();
  world.scenarios = result.scenarios;
  assert.equal(result.epic.journey, "J2");
  assert.equal(result.workspace.liveExternalCalls, 0, "the drill stays fully mocked");
});

When("Atlas runs the J2 tool journey against hello-bindle on the S2 sandbox", () => {
  const scenarios = world.scenarios;
  assert.ok(scenarios, "the drill must have run");
  for (const tool of ["list_templates", "new", "plan", "request_token"]) {
    assert.ok(
      scenarios.journey.some((step) => step.tool === tool && step.ok),
      `J2 journey step ${tool} must succeed`,
    );
  }
});

Then("every J2 journey tool call succeeds and the deploy self-corrects to done", () => {
  const scenarios = world.scenarios;
  assert.ok(scenarios);
  assert.equal(scenarios.selfCorrection.deploy.ok, true, "the corrected deploy succeeds");
  assert.equal(scenarios.selfCorrection.deploy.data.credentialKind, "brokered-short-lived");
  assert.equal(scenarios.inspect.ok !== false, true, "inspect_run succeeds");
  assert.equal(scenarios.logs.data.complete, true, "tail_logs completes");
});

Then("only brokered short-lived credentials appear in the drill trace", () => {
  const scenarios = world.scenarios;
  assert.ok(scenarios);
  assert.equal(scenarios.traceScan.staticSecretsFound, false);
  assert.equal(scenarios.traceScan.brokeredOnly, true);
  assert.deepEqual(scenarios.traceScan.patterns, [], "no static secret pattern matches");
});

// --- Scenario: Brokered token audit trail is replayable ----------------------

Given("the completed J2 brokered-token drill trace", async () => {
  const result = await drill();
  world.scenarios = result.scenarios;
});

When("the brokered-token event store is replayed", () => {
  assert.ok(world.scenarios?.replay, "the replay projection must exist");
});

Then(
  "token.Granted and token.Used events are present and the replay carries a digest",
  () => {
    const scenarios = world.scenarios;
    assert.ok(scenarios);
    assert.ok(scenarios.tokenEvents.includes("token.Granted"));
    assert.ok(scenarios.tokenEvents.includes("token.Used"));
    assert.equal(scenarios.replay.replayable, true);
    assert.match(scenarios.replay.digest, /^[0-9a-f]{64}$/, "replay digest is a sha256 hex");
  },
);

// --- Scenario: NFR-017 self-correction ---------------------------------------

Given("a hello-bindle deploy gated behind a missing digest pin", async () => {
  const result = await drill();
  world.scenarios = result.scenarios;
  assert.equal(world.scenarios.failedDeploy.data.code, "DEPLOY_GATE_FAILED");
});

When("the first brokered deploy fails with an NFR-017 explainable error", () => {
  const explain = world.scenarios?.selfCorrection.explain;
  assert.ok(explain, "the failure must carry an explainFailure payload");
  assert.equal(explain.machineReadable, true);
  assert.equal(explain.cause, "compat.GateFailed");
});

Then("the machine-readable remediation drives verify then redeploy to success", () => {
  const selfCorrection = world.scenarios?.selfCorrection;
  assert.ok(selfCorrection);
  assert.deepEqual(selfCorrection.followedSteps, ["verify", "deploy"]);
  assert.equal(selfCorrection.verify.ok !== false, true, "the verify step succeeds");
  assert.equal(selfCorrection.deploy.ok, true, "the redeploy succeeds after verify");
});

// --- Scenario: Agent guardrails hold the allow ceiling -----------------------

When("Atlas requests a token outside the allow ceiling and a high-risk prod deploy", () => {
  const scenarios = world.scenarios;
  assert.ok(scenarios, "the drill must have run");
  assert.ok(scenarios.overBroadToken, "the over-broad token attempt is recorded");
  assert.ok(scenarios.prodDeployBlocked, "the prod deploy attempt is recorded");
});

Then("the over-broad token request is refused with code {string}", (code: string) => {
  const overBroad = world.scenarios?.overBroadToken;
  assert.ok(overBroad);
  assert.equal(overBroad.ok, false);
  assert.equal(overBroad.error.code, code);
});

Then("the prod deploy blocks until a human approves", () => {
  const scenarios = world.scenarios;
  assert.ok(scenarios);
  assert.equal(scenarios.prodDeployBlocked.decision.effect, "require-approval");
  assert.equal(scenarios.prodDeployApproved.ok, true, "the approval hook resolves the block");
});

Then("a static cloud key offered to the drill is rejected", () => {
  assert.equal(world.scenarios?.staticSecretAttempt.status, "rejected");
});
