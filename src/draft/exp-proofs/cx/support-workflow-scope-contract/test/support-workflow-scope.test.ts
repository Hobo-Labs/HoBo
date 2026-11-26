import assert from "node:assert/strict";
import { test } from "vitest";

const contract = await import("../src/support-workflow-scope.ts").catch(() => null);

test("M0 support workflow record states goal, personas, scope, non-goals, and boundaries", () => {
  assert.ok(contract, "support workflow scope module should exist");

  const {
    REQUIRED_BOUNDARIES,
    SUPPORT_WORKFLOW_SCOPE,
    validateSupportWorkflowScope,
  } = contract;

  assert.deepEqual(validateSupportWorkflowScope(SUPPORT_WORKFLOW_SCOPE), {
    ok: true,
    errors: [],
  });
  assert.equal(SUPPORT_WORKFLOW_SCOPE.issue, "HOBO-448");
  assert.equal(SUPPORT_WORKFLOW_SCOPE.project, "Support Workflow");
  assert.equal(SUPPORT_WORKFLOW_SCOPE.phase, "M0");
  assert.match(SUPPORT_WORKFLOW_SCOPE.goal, /support workflow/i);
  assert.match(SUPPORT_WORKFLOW_SCOPE.goal, /triage/i);
  assert.deepEqual(
    SUPPORT_WORKFLOW_SCOPE.personas.map((persona: { id: string }) => persona.id),
    [
      "support-lead",
      "support-operator",
      "customer-admin",
      "incident-commander",
      "release-owner",
      "security-compliance-reviewer",
    ],
  );
  assert.deepEqual(
    SUPPORT_WORKFLOW_SCOPE.boundaries.map((boundary: { id: string }) => boundary.id).sort(),
    [...REQUIRED_BOUNDARIES].sort(),
  );
  assert.ok(SUPPORT_WORKFLOW_SCOPE.scopeOut.some((item: string) => /helpdesk/i.test(item)));
});

test("support workflow intake states and evidence fields are explicit", () => {
  assert.ok(contract, "support workflow scope module should exist");

  const { SUPPORT_WORKFLOW_SCOPE } = contract;

  assert.deepEqual(
    SUPPORT_WORKFLOW_SCOPE.intakeStates.map((state: { id: string }) => state.id),
    ["received", "classified", "evidence-linked", "owner-routed", "customer-updated", "closed"],
  );
  assert.deepEqual(
    SUPPORT_WORKFLOW_SCOPE.requiredEvidence.map((field: { id: string }) => field.id),
    [
      "requester",
      "customer-safe-summary",
      "severity",
      "affected-surface",
      "owner-route",
      "evidence-links",
      "redaction-state",
      "next-update-condition",
    ],
  );
});

test("owning initiative dependencies and M1 evidence are mapped", () => {
  assert.ok(contract, "support workflow scope module should exist");

  const { SUPPORT_WORKFLOW_SCOPE } = contract;

  assert.ok(
    SUPPORT_WORKFLOW_SCOPE.designRefs.includes("docs/design/support-sla-channels.md"),
  );
  assert.ok(
    SUPPORT_WORKFLOW_SCOPE.designRefs.includes("docs/design/launch-support-escalation.md"),
  );
  assert.ok(
    SUPPORT_WORKFLOW_SCOPE.initiativeDependencies.some(
      (dependency: { owner: string; boundary: string }) =>
        dependency.owner === "Admin Console" && /tenant/i.test(dependency.boundary),
    ),
  );
  assert.deepEqual(
    SUPPORT_WORKFLOW_SCOPE.m1Evidence.map((evidence: { id: string }) => evidence.id),
    [
      "support-intake-schema",
      "triage-state-machine",
      "customer-safe-evidence-pack",
      "owner-route-matrix",
      "redaction-and-access-guard",
      "scope-boundary-register",
    ],
  );
});

test("M1-M4 follow-up work is blocked until M0 support workflow acceptance exists", () => {
  assert.ok(contract, "support workflow scope module should exist");

  const { canCreateSupportWorkflowFollowUp } = contract;

  assert.equal(canCreateSupportWorkflowFollowUp({ phase: "M1", m0Accepted: false }).allowed, false);
  assert.equal(canCreateSupportWorkflowFollowUp({ phase: "M4", m0Accepted: false }).allowed, false);
  assert.equal(canCreateSupportWorkflowFollowUp({ phase: "M1", m0Accepted: true }).allowed, true);
  assert.equal(canCreateSupportWorkflowFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("validation rejects helpdesk automation, customer data access, SLA promises, and incident-command creep", () => {
  assert.ok(contract, "support workflow scope module should exist");

  const { SUPPORT_WORKFLOW_SCOPE, validateSupportWorkflowScope } = contract;

  const result = validateSupportWorkflowScope({
    ...SUPPORT_WORKFLOW_SCOPE,
    scopeIn: [
      ...SUPPORT_WORKFLOW_SCOPE.scopeIn,
      "Build helpdesk queue automation, grant production customer data access, guarantee a 15 minute SLA, and run incident command here.",
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /helpdesk/i);
  assert.match(result.errors.join("\n"), /customer data/i);
  assert.match(result.errors.join("\n"), /sla/i);
  assert.match(result.errors.join("\n"), /incident/i);
});

test("decision classifier routes adjacent work to owning initiatives", () => {
  assert.ok(contract, "support workflow scope module should exist");

  const { classifySupportWorkflowDecision } = contract;

  assert.deepEqual(classifySupportWorkflowDecision("define support intake triage record"), {
    owner: "Support Workflow",
    inScope: true,
  });
  assert.equal(
    classifySupportWorkflowDecision("build helpdesk ticket automation").owner,
    "Support Tooling",
  );
  assert.equal(
    classifySupportWorkflowDecision("publish incident status page update").owner,
    "Incident Communications",
  );
  assert.equal(
    classifySupportWorkflowDecision("show tenant entitlement context in admin console").owner,
    "Admin Console",
  );
  assert.equal(
    classifySupportWorkflowDecision("approve contractual support SLA language").owner,
    "Business Owner / Legal",
  );
});
