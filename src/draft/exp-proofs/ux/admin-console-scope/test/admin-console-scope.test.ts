import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ADMIN_CONSOLE_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreateFollowUpIssue,
  classifyAdminConsoleRequest,
  validateAdminConsoleScope,
} from "../src/admin-console-scope.ts";

test("M0 record states goal, personas, scope, non-goals, and operating boundaries", () => {
  const result = validateAdminConsoleScope(ADMIN_CONSOLE_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(ADMIN_CONSOLE_SCOPE.issue, "HOBO-425");
  assert.equal(ADMIN_CONSOLE_SCOPE.phase, "M0");
  assert.match(ADMIN_CONSOLE_SCOPE.goal, /admin console/i);
  assert.deepEqual(
    ADMIN_CONSOLE_SCOPE.personas.map((persona) => persona.role),
    [
      "workspace admin",
      "project owner",
      "support operator",
      "security/policy admin",
    ],
  );
  assert.deepEqual(Object.keys(ADMIN_CONSOLE_SCOPE.boundaries), REQUIRED_BOUNDARIES);
  assert.ok(ADMIN_CONSOLE_SCOPE.scopeIn.length >= 5);
  assert.ok(ADMIN_CONSOLE_SCOPE.scopeOut.length >= 5);
});

test("M0 record maps dependencies to authoritative design sources", () => {
  assert.deepEqual(
    ADMIN_CONSOLE_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/developer-experience.md#plan-07",
      "docs/design/organization-workspace-model.md",
      "docs/design/settings-project-lifecycle.md",
      "docs/design/member-rbac-administration.md",
      "docs/design/tenant-isolation-quotas.md",
      "docs/design/support-sla-channels.md",
      "docs/design/security-networking.md#plan-50",
      "docs/design/adr/02-identity-security.md#adr-0074",
      "docs/design/adr/02-identity-security.md#adr-0077",
      "docs/design/adr/02-identity-security.md#adr-0080",
    ],
  );
});

test("M0 record maps owning initiative dependencies without taking their scope", () => {
  assert.deepEqual(
    ADMIN_CONSOLE_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Admin Console",
      "Settings & Project Lifecycle",
      "Member/RBAC Administration",
      "Tenant Isolation & Quotas",
      "Support Workflow",
      "Security Verification",
      "Meta-cloud Broker",
    ],
  );
  assert.equal(
    ADMIN_CONSOLE_SCOPE.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M0 record lists evidence required before M1 design and contract proof", () => {
  assert.deepEqual(
    ADMIN_CONSOLE_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "navigation-information-architecture",
      "read-model-contract",
      "action-intent-matrix",
      "audit-redaction-export",
      "break-glass-visibility-fixture",
      "scope-boundary-register",
    ],
  );
  assert.equal(
    ADMIN_CONSOLE_SCOPE.m1Evidence.every(
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

test("scope validation rejects UI implementation, enforcement, live-data, billing, and provider creep", () => {
  const result = validateAdminConsoleScope({
    ...ADMIN_CONSOLE_SCOPE,
    scopeIn: [
      ...ADMIN_CONSOLE_SCOPE.scopeIn,
      "Build admin console React screens, mutate live customer data, enforce RBAC, view provider credentials, and edit billing limits.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("admin console request routing keeps adjacent ownership explicit", () => {
  assert.deepEqual(classifyAdminConsoleRequest("show project lifecycle state and owner"), {
    owner: "Admin Console",
    inScope: true,
  });
  assert.deepEqual(classifyAdminConsoleRequest("change RBAC role binding policy"), {
    owner: "Member/RBAC Administration",
    inScope: false,
  });
  assert.deepEqual(classifyAdminConsoleRequest("override tenant quota limit"), {
    owner: "Tenant Isolation & Quotas",
    inScope: false,
  });
  assert.deepEqual(classifyAdminConsoleRequest("open support ticket queue workflow"), {
    owner: "Support Workflow",
    inScope: false,
  });
  assert.deepEqual(classifyAdminConsoleRequest("read raw provider credentials"), {
    owner: "Security Verification",
    inScope: false,
  });
});
