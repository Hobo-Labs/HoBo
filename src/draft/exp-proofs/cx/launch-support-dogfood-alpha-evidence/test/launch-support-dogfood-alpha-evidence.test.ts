import assert from "node:assert/strict";
import { test } from "vitest";

import {
  HOBO_460_REQUIRED_EVIDENCE,
  buildParentInitiativeStatus,
  deriveSupportFollowUpIssues,
  launchSupportDogfoodAlphaEvidence,
  validateLaunchSupportDogfoodAlphaEvidence,
} from "../src/launch-support-dogfood-alpha-evidence.js";

test("HOBO-460 M1 record maps required support evidence to owners and sources", () => {
  const result = validateLaunchSupportDogfoodAlphaEvidence(launchSupportDogfoodAlphaEvidence);

  assert.deepEqual(result, { ok: true, errors: [] });
  assert.equal(launchSupportDogfoodAlphaEvidence.issue, "HOBO-460");
  assert.equal(launchSupportDogfoodAlphaEvidence.phase, "M1");
  assert.equal(launchSupportDogfoodAlphaEvidence.project, "V1 Launch Support Desk & Escalation");
  assert.deepEqual(
    launchSupportDogfoodAlphaEvidence.evidence.map((item) => item.id),
    HOBO_460_REQUIRED_EVIDENCE,
  );
  assert.equal(
    launchSupportDogfoodAlphaEvidence.evidence.every(
      (item) => item.ownerProject && item.source && item.proves && item.acceptanceStatus,
    ),
    true,
  );
});

test("blockers and accepted risks are recorded with launch cutline actions", () => {
  assert.deepEqual(
    launchSupportDogfoodAlphaEvidence.findings.map((finding) => finding.classification),
    ["accepted-risk", "launch-note", "post-ga-follow-up"],
  );

  const acceptedRisk = launchSupportDogfoodAlphaEvidence.findings.find(
    (finding) => finding.classification === "accepted-risk",
  );
  assert.equal(acceptedRisk?.blocksLaunch, false);
  assert.ok(acceptedRisk?.mitigation);
  assert.ok(acceptedRisk?.expiry);
  assert.equal(acceptedRisk?.ownerProject, "V1 Launch Support Desk & Escalation");
});

test("cross-project dependencies are reflected in release cutline and adjacent launch lanes", () => {
  assert.deepEqual(
    launchSupportDogfoodAlphaEvidence.dependencies.map((dependency) => dependency.ownerProject),
    [
      "V1 Release Program & Cutline",
      "Incident Communications",
      "Support Workflow",
      "V1 Beta Pilot & Feedback Loop",
      "Reliability, Observability & Cost Controls",
      "Operator Agents, SRE & Incident Response",
    ],
  );
  assert.ok(
    launchSupportDogfoodAlphaEvidence.dependencies.every(
      (dependency) => dependency.cutlineRef && dependency.requiredForM1,
    ),
  );
});

test("follow-up issues are created only for missing evidence", () => {
  const followUps = deriveSupportFollowUpIssues(launchSupportDogfoodAlphaEvidence);

  assert.deepEqual(
    followUps.map((issue) => issue.title),
    ["Fill Launch Support Desk alpha known-limitation FAQ evidence"],
  );
  assert.equal(followUps[0].ownerProject, "V1 Launch Support Desk & Escalation");
  assert.equal(followUps[0].blocksLaunch, false);
  assert.equal(followUps[0].sourceEvidenceId, "alpha-known-limitation-faq");
});

test("parent initiative status updates only when support gate changes launch risk", () => {
  assert.deepEqual(buildParentInitiativeStatus(launchSupportDogfoodAlphaEvidence), {
    health: "onTrack",
    summary:
      "HOBO-460 M1 support evidence is accepted with one non-blocking launch-note follow-up.",
    changedLaunchRisk: false,
  });

  const invalid = structuredClone(launchSupportDogfoodAlphaEvidence);
  invalid.findings.push({
    id: "missing-sev0-runbook",
    sourceEvidenceId: "sev0-sev1-drill",
    classification: "launch-blocker",
    ownerProject: "Operator Agents, SRE & Incident Response",
    blocksLaunch: true,
    mitigation: "",
    expiry: "",
  });

  assert.deepEqual(buildParentInitiativeStatus(invalid), {
    health: "atRisk",
    summary: "HOBO-460 M1 support evidence has 1 launch blocker.",
    changedLaunchRisk: true,
  });
});

test("validation rejects missing owners, support tooling implementation, and unapproved SLA claims", () => {
  const invalid = structuredClone(launchSupportDogfoodAlphaEvidence);
  invalid.evidence[0].ownerProject = "";
  invalid.scopeIn.push("Build support ticket automation and approve 15 minute response SLA.");

  const result = validateLaunchSupportDogfoodAlphaEvidence(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /ownerProject/);
  assert.match(result.errors.join("\n"), /support tooling implementation/i);
  assert.match(result.errors.join("\n"), /unapproved customer-facing SLA/i);
});
