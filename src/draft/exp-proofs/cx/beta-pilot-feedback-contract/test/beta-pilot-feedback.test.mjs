import assert from "node:assert/strict";
import { test } from "vitest";

import {
  BETA_PILOT_FEEDBACK_CONTRACT,
  classifyFeedback,
  canGraduateToReleaseCandidate,
  validateBetaPilotFeedbackContract,
  validateFeedbackIntake
} from "../src/beta-pilot-feedback.mjs";

test("M0 contract defines cohort criteria, intake fields, triage routes, and RC exit criteria", () => {
  const result = validateBetaPilotFeedbackContract(BETA_PILOT_FEEDBACK_CONTRACT);

  assert.deepEqual(result.errors, []);
  assert.equal(BETA_PILOT_FEEDBACK_CONTRACT.issue, "HOBO-404");
  assert.equal(BETA_PILOT_FEEDBACK_CONTRACT.phase, "M0");
  assert.deepEqual(
    BETA_PILOT_FEEDBACK_CONTRACT.intake.requiredFields,
    ["persona", "environment", "workflow", "severity", "evidence", "customerImpact"]
  );
  assert.deepEqual(
    BETA_PILOT_FEEDBACK_CONTRACT.triageRoutes.map((route) => route.destination),
    ["cutline", "support", "product-ux", "docs", "capability-project"]
  );
});

test("cohort criteria include target fit, readiness, capacity, consent, and exclusion rules", () => {
  assert.deepEqual(
    BETA_PILOT_FEEDBACK_CONTRACT.cohortCriteria.map((criterion) => criterion.id),
    [
      "target-persona-fit",
      "workflow-readiness",
      "support-capacity",
      "feedback-consent",
      "exclusion-rules"
    ]
  );
  assert.equal(
    BETA_PILOT_FEEDBACK_CONTRACT.cohortCriteria.every((criterion) => criterion.owner && criterion.evidence),
    true
  );
});

test("feedback intake requires persona, environment, workflow, severity, evidence, and impact", () => {
  const valid = {
    persona: "platform engineer",
    environment: "hosted dogfood yard",
    workflow: "first deploy",
    severity: "high-risk-non-blocker",
    evidence: ["screen recording", "trace id trace-123"],
    customerImpact: "Blocks platform engineer confidence in preview deploys."
  };

  assert.deepEqual(validateFeedbackIntake(valid).errors, []);

  const missingImpact = { ...valid };
  delete missingImpact.customerImpact;

  assert.match(validateFeedbackIntake(missingImpact).errors.join("\n"), /customerImpact/);
});

test("triage maps beta feedback to cutline, support, product UX, docs, or capability owners", () => {
  assert.equal(classifyFeedback({ severity: "blocker", workflow: "go/no-go" }), "cutline");
  assert.equal(classifyFeedback({ severity: "support-request", workflow: "install" }), "support");
  assert.equal(classifyFeedback({ severity: "usability", workflow: "onboarding" }), "product-ux");
  assert.equal(classifyFeedback({ severity: "docs-gap", workflow: "upgrade" }), "docs");
  assert.equal(classifyFeedback({ severity: "capability-gap", workflow: "provider mapping" }), "capability-project");
});

test("release candidate exit requires resolved blockers, representative coverage, and evidence completeness", () => {
  assert.equal(
    canGraduateToReleaseCandidate({
      openBlockers: 0,
      targetPersonasCovered: ["app developer", "platform engineer", "support/operator"],
      requiredEvidenceComplete: true,
      unresolvedHighRiskAccepted: true
    }),
    true
  );
  assert.equal(
    canGraduateToReleaseCandidate({
      openBlockers: 1,
      targetPersonasCovered: ["app developer", "platform engineer", "support/operator"],
      requiredEvidenceComplete: true,
      unresolvedHighRiskAccepted: true
    }),
    false
  );
});

test("scope guards reject customer onboarding and general feedback infrastructure creep", () => {
  const invalid = structuredClone(BETA_PILOT_FEEDBACK_CONTRACT);
  invalid.scopeIn.push("Onboard the first ten beta customers and build a general feedback portal.");

  const result = validateBetaPilotFeedbackContract(invalid);

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("scope guards reject beta customer onboarding even without feedback infrastructure", () => {
  const invalid = structuredClone(BETA_PILOT_FEEDBACK_CONTRACT);
  invalid.scopeIn.push("Onboard the first ten beta customers.");

  const result = validateBetaPilotFeedbackContract(invalid);

  assert.match(result.errors.join("\n"), /scope creep/i);
});
