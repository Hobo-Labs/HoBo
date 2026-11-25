import assert from "node:assert/strict";
import { test } from "vitest";

import {
  EXAMPLE_APPS_SCOPE,
  canCreateFollowUpIssue,
  validateExampleAppsScope,
} from "../src/example-apps-scope.js";

test("M0 record states goal, personas, scope, non-goals, and operating boundaries", () => {
  const result = validateExampleAppsScope(EXAMPLE_APPS_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(EXAMPLE_APPS_SCOPE.issue, "HOBO-435");
  assert.equal(EXAMPLE_APPS_SCOPE.phase, "M0");
  assert.match(EXAMPLE_APPS_SCOPE.goal, /example apps/i);
  assert.deepEqual(
    EXAMPLE_APPS_SCOPE.personas.map((persona) => persona.role),
    [
      "app developer evaluator",
      "platform engineer evaluator",
      "agent builder",
      "demo maintainer",
    ],
  );
  assert.deepEqual(Object.keys(EXAMPLE_APPS_SCOPE.boundaries), [
    "service",
    "ux",
    "security",
    "support",
  ]);
  assert.ok(EXAMPLE_APPS_SCOPE.scopeIn.length >= 4);
  assert.ok(EXAMPLE_APPS_SCOPE.scopeOut.length >= 4);
});

test("M0 record maps dependencies to authoritative design sources", () => {
  assert.deepEqual(
    EXAMPLE_APPS_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/worked-example.md#plan-19",
      "docs/design/walkthrough.md",
      "docs/design/developer-experience.md#plan-07",
      "docs/design/authoring-resources-wiring.md#plan-21",
      "docs/design/adr/07-portability-extensibility.md#adr-0064",
    ],
  );
});

test("M0 record maps owning initiative dependencies without taking their scope", () => {
  assert.deepEqual(
    EXAMPLE_APPS_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Example Apps",
      "V1 Launch Site, Messaging & Demo Assets",
      "Workspace & Onboarding UX",
      "Customer Onboarding",
      "V1 Release Program & Cutline",
    ],
  );
  assert.equal(
    EXAMPLE_APPS_SCOPE.initiativeDependencies.every((dependency) => dependency.consumes && dependency.scopeBoundary),
    true,
  );
});

test("M0 record lists evidence required before M1 design and contract proof", () => {
  assert.deepEqual(
    EXAMPLE_APPS_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "catalog",
      "scaffold-smoke",
      "command-transcript",
      "proof-assets",
      "failure-mode-contracts",
    ],
  );
  assert.equal(
    EXAMPLE_APPS_SCOPE.m1Evidence.every((evidence) => evidence.owner && evidence.proves),
    true,
  );
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateFollowUpIssue({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateFollowUpIssue({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateFollowUpIssue({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateFollowUpIssue({ phase: "M0", m0Accepted: true }), false);
});

test("scope validation rejects launch-demo or production-app scope creep", () => {
  const result = validateExampleAppsScope({
    ...EXAMPLE_APPS_SCOPE,
    scopeIn: [
      ...EXAMPLE_APPS_SCOPE.scopeIn,
      "Ship a production-hosted launch demo app with real customer data.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("scope validation requires proof mode for user-visible claims", () => {
  const result = validateExampleAppsScope({
    ...EXAMPLE_APPS_SCOPE,
    m1Evidence: [
      ...EXAMPLE_APPS_SCOPE.m1Evidence,
      {
        kind: "claim",
        owner: "demo maintainer",
        proves: "Example is launch ready.",
      },
    ],
  });

  assert.match(result.errors.join("\n"), /proof mode/i);
});
