import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import { runStageGateS3Drill } from "../../services/stage-gate-s3-drill.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pactRoot = path.resolve(__dirname, "../pacts");

test("consumer pact fixtures match stage gate S3 boundary coverage", async () => {
  const result = await runStageGateS3Drill();
  const pactFiles = [
    "j2-mcp-journey.pact.json",
    "brokered-token-audit.pact.json",
    "agent-guardrail-gate.pact.json",
    "credential-audit-retention.pact.json",
  ];
  const pacts = await Promise.all(
    pactFiles.map(async (file) => JSON.parse(await readFile(path.join(pactRoot, file), "utf8"))),
  );

  assert.deepEqual(result.contracts.missing, []);
  assert.deepEqual(
    result.contracts.covered,
    pactFiles.map((file) => file.replace(".pact.json", "")),
  );
  assert.ok(pacts.every((pact) => pact.consumer?.name && pact.provider?.name));
  assert.ok(pacts.every((pact) => Array.isArray(pact.interactions) && pact.interactions.length > 0));
});

test("pact expectations align with simulated J2 drill outcomes", async () => {
  const result = await runStageGateS3Drill();

  assert.equal(result.scenarios.failedDeploy.data.code, "DEPLOY_GATE_FAILED");
  assert.equal(result.scenarios.selfCorrection.deploy.ok, true);
  assert.equal(result.scenarios.overBroadToken.ok, false);
  assert.equal(result.scenarios.overBroadToken.error.code, "MCP_SCOPE_DENIED");
  assert.equal(result.scenarios.prodDeployBlocked.decision.effect, "require-approval");
  assert.equal(result.scenarios.replay.replayable, true);
  assert.equal(result.scenarios.traceScan.staticSecretsFound, false);
});
