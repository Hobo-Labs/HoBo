import assert from "node:assert/strict";
import { test } from "vitest";

import {
  RELEASE_NOTES_DOGFOOD_ALPHA_GATE,
  deriveDogfoodAlphaFollowUps,
  evaluateDogfoodAlphaGate,
  validateDogfoodAlphaGate,
} from "../src/release-notes-dogfood-alpha.js";

test("M1 evidence is listed and mapped to owning launch projects", () => {
  const result = validateDogfoodAlphaGate(RELEASE_NOTES_DOGFOOD_ALPHA_GATE);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    RELEASE_NOTES_DOGFOOD_ALPHA_GATE.evidence.map((item) => item.id),
    [
      "release-summary-dogfood-cutline",
      "supported-install-alpha-smoke",
      "upgrade-dry-run-alpha",
      "compatibility-alpha-thresholds",
      "known-limitations-alpha-register",
      "support-contact-alpha-route",
    ],
  );
  assert.equal(
    RELEASE_NOTES_DOGFOOD_ALPHA_GATE.evidence.every(
      (item) => item.ownerProject && item.sourceEvidence && item.releaseNoteSections.length > 0,
    ),
    true,
  );
});

test("blockers and accepted risks are explicit gate records", () => {
  const gate = evaluateDogfoodAlphaGate(RELEASE_NOTES_DOGFOOD_ALPHA_GATE);

  assert.equal(gate.acceptanceState, "accepted-with-risk");
  assert.deepEqual(
    RELEASE_NOTES_DOGFOOD_ALPHA_GATE.blockers.map((blocker) => blocker.id),
    ["known-limitations-copy-owner-approval"],
  );
  assert.deepEqual(
    RELEASE_NOTES_DOGFOOD_ALPHA_GATE.acceptedRisks.map((risk) => risk.id),
    ["dogfood-only-upgrade-copy"],
  );
});

test("cross-project dependencies are reflected in the release cutline categories", () => {
  const cutlineCategories = new Set(RELEASE_NOTES_DOGFOOD_ALPHA_GATE.evidence.map((item) => item.cutlineCategory));

  assert.deepEqual([...cutlineCategories].sort(), [
    "v1-blocker.documentation",
    "v1-blocker.operations-readiness",
    "v1-blocker.productization",
    "v1-blocker.support",
  ]);
});

test("follow-up execution issues are created only for missing evidence", () => {
  assert.deepEqual(deriveDogfoodAlphaFollowUps(RELEASE_NOTES_DOGFOOD_ALPHA_GATE), []);

  const missing = structuredClone(RELEASE_NOTES_DOGFOOD_ALPHA_GATE);
  missing.evidence[2].status = "missing";
  missing.followUps = [
    {
      evidenceId: "upgrade-dry-run-alpha",
      issue: "HOBO-TBD",
      ownerProject: "Upgrade & Migration Engine",
      reason: "Dogfood alpha upgrade dry-run transcript is missing.",
    },
  ];

  assert.deepEqual(deriveDogfoodAlphaFollowUps(missing), ["upgrade-dry-run-alpha"]);

  const invalid = structuredClone(RELEASE_NOTES_DOGFOOD_ALPHA_GATE);
  invalid.followUps = [
    {
      evidenceId: "supported-install-alpha-smoke",
      issue: "HOBO-TBD",
      ownerProject: "Bootstrap Installer",
      reason: "Do not create work when accepted evidence exists.",
    },
  ];

  const result = validateDogfoodAlphaGate(invalid);

  assert.match(result.errors.join("\n"), /follow-up supported-install-alpha-smoke has no missing evidence/i);
});

test("parent release-readiness status update is required when launch risk changes", () => {
  const gate = evaluateDogfoodAlphaGate(RELEASE_NOTES_DOGFOOD_ALPHA_GATE);

  assert.deepEqual(gate.parentReadinessStatusUpdate, {
    initiative: "HoBo v1 Release Readiness",
    status: "at-risk",
    reason: "Accepted dogfood-only upgrade copy risk changes launch-note posture.",
  });

  const invalid = structuredClone(RELEASE_NOTES_DOGFOOD_ALPHA_GATE);
  invalid.parentReadinessStatusUpdate = null;

  const result = validateDogfoodAlphaGate(invalid);

  assert.match(result.errors.join("\n"), /parent release-readiness status update is required/i);
});
