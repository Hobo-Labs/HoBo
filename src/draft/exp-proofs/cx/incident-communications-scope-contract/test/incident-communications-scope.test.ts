import assert from "node:assert/strict";
import { test } from "vitest";

import {
  INCIDENT_COMMUNICATIONS_SCOPE,
  REQUIRED_BOUNDARIES,
  REQUIRED_DEPENDENCY_TARGETS,
  canCreateIncidentCommunicationFollowUp,
  canPublishIncidentCommunication,
  classifyIncidentCommunicationRequest,
  validateIncidentCommunicationsScope,
} from "../src/incident-communications-scope.ts";

function cloneScope() {
  return structuredClone(INCIDENT_COMMUNICATIONS_SCOPE);
}

test("HOBO-450 M0 record states goal, personas, scope, non-goals, and boundaries", () => {
  assert.deepEqual(validateIncidentCommunicationsScope(INCIDENT_COMMUNICATIONS_SCOPE), {
    ok: true,
    errors: [],
  });
  assert.equal(INCIDENT_COMMUNICATIONS_SCOPE.issue, "HOBO-450");
  assert.equal(INCIDENT_COMMUNICATIONS_SCOPE.project, "Incident Communications");
  assert.equal(INCIDENT_COMMUNICATIONS_SCOPE.phase, "M0");
  assert.match(INCIDENT_COMMUNICATIONS_SCOPE.goal, /incident communications/i);
  assert.deepEqual(
    INCIDENT_COMMUNICATIONS_SCOPE.personas.map((persona) => persona.id),
    [
      "incident-commander",
      "support-lead",
      "customer-admin",
      "sre-operator",
      "release-owner",
      "security-compliance-reviewer",
    ],
  );
  assert.deepEqual(
    INCIDENT_COMMUNICATIONS_SCOPE.boundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_BOUNDARIES].sort(),
  );
  assert.equal(
    INCIDENT_COMMUNICATIONS_SCOPE.scopeOut.some((item) => /live notification dispatch/i.test(item)),
    true,
  );
});

test("communication surfaces, incident states, templates, and evidence gates are explicit", () => {
  assert.deepEqual(
    INCIDENT_COMMUNICATIONS_SCOPE.communicationSurfaces.map((surface) => surface.id),
    [
      "public-status-page",
      "named-customer-update",
      "support-ticket-handoff",
      "internal-launch-room",
      "release-notes-limitation",
    ],
  );
  assert.deepEqual(
    INCIDENT_COMMUNICATIONS_SCOPE.incidentStates.map((state) => state.id),
    ["candidate", "investigating", "identified", "monitoring", "resolved", "follow-up"],
  );
  assert.deepEqual(
    INCIDENT_COMMUNICATIONS_SCOPE.templateKinds.map((template) => template.id),
    ["initial-notice", "progress-update", "maintenance-notice", "resolution-summary", "limitation-note"],
  );
  assert.equal(
    INCIDENT_COMMUNICATIONS_SCOPE.templateKinds.every(
      (template) => template.requiredFields.includes("communication_id") && template.redactionGate,
    ),
    true,
  );
});

test("dependency map and M1 evidence cover service, UX, security, and support owners", () => {
  assert.deepEqual(
    INCIDENT_COMMUNICATIONS_SCOPE.dependencies.map((dependency) => dependency.target),
    REQUIRED_DEPENDENCY_TARGETS,
  );
  assert.equal(INCIDENT_COMMUNICATIONS_SCOPE.m1Evidence.length >= 6, true);
  assert.deepEqual(
    new Set(INCIDENT_COMMUNICATIONS_SCOPE.m1Evidence.map((evidence) => evidence.boundary)),
    new Set(["service", "ux", "security", "support"]),
  );
});

test("M1-M4 follow-up work remains blocked until M0 scope acceptance", () => {
  assert.equal(canCreateIncidentCommunicationFollowUp({ phase: "M1", m0Accepted: false }).allowed, false);
  assert.equal(canCreateIncidentCommunicationFollowUp({ phase: "M4", m0Accepted: false }).allowed, false);
  assert.equal(canCreateIncidentCommunicationFollowUp({ phase: "M1", m0Accepted: true }).allowed, true);
  assert.equal(canCreateIncidentCommunicationFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("customer-visible communication publication requires evidence, redaction, and no SLA/customer-data leakage", () => {
  assert.equal(
    canPublishIncidentCommunication({
      audience: "customer-visible",
      evidenceAccepted: false,
      redactionApproved: true,
      customerDataIncluded: false,
      contractualSlaIncluded: false,
    }).allowed,
    false,
  );
  assert.equal(
    canPublishIncidentCommunication({
      audience: "customer-visible",
      evidenceAccepted: true,
      redactionApproved: false,
      customerDataIncluded: false,
      contractualSlaIncluded: false,
    }).allowed,
    false,
  );
  assert.equal(
    canPublishIncidentCommunication({
      audience: "customer-visible",
      evidenceAccepted: true,
      redactionApproved: true,
      customerDataIncluded: true,
      contractualSlaIncluded: false,
    }).allowed,
    false,
  );
  assert.equal(
    canPublishIncidentCommunication({
      audience: "customer-visible",
      evidenceAccepted: true,
      redactionApproved: true,
      customerDataIncluded: false,
      contractualSlaIncluded: true,
    }).allowed,
    false,
  );
  assert.equal(
    canPublishIncidentCommunication({
      audience: "customer-visible",
      evidenceAccepted: true,
      redactionApproved: true,
      customerDataIncluded: false,
      contractualSlaIncluded: false,
    }).allowed,
    true,
  );
});

test("validation rejects live publishing, notification dispatch, ticket automation, runbook execution, SLA promises, and customer data", () => {
  const result = validateIncidentCommunicationsScope({
    ...cloneScope(),
    scopeIn: [
      ...INCIDENT_COMMUNICATIONS_SCOPE.scopeIn,
      "Implement live notification dispatch, ticket automation, runbook execution, and a 15 minute customer SLA with customer_email in templates.",
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /live notification dispatch/i);
  assert.match(result.errors.join("\n"), /ticket automation/i);
  assert.match(result.errors.join("\n"), /runbook execution/i);
  assert.match(result.errors.join("\n"), /SLA/i);
  assert.match(result.errors.join("\n"), /customer data/i);
});

test("request classifier routes adjacent work to owning lanes instead of expanding HOBO-450", () => {
  assert.deepEqual(classifyIncidentCommunicationRequest("define customer-safe incident communication scope"), {
    owner: "Incident Communications",
    inScope: true,
  });
  assert.equal(classifyIncidentCommunicationRequest("build status page publishing workflow").owner, "Public Status Page");
  assert.equal(classifyIncidentCommunicationRequest("approve contractual response SLA").owner, "Business Owner / Legal");
  assert.equal(classifyIncidentCommunicationRequest("wire support ticket automation").owner, "Support Workflow");
  assert.equal(classifyIncidentCommunicationRequest("execute incident runbook remediation").owner, "Operators/SRE");
  assert.equal(classifyIncidentCommunicationRequest("include private tenant data in update").owner, "Security Verification / Legal");
});
