import assert from "node:assert/strict";
import { test } from "vitest";

import {
  V1_BETA_PILOT_PRIVATE_BETA_EVIDENCE,
  classifyEvidenceGap,
  createFollowUpIssues,
  summarizeParentReadinessSignal,
  validatePrivateBetaEvidenceGate
} from "../src/v1-beta-pilot-private-beta-evidence.ts";

test("lists required M2 private-beta evidence and maps each item to an owning project", () => {
  const result = validatePrivateBetaEvidenceGate(V1_BETA_PILOT_PRIVATE_BETA_EVIDENCE);

  assert.deepEqual(result.errors, []);
  assert.equal(V1_BETA_PILOT_PRIVATE_BETA_EVIDENCE.issue, "HOBO-463");
  assert.equal(V1_BETA_PILOT_PRIVATE_BETA_EVIDENCE.phase, "M2");
  assert.deepEqual(
    V1_BETA_PILOT_PRIVATE_BETA_EVIDENCE.requiredEvidence.map((item) => item.id),
    [
      "pilot-cohort-snapshot",
      "workflow-feedback-ledger",
      "blocker-and-risk-register",
      "release-cutline-dependency-map",
      "parent-readiness-signal"
    ]
  );
  assert.equal(
    V1_BETA_PILOT_PRIVATE_BETA_EVIDENCE.requiredEvidence.every(
      (item) => item.ownerProject && item.evidenceKinds.length > 0
    ),
    true
  );
});

test("records blockers and accepted risks as first-class release evidence", () => {
  const gate = V1_BETA_PILOT_PRIVATE_BETA_EVIDENCE;

  assert.deepEqual(
    gate.blockerStates.map((blocker) => blocker.status),
    ["open", "resolved", "accepted-limitation"]
  );
  assert.equal(gate.acceptedRisks.every((risk) => risk.owner && risk.mitigation && risk.launchNoteOrFollowUp), true);
});

test("reflects cross-project dependencies in the release cutline", () => {
  const cutline = V1_BETA_PILOT_PRIVATE_BETA_EVIDENCE.releaseCutline;

  assert.deepEqual(cutline.consumesProjects, [
    "V1 Release Program & Cutline",
    "V1 Launch Support Desk & Escalation",
    "V1 Release Notes & Upgrade Guide",
    "Workspace & Onboarding UX",
    "Capability project owners"
  ]);
  assert.equal(cutline.blocksReleaseCandidateWithoutDependencyDisposition, true);
});

test("creates follow-up issue specs only for missing evidence", () => {
  assert.equal(classifyEvidenceGap({ required: true, status: "missing" }), "follow-up-issue-required");
  assert.equal(classifyEvidenceGap({ required: true, status: "complete" }), "no-follow-up");
  assert.equal(classifyEvidenceGap({ required: false, status: "missing" }), "no-follow-up");

  const followUps = createFollowUpIssues(V1_BETA_PILOT_PRIVATE_BETA_EVIDENCE);

  assert.deepEqual(
    followUps.map((issue) => issue.evidenceId),
    ["workflow-feedback-ledger"]
  );
  assert.equal(followUps[0]?.parentIssue, "HOBO-463");
  assert.equal(followUps[0]?.labels.includes("slice"), true);
});

test("updates parent release-readiness signal only when evidence changes launch risk", () => {
  assert.equal(
    summarizeParentReadinessSignal({
      previousRisk: "medium",
      currentRisk: "high",
      missingRequiredEvidence: 1,
      openBlockers: 1
    }),
    "risk-increased"
  );
  assert.equal(
    summarizeParentReadinessSignal({
      previousRisk: "medium",
      currentRisk: "medium",
      missingRequiredEvidence: 0,
      openBlockers: 0
    }),
    "no-parent-status-change"
  );
});

test("scope guards reject customer onboarding, support tooling, and blocker resolution creep", () => {
  const invalid = structuredClone(V1_BETA_PILOT_PRIVATE_BETA_EVIDENCE);
  invalid.scopeIn.push("Onboard beta customers and resolve their launch blockers in this package.");
  invalid.scopeIn.push("Build support ticketing automation for private beta feedback.");

  const result = validatePrivateBetaEvidenceGate(invalid);

  assert.match(result.errors.join("\n"), /customer onboarding/i);
  assert.match(result.errors.join("\n"), /blocker resolution/i);
  assert.match(result.errors.join("\n"), /support tooling/i);
});
