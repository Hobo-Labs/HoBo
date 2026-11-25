import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ORGANIZATION_WORKSPACE_MODEL,
  canCreateFollowUpIssue,
  classifyWorkspaceDecision,
  validateOrganizationWorkspaceModel,
} from "../src/organization-workspace-model.mjs";

test("M0 record states the organization/workspace goal, personas, scope, and non-goals", () => {
  const result = validateOrganizationWorkspaceModel(ORGANIZATION_WORKSPACE_MODEL);

  assert.deepEqual(result.errors, []);
  assert.equal(ORGANIZATION_WORKSPACE_MODEL.issue, "HOBO-413");
  assert.equal(ORGANIZATION_WORKSPACE_MODEL.phase, "M0");
  assert.match(ORGANIZATION_WORKSPACE_MODEL.goal, /organization and workspace/i);
  assert.deepEqual(
    ORGANIZATION_WORKSPACE_MODEL.personas.map((persona) => persona.role),
    [
      "workspace admin",
      "platform engineer",
      "app developer",
      "support/operator",
    ],
  );
  assert.ok(ORGANIZATION_WORKSPACE_MODEL.scopeIn.length >= 5);
  assert.ok(ORGANIZATION_WORKSPACE_MODEL.scopeOut.length >= 5);
  assert.ok(ORGANIZATION_WORKSPACE_MODEL.nonGoals.length >= 3);
});

test("M0 record maps service, UX, security, and support boundaries", () => {
  assert.deepEqual(Object.keys(ORGANIZATION_WORKSPACE_MODEL.boundaries), [
    "service",
    "ux",
    "security",
    "support",
  ]);
  for (const [boundary, rule] of Object.entries(ORGANIZATION_WORKSPACE_MODEL.boundaries)) {
    assert.ok(rule.includes("Organization & Workspace Model"), `${boundary} boundary must name owning model`);
  }
});

test("M0 record cites authoritative design and ADR sources", () => {
  assert.deepEqual(
    ORGANIZATION_WORKSPACE_MODEL.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/architecture.md#plan-10",
      "docs/design/developer-experience.md#plan-07",
      "docs/design/security-networking.md#plan-50",
      "docs/design/adr/02-identity-security.md#adr-0074",
      "docs/design/adr/02-identity-security.md#adr-0079",
      "docs/design/adr/02-identity-security.md#adr-0080",
    ],
  );
});

test("M0 record maps owning initiative dependencies without taking adjacent scope", () => {
  assert.deepEqual(
    ORGANIZATION_WORKSPACE_MODEL.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Organization & Workspace Model",
      "Tenant Isolation & Quotas",
      "Member/RBAC Administration",
      "Settings & Project Lifecycle",
      "Workspace & Onboarding UX",
      "V1 Release Program & Cutline",
    ],
  );
  assert.equal(
    ORGANIZATION_WORKSPACE_MODEL.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M0 record lists M1 evidence required before design and contract proof", () => {
  assert.deepEqual(
    ORGANIZATION_WORKSPACE_MODEL.m1Evidence.map((evidence) => evidence.kind),
    [
      "domain-model",
      "membership-rbac-handshake",
      "tenant-quota-handshake",
      "project-lifecycle-handshake",
      "support-audit-export",
    ],
  );
  assert.equal(
    ORGANIZATION_WORKSPACE_MODEL.m1Evidence.every((evidence) => evidence.owner && evidence.proves),
    true,
  );
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateFollowUpIssue({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateFollowUpIssue({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateFollowUpIssue({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateFollowUpIssue({ phase: "M0", m0Accepted: true }), false);
});

test("scope validation rejects capability implementation and customer-data scope creep", () => {
  const result = validateOrganizationWorkspaceModel({
    ...ORGANIZATION_WORKSPACE_MODEL,
    scopeIn: [
      ...ORGANIZATION_WORKSPACE_MODEL.scopeIn,
      "Build production workspace invite flows with real customer data.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("workspace decisions route to the right adjacent owner", () => {
  assert.equal(classifyWorkspaceDecision("workspace invite approval"), "Member/RBAC Administration");
  assert.equal(classifyWorkspaceDecision("tenant quota exceeded"), "Tenant Isolation & Quotas");
  assert.equal(classifyWorkspaceDecision("project archived"), "Settings & Project Lifecycle");
  assert.equal(classifyWorkspaceDecision("first workspace activation"), "Workspace & Onboarding UX");
  assert.equal(classifyWorkspaceDecision("unsupported organization shape"), "Organization & Workspace Model");
});
