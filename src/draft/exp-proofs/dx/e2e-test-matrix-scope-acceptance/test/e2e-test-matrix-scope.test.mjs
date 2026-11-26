import assert from "node:assert/strict";
import { test } from "vitest";

import {
  E2E_TEST_MATRIX_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreateFollowUpIssue,
  classifyE2eEvidenceGap,
  validateE2eTestMatrixScope,
} from "../src/e2e-test-matrix-scope.mjs";

test("M0 record states goal, personas, scope, non-goals, and boundaries", () => {
  const result = validateE2eTestMatrixScope(E2E_TEST_MATRIX_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(E2E_TEST_MATRIX_SCOPE.issue, "HOBO-438");
  assert.equal(E2E_TEST_MATRIX_SCOPE.phase, "M0");
  assert.match(E2E_TEST_MATRIX_SCOPE.goal, /E2E Test Matrix/i);
  assert.deepEqual(
    E2E_TEST_MATRIX_SCOPE.personas.map((persona) => persona.role),
    [
      "release owner",
      "app developer",
      "platform engineer",
      "security reviewer",
      "support operator",
    ],
  );
  assert.deepEqual(Object.keys(E2E_TEST_MATRIX_SCOPE.boundaries), REQUIRED_BOUNDARIES);
  assert.ok(E2E_TEST_MATRIX_SCOPE.scopeIn.length >= 5);
  assert.ok(E2E_TEST_MATRIX_SCOPE.scopeOut.length >= 5);
  assert.ok(E2E_TEST_MATRIX_SCOPE.nonGoals.length >= 3);
});

test("M0 record maps dependencies to authoritative design sources", () => {
  assert.deepEqual(
    E2E_TEST_MATRIX_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/developer-experience.md#plan-07",
      "docs/design/architecture.md#plan-10",
      "docs/design/adr/02-identity-security.md#adr-0082",
      "docs/design/launch-e2e-persona-matrix.md",
      "docs/design/release-notes-upgrade-guide.md",
    ],
  );
});

test("M0 record maps owning initiatives without taking adjacent scope", () => {
  assert.deepEqual(
    E2E_TEST_MATRIX_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "E2E Test Matrix",
      "V1 Release Program & Cutline",
      "Compatibility Matrix",
      "Performance & Load Tests",
      "Bootstrap Installer",
      "Support Workflow",
      "Security Verification",
    ],
  );
  assert.equal(
    E2E_TEST_MATRIX_SCOPE.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M0 record lists evidence required before M1 design and contract proof", () => {
  assert.deepEqual(
    E2E_TEST_MATRIX_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "journey-inventory",
      "fixture-boundary-map",
      "evidence-schema",
      "flake-and-quarantine-policy",
      "release-claim-handoff",
    ],
  );
  assert.equal(
    E2E_TEST_MATRIX_SCOPE.m1Evidence.every(
      (evidence) => evidence.owner && evidence.proofMode && evidence.proves,
    ),
    true,
  );
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateFollowUpIssue({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateFollowUpIssue({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateFollowUpIssue({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateFollowUpIssue({ phase: "M0", m0Accepted: true }), false);
});

test("scope validation rejects full harness, live-provider, or device-lab implementation creep", () => {
  const result = validateE2eTestMatrixScope({
    ...E2E_TEST_MATRIX_SCOPE,
    scopeIn: [
      ...E2E_TEST_MATRIX_SCOPE.scopeIn,
      "Implement the full browser e2e harness with live provider execution and a device lab.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("evidence gaps route to the owning project instead of becoming silent passes", () => {
  assert.equal(classifyE2eEvidenceGap("missing browser/device fixture"), "Compatibility Matrix");
  assert.equal(classifyE2eEvidenceGap("load threshold missing"), "Performance & Load Tests");
  assert.equal(classifyE2eEvidenceGap("install smoke missing"), "Bootstrap Installer");
  assert.equal(classifyE2eEvidenceGap("security proof stale"), "Security Verification");
  assert.equal(classifyE2eEvidenceGap("unknown journey owner"), "E2E Test Matrix");
});
