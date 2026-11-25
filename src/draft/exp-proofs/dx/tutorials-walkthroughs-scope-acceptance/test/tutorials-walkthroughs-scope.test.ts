import assert from "node:assert/strict";
import { test } from "vitest";

import {
  TUTORIALS_WALKTHROUGHS_SCOPE,
  canCreateFollowUpIssue,
  validateTutorialsWalkthroughsScope,
} from "../src/tutorials-walkthroughs-scope.js";

test("M0 record states goal, personas, scope, non-goals, and operating boundaries", () => {
  const result = validateTutorialsWalkthroughsScope(TUTORIALS_WALKTHROUGHS_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(TUTORIALS_WALKTHROUGHS_SCOPE.issue, "HOBO-436");
  assert.equal(TUTORIALS_WALKTHROUGHS_SCOPE.phase, "M0");
  assert.match(TUTORIALS_WALKTHROUGHS_SCOPE.goal, /tutorials and walkthroughs/i);
  assert.deepEqual(
    TUTORIALS_WALKTHROUGHS_SCOPE.personas.map((persona) => persona.role),
    [
      "first-time app developer",
      "coding agent",
      "platform engineer evaluator",
      "docs maintainer",
      "support operator",
    ],
  );
  assert.deepEqual(Object.keys(TUTORIALS_WALKTHROUGHS_SCOPE.boundaries), [
    "service",
    "ux",
    "security",
    "support",
  ]);
  assert.ok(TUTORIALS_WALKTHROUGHS_SCOPE.scopeIn.length >= 5);
  assert.ok(TUTORIALS_WALKTHROUGHS_SCOPE.scopeOut.length >= 5);
});

test("M0 record maps dependencies to authoritative design sources", () => {
  assert.deepEqual(
    TUTORIALS_WALKTHROUGHS_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/walkthrough.md",
      "docs/design/worked-example.md#plan-19",
      "docs/design/developer-experience.md#plan-07",
      "docs/design/example-apps.md",
      "docs/design/workspace-onboarding-ux.md",
      "docs/design/adr/07-portability-extensibility.md#adr-0064",
    ],
  );
});

test("M0 record maps owning initiative dependencies without taking their scope", () => {
  assert.deepEqual(
    TUTORIALS_WALKTHROUGHS_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Tutorials & Walkthroughs",
      "Docs Portal",
      "Example Apps",
      "Workspace & Onboarding UX",
      "Customer Onboarding",
      "Support Workflow",
      "V1 Launch Site, Messaging & Demo Assets",
      "V1 Release Program & Cutline",
    ],
  );
  assert.equal(
    TUTORIALS_WALKTHROUGHS_SCOPE.initiativeDependencies.every((dependency) => dependency.consumes && dependency.scopeBoundary),
    true,
  );
});

test("M0 record lists evidence required before M1 design and contract proof", () => {
  assert.deepEqual(
    TUTORIALS_WALKTHROUGHS_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "tutorial-map",
      "persona-walkthrough-scenarios",
      "command-transcripts",
      "agent-run-fixtures",
      "accessibility-and-localization-notes",
      "support-handoff-fixtures",
    ],
  );
  assert.equal(
    TUTORIALS_WALKTHROUGHS_SCOPE.m1Evidence.every((evidence) => evidence.owner && evidence.proves),
    true,
  );
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateFollowUpIssue({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateFollowUpIssue({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateFollowUpIssue({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateFollowUpIssue({ phase: "M0", m0Accepted: true }), false);
});

test("scope validation rejects docs-portal, marketing, or implementation creep", () => {
  const result = validateTutorialsWalkthroughsScope({
    ...TUTORIALS_WALKTHROUGHS_SCOPE,
    scopeIn: [
      ...TUTORIALS_WALKTHROUGHS_SCOPE.scopeIn,
      "Build the production docs portal and launch marketing tutorial pages.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("scope validation requires proof mode for every user-visible tutorial claim", () => {
  const result = validateTutorialsWalkthroughsScope({
    ...TUTORIALS_WALKTHROUGHS_SCOPE,
    m1Evidence: [
      ...TUTORIALS_WALKTHROUGHS_SCOPE.m1Evidence,
      {
        kind: "claim",
        owner: "docs maintainer",
        proves: "Tutorial path is launch ready.",
      },
    ],
  });

  assert.match(result.errors.join("\n"), /proof mode/i);
});
