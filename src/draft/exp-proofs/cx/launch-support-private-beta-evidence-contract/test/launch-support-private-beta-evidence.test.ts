import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_PRIVATE_BETA_SUPPORT_EVIDENCE_IDS,
  assertLaunchSupportPrivateBetaEvidence,
  launchSupportPrivateBetaEvidence,
  validateLaunchSupportPrivateBetaEvidence
} from "../src/launch-support-private-beta-evidence.js";

test("M2 private beta support evidence records owners, blockers, risks, dependencies, follow-ups, and parent sync", () => {
  const result = validateLaunchSupportPrivateBetaEvidence(launchSupportPrivateBetaEvidence);

  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(launchSupportPrivateBetaEvidence.issue, "HOBO-467");
  assert.equal(launchSupportPrivateBetaEvidence.phase, "M2");
  assert.equal(launchSupportPrivateBetaEvidence.milestoneGate, "M2 Private beta proof");

  const evidenceIds = launchSupportPrivateBetaEvidence.requiredEvidence.map((item) => item.id);
  for (const evidenceId of REQUIRED_PRIVATE_BETA_SUPPORT_EVIDENCE_IDS) {
    assert.ok(evidenceIds.includes(evidenceId), `${evidenceId} missing`);
  }

  assert.ok(launchSupportPrivateBetaEvidence.requiredEvidence.every((item) => item.ownerProject));
  assert.ok(launchSupportPrivateBetaEvidence.blockers.length > 0);
  assert.ok(launchSupportPrivateBetaEvidence.acceptedRisks.length > 0);
  assert.ok(launchSupportPrivateBetaEvidence.crossProjectDependencies.length > 0);
  assert.ok(
    launchSupportPrivateBetaEvidence.followUpIssues.every((item) =>
      launchSupportPrivateBetaEvidence.missingEvidence.some((missing) => missing.id === item.missingEvidenceId)
    )
  );
  assert.equal(launchSupportPrivateBetaEvidence.parentInitiativeSync.statusUpdated, true);
});

test("M2 private beta support guard rejects pending evidence, speculative follow-ups, and unsynced launch risk", () => {
  const invalid = structuredClone(launchSupportPrivateBetaEvidence);
  invalid.requiredEvidence.find((item) => item.id === "support-workflow-intake").status = "pending";
  invalid.followUpIssues.push({
    id: "speculative-support-tooling",
    ownerProject: "V1 Launch Support Desk & Escalation",
    missingEvidenceId: "support-escalation-baseline",
    allowedReason: "Create support tooling even though the baseline evidence is accepted"
  });
  invalid.parentInitiativeSync.statusUpdated = false;

  const result = validateLaunchSupportPrivateBetaEvidence(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /support-workflow-intake must be accepted/);
  assert.match(result.errors.join("\n"), /follow-up is allowed only for missing evidence/);
  assert.match(result.errors.join("\n"), /parent initiative status must be updated/);
  assert.throws(() => assertLaunchSupportPrivateBetaEvidence(invalid), /launch support private beta evidence invalid/);
});

test("M2 private beta support guard rejects public SLA promises and runtime implementation claims", () => {
  const invalid = structuredClone(launchSupportPrivateBetaEvidence);
  invalid.customerCommitments.publicSlaPromised = true;
  invalid.scopeBoundary.implementsSupportRuntime = true;
  invalid.scopeBoundary.implementsTicketQueue = true;
  invalid.scopeBoundary.publishesStatusPage = true;
  invalid.scopeBoundary.usesCustomerData = true;
  invalid.scopeBoundary.approvesCommercialTerms = true;

  const result = validateLaunchSupportPrivateBetaEvidence(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /public SLA promises require GA evidence and business-owner signoff/);
  assert.match(result.errors.join("\n"), /support runtime implementation is out of scope/);
  assert.match(result.errors.join("\n"), /support ticket queue implementation is out of scope/);
  assert.match(result.errors.join("\n"), /status-page publication is out of scope/);
  assert.match(result.errors.join("\n"), /customer data access is out of scope/);
  assert.match(result.errors.join("\n"), /commercial terms approval is out of scope/);
});
