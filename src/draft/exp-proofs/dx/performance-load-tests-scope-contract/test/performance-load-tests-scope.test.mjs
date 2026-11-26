import assert from "node:assert/strict";
import { test } from "vitest";

import {
  PERFORMANCE_LOAD_TESTS_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreatePerformanceLoadFollowUp,
  classifyPerformanceEvidenceGap,
  validatePerformanceLoadTestsScope,
} from "../src/performance-load-tests-scope.mjs";

test("M0 record states goal, personas, scope, non-goals, and boundaries", () => {
  const result = validatePerformanceLoadTestsScope(PERFORMANCE_LOAD_TESTS_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(PERFORMANCE_LOAD_TESTS_SCOPE.issue, "HOBO-440");
  assert.equal(PERFORMANCE_LOAD_TESTS_SCOPE.phase, "M0");
  assert.match(PERFORMANCE_LOAD_TESTS_SCOPE.goal, /Performance & Load Tests/i);
  assert.deepEqual(
    PERFORMANCE_LOAD_TESTS_SCOPE.personas.map((persona) => persona.role),
    [
      "release owner",
      "platform engineer",
      "sre operator",
      "finops reviewer",
      "support operator",
    ],
  );
  assert.deepEqual(Object.keys(PERFORMANCE_LOAD_TESTS_SCOPE.boundaries), REQUIRED_BOUNDARIES);
  assert.ok(PERFORMANCE_LOAD_TESTS_SCOPE.scopeIn.length >= 5);
  assert.ok(PERFORMANCE_LOAD_TESTS_SCOPE.scopeOut.length >= 5);
  assert.ok(PERFORMANCE_LOAD_TESTS_SCOPE.nonGoals.length >= 3);
});

test("M0 record maps dependencies to authoritative design sources", () => {
  assert.deepEqual(
    PERFORMANCE_LOAD_TESTS_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/reliability-observability-cost.md#plan-05",
      "docs/design/e2e-test-matrix.md",
      "docs/design/launch-e2e-persona-matrix.md",
      "docs/design/pre-launch-outcome-contract.md",
      "docs/design/adr/02-identity-security.md#adr-0045",
      "docs/design/adr/02-identity-security.md#adr-0082",
    ],
  );
});

test("M0 record maps owning initiatives without taking adjacent scope", () => {
  assert.deepEqual(
    PERFORMANCE_LOAD_TESTS_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Performance & Load Tests",
      "E2E Test Matrix",
      "V1 Release Program & Cutline",
      "Reliability, Observability & Cost",
      "Support Workflow",
      "Security Verification",
    ],
  );
  assert.equal(
    PERFORMANCE_LOAD_TESTS_SCOPE.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M0 record lists evidence required before M1 design and contract proof", () => {
  assert.deepEqual(
    PERFORMANCE_LOAD_TESTS_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "scenario-inventory",
      "workload-model-fixture",
      "capacity-envelope-schema",
      "threshold-and-abort-policy",
      "evidence-retention-and-support-handoff",
    ],
  );
  assert.equal(
    PERFORMANCE_LOAD_TESTS_SCOPE.m1Evidence.every(
      (evidence) => evidence.owner && evidence.proofMode && evidence.proves,
    ),
    true,
  );
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreatePerformanceLoadFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreatePerformanceLoadFollowUp({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreatePerformanceLoadFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreatePerformanceLoadFollowUp({ phase: "M0", m0Accepted: true }), false);
});

test("scope validation rejects runner, live-provider, chaos, or launch-decision creep", () => {
  const result = validatePerformanceLoadTestsScope({
    ...PERFORMANCE_LOAD_TESTS_SCOPE,
    scopeIn: [
      ...PERFORMANCE_LOAD_TESTS_SCOPE.scopeIn,
      "Implement the production load runner with live provider stress tests and final GA launch decisions.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("evidence gaps route to the owning project instead of becoming silent passes", () => {
  assert.equal(classifyPerformanceEvidenceGap("journey row missing expected-load metadata"), "E2E Test Matrix");
  assert.equal(classifyPerformanceEvidenceGap("slo burn rate threshold missing"), "Reliability, Observability & Cost");
  assert.equal(classifyPerformanceEvidenceGap("support evidence retention unknown"), "Support Workflow");
  assert.equal(classifyPerformanceEvidenceGap("secret redaction for load log missing"), "Security Verification");
  assert.equal(classifyPerformanceEvidenceGap("unknown workload owner"), "Performance & Load Tests");
});
