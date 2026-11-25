import assert from "node:assert/strict";
import { test } from "vitest";

import {
  PLAN_DIFF_VIEWER_SCOPE,
  canCreatePlanDiffViewerFollowUp,
  validatePlanDiffViewerScope,
} from "../src/plan-diff-viewer-scope.mjs";

test("M0 record states goal, personas, scope, non-goals, and operating boundaries", () => {
  const result = validatePlanDiffViewerScope(PLAN_DIFF_VIEWER_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(PLAN_DIFF_VIEWER_SCOPE.issue, "HOBO-411");
  assert.equal(PLAN_DIFF_VIEWER_SCOPE.phase, "M0");
  assert.match(PLAN_DIFF_VIEWER_SCOPE.goal, /plan/i);
  assert.match(PLAN_DIFF_VIEWER_SCOPE.goal, /diff/i);
  assert.deepEqual(
    PLAN_DIFF_VIEWER_SCOPE.personas.map((persona) => persona.role),
    [
      "app developer reviewer",
      "platform engineer approver",
      "security reviewer",
      "support operator",
    ],
  );
  assert.deepEqual(Object.keys(PLAN_DIFF_VIEWER_SCOPE.boundaries), [
    "service",
    "ux",
    "security",
    "support",
  ]);
  assert.ok(PLAN_DIFF_VIEWER_SCOPE.scopeIn.length >= 4);
  assert.ok(PLAN_DIFF_VIEWER_SCOPE.scopeOut.length >= 4);
});

test("M0 record maps dependencies to authoritative design sources", () => {
  assert.deepEqual(
    PLAN_DIFF_VIEWER_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/developer-experience.md#plan-07",
      "docs/design/control-plane.md#plan-04",
      "docs/design/platform-engineering.md#plan-25",
      "docs/design/reliability-observability-cost.md#plan-05",
      "docs/design/contracts-policy-flags.md#plan-29",
      "docs/design/adr/01-architecture-core.md#adr-0033",
      "docs/design/adr/07-portability-extensibility.md#adr-0064",
    ],
  );
});

test("M0 record maps owning initiatives without taking their scope", () => {
  assert.deepEqual(
    PLAN_DIFF_VIEWER_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Plan/Diff Viewer",
      "Deployment Dashboard & Topology Explorer",
      "Workspace & Onboarding UX",
      "Security Verification",
      "Support & Debug Tools",
      "V1 Release Program & Cutline",
    ],
  );
  assert.equal(
    PLAN_DIFF_VIEWER_SCOPE.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M0 record lists evidence required before M1 design and contract proof", () => {
  assert.deepEqual(
    PLAN_DIFF_VIEWER_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "plan-diff-state-model",
      "golden-plan-fixtures",
      "risk-and-policy-annotations",
      "cost-and-capacity-summary",
      "blocked-plan-support-handoff",
    ],
  );
  assert.equal(
    PLAN_DIFF_VIEWER_SCOPE.m1Evidence.every((evidence) => evidence.owner && evidence.source && evidence.proves),
    true,
  );
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreatePlanDiffViewerFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreatePlanDiffViewerFollowUp({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreatePlanDiffViewerFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreatePlanDiffViewerFollowUp({ phase: "M0", m0Accepted: true }), false);
});

test("scope validation rejects planner, apply, dashboard, or live-provider creep", () => {
  const result = validatePlanDiffViewerScope({
    ...PLAN_DIFF_VIEWER_SCOPE,
    scopeIn: [
      ...PLAN_DIFF_VIEWER_SCOPE.scopeIn,
      "Build the production dashboard and apply the plan through live provider credentials.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("evidence validation requires proof mode and source for launch-facing claims", () => {
  const result = validatePlanDiffViewerScope({
    ...PLAN_DIFF_VIEWER_SCOPE,
    m1Evidence: [
      ...PLAN_DIFF_VIEWER_SCOPE.m1Evidence,
      {
        kind: "claim",
        owner: "product",
        proves: "Plan/Diff Viewer is launch ready.",
      },
    ],
  });

  assert.match(result.errors.join("\n"), /proof mode/i);
  assert.match(result.errors.join("\n"), /source/i);
});
