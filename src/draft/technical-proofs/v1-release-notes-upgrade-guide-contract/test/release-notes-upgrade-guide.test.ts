import assert from "node:assert/strict";
import { test } from "vitest";

import {
  RELEASE_NOTES_UPGRADE_GUIDE,
  canPublishReleaseNotes,
  classifyMissingEvidence,
  validateReleaseNotesUpgradeGuide,
} from "../src/release-notes-upgrade-guide.js";

test("outline covers the required v1 release notes and upgrade-guide sections", () => {
  const result = validateReleaseNotesUpgradeGuide(RELEASE_NOTES_UPGRADE_GUIDE);

  assert.deepEqual(result.errors, []);
  assert.deepEqual(
    RELEASE_NOTES_UPGRADE_GUIDE.outline.map((section) => section.id),
    [
      "release-summary",
      "supported-install-paths",
      "upgrade-paths",
      "compatibility-matrix",
      "known-limitations",
      "rollback-guidance",
      "migration-notes",
      "support-contacts",
    ],
  );
});

test("required inputs map to source projects and owning handoff domains", () => {
  assert.deepEqual(
    RELEASE_NOTES_UPGRADE_GUIDE.requiredInputs.map((input) => input.project),
    [
      "Release Engineering",
      "V1 Docs",
      "Bootstrap Installer",
      "Compatibility Matrix",
      "Support Workflow",
    ],
  );
  assert.equal(
    RELEASE_NOTES_UPGRADE_GUIDE.requiredInputs.every((input) => input.ownerDomain && input.consumedBy.length > 0),
    true,
  );
});

test("missing evidence becomes a release-blocker candidate or explicit follow-up", () => {
  assert.equal(
    classifyMissingEvidence({ requiredForLaunchClaim: true, hasAcceptedSubstitute: false }),
    "release-blocker-candidate",
  );
  assert.equal(
    classifyMissingEvidence({ requiredForLaunchClaim: false, hasAcceptedSubstitute: false }),
    "follow-up",
  );
  assert.equal(
    classifyMissingEvidence({ requiredForLaunchClaim: true, hasAcceptedSubstitute: true }),
    "covered-by-substitute-evidence",
  );
});

test("scope guard blocks final release notes before release-candidate evidence", () => {
  assert.equal(
    canPublishReleaseNotes({ releaseCandidateEvidenceAccepted: false, finalCompatibilityClaims: false }),
    false,
  );
  assert.equal(
    canPublishReleaseNotes({ releaseCandidateEvidenceAccepted: true, finalCompatibilityClaims: false }),
    true,
  );
});

test("validation rejects compatibility guarantees without supporting tests", () => {
  const invalid = structuredClone(RELEASE_NOTES_UPGRADE_GUIDE);
  invalid.outline.find((section) => section.id === "compatibility-matrix").claims.push({
    text: "All browsers and platforms are fully supported.",
    evidence: [],
  });

  const result = validateReleaseNotesUpgradeGuide(invalid);

  assert.match(result.errors.join("\n"), /compatibility guarantee lacks test evidence/i);
});
