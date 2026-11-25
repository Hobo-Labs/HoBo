import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_BOUNDARIES,
  SETTINGS_PROJECT_LIFECYCLE_SCOPE,
  canCreateFollowUpIssue,
  validateSettingsProjectLifecycleScope,
} from "../src/settings-project-lifecycle.mjs";

test("M0 record states goal, personas, scope, non-goals, and operating boundaries", () => {
  const result = validateSettingsProjectLifecycleScope(SETTINGS_PROJECT_LIFECYCLE_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(SETTINGS_PROJECT_LIFECYCLE_SCOPE.issue, "HOBO-412");
  assert.equal(SETTINGS_PROJECT_LIFECYCLE_SCOPE.phase, "M0");
  assert.match(SETTINGS_PROJECT_LIFECYCLE_SCOPE.goal, /settings/i);
  assert.match(SETTINGS_PROJECT_LIFECYCLE_SCOPE.goal, /project lifecycle/i);
  assert.deepEqual(
    SETTINGS_PROJECT_LIFECYCLE_SCOPE.personas.map((persona) => persona.role),
    [
      "workspace admin",
      "project owner",
      "platform engineer",
      "support operator",
    ],
  );
  assert.deepEqual(Object.keys(SETTINGS_PROJECT_LIFECYCLE_SCOPE.boundaries), REQUIRED_BOUNDARIES);
  assert.ok(SETTINGS_PROJECT_LIFECYCLE_SCOPE.scopeIn.length >= 5);
  assert.ok(SETTINGS_PROJECT_LIFECYCLE_SCOPE.scopeOut.length >= 5);
});

test("M0 record maps dependencies to authoritative design sources", () => {
  assert.deepEqual(
    SETTINGS_PROJECT_LIFECYCLE_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/developer-experience.md#plan-07",
      "docs/design/architecture.md#plan-10",
      "docs/design/security-networking.md#plan-50",
      "docs/design/adr/02-identity-security.md#adr-0077",
      "docs/design/adr/02-identity-security.md#adr-0074",
    ],
  );
});

test("M0 record maps owning initiative dependencies without taking their scope", () => {
  assert.deepEqual(
    SETTINGS_PROJECT_LIFECYCLE_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Settings & Project Lifecycle",
      "Member/RBAC Administration",
      "Tenant Isolation & Quotas",
      "Environment Lifecycle",
      "Deployment Dashboard & Topology Explorer",
      "Support Workflow",
    ],
  );
  assert.equal(
    SETTINGS_PROJECT_LIFECYCLE_SCOPE.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M0 record lists evidence required before M1 design and contract proof", () => {
  assert.deepEqual(
    SETTINGS_PROJECT_LIFECYCLE_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "settings-schema",
      "project-lifecycle-state-machine",
      "audit-event-fixture",
      "rbac-boundary-matrix",
      "support-export-contract",
    ],
  );
  assert.equal(
    SETTINGS_PROJECT_LIFECYCLE_SCOPE.m1Evidence.every(
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

test("scope validation rejects admin-console, RBAC, or tenant-quota implementation creep", () => {
  const result = validateSettingsProjectLifecycleScope({
    ...SETTINGS_PROJECT_LIFECYCLE_SCOPE,
    scopeIn: [
      ...SETTINGS_PROJECT_LIFECYCLE_SCOPE.scopeIn,
      "Implement admin console workflows, RBAC enforcement, and tenant quota metering.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("scope validation requires proof mode for customer-visible settings claims", () => {
  const result = validateSettingsProjectLifecycleScope({
    ...SETTINGS_PROJECT_LIFECYCLE_SCOPE,
    m1Evidence: [
      ...SETTINGS_PROJECT_LIFECYCLE_SCOPE.m1Evidence,
      {
        kind: "settings-claim",
        owner: "workspace admin",
        proves: "Settings are launch ready.",
      },
    ],
  });

  assert.match(result.errors.join("\n"), /proof mode/i);
});
