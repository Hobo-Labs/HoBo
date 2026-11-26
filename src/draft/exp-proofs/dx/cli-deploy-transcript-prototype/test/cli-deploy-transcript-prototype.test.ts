import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CLI_DEPLOY_TRANSCRIPT_PROTOTYPE,
  REQUIRED_BLOCKED_REASONS,
  REQUIRED_FIXTURE_KINDS,
  evaluateCliDeployTranscriptPrototype,
  renderCliTranscript,
  renderMcpToolResult,
  rejectDeployTranscriptScopeCreep,
} from "../src/cli-deploy-transcript-prototype.js";

test("transcript covers one successful deploy and the required blocked deploys", () => {
  const result = evaluateCliDeployTranscriptPrototype(CLI_DEPLOY_TRANSCRIPT_PROTOTYPE);
  const transcript = renderCliTranscript(CLI_DEPLOY_TRANSCRIPT_PROTOTYPE);

  assert.deepEqual(result.errors, []);
  assert.equal(result.accepted.successfulDeploys, 1);
  assert.deepEqual(result.accepted.blockedReasons, REQUIRED_BLOCKED_REASONS);
  assert.match(transcript, /hobo collect --camp preview/);
  assert.match(transcript, /hobo plan --camp preview --json/);
  assert.match(transcript, /hobo up --camp preview/);
  assert.match(transcript, /Gatekeeper explanation:/);
  assert.match(transcript, /approval\/refusal: approved/);
  assert.match(transcript, /blocked: policy denied/);
  assert.match(transcript, /blocked: contract incompatible/);
  assert.match(transcript, /blocked: stale or unknown evidence/);
  assert.match(transcript, /Value proof:/);
});

test("each scenario consumes the M1 fixture corpus surface", () => {
  for (const scenario of CLI_DEPLOY_TRANSCRIPT_PROTOTYPE.scenarios) {
    assert.deepEqual(
      scenario.fixtures.map((fixture) => fixture.kind),
      REQUIRED_FIXTURE_KINDS,
      scenario.id,
    );
    assert.equal(scenario.proofMode, "reference fixture");
  }
});

test("MCP tool results are semantically equivalent to CLI transcript cases", () => {
  for (const scenario of CLI_DEPLOY_TRANSCRIPT_PROTOTYPE.scenarios) {
    const toolResult = renderMcpToolResult(scenario);

    assert.equal(toolResult.operation, "hobo.up");
    assert.equal(toolResult.status, scenario.outcome);
    assert.equal(toolResult.reason, scenario.reason ?? "deployed");
    assert.equal(toolResult.planId, scenario.deploymentPlanId);
    assert.equal(toolResult.deploymentSetId, scenario.deploymentSetId);
    assert.equal(toolResult.deltaId, scenario.deltaId);
    assert.equal(toolResult.gatekeeperDecisionId, scenario.gatekeeperDecisionId);
    assert.equal(toolResult.gatekeeperExplanation, scenario.gatekeeperExplanation);
    assert.equal(toolResult.valueProof, scenario.valueProof);
    assert.deepEqual(
      toolResult.fixtureIds,
      scenario.fixtures.map((fixture) => fixture.id),
    );
  }
});

test("support wording, accessibility notes, and proof-mode labels are present", () => {
  for (const scenario of CLI_DEPLOY_TRANSCRIPT_PROTOTYPE.scenarios) {
    assert.match(scenario.gatekeeperExplanation, /Gatekeeper.*(approved|refused|hold|held)/i, scenario.id);
    assert.match(scenario.valueProof, /Value proof:/, scenario.id);
    assert.match(scenario.supportWording, /support|ticket|customer-safe|operator/i, scenario.id);
    assert.match(scenario.accessibilityNote, /plain text|screen reader|non-color|stable/i, scenario.id);
    assert.ok(["reference fixture", "simulated", "live", "scope-out"].includes(scenario.proofMode));
  }
});

test("scope guard rejects production deploy, live-provider, account, launch-claim, and dashboard creep", () => {
  const denials = rejectDeployTranscriptScopeCreep([
    "Implement production hobo up against AWS now.",
    "Call a live provider to get realistic outputs.",
    "Use real account login and credentials for the happy path.",
    "Publish final launch demo claims from this transcript.",
    "Replace the terminal flow with a dashboard tour.",
  ]);

  assert.equal(denials.length, 5);
  assert.equal(denials.every((denial) => denial.decision === "reject"), true);
});

test("validation fails closed when acceptance or adversarial evidence drifts", () => {
  const invalid = structuredClone(CLI_DEPLOY_TRANSCRIPT_PROTOTYPE);
  invalid.scenarios = invalid.scenarios.filter((scenario) => scenario.outcome !== "deployed");
  invalid.scenarios[0].fixtures = invalid.scenarios[0].fixtures.filter(
    (fixture) => fixture.kind !== "gatekeeper-decision",
  );
  invalid.scenarios[1].mcpEquivalent = false;
  invalid.scenarios[2].proofMode = "live";
  invalid.scenarios[2].valueProof = "no proof phrasing";

  const result = evaluateCliDeployTranscriptPrototype(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /exactly one successful deploy/);
  assert.match(result.errors.join("\n"), /missing fixture kind: gatekeeper-decision/);
  assert.match(result.errors.join("\n"), /MCP tool result must be equivalent/);
  assert.match(result.errors.join("\n"), /live proof mode is out of scope/);
  assert.match(result.errors.join("\n"), /value proof is required/);
});
