import assert from "node:assert/strict";
import { test } from "vitest";

import {
  canOpenSupportExecutionIssue,
  launchSupportEscalationMatrix,
  requiredLaunchSupportRoutes,
  validateLaunchSupportEscalationMatrix,
} from "../src/launch-support-escalation.js";

function cloneRecord() {
  return structuredClone(launchSupportEscalationMatrix);
}

function assertValid(record = launchSupportEscalationMatrix) {
  const result = validateLaunchSupportEscalationMatrix(record);
  assert.equal(result.valid, true, result.errors.join("\n"));
}

test("HOBO-408 M0 record names launch goal, personas, refs, and hard scope boundaries", () => {
  assertValid();

  assert.equal(launchSupportEscalationMatrix.issue, "HOBO-408");
  assert.equal(launchSupportEscalationMatrix.phase, "M0");
  assert.match(launchSupportEscalationMatrix.goal, /launch support/i);
  assert.deepEqual(
    launchSupportEscalationMatrix.personas.map((persona) => persona.role),
    [
      "support-lead",
      "incident-commander",
      "first-responder",
      "customer-communications-owner",
      "release-owner",
    ],
  );
  assert.ok(
    launchSupportEscalationMatrix.designRefs.includes("docs/design/operators-sre.md#plan-40"),
  );
  assert.ok(
    launchSupportEscalationMatrix.designRefs.includes(
      "docs/design/developer-experience.md#plan-49",
    ),
  );
  assert.ok(
    launchSupportEscalationMatrix.scopeOut.includes("Support tooling implementation"),
  );
  assert.ok(
    launchSupportEscalationMatrix.scopeOut.includes(
      "Customer-facing response SLA commitments without owner approval",
    ),
  );
});

test("escalation matrix covers required columns for every severity level", () => {
  assert.deepEqual(
    launchSupportEscalationMatrix.severityLevels.map((level) => level.id),
    ["sev0", "sev1", "sev2", "sev3"],
  );

  for (const severity of launchSupportEscalationMatrix.severityLevels) {
    assert.ok(severity.label);
    assert.ok(severity.firstResponder);
    assert.ok(severity.escalationOwner);
    assert.ok(severity.expectedResponse);
    assert.ok(severity.customerCommunication.channel);
    assert.ok(severity.customerCommunication.requiredFields.length > 0);
    assert.ok(severity.customerCommunication.redactionGate);
    assert.ok(severity.handoffCriteria.length > 0);
  }
});

test("support and debug tooling prerequisites plus incident templates are explicit", () => {
  assert.deepEqual(
    launchSupportEscalationMatrix.toolingPrerequisites.map((item) => item.area),
    [
      "observability-access",
      "incident-timeline",
      "tenant-context",
      "status-page-redaction",
      "runbook-notification",
      "release-feature-context",
    ],
  );

  assert.deepEqual(
    launchSupportEscalationMatrix.communicationTemplates.map((template) => template.kind),
    ["initial-ack", "investigation-update", "mitigation-update", "resolution-followup"],
  );

  for (const template of launchSupportEscalationMatrix.communicationTemplates) {
    assert.ok(template.audience);
    assert.ok(template.channel);
    assert.ok(template.body.includes("{{incident_id}}"));
    assert.equal(template.redactionGate, true);
    assert.ok(template.evidenceSource);
  }
});

test("known launch support gaps route to owning project lanes", () => {
  assert.deepEqual(
    launchSupportEscalationMatrix.gapRoutes.map((route) => route.ownerLane),
    requiredLaunchSupportRoutes,
  );
  assert.ok(
    launchSupportEscalationMatrix.gapRoutes.every((route) => route.followUpProject),
  );
});

test("follow-up execution remains blocked until the M0 record is accepted", () => {
  assert.deepEqual(canOpenSupportExecutionIssue({ acceptedAt: null }), {
    allowed: false,
    reason: "HOBO-408 M0 support escalation record is not accepted.",
  });

  assert.deepEqual(
    canOpenSupportExecutionIssue({ acceptedAt: "2026-06-29T12:00:00.000Z" }),
    {
      allowed: true,
      reason: "Support execution issue may reference the accepted HOBO-408 record.",
    },
  );
});

test("validation rejects customer-facing SLA promises without owner approval", () => {
  const record = cloneRecord();
  record.severityLevels[0].expectedResponse = "15 minute customer response SLA";

  const result = validateLaunchSupportEscalationMatrix(record);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /owner approval/i);
});

test("validation rejects support-tooling implementation scope creep", () => {
  const record = cloneRecord();
  record.scopeIn.push("Build support ticket automation and incident tooling now");

  const result = validateLaunchSupportEscalationMatrix(record);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /support tooling implementation/i);
});

test("validation rejects incident templates without redaction and evidence gates", () => {
  const record = cloneRecord();
  record.communicationTemplates[1].redactionGate = false;
  record.communicationTemplates[1].evidenceSource = "";

  const result = validateLaunchSupportEscalationMatrix(record);
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /redaction/i);
  assert.match(result.errors.join("\n"), /evidence/i);
});
