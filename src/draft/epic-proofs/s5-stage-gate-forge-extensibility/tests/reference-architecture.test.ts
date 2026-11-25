import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import { runS5StageGateForgeDrill } from "../services/s5-stage-gate-reference.js";

test("hobo forge url yields certified provider with gen.PluginCertified and install verification", async () => {
  const result = await runS5StageGateForgeDrill();

  assert.equal(result.epic.slug, "s5-stage-gate-forge-extensibility");
  assert.equal(result.forge.outcome, "certified");
  assert.match(result.forge.command, /^hobo forge /);
  assert.equal(result.forge.conformancePassed, true);
  assert.equal(result.forge.traceReplayPassed, true);
  assert.equal(result.forge.egressAttempts, 0);
  assert.ok(
    result.forge.registryEventType === "gen.PluginCertified"
      || result.forge.registryEventType === "gen.Certified",
  );
  assert.equal(result.registry.installOk, true);
  assert.equal(result.registry.eventType, "gen.PluginCertified");
  assert.equal(result.registry.availableToMatching, true);
  assert.equal(result.registry.selectedByMatching, false);
  assert.equal(result.registry.assurance, "integrity-and-conformance-verified");
});

test("forged provider deploys a Bindle resource end-to-end", async () => {
  const result = await runS5StageGateForgeDrill();

  assert.equal(result.bindleDeploy.outcome, "succeeded");
  assert.equal(result.bindleDeploy.resourceStatus, "ready");
  assert.equal(result.bindleDeploy.providerDigestPinned, true);
  assert.deepEqual(result.bindleDeploy.events, [
    "deploy.Requested",
    "provider.ResourceProvisioned",
    "deploy.Succeeded",
  ]);
});

test("stubbed port AI implementation reproduces traces and promotes through eval gate", async () => {
  const result = await runS5StageGateForgeDrill();

  assert.equal(result.stubImpl.traceReplay, "passed");
  assert.equal(result.stubImpl.evalGate, "passed");
  assert.equal(result.stubImpl.promotionOutcome, "promoted");
  assert.ok(result.stubImpl.events.includes("eval.GatePassed"));
});

test("simulated SLO regression auto-rolls back and retains regression test", async () => {
  const result = await runS5StageGateForgeDrill();

  assert.equal(result.liveFix.status, "rolled-back");
  assert.equal(result.liveFix.autoRollback, true);
  assert.equal(result.liveFix.regressionTestRetained, true);
  assert.ok(result.liveFix.eventTypes.includes("deployment.RolledBack"));
  assert.ok(result.liveFix.eventTypes.includes("livefix.RegressionTestRetained"));
});

test("adversarial cases refuse tampered or unsigned artifacts and block high-risk live-fix", async () => {
  const result = await runS5StageGateForgeDrill();

  assert.equal(result.adversarial.tamperedArtifactRefused, true);
  assert.equal(result.adversarial.unsignedArtifactRefused, true);
  assert.equal(result.adversarial.highRiskNeedsApproval, true);
  assert.equal(result.adversarial.highRiskStatus, "needs-approval");
});

test("stage gate drill declares every mocked service boundary", async () => {
  const result = await runS5StageGateForgeDrill();

  assert.deepEqual([...result.contracts.covered].sort(), [
    "BindleDeployOrchestrator",
    "ForgeRegistryCertification",
    "LiveFixAutoRollbackGate",
    "StubImplEvalPromotionGate",
  ]);
  assert.equal(result.contracts.missing.length, 0);
});

test("architecture artifacts pin protobuf, CUE, Pact, and event-architecture evidence", () => {
  const architecture = readFileSync(new URL("../architecture.md", import.meta.url), "utf8");
  const proto = readFileSync(
    new URL("../architecture/s5_stage_gate_forge_extensibility.proto", import.meta.url),
    "utf8",
  );
  const cue = readFileSync(
    new URL("../architecture/s5_stage_gate_forge_extensibility.cue", import.meta.url),
    "utf8",
  );
  const pact = JSON.parse(
    readFileSync(
      new URL("../architecture/pacts/s5_stage_gate_forge_extensibility.pact.json", import.meta.url),
      "utf8",
    ),
  );

  assert.match(proto, /message S5StageGateForgeExtensibilityRecord/);
  assert.match(cue, /#S5StageGateForgeExtensibilityRecord:/);
  assert.equal(pact.consumer.name, "S5StageGateForgeDrill");
  assert.equal(pact.provider.name, "S5StageGateForgeExtensibilityPackage");
  assert.equal(pact.interactions[0].contents.contractsCovered, 4);
  assert.match(architecture, /parse, don't validate/i);
  assert.match(architecture, /Command/i);
  assert.match(architecture, /Event/i);
  assert.match(architecture, /Actor/i);
  assert.match(architecture, /event[- ]store/i);
  assert.match(architecture, /projection/i);
  assert.match(architecture, /read store/i);
});
