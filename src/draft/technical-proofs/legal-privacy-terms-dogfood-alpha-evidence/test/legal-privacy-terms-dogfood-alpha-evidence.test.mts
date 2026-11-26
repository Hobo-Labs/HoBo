import assert from "node:assert/strict";
import { test } from "vitest";

import {
  buildLegalPrivacyTermsDogfoodAlphaRecord,
  evaluateLegalPrivacyTermsDogfoodAlphaGate,
  validateLegalPrivacyTermsDogfoodAlphaRecord,
} from "../src/legal-privacy-terms-dogfood-alpha-evidence.ts";

test("accepted M1 dogfood alpha evidence records every required launch-readiness signal", () => {
  const record = buildLegalPrivacyTermsDogfoodAlphaRecord();
  const gate = evaluateLegalPrivacyTermsDogfoodAlphaGate(record);

  assert.equal(record.issue, "HOBO-457");
  assert.equal(record.phase, "M1 Dogfood/alpha proof");
  assert.equal(record.project, "V1 Legal, Privacy & Terms Readiness");
  assert.equal(record.scope.excludesFinalLegalText, true);
  assert.equal(record.scope.excludesPaidOrPublicLaunch, true);
  assert.equal(record.milestoneEvidenceAccepted, true);

  assert.deepEqual(
    record.evidence.map((item) => item.domain),
    [
      "terms",
      "privacy-notice",
      "data-retention",
      "telemetry",
      "subprocessors-provider-claims",
      "security-claims",
      "support-obligations",
      "customer-communications",
    ],
  );
  assert.equal(record.evidence.every((item) => item.status === "accepted"), true);
  assert.equal(record.evidence.every((item) => item.owningProject.length > 0), true);
  assert.equal(record.evidence.every((item) => item.releaseCutlineRef.length > 0), true);
  assert.equal(record.evidence.every((item) => item.followUpIssue === undefined), true);

  assert.deepEqual(gate.blockers, []);
  assert.deepEqual(gate.missingEvidence, []);
  assert.deepEqual(gate.invalidFollowUps, []);
  assert.equal(gate.canCompleteMilestone, true);
});

test("release cutline mirrors all cross-project dependencies and parent risk update", () => {
  const record = buildLegalPrivacyTermsDogfoodAlphaRecord();
  const gate = evaluateLegalPrivacyTermsDogfoodAlphaGate(record);

  assert.deepEqual(record.releaseCutline.dependencies, [
    "V1 Release Program & Cutline",
    "Tenant Data Lifecycle",
    "Customer Assurance Evidence Packet",
    "Security Verification",
    "Support & Debug Tools",
    "V1 Launch Site, Messaging & Demo Assets",
  ]);
  assert.deepEqual(gate.unreflectedDependencies, []);
  assert.equal(record.parentInitiativeUpdate?.initiative, "HoBo v1 Release Readiness");
  assert.equal(record.parentInitiativeUpdate?.riskChanged, false);
  assert.equal(record.parentInitiativeUpdate?.status, "dogfood-alpha-legal-ready");
});

test("missing evidence must create follow-up work and blocks milestone completion", () => {
  const baseline = buildLegalPrivacyTermsDogfoodAlphaRecord();
  const record = buildLegalPrivacyTermsDogfoodAlphaRecord({
    evidence: baseline.evidence.map((item) =>
      item.domain === "privacy-notice"
        ? {
            ...item,
            status: "missing",
          }
        : item,
    ),
  });

  assert.throws(
    () => validateLegalPrivacyTermsDogfoodAlphaRecord(record),
    /evidence\.privacy-notice\.missing_follow_up/,
  );

  const withFollowUp = buildLegalPrivacyTermsDogfoodAlphaRecord({
    evidence: baseline.evidence.map((item) =>
      item.domain === "privacy-notice"
        ? {
            ...item,
            status: "missing",
            followUpIssue: "HOBO-FOLLOWUP",
          }
        : item,
    ),
  });
  const gate = evaluateLegalPrivacyTermsDogfoodAlphaGate(withFollowUp);

  assert.deepEqual(gate.missingEvidence, ["privacy-notice"]);
  assert.equal(gate.canCompleteMilestone, false);
});

test("required evidence domains cannot be omitted from milestone completion", () => {
  const record = buildLegalPrivacyTermsDogfoodAlphaRecord({
    evidence: [
      {
        domain: "terms",
        status: "accepted",
        owningProject: "V1 Legal, Privacy & Terms Readiness",
        requiredEvidence: "Dogfood terms approval path",
        source: "legal-owner-review",
        releaseCutlineRef: "cutline.legal.terms",
      },
    ],
  });

  assert.throws(
    () => validateLegalPrivacyTermsDogfoodAlphaRecord(record),
    /evidence\.privacy-notice\.missing/,
  );
});

test("accepted evidence cannot spawn follow-up issues", () => {
  const record = buildLegalPrivacyTermsDogfoodAlphaRecord({
    evidence: [
      {
        domain: "terms",
        status: "accepted",
        owningProject: "V1 Legal, Privacy & Terms Readiness",
        requiredEvidence: "Dogfood terms approval path",
        source: "legal-owner-review",
        releaseCutlineRef: "cutline.legal.terms",
        followUpIssue: "HOBO-SHOULD-NOT-EXIST",
      },
    ],
  });

  assert.throws(
    () => validateLegalPrivacyTermsDogfoodAlphaRecord(record),
    /evidence\.terms\.unexpected_follow_up/,
  );
});

test("scope guards reject final legal text and unsupported public launch claims", () => {
  assert.throws(
    () =>
      validateLegalPrivacyTermsDogfoodAlphaRecord(
        buildLegalPrivacyTermsDogfoodAlphaRecord({
          finalLegalTextDrafted: true,
        }),
      ),
    /scope\.final_legal_text/,
  );

  assert.throws(
    () =>
      validateLegalPrivacyTermsDogfoodAlphaRecord(
        buildLegalPrivacyTermsDogfoodAlphaRecord({
          publicLaunchClaim: "HoBo terms and privacy policy are final for GA customers.",
        }),
      ),
    /scope\.unsupported_public_launch_claim/,
  );
});
