import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import { runCliMcpDeveloperExperienceReference } from "../../services/cli-mcp-reference.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pactRoot = path.resolve(__dirname, "../pacts");

test("consumer pact fixtures match the simulated service-boundary coverage", async () => {
  const result = await runCliMcpDeveloperExperienceReference();
  const pactFiles = [
    "cli-command-path.pact.json",
    "mcp-control-surface.pact.json",
    "runtime-projection-boundary.pact.json",
    "identity-policy-boundary.pact.json",
    "operations-manifest-boundary.pact.json",
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

test("Pact interaction expectations are backed by reference simulation outcomes", async () => {
  const result = await runCliMcpDeveloperExperienceReference();

  assert.equal(result.commandSurface.parity.ok, true);
  assert.deepEqual(result.scenarios.planPreview.sideEffectEvents, []);
  assert.equal(result.scenarios.mcp.plan.ok, true);
  assert.equal(result.scenarios.mcp.deniedDeploy.error.code, "MCP_SCOPE_DENIED");
  assert.equal(result.scenarios.blockedDeploy.applied, false);
  assert.equal(result.scenarios.credentials.staticKey.reason, "static-cloud-key-not-accepted");
  assert.equal(result.scenarios.secops.decision.effect, "deny");
  assert.equal(result.scenarios.manifests.validation.ok, true);
});
