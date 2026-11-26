import assert from "node:assert/strict";
import { test } from "vitest";

import {
  WORKSPACE_ONBOARDING_SCOPE,
  canCreateWorkspaceOnboardingFollowUp,
  validateWorkspaceOnboardingScope,
} from "../src/workspace-onboarding-scope.mjs";

test("M0 record states goal, personas, scope, non-goals, and operating boundaries", () => {
  const result = validateWorkspaceOnboardingScope(WORKSPACE_ONBOARDING_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(WORKSPACE_ONBOARDING_SCOPE.issue, "HOBO-409");
  assert.equal(WORKSPACE_ONBOARDING_SCOPE.phase, "M0");
  assert.match(WORKSPACE_ONBOARDING_SCOPE.goal, /workspace/i);
  assert.match(WORKSPACE_ONBOARDING_SCOPE.goal, /onboarding/i);
  assert.deepEqual(
    WORKSPACE_ONBOARDING_SCOPE.personas.map((persona) => persona.role),
    [
      "first-time app developer",
      "team admin",
      "platform engineer",
      "support operator",
    ],
  );
  assert.deepEqual(Object.keys(WORKSPACE_ONBOARDING_SCOPE.boundaries), [
    "service",
    "ux",
    "security",
    "support",
  ]);
  assert.ok(WORKSPACE_ONBOARDING_SCOPE.scopeIn.length >= 4);
  assert.ok(WORKSPACE_ONBOARDING_SCOPE.scopeOut.length >= 4);
});

test("M0 record maps dependencies to authoritative design sources", () => {
  assert.deepEqual(
    WORKSPACE_ONBOARDING_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/vision.md#plan-17",
      "docs/design/developer-experience.md#plan-07",
      "docs/design/walkthrough.md",
      "docs/design/worked-example.md#plan-19",
      "docs/design/example-apps.md",
      "docs/design/adr/07-portability-extensibility.md#adr-0064",
    ],
  );
});

test("M0 record maps owning initiatives without taking their scope", () => {
  assert.deepEqual(
    WORKSPACE_ONBOARDING_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Workspace & Onboarding UX",
      "Settings & Project Lifecycle",
      "Organization & Workspace Model",
      "Example Apps",
      "Customer Onboarding",
      "Support Workflow",
      "V1 Release Program & Cutline",
    ],
  );
  assert.equal(
    WORKSPACE_ONBOARDING_SCOPE.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M0 record lists evidence required before M1 design and contract proof", () => {
  assert.deepEqual(
    WORKSPACE_ONBOARDING_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "activation-rail-map",
      "persona-first-run-scenarios",
      "workspace-state-model",
      "telemetry-event-contract",
      "recovery-and-handoff-fixtures",
    ],
  );
  assert.equal(
    WORKSPACE_ONBOARDING_SCOPE.m1Evidence.every((evidence) => evidence.owner && evidence.proves),
    true,
  );
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateWorkspaceOnboardingFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateWorkspaceOnboardingFollowUp({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateWorkspaceOnboardingFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateWorkspaceOnboardingFollowUp({ phase: "M0", m0Accepted: true }), false);
});

test("scope validation rejects dashboard, auth, billing, or production instrumentation creep", () => {
  const result = validateWorkspaceOnboardingScope({
    ...WORKSPACE_ONBOARDING_SCOPE,
    scopeIn: [
      ...WORKSPACE_ONBOARDING_SCOPE.scopeIn,
      "Implement the production dashboard and billing-backed account onboarding flow.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("scope validation requires owner, proof mode, and source for evidence", () => {
  const result = validateWorkspaceOnboardingScope({
    ...WORKSPACE_ONBOARDING_SCOPE,
    m1Evidence: [
      ...WORKSPACE_ONBOARDING_SCOPE.m1Evidence,
      {
        kind: "claim",
        owner: "product",
        proves: "Onboarding is launch ready.",
      },
    ],
  });

  assert.match(result.errors.join("\n"), /proof mode/i);
  assert.match(result.errors.join("\n"), /source/i);
});
