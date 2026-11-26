import assert from "node:assert/strict";
import { test } from "vitest";

const PROOF_MODES = ["live-product", "reference-fixture", "simulated-reference"];
const REQUIRED_ASSETS = ["screenshots", "recording-manifest", "command-transcript", "fixture-data", "docs"];

async function loadContract() {
  const module = await import("../src/launch-demo-golden-path.ts").catch((error) => ({
    __loadError: error,
  }));

  assert.equal(module.__loadError, undefined, module.__loadError?.message);
  return module;
}

test("golden path names sample app, persona, setup, commands, screens, outputs, recovery, and evidence", async () => {
  const { launchDemoGoldenPath, validateLaunchDemoGoldenPath } = await loadContract();
  const result = validateLaunchDemoGoldenPath(launchDemoGoldenPath);

  assert.deepEqual(result.errors, []);
  assert.equal(launchDemoGoldenPath.issue, "HOBO-488");
  assert.equal(launchDemoGoldenPath.phase, "M0");
  assert.equal(launchDemoGoldenPath.sampleApp.id, "snapshop");
  assert.ok(launchDemoGoldenPath.primaryPersona.role.includes("developer"));
  assert.ok(launchDemoGoldenPath.setupPrerequisites.length >= 4);
  assert.ok(launchDemoGoldenPath.commandPath.length >= 5);
  assert.ok(launchDemoGoldenPath.screens.length >= 4);
  assert.ok(launchDemoGoldenPath.expectedOutputs.length >= 5);
  assert.ok(launchDemoGoldenPath.failureRecovery.length >= 4);
  assert.ok(launchDemoGoldenPath.evidenceArtifacts.length >= REQUIRED_ASSETS.length);
});

test("demo proof distinguishes live product behavior from reference and simulated evidence", async () => {
  const { launchDemoGoldenPath } = await loadContract();
  const modes = new Set([
    ...launchDemoGoldenPath.commandPath.map((step) => step.proofMode),
    ...launchDemoGoldenPath.expectedOutputs.map((output) => output.proofMode),
  ]);

  assert.deepEqual([...modes].sort(), [...PROOF_MODES].sort());

  for (const step of launchDemoGoldenPath.commandPath) {
    assert.ok(step.claimBoundary, `${step.id} must label the claim boundary`);
    assert.ok(PROOF_MODES.includes(step.proofMode), `${step.id} has invalid proof mode`);
  }
});

test("required proof assets list screenshots, recordings, fixtures, transcripts, and docs", async () => {
  const { launchDemoGoldenPath } = await loadContract();
  const assetsByKind = new Map(launchDemoGoldenPath.evidenceArtifacts.map((asset) => [asset.kind, asset]));

  for (const kind of REQUIRED_ASSETS) {
    assert.ok(assetsByKind.has(kind), `missing ${kind}`);
    const asset = assetsByKind.get(kind);
    assert.ok(asset.owner, `${kind} missing owner`);
    assert.ok(asset.source, `${kind} missing source`);
    assert.ok(asset.refreshTrigger, `${kind} missing refresh trigger`);
    assert.ok(PROOF_MODES.includes(asset.proofMode) || asset.proofMode === "design-record");
  }
});

test("scope guard rejects marketing polish, demo implementation, and unlabelled production claims", async () => {
  const { launchDemoGoldenPath, validateLaunchDemoGoldenPath } = await loadContract();
  const invalid = structuredClone(launchDemoGoldenPath);

  invalid.scopeOut.push("Build the launch marketing page and final polished demo video.");
  invalid.commandPath.push({
    id: "ship-demo-app",
    command: "deploy production demo",
    screen: "public launch site",
    proofMode: "live-product",
    claimBoundary: "production-ready without evidence label",
  });
  invalid.expectedOutputs[0].proofMode = "";

  const result = validateLaunchDemoGoldenPath(invalid);

  assert.match(result.errors.join("\n"), /marketing polish is scope-out/);
  assert.match(result.errors.join("\n"), /demo implementation is scope-out/);
  assert.match(result.errors.join("\n"), /must declare a proof mode/);
});
