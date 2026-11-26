import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_PRIVATE_BETA_EVIDENCE_IDS,
  assertLegalPrivacyPrivateBetaEvidence,
  legalPrivacyPrivateBetaEvidence,
  validateLegalPrivacyPrivateBetaEvidence
} from "../src/legal-privacy-private-beta-evidence.js";

test("M2 private beta legal/privacy evidence maps required evidence to owning projects", () => {
  const result = validateLegalPrivacyPrivateBetaEvidence(legalPrivacyPrivateBetaEvidence);

  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(legalPrivacyPrivateBetaEvidence.issue, "HOBO-464");
  assert.equal(legalPrivacyPrivateBetaEvidence.phase, "M2");
  assert.equal(legalPrivacyPrivateBetaEvidence.milestoneGate, "M2 Private beta proof");

  const evidenceIds = legalPrivacyPrivateBetaEvidence.requiredEvidence.map((item) => item.id);
  assert.deepEqual([...evidenceIds].sort(), [...REQUIRED_PRIVATE_BETA_EVIDENCE_IDS].sort());
  assert.ok(legalPrivacyPrivateBetaEvidence.requiredEvidence.every((item) => item.ownerProject));
});

test("M2 private beta gate records blockers, accepted risks, dependencies, follow-ups, and parent sync", () => {
  assertLegalPrivacyPrivateBetaEvidence();

  assert.ok(legalPrivacyPrivateBetaEvidence.blockers.length > 0);
  assert.ok(legalPrivacyPrivateBetaEvidence.acceptedRisks.length > 0);
  assert.ok(legalPrivacyPrivateBetaEvidence.crossProjectDependencies.length > 0);
  assert.ok(legalPrivacyPrivateBetaEvidence.followUpIssues.length > 0);
  assert.equal(legalPrivacyPrivateBetaEvidence.parentInitiativeSync.statusUpdated, true);
});

test("follow-up issues are allowed only for missing evidence", () => {
  const result = validateLegalPrivacyPrivateBetaEvidence({
    ...legalPrivacyPrivateBetaEvidence,
    followUpIssues: [
      ...legalPrivacyPrivateBetaEvidence.followUpIssues,
      {
        id: "HOBO-999",
        ownerProject: "V1 Launch Site, Messaging & Demo Assets",
        missingEvidenceId: "privacy-notice-beta-review",
        allowedReason: "Speculative launch copy follow-up even though evidence is accepted"
      }
    ]
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /follow-up is allowed only for missing evidence/);
});

test("private beta evidence rejects unsupported claims, pending evidence, and unsynced launch risk", () => {
  const invalid = structuredClone(legalPrivacyPrivateBetaEvidence);
  invalid.requiredEvidence.find((item) => item.id === "subprocessor-provider-beta-register")!.status = "pending";
  invalid.customerClaimPolicy.unsupportedPublicClaims.push("HoBo is SOC2 certified for all regions.");
  invalid.parentInitiativeSync.statusUpdated = false;

  const result = validateLegalPrivacyPrivateBetaEvidence(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /subprocessor-provider-beta-register must be accepted/);
  assert.match(result.errors.join("\n"), /unsupported public claim/);
  assert.match(result.errors.join("\n"), /parent initiative status must be updated/);
});
