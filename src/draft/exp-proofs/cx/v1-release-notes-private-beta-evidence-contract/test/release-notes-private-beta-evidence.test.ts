import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_PRIVATE_BETA_EVIDENCE,
  RELEASE_NOTES_PRIVATE_BETA_EVIDENCE,
  assertReleaseNotesPrivateBetaEvidence,
  canCompletePrivateBetaGate,
  validateReleaseNotesPrivateBetaEvidence
} from "../src/release-notes-private-beta-evidence.js";
import { asJsonObject, type JsonBag } from "../src/json.js";


test("required private-beta evidence is listed and mapped to owning projects", () => {
  const record = assertReleaseNotesPrivateBetaEvidence(RELEASE_NOTES_PRIVATE_BETA_EVIDENCE);

  assert.deepEqual(
    record.requiredEvidence.map((evidence) => evidence.id),
    REQUIRED_PRIVATE_BETA_EVIDENCE
  );
  assert.ok(record.requiredEvidence.every((evidence) => evidence.owningProject.length > 0));
  assert.ok(record.requiredEvidence.every((evidence) => evidence.proofSource.length > 0));
});

test("blockers and accepted risks are recorded with owners and revisit gates", () => {
  const record = assertReleaseNotesPrivateBetaEvidence(RELEASE_NOTES_PRIVATE_BETA_EVIDENCE);

  assert.ok(record.blockers.length > 0);
  assert.ok(record.blockers.every((blocker) => blocker.owner.length > 0));
  assert.ok(record.acceptedRisks.length > 0);
  assert.ok(record.acceptedRisks.every((risk) => risk.owner.length > 0));
  assert.ok(record.acceptedRisks.every((risk) => risk.revisitGate.length > 0));
});

test("cross-project dependencies are reflected in the release cutline", () => {
  const record = assertReleaseNotesPrivateBetaEvidence(RELEASE_NOTES_PRIVATE_BETA_EVIDENCE);
  const evidenceProjects = new Set(record.requiredEvidence.map((evidence) => evidence.owningProject));
  const cutlineProjects = new Set(record.releaseCutline.dependencies.map((dependency) => dependency.project));

  for (const project of evidenceProjects) {
    assert.equal(cutlineProjects.has(project), true, `${project} missing from release cutline`);
  }
});

test("follow-up execution issues are allowed only where evidence is missing", () => {
  const record = assertReleaseNotesPrivateBetaEvidence(RELEASE_NOTES_PRIVATE_BETA_EVIDENCE);

  assert.equal(record.followUps.length, 0);

  const invalid = structuredClone(record);
  invalid.followUps.push({
    id: "unneeded-docs-copy-follow-up",
    evidenceId: "release-notes-private-beta-outline",
    owningProject: "V1 Docs",
    reason: "Speculative polish despite accepted evidence"
  });

  const result = validateReleaseNotesPrivateBetaEvidence(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /follow-up.*release-notes-private-beta-outline.*already has accepted evidence/i);
});

test("parent release-readiness status update is required when launch risk changes", () => {
  const record = assertReleaseNotesPrivateBetaEvidence(RELEASE_NOTES_PRIVATE_BETA_EVIDENCE);

  assert.equal(record.parentInitiativeStatus.initiative, "HoBo v1 Release Readiness");
  assert.equal(record.parentInitiativeStatus.gateChangesLaunchRisk, true);
  assert.ok(record.parentInitiativeStatus.statusUpdateEvidence.length > 0);

  const invalid = structuredClone(record);
  invalid.parentInitiativeStatus.statusUpdateEvidence = "";

  const result = validateReleaseNotesPrivateBetaEvidence(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /parent initiative status update evidence is required/i);
});

test("M2 private beta gate completes only when all required evidence is accepted", () => {
  const record = assertReleaseNotesPrivateBetaEvidence(RELEASE_NOTES_PRIVATE_BETA_EVIDENCE);

  assert.equal(canCompletePrivateBetaGate(record), true);

  const invalid = structuredClone(record);
  invalid.requiredEvidence[0].status = "missing";

  assert.equal(canCompletePrivateBetaGate(invalid), false);
});

test("malformed evidence payloads fail closed without throwing", () => {
  const record = assertReleaseNotesPrivateBetaEvidence(RELEASE_NOTES_PRIVATE_BETA_EVIDENCE);
  const invalid: JsonBag = { ...asJsonObject(structuredClone(record)) };
  invalid.requiredEvidence = [
    null,
    {
      ...asJsonObject(record.requiredEvidence[0]),
      status: "pending-review"
    }
  ];
  invalid.releaseCutline = {
    ...asJsonObject(record.releaseCutline),
    dependencies: {},
  };
  invalid.followUps = {};

  assert.doesNotThrow(() => validateReleaseNotesPrivateBetaEvidence(invalid));
  const result = validateReleaseNotesPrivateBetaEvidence(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /requiredEvidence\[0\] must be an object/);
  assert.match(result.errors.join("\n"), /release-notes-private-beta-outline must use a valid evidence status/);
  assert.match(result.errors.join("\n"), /releaseCutline\.dependencies must be an array/);
  assert.match(result.errors.join("\n"), /followUps must be an array/);
  assert.equal(canCompletePrivateBetaGate(invalid), false);
});
