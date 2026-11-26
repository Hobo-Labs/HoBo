import assert from "node:assert/strict";
import { test } from "vitest";

import {
  LAUNCH_PERFORMANCE_CAPACITY_ENVELOPE,
  REQUIRED_ENVELOPE_SECTIONS,
  validateLaunchPerformanceCapacityEnvelope,
} from "../src/launch-performance-capacity-envelope.mjs";

test("M0 envelope defines workflows, beta load, thresholds, capacity assumptions, fixture shape, and non-goals", () => {
  const result = validateLaunchPerformanceCapacityEnvelope(LAUNCH_PERFORMANCE_CAPACITY_ENVELOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(LAUNCH_PERFORMANCE_CAPACITY_ENVELOPE.issue, "HOBO-502");
  assert.equal(LAUNCH_PERFORMANCE_CAPACITY_ENVELOPE.phase, "M0");
  assert.deepEqual(REQUIRED_ENVELOPE_SECTIONS, [
    "targetWorkflows",
    "betaLoadAssumptions",
    "thresholds",
    "capacityAssumptions",
    "loadTestFixtureContract",
    "nonGoals",
  ]);
  for (const section of REQUIRED_ENVELOPE_SECTIONS) {
    assert.ok(LAUNCH_PERFORMANCE_CAPACITY_ENVELOPE[section].length > 0, `${section} must be defined`);
  }
});

test("each threshold maps a measurable target to support and release-note handling", () => {
  assert.deepEqual(
    LAUNCH_PERFORMANCE_CAPACITY_ENVELOPE.thresholds.map((threshold) => threshold.id),
    [
      "threshold.first-plan-p95",
      "threshold.first-deploy-e2e-p95",
      "threshold.dashboard-readiness-p95",
      "threshold.support-evidence-lookup-p95",
      "threshold.cost-per-smoke-run",
    ],
  );

  for (const threshold of LAUNCH_PERFORMANCE_CAPACITY_ENVELOPE.thresholds) {
    assert.ok(threshold.metric, `${threshold.id} missing metric`);
    assert.ok(threshold.betaTarget, `${threshold.id} missing betaTarget`);
    assert.ok(threshold.gaTarget, `${threshold.id} missing gaTarget`);
    assert.ok(threshold.supportAction, `${threshold.id} missing supportAction`);
    assert.ok(threshold.releaseNotesImpact, `${threshold.id} missing releaseNotesImpact`);
  }
});

test("cost guardrails align with usage metering, billing, and entitlements ownership", () => {
  assert.deepEqual(
    LAUNCH_PERFORMANCE_CAPACITY_ENVELOPE.costGuardrails.map((guardrail) => guardrail.ownerProject),
    ["Usage Metering", "Billing & Credits", "Entitlements & Plan Limits"],
  );

  for (const guardrail of LAUNCH_PERFORMANCE_CAPACITY_ENVELOPE.costGuardrails) {
    assert.ok(guardrail.sourceEvidence, `${guardrail.id} missing sourceEvidence`);
    assert.ok(guardrail.launchRule, `${guardrail.id} missing launchRule`);
    assert.ok(guardrail.scopeBoundary, `${guardrail.id} missing scopeBoundary`);
  }
});

test("load-test fixture shape is deterministic and avoids live production execution", () => {
  assert.deepEqual(
    LAUNCH_PERFORMANCE_CAPACITY_ENVELOPE.loadTestFixtureContract.map((fixture) => fixture.id),
    [
      "fixture.local-smoke",
      "fixture.saas-beta-synthetic",
      "fixture.self-host-synthetic",
      "fixture.cost-envelope-replay",
    ],
  );

  for (const fixture of LAUNCH_PERFORMANCE_CAPACITY_ENVELOPE.loadTestFixtureContract) {
    assert.ok(fixture.dataSet, `${fixture.id} missing dataSet`);
    assert.ok(fixture.measurementMode, `${fixture.id} missing measurementMode`);
    assert.equal(fixture.executesAgainstProduction, false, `${fixture.id} must not execute against production`);
  }
});

test("validation rejects missing support routing, unaligned cost guardrails, and production load execution", () => {
  const invalid = structuredClone(LAUNCH_PERFORMANCE_CAPACITY_ENVELOPE);
  invalid.thresholds[0] = {
    ...invalid.thresholds[0],
    supportAction: "",
  };
  invalid.costGuardrails[0] = {
    ...invalid.costGuardrails[0],
    ownerProject: "Unowned Cost Project",
  };
  invalid.loadTestFixtureContract.push({
    id: "fixture.production-load-test",
    dataSet: "live customer production traffic",
    measurementMode: "live-production",
    executesAgainstProduction: true,
  });
  invalid.nonGoals = invalid.nonGoals.filter((item) => item.id !== "scope-out.production-load-execution");

  const result = validateLaunchPerformanceCapacityEnvelope(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /threshold\.first-plan-p95 missing supportAction/);
  assert.match(result.errors.join("\n"), /Unowned Cost Project is not an allowed cost owner/);
  assert.match(result.errors.join("\n"), /fixture\.production-load-test must not execute against production/);
  assert.match(result.errors.join("\n"), /scope-out\.production-load-execution is required/);
});

test("validation requires threshold, cost guardrail, and fixture sections", () => {
  const result = validateLaunchPerformanceCapacityEnvelope({
    ...LAUNCH_PERFORMANCE_CAPACITY_ENVELOPE,
    thresholds: [],
    costGuardrails: [],
    loadTestFixtureContract: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /thresholds must be a non-empty list/);
  assert.match(result.errors.join("\n"), /costGuardrails must be a non-empty list/);
  assert.match(result.errors.join("\n"), /loadTestFixtureContract must be a non-empty list/);
});
