import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_RELEASE_CANDIDATE_EVIDENCE_IDS,
  assertLegalPrivacyReleaseCandidateEvidence,
  legalPrivacyReleaseCandidateEvidence,
  validateLegalPrivacyReleaseCandidateEvidence
} from "../src/legal-privacy-release-candidate-evidence.js";

test("M3 legal/privacy release-candidate evidence maps required evidence to owning projects", () => {
  const result = validateLegalPrivacyReleaseCandidateEvidence(legalPrivacyReleaseCandidateEvidence);

  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(legalPrivacyReleaseCandidateEvidence.issue, "HOBO-471");
  assert.equal(legalPrivacyReleaseCandidateEvidence.parentIssue, "HOBO-405");
  assert.equal(legalPrivacyReleaseCandidateEvidence.phase, "M3");
  assert.equal(legalPrivacyReleaseCandidateEvidence.milestoneGate, "M3 Release candidate");

  const evidenceIds = legalPrivacyReleaseCandidateEvidence.requiredEvidence.map((item) => item.id);
  assert.deepEqual([...evidenceIds].sort(), [...REQUIRED_RELEASE_CANDIDATE_EVIDENCE_IDS].sort());
  assert.ok(legalPrivacyReleaseCandidateEvidence.requiredEvidence.every((item) => item.ownerProject));
  assert.ok(legalPrivacyReleaseCandidateEvidence.requiredEvidence.every((item) => item.evidenceSource));
});

test("M3 gate records blockers, accepted risks, release cutline dependencies, follow-ups, and parent sync", () => {
  assertLegalPrivacyReleaseCandidateEvidence();

  assert.ok(legalPrivacyReleaseCandidateEvidence.blockers.length >= 2);
  assert.ok(legalPrivacyReleaseCandidateEvidence.acceptedRisks.length >= 2);
  assert.ok(legalPrivacyReleaseCandidateEvidence.crossProjectDependencies.length >= 5);
  assert.ok(legalPrivacyReleaseCandidateEvidence.followUpIssues.length >= 1);
  assert.equal(legalPrivacyReleaseCandidateEvidence.parentInitiativeSync.statusUpdated, true);
  assert.equal(legalPrivacyReleaseCandidateEvidence.releaseCutlineReflection.limitationsAreVisible, true);
});

test("follow-up execution issues are allowed only for missing evidence", () => {
  const invalid = structuredClone(legalPrivacyReleaseCandidateEvidence);
  invalid.followUpIssues.push({
    id: "HOBO-999",
    ownerProject: "V1 Launch Site, Messaging & Demo Assets",
    missingEvidenceId: "privacy-release-candidate-review",
    allowedReason: "Speculative work for evidence that was already accepted"
  });

  const result = validateLegalPrivacyReleaseCandidateEvidence(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /follow-up is allowed only for missing evidence/);
});

test("release-candidate evidence rejects unaccepted required evidence and unsynced launch risk", () => {
  const invalid = structuredClone(legalPrivacyReleaseCandidateEvidence);
  invalid.requiredEvidence.find((item) => item.id === "subprocessor-provider-release-candidate-register")!.status = "pending";
  invalid.parentInitiativeSync.statusUpdated = false;

  const result = validateLegalPrivacyReleaseCandidateEvidence(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /subprocessor-provider-release-candidate-register must be accepted/);
  assert.match(result.errors.join("\n"), /parent initiative status must be updated/);
});

test("scope guard rejects final legal text, paid GA approval, and unsupported public claims", () => {
  const invalid = structuredClone(legalPrivacyReleaseCandidateEvidence);
  invalid.customerClaimPolicy.unsupportedPublicClaims.push("HoBo has final terms approved for paid GA in all regions.");
  invalid.customerClaimPolicy.scopeOut.push("Draft final customer terms and DPA language.");
  invalid.customerClaimPolicy.scopeOut.push("Approve paid GA legal launch.");

  const result = validateLegalPrivacyReleaseCandidateEvidence(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /unsupported public claim/);
  assert.match(result.errors.join("\n"), /final legal text is scope-out/);
  assert.match(result.errors.join("\n"), /paid GA approval is scope-out/);
});
