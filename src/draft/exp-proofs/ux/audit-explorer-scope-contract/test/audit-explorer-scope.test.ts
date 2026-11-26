import assert from "node:assert/strict";
import { test } from "vitest";

import {
  AUDIT_EXPLORER_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreateAuditExplorerFollowUp,
  classifyAuditExplorerRequest,
  validateAuditExplorerScope,
} from "../src/audit-explorer-scope.ts";

test("M0 record states goal, personas, scope, non-goals, and operating boundaries", () => {
  const result = validateAuditExplorerScope(AUDIT_EXPLORER_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(AUDIT_EXPLORER_SCOPE.issue, "HOBO-427");
  assert.equal(AUDIT_EXPLORER_SCOPE.phase, "M0");
  assert.match(AUDIT_EXPLORER_SCOPE.goal, /audit explorer/i);
  assert.deepEqual(
    AUDIT_EXPLORER_SCOPE.personas.map((persona) => persona.role),
    [
      "security/compliance reviewer",
      "support operator",
      "workspace admin",
      "platform engineer",
      "governance lead",
    ],
  );
  assert.deepEqual(Object.keys(AUDIT_EXPLORER_SCOPE.boundaries), REQUIRED_BOUNDARIES);
  assert.ok(AUDIT_EXPLORER_SCOPE.scopeIn.length >= 5);
  assert.ok(AUDIT_EXPLORER_SCOPE.scopeOut.length >= 5);
});

test("M0 record maps dependencies to authoritative design and ADR sources", () => {
  assert.deepEqual(
    AUDIT_EXPLORER_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/developer-experience.md#plan-07",
      "docs/design/developer-experience.md#plan-49",
      "docs/design/data-plane.md#plan-11",
      "docs/design/contracts-policy-flags.md#plan-29",
      "docs/design/ai-native-agent-auth.md#plan-06",
      "docs/design/governance-planes.md#plan-46",
      "docs/design/adr/02-identity-security.md#adr-0046",
      "docs/design/adr/02-identity-security.md#adr-0074",
      "docs/design/adr/02-identity-security.md#adr-0077",
      "docs/design/adr/03-data-plane.md#adr-0050",
    ],
  );
});

test("M0 record maps owning initiative dependencies without taking their scope", () => {
  assert.deepEqual(
    AUDIT_EXPLORER_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Audit Explorer",
      "Admin Console",
      "Support Workflow",
      "Security Verification",
      "Governance/Compliance Evidence",
      "Data Plane",
      "CLI/MCP & Developer Experience",
      "Identity/Auth",
    ],
  );
  assert.equal(
    AUDIT_EXPLORER_SCOPE.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M0 record lists evidence required before M1 design and contract proof", () => {
  assert.deepEqual(
    AUDIT_EXPLORER_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "audit-fact-class-register",
      "query-filter-contract",
      "redaction-and-no-secret-fixture",
      "export-evidence-manifest",
      "support-handoff-context",
      "replay-reconstruction-fixture",
      "follow-up-issue-gate",
    ],
  );
  assert.equal(
    AUDIT_EXPLORER_SCOPE.m1Evidence.every(
      (evidence) => evidence.owner && evidence.proofMode && evidence.proves,
    ),
    true,
  );
});

test("audit read model and export shape preserve tenant-first filtering and no secret exposure", () => {
  assert.deepEqual(AUDIT_EXPLORER_SCOPE.queryFilterAxes.slice(0, 2), ["tenant", "project"]);
  assert.equal(
    AUDIT_EXPLORER_SCOPE.auditFactClasses.every((fact) => fact.eventFamilies.length > 0),
    true,
  );
  assert.equal(
    AUDIT_EXPLORER_SCOPE.auditFactClasses.some((fact) => fact.id === "credential-audit"),
    true,
  );
  assert.equal(
    AUDIT_EXPLORER_SCOPE.exportEvidence.every((evidence) => evidence.redacted === true),
    true,
  );
  assert.equal(JSON.stringify(AUDIT_EXPLORER_SCOPE).includes("raw secret"), false);
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateAuditExplorerFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateAuditExplorerFollowUp({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateAuditExplorerFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateAuditExplorerFollowUp({ phase: "M0", m0Accepted: true }), false);
});

test("scope validation rejects UI, runtime, export-service, RBAC, and live-data creep", () => {
  const result = validateAuditExplorerScope({
    ...AUDIT_EXPLORER_SCOPE,
    scopeIn: [
      ...AUDIT_EXPLORER_SCOPE.scopeIn,
      "Build Audit Explorer React screens, event-store projector runtime, SIEM export service, RBAC enforcement, and raw customer data search.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("audit explorer request routing keeps adjacent ownership explicit", () => {
  assert.deepEqual(classifyAuditExplorerRequest("filter replayable audit trail by tenant and actor"), {
    owner: "Audit Explorer",
    inScope: true,
  });
  assert.deepEqual(classifyAuditExplorerRequest("build Audit Explorer UI screen"), {
    owner: "Admin Console",
    inScope: false,
  });
  assert.deepEqual(classifyAuditExplorerRequest("open support ticket SLA workflow"), {
    owner: "Support Workflow",
    inScope: false,
  });
  assert.deepEqual(classifyAuditExplorerRequest("enforce RBAC policy role binding"), {
    owner: "Security Verification",
    inScope: false,
  });
  assert.deepEqual(classifyAuditExplorerRequest("implement event-store projector and search index"), {
    owner: "Data Plane",
    inScope: false,
  });
  assert.deepEqual(classifyAuditExplorerRequest("export provider credential secret"), {
    owner: "Security Verification",
    inScope: false,
  });
});
