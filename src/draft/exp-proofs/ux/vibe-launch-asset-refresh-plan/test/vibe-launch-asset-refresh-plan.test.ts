import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_ASSET_KINDS,
  REQUIRED_PROOF_MODES,
  REQUIRED_SCENARIO_KINDS,
  VIBE_LAUNCH_ASSET_REFRESH_PLAN,
  evaluateLaunchAssetRefreshPlan,
  rejectLaunchAssetScopeCreep,
} from "../src/vibe-launch-asset-refresh-plan.js";

test("refresh plan names every required launch-demo asset and ownership field", () => {
  const result = evaluateLaunchAssetRefreshPlan(VIBE_LAUNCH_ASSET_REFRESH_PLAN);
  const assetsByKind = new Map(VIBE_LAUNCH_ASSET_REFRESH_PLAN.assets.map((asset) => [asset.kind, asset]));

  assert.deepEqual(result.errors, []);
  assert.equal(VIBE_LAUNCH_ASSET_REFRESH_PLAN.issue, "HOBO-556");
  assert.equal(
    VIBE_LAUNCH_ASSET_REFRESH_PLAN.targetPackagePath,
    "src/draft/exp-proofs/ux/vibe-launch-asset-refresh-plan",
  );
  assert.equal(
    VIBE_LAUNCH_ASSET_REFRESH_PLAN.proofNotePath,
    "docs/design/proofs/vibe-launch-asset-refresh-plan/README.md",
  );

  for (const kind of REQUIRED_ASSET_KINDS) {
    assert.ok(assetsByKind.has(kind), `missing ${kind}`);
    const asset = assetsByKind.get(kind);
    assert.ok(asset?.sourceOwner, `${kind} missing source owner`);
    assert.ok(asset?.proofMode, `${kind} missing proof mode`);
    assert.ok(asset?.freshnessRule, `${kind} missing freshness rule`);
    assert.ok(asset?.refreshTrigger, `${kind} missing refresh trigger`);
    assert.ok(asset?.validationRoute, `${kind} missing validation route`);
    assert.ok(asset?.staleDowngrade, `${kind} missing stale downgrade behavior`);
  }
});

test("fixture examples distinguish live, simulated, reference fixture, and scope-out proof modes", () => {
  const result = evaluateLaunchAssetRefreshPlan(VIBE_LAUNCH_ASSET_REFRESH_PLAN);
  const modes = new Set(VIBE_LAUNCH_ASSET_REFRESH_PLAN.fixtureExamples.map((fixture) => fixture.proofMode));

  assert.deepEqual(result.accepted.proofModes, REQUIRED_PROOF_MODES);
  assert.deepEqual([...modes].sort(), [...REQUIRED_PROOF_MODES].sort());

  for (const fixture of VIBE_LAUNCH_ASSET_REFRESH_PLAN.fixtureExamples) {
    assert.ok(fixture.evidenceSource, `${fixture.id} missing evidence source`);
    assert.ok(fixture.claimBoundary, `${fixture.id} missing claim boundary`);
  }
});

test("scenarios cover happy, blocked, stale or unknown evidence, support handoff, and accessibility notes", () => {
  const result = evaluateLaunchAssetRefreshPlan(VIBE_LAUNCH_ASSET_REFRESH_PLAN);

  assert.deepEqual(result.accepted.scenarioKinds, REQUIRED_SCENARIO_KINDS);

  for (const scenario of VIBE_LAUNCH_ASSET_REFRESH_PLAN.scenarios) {
    assert.ok(scenario.safeNextAction, `${scenario.id} missing safe next action`);
    assert.match(scenario.supportHandoff, /support|owner|handoff|ticket/i, scenario.id);
    assert.match(scenario.accessibilityNote, /screen reader|keyboard|contrast|reduced motion|plain text/i, scenario.id);
    assert.ok(REQUIRED_PROOF_MODES.includes(scenario.proofMode), `${scenario.id} invalid proof mode`);
  }
});

test("stale or unknown evidence downgrades launch readiness instead of promoting claims", () => {
  const staleScenario = VIBE_LAUNCH_ASSET_REFRESH_PLAN.scenarios.find(
    (scenario) => scenario.kind === "stale-or-unknown-evidence",
  );
  assert.ok(staleScenario, "stale or unknown evidence scenario required");
  assert.equal(staleScenario.launchReadinessImpact, "downgrade-until-refreshed");
  assert.match(staleScenario.safeNextAction, /refresh|downgrade/i);
  assert.match(staleScenario.supportHandoff, /owner|support/i);
});

test("scope guard rejects final assets, recording production, live providers, customer data, publication, and unsupported claims", () => {
  const denials = rejectLaunchAssetScopeCreep([
    "Create final marketing screenshots for the public launch site.",
    "Record the production demo video in this proof.",
    "Call a live provider so the recording looks real.",
    "Use customer data in the fixture manifest.",
    "Publish the launch page after the refresh plan lands.",
    "Claim production readiness from unsupported simulated evidence.",
  ]);

  assert.equal(denials.length, 6);
  assert.equal(denials.every((denial) => denial.decision === "reject"), true);
});

test("validation fails closed when required acceptance or adversarial evidence drifts", () => {
  const invalid = structuredClone(VIBE_LAUNCH_ASSET_REFRESH_PLAN);
  invalid.assets = invalid.assets.filter((asset) => asset.kind !== "recording-manifest");
  invalid.assets[0].sourceOwner = "";
  invalid.fixtureExamples = invalid.fixtureExamples.filter((fixture) => fixture.proofMode !== "scope-out");
  invalid.scenarios = invalid.scenarios.filter((scenario) => scenario.kind !== "blocked-path");
  invalid.scenarios[0].supportHandoff = "";
  invalid.scenarios[0].accessibilityNote = "";

  const result = evaluateLaunchAssetRefreshPlan(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /missing required asset: recording-manifest/);
  assert.match(result.errors.join("\n"), /source owner is required/);
  assert.match(result.errors.join("\n"), /missing proof mode fixture: scope-out/);
  assert.match(result.errors.join("\n"), /missing scenario kind: blocked-path/);
  assert.match(result.errors.join("\n"), /support handoff is required/);
  assert.match(result.errors.join("\n"), /accessibility note is required/);
});
