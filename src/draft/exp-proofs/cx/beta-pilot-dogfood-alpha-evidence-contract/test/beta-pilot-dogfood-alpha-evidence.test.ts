import assert from "node:assert/strict";
import { test } from "vitest";

import {
  BETA_PILOT_FEEDBACK_CONTRACT
} from "../../../cx/beta-pilot-feedback-contract/src/beta-pilot-feedback.mjs";
import {
  REQUIRED_DOGFOOD_ALPHA_EVIDENCE,
  betaPilotDogfoodAlphaEvidence,
  canAcceptDogfoodAlphaGate,
  validateDogfoodAlphaEvidence
} from "../src/beta-pilot-dogfood-alpha-evidence.js";

test("dogfood/alpha record consumes the M0 beta feedback contract and lists required phase evidence", () => {
  const result = validateDogfoodAlphaEvidence(betaPilotDogfoodAlphaEvidence);

  assert.deepEqual(result.errors, []);
  assert.equal(betaPilotDogfoodAlphaEvidence.issue, "HOBO-456");
  assert.equal(betaPilotDogfoodAlphaEvidence.phase, "M1");
  assert.equal(betaPilotDogfoodAlphaEvidence.sourceContract.issue, BETA_PILOT_FEEDBACK_CONTRACT.issue);
  assert.deepEqual(
    betaPilotDogfoodAlphaEvidence.requiredIntakeFields,
    BETA_PILOT_FEEDBACK_CONTRACT.intake.requiredFields
  );
  assert.deepEqual(
    betaPilotDogfoodAlphaEvidence.requiredEvidence.map((item) => item.id),
    REQUIRED_DOGFOOD_ALPHA_EVIDENCE
  );
});

test("required evidence maps to owner projects and accepted evidence links", () => {
  for (const item of betaPilotDogfoodAlphaEvidence.requiredEvidence) {
    assert.ok(item.ownerProject, `${item.id} must have ownerProject`);
    assert.ok(item.acceptedEvidence.length > 0, `${item.id} must have accepted evidence`);
    assert.equal(item.status, "accepted", `${item.id} should be accepted for the M1 gate`);
  }
});

test("blockers and risks are routed through cutline, support, docs, product UX, or capability owners", () => {
  assert.deepEqual(
    betaPilotDogfoodAlphaEvidence.crossProjectDependencies.map((item) => item.ownerProject),
    [
      "V1 Release Program & Cutline",
      "V1 Launch Support Desk & Escalation",
      "Workspace & Onboarding UX",
      "V1 Release Notes & Upgrade Guide",
      "Owning capability project"
    ]
  );
  assert.ok(
    betaPilotDogfoodAlphaEvidence.blockerRiskRegister.every((item) => item.ownerProject && item.route),
    "every blocker/risk must name route and owner"
  );
});

test("follow-up issues are allowed only for missing evidence gaps", () => {
  assert.equal(betaPilotDogfoodAlphaEvidence.followUpPolicy.blanketFollowUpsAllowed, false);
  assert.ok(
    betaPilotDogfoodAlphaEvidence.followUpPolicy.allowedReasons.includes("missing-accepted-evidence"),
    "missing evidence must be a valid follow-up reason"
  );
  assert.equal(
    betaPilotDogfoodAlphaEvidence.followUpPolicy.proposedFollowUps.every((item) => item.reason === "missing-accepted-evidence"),
    true
  );

  const invalid = structuredClone(betaPilotDogfoodAlphaEvidence);
  invalid.followUpPolicy.blanketFollowUpsAllowed = true;
  invalid.followUpPolicy.proposedFollowUps.push({
    reason: "nice-to-have",
    ownerProject: "V1 Beta Pilot & Feedback Loop",
    summary: "Create broad beta feedback backlog"
  });

  const result = validateDogfoodAlphaEvidence(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /blanket follow-up creation is not allowed/);
  assert.match(result.errors.join("\n"), /unsupported follow-up reason/);
});

test("parent initiative update is required only when launch risk changes", () => {
  assert.equal(betaPilotDogfoodAlphaEvidence.launchRiskDelta, "none");
  assert.equal(betaPilotDogfoodAlphaEvidence.parentInitiativeStatus.required, false);
  assert.equal(canAcceptDogfoodAlphaGate(betaPilotDogfoodAlphaEvidence), true);

  const invalid = structuredClone(betaPilotDogfoodAlphaEvidence);
  invalid.launchRiskDelta = "increased";
  invalid.parentInitiativeStatus.required = false;

  const result = validateDogfoodAlphaEvidence(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /parent initiative status update is required/);
});
