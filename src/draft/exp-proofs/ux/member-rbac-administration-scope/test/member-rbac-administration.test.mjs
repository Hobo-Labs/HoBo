import assert from "node:assert/strict";
import { test } from "vitest";

import {
  MEMBER_RBAC_ADMINISTRATION_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreateFollowUpIssue,
  classifyMemberRbacDecision,
  validateMemberRbacAdministrationScope,
} from "../src/member-rbac-administration.mjs";

test("M0 record states goal, personas, scope, non-goals, and operating boundaries", () => {
  const result = validateMemberRbacAdministrationScope(MEMBER_RBAC_ADMINISTRATION_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(MEMBER_RBAC_ADMINISTRATION_SCOPE.issue, "HOBO-416");
  assert.equal(MEMBER_RBAC_ADMINISTRATION_SCOPE.phase, "M0");
  assert.match(MEMBER_RBAC_ADMINISTRATION_SCOPE.goal, /member/i);
  assert.match(MEMBER_RBAC_ADMINISTRATION_SCOPE.goal, /RBAC/i);
  assert.deepEqual(
    MEMBER_RBAC_ADMINISTRATION_SCOPE.personas.map((persona) => persona.role),
    [
      "workspace admin",
      "security/policy admin",
      "project owner",
      "support auditor",
    ],
  );
  assert.deepEqual(Object.keys(MEMBER_RBAC_ADMINISTRATION_SCOPE.boundaries), REQUIRED_BOUNDARIES);
  assert.ok(MEMBER_RBAC_ADMINISTRATION_SCOPE.scopeIn.length >= 5);
  assert.ok(MEMBER_RBAC_ADMINISTRATION_SCOPE.scopeOut.length >= 5);
});

test("M0 record maps dependencies to authoritative design sources", () => {
  assert.deepEqual(
    MEMBER_RBAC_ADMINISTRATION_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/organization-workspace-model.md",
      "docs/design/settings-project-lifecycle.md",
      "docs/design/tenant-isolation-quotas.md",
      "docs/design/developer-experience.md#plan-07",
      "docs/design/security-networking.md#plan-12",
      "docs/design/adr/02-identity-security.md#adr-0074",
      "docs/design/adr/02-identity-security.md#adr-0077",
    ],
  );
});

test("M0 record maps owning initiative dependencies without taking their scope", () => {
  assert.deepEqual(
    MEMBER_RBAC_ADMINISTRATION_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Member/RBAC Administration",
      "Organization & Workspace Model",
      "Settings & Project Lifecycle",
      "Tenant Isolation & Quotas",
      "Security Verification",
      "Support Workflow",
    ],
  );
  assert.equal(
    MEMBER_RBAC_ADMINISTRATION_SCOPE.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M0 record lists evidence required before M1 design and contract proof", () => {
  assert.deepEqual(
    MEMBER_RBAC_ADMINISTRATION_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "membership-state-model",
      "role-authority-matrix",
      "sso-scim-binding-fixture",
      "no-self-escalation-gate",
      "audit-support-export",
      "scope-boundary-register",
    ],
  );
  assert.equal(
    MEMBER_RBAC_ADMINISTRATION_SCOPE.m1Evidence.every(
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

test("scope validation rejects enforcement, sync, UI, provider, billing, or live-data creep", () => {
  const result = validateMemberRbacAdministrationScope({
    ...MEMBER_RBAC_ADMINISTRATION_SCOPE,
    scopeIn: [
      ...MEMBER_RBAC_ADMINISTRATION_SCOPE.scopeIn,
      "Implement RBAC enforcement, SCIM sync, admin console screens, provider access, billing roles, and live customer data migration.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("membership decisions route to the right adjacent owner", () => {
  assert.deepEqual(classifyMemberRbacDecision("workspace invite acceptance"), {
    owner: "Member/RBAC Administration",
    inScope: true,
  });
  assert.deepEqual(classifyMemberRbacDecision("project lifecycle archive approver"), {
    owner: "Settings & Project Lifecycle",
    inScope: false,
  });
  assert.deepEqual(classifyMemberRbacDecision("tenant quota override"), {
    owner: "Tenant Isolation & Quotas",
    inScope: false,
  });
  assert.deepEqual(classifyMemberRbacDecision("cross-tenant leak review"), {
    owner: "Security Verification",
    inScope: false,
  });
  assert.deepEqual(classifyMemberRbacDecision("support ticket severity"), {
    owner: "Support Workflow",
    inScope: false,
  });
});
