import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

import {
  EPIC_REFERENCE,
  runCliMcpDeveloperExperienceReference,
} from "../services/cli-mcp-reference.js";

test("reference implementation selects only the CLI/MCP developer experience epic", async () => {
  const result = await runWithWorkspace();

  assert.equal(result.epic.epicId, EPIC_REFERENCE.epicId);
  assert.equal(result.epic.slug, "cli-mcp-developer-experience");
  assert.deepEqual(result.contracts.missing, []);
  assert.equal(result.workspace.mockedOnly, true);
  assert.equal(result.workspace.liveExternalCalls, 0);
});

test("CLI commands and MCP tools stay parity-checked", async () => {
  const result = await runWithWorkspace();

  assert.equal(result.commandSurface.parity.ok, true);
  assert.deepEqual(result.commandSurface.missingRequiredCommands, []);
  assert.equal(result.scenarios.manifests.validation.ok, true);
  assert.ok(result.scenarios.manifests.sampleRoutes.every(Boolean));
});

test("app developer path runs deterministic local-to-Camp simulation", async () => {
  const result = await runWithWorkspace();
  const app = result.scenarios.appDeveloper;

  assert.equal(app.deterministicSnapshot.up.status, "deployed");
  assert.deepEqual(app.deterministicSnapshot.cloudSpecificCodeMatches, []);
  assert.equal(app.deterministicSnapshot.dev.replayDiff.status, "unchanged");
  assert.equal(result.scenarios.blockedDeploy.status, "blocked");
  assert.equal(result.scenarios.blockedDeploy.applied, false);
  assert.equal(result.scenarios.doctor.ok, true);
});

test("MCP and credential boundaries fail closed on missing scope or static keys", async () => {
  const result = await runWithWorkspace();

  assert.equal(result.scenarios.mcp.plan.ok, true);
  assert.equal(result.scenarios.mcp.deniedDeploy.ok, false);
  assert.equal(result.scenarios.mcp.deniedDeploy.error.code, "MCP_SCOPE_DENIED");
  assert.equal(result.scenarios.credentials.staticKey.status, "rejected");
  assert.equal(result.scenarios.credentials.deniedAfterRevoke.status, "denied");
  assert.match(result.scenarios.credentials.failureReport.crashDump, /<redacted/);
});

test("fidelity, policy, and role journeys preserve adversarial evidence", async () => {
  const result = await runWithWorkspace();

  assert.equal(result.scenarios.fidelity.catalog.status, "pass");
  assert.equal(result.scenarios.fidelity.prodReady.status, "blocked");
  assert.equal(result.scenarios.fidelity.replay.status, "pass");
  assert.equal(result.scenarios.mcpHardening.deniedToken.ok, false);
  assert.equal(result.scenarios.mcpHardening.destructive.executed, false);
  assert.equal(result.scenarios.secops.decision.effect, "deny");
  assert.equal(result.scenarios.secops.replay.effect, "deny");
  assert.deepEqual(result.scenarios.secops.secretLeakFindings, []);
  assert.equal(result.scenarios.gitops.readOnlyPlan, true);
  assert.equal(result.scenarios.canDeploySkew.applied, false);
  assert.equal(result.scenarios.sre.replay.drift.detected, true);
  assert.equal(result.scenarios.canary.status.state, "promoted");
  assert.equal(result.scenarios.canaryRollback.status.state, "rolled-back");
});

async function runWithWorkspace() {
  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "hobo-cli-mcp-reference-test-"));
  try {
    return await runCliMcpDeveloperExperienceReference({ workspaceRoot });
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
