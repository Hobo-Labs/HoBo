import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_BOUNDARIES,
  SUPPORT_DEBUG_TOOLS_SCOPE,
  canCreateSupportDebugFollowUp,
  classifySupportDebugRequest,
  validateSupportDebugToolsScope,
} from "../src/support-debug-tools-scope.js";

test("M0 record states goal, personas, scope, non-goals, and operating boundaries", () => {
  const result = validateSupportDebugToolsScope(SUPPORT_DEBUG_TOOLS_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(SUPPORT_DEBUG_TOOLS_SCOPE.issue, "HOBO-426");
  assert.equal(SUPPORT_DEBUG_TOOLS_SCOPE.phase, "M0");
  assert.match(SUPPORT_DEBUG_TOOLS_SCOPE.goal, /support.*debug/i);
  assert.deepEqual(
    SUPPORT_DEBUG_TOOLS_SCOPE.personas.map((persona) => persona.role),
    [
      "support operator",
      "on-call responder",
      "workspace admin",
      "platform engineer",
      "security/compliance reviewer",
    ],
  );
  assert.deepEqual(Object.keys(SUPPORT_DEBUG_TOOLS_SCOPE.boundaries), REQUIRED_BOUNDARIES);
  assert.ok(SUPPORT_DEBUG_TOOLS_SCOPE.scopeIn.length >= 5);
  assert.ok(SUPPORT_DEBUG_TOOLS_SCOPE.scopeOut.length >= 6);
});

test("M0 record maps dependencies to authoritative design and ADR sources", () => {
  assert.deepEqual(
    SUPPORT_DEBUG_TOOLS_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/developer-experience.md#plan-07",
      "docs/design/developer-experience.md#plan-49",
      "docs/design/workspace-activation-telemetry-contract.md",
      "docs/design/admin-console.md",
      "docs/design/audit-explorer.md",
      "docs/design/support-sla-channels.md",
      "docs/design/launch-support-escalation.md",
      "docs/design/operators-sre.md#plan-40",
      "docs/design/data-plane.md#plan-11",
      "docs/design/adr/02-identity-security.md#adr-0074",
      "docs/design/adr/03-data-plane.md#adr-0050",
      "docs/design/adr/03-data-plane.md#adr-0058",
    ],
  );
});

test("M0 record maps owning initiative dependencies without taking their scope", () => {
  assert.deepEqual(
    SUPPORT_DEBUG_TOOLS_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Support & Debug Tools",
      "Admin Console",
      "Audit Explorer",
      "Support Workflow",
      "Operators/SRE",
      "Reliability/Observability/Cost",
      "Security Verification",
      "CLI/MCP & Developer Experience",
      "Data Plane",
    ],
  );
  assert.equal(
    SUPPORT_DEBUG_TOOLS_SCOPE.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M0 record lists evidence required before M1 design and contract proof", () => {
  assert.deepEqual(
    SUPPORT_DEBUG_TOOLS_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "diagnostic-bundle-contract",
      "redaction-and-no-secret-fixture",
      "recovery-route-matrix",
      "read-only-tool-intent",
      "incident-handoff-context",
      "replay-correlation-fixture",
      "follow-up-issue-gate",
    ],
  );
  assert.equal(
    SUPPORT_DEBUG_TOOLS_SCOPE.m1Evidence.every(
      (evidence) => evidence.owner && evidence.proofMode && evidence.proves,
    ),
    true,
  );
});

test("diagnostic bundle classes are tenant-scoped, redacted, and safe for support handoff", () => {
  assert.equal(
    SUPPORT_DEBUG_TOOLS_SCOPE.diagnosticBundleClasses.every((bundle) => bundle.redactionRequired),
    true,
  );
  assert.equal(
    SUPPORT_DEBUG_TOOLS_SCOPE.diagnosticBundleClasses.every((bundle) =>
      ["tenant", "project", "environment", "correlation-id"].every((field) =>
        bundle.safeFields.includes(field),
      ),
    ),
    true,
  );
  assert.equal(
    SUPPORT_DEBUG_TOOLS_SCOPE.diagnosticBundleClasses.some(
      (bundle) => bundle.id === "first-run-recovery",
    ),
    true,
  );
  assert.equal(JSON.stringify(SUPPORT_DEBUG_TOOLS_SCOPE).includes("provider secret"), false);
});

test("support recovery routes point to owners without executing remediation", () => {
  assert.deepEqual(
    SUPPORT_DEBUG_TOOLS_SCOPE.recoveryRoutes.map((route) => route.id),
    [
      "first-run-failure",
      "deploy-plan-rejected",
      "auth-or-policy-denied",
      "provider-or-network-drift",
      "incident-handoff",
    ],
  );
  assert.equal(
    SUPPORT_DEBUG_TOOLS_SCOPE.recoveryRoutes.every(
      (route) => route.owner && route.safeNextAction && route.mutationAllowed === false,
    ),
    true,
  );
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateSupportDebugFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateSupportDebugFollowUp({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateSupportDebugFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateSupportDebugFollowUp({ phase: "M0", m0Accepted: true }), false);
});

test("scope validation rejects UI, ticketing, runtime, remediation, credential, and RBAC creep", () => {
  const result = validateSupportDebugToolsScope({
    ...SUPPORT_DEBUG_TOOLS_SCOPE,
    scopeIn: [
      ...SUPPORT_DEBUG_TOOLS_SCOPE.scopeIn,
      "Build React screens, create support tickets, stream live logs, execute runbook remediation, read provider credentials, and enforce RBAC.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("support debug request routing keeps adjacent ownership explicit", () => {
  assert.deepEqual(classifySupportDebugRequest("assemble tenant diagnostic bundle by correlation id"), {
    owner: "Support & Debug Tools",
    inScope: true,
  });
  assert.deepEqual(classifySupportDebugRequest("build support UI screen"), {
    owner: "Admin Console",
    inScope: false,
  });
  assert.deepEqual(classifySupportDebugRequest("open helpdesk ticket queue with SLA"), {
    owner: "Support Workflow",
    inScope: false,
  });
  assert.deepEqual(classifySupportDebugRequest("restart service using runbook remediation"), {
    owner: "Operators/SRE",
    inScope: false,
  });
  assert.deepEqual(classifySupportDebugRequest("tail raw logs from event-store projector"), {
    owner: "Data Plane",
    inScope: false,
  });
  assert.deepEqual(classifySupportDebugRequest("read provider credential secret"), {
    owner: "Security Verification",
    inScope: false,
  });
});
