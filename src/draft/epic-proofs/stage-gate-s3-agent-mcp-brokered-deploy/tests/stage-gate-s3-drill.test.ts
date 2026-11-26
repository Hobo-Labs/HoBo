import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  EPIC_REFERENCE,
  runStageGateS3Drill,
} from "../services/stage-gate-s3-drill.js";

test("stage gate S3 drill pins HOBO-636 J2 journey against hello-bindle", async () => {
  const result = await runStageGateS3Drill();

  assert.equal(result.epic.issueId, EPIC_REFERENCE.issueId);
  assert.equal(result.epic.fixture, "examples/hello-bindle");
  assert.deepEqual(result.contracts.missing, []);
  assert.equal(result.workspace.mockedOnly, true);
  assert.equal(result.workspace.liveExternalCalls, 0);
});

test("J2 MCP path uses brokered tokens and emits token audit events", async () => {
  const result = await runStageGateS3Drill();

  for (const tool of ["list_templates", "new", "plan", "request_token"]) {
    assert.ok(
      result.scenarios.journey.some((step) => step.tool === tool && step.ok),
      `expected J2 journey step ${tool} to succeed`,
    );
  }
  assert.ok(result.scenarios.tokenEvents.includes("token.Granted"));
  assert.ok(result.scenarios.tokenEvents.includes("token.Used"));
  assert.equal(result.scenarios.traceScan.brokeredOnly, true);
  assert.equal(result.scenarios.traceScan.staticSecretsFound, false);
});

test("NFR-017 failure is machine-readable and self-correction redeploys", async () => {
  const result = await runStageGateS3Drill();

  assert.equal(result.scenarios.failedDeploy.ok, false);
  assert.equal(result.scenarios.failedDeploy.data.explainFailure.machineReadable, true);
  assert.deepEqual(
    result.scenarios.selfCorrection.followedSteps,
    ["verify", "deploy"],
  );
  assert.equal(result.scenarios.selfCorrection.deploy.ok, true);
  assert.equal(result.scenarios.inspect.ok, true);
  assert.equal(result.scenarios.logs.ok, true);
});

test("adversarial cases fail closed on over-broad tokens, static keys, and prod approval", async () => {
  const result = await runStageGateS3Drill();

  assert.equal(result.scenarios.overBroadToken.ok, false);
  assert.equal(result.scenarios.overBroadToken.error.code, "MCP_SCOPE_DENIED");
  assert.equal(result.scenarios.staticSecretAttempt.status, "rejected");
  assert.equal(result.scenarios.prodDeployBlocked.decision.effect, "require-approval");
  assert.equal(result.scenarios.prodDeployApproved.ok, true);
  assert.equal(result.scenarios.replay.replayable, true);
});

test("architecture artifacts pin protobuf, CUE, Pact, and event-architecture evidence", () => {
  const architecture = readFileSync(new URL("../architecture.md", import.meta.url), "utf8");
  const proto = readFileSync(
    new URL("../architecture/stage_gate_s3_agent_mcp_brokered_deploy.proto", import.meta.url),
    "utf8",
  );
  const cue = readFileSync(
    new URL("../architecture/stage_gate_s3_agent_mcp_brokered_deploy.cue", import.meta.url),
    "utf8",
  );
  const pact = JSON.parse(
    readFileSync(new URL("../contracts/pacts/j2-mcp-journey.pact.json", import.meta.url), "utf8"),
  );

  assert.match(proto, /message StageGateS3DrillRecord/);
  assert.match(cue, /#StageGateS3DrillRecord:/);
  assert.equal(pact.consumer.name, "stage-gate-j2-agent");
  assert.equal(pact.provider.name, "hobo-mcp-s2-sandbox");
  assert.ok(pact.interactions.some((interaction) => interaction.request.tool === "deploy"));
  assert.match(architecture, /parse, don't validate/i);
  assert.match(architecture, /Command/i);
  assert.match(architecture, /Event/i);
  assert.match(architecture, /Actor/i);
  assert.match(architecture, /event store/i);
  assert.match(architecture, /projection/i);
  assert.match(architecture, /read store/i);
});
