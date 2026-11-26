import assert from "node:assert/strict";
import { test } from "vitest";

import {
  MINIMAL_OUTCOME_FIELDS,
  PRE_LAUNCH_OUTCOME_CONTRACT,
  REQUIRED_SURFACES,
  validateLaunchReadiness,
  validateOutcomeContractDefinition,
} from "../src/pre-launch-outcome.js";

test("M0 contract defines the minimal v1 outcome baseline fields", () => {
  const result = validateOutcomeContractDefinition(PRE_LAUNCH_OUTCOME_CONTRACT);

  assert.deepEqual(result.errors, []);
  assert.equal(PRE_LAUNCH_OUTCOME_CONTRACT.issue, "HOBO-509");
  assert.equal(PRE_LAUNCH_OUTCOME_CONTRACT.phase, "M0");
  assert.deepEqual(
    PRE_LAUNCH_OUTCOME_CONTRACT.fields.map((field) => field.id),
    MINIMAL_OUTCOME_FIELDS,
  );
});

test("each launch surface maps every baseline field it consumes", () => {
  assert.deepEqual(
    PRE_LAUNCH_OUTCOME_CONTRACT.surfaces.map((surface) => surface.id),
    REQUIRED_SURFACES,
  );

  for (const surface of PRE_LAUNCH_OUTCOME_CONTRACT.surfaces) {
    assert.deepEqual(surface.fieldsUsed, MINIMAL_OUTCOME_FIELDS, `${surface.id} has incomplete field mapping`);
    assert.ok(surface.ownerProject);
    assert.ok(surface.evidenceUse);
  }
});

test("safe-test and post-launch comparison evidence are explicit", () => {
  assert.deepEqual(
    PRE_LAUNCH_OUTCOME_CONTRACT.evidenceRequirements.map((evidence) => evidence.id),
    [
      "safe-test-sample-cases",
      "safe-test-result-pack",
      "plan-diff-baseline",
      "post-launch-comparison-window",
      "support-review-export",
    ],
  );
  assert.equal(
    PRE_LAUNCH_OUTCOME_CONTRACT.evidenceRequirements.every(
      (evidence) => evidence.proofMode && evidence.comparesAgainstBaseline,
    ),
    true,
  );
});

test("privacy, retention, and customer visibility rules are documented", () => {
  assert.deepEqual(
    PRE_LAUNCH_OUTCOME_CONTRACT.privacyRetentionRules.map((rule) => rule.id),
    [
      "customer-visible-baseline",
      "pii-and-secret-exclusion",
      "retention-by-deployment",
      "support-redaction-boundary",
    ],
  );

  assert.equal(
    PRE_LAUNCH_OUTCOME_CONTRACT.privacyRetentionRules.every(
      (rule) => rule.customerVisibility && rule.retention && rule.exclusion,
    ),
    true,
  );
});

test("source evidence stays linked without implementing the full value loop", () => {
  assert.deepEqual(
    PRE_LAUNCH_OUTCOME_CONTRACT.sourceEvidence.map((source) => source.id),
    [
      "QUI-92",
      "competitive-persona-gap-synthesis-2026-06-11",
      "quickdeployai-customer-personas",
    ],
  );
  assert.equal(PRE_LAUNCH_OUTCOME_CONTRACT.followUpBoundary.implementsThirtyDayValueLoop, false);
  assert.equal(PRE_LAUNCH_OUTCOME_CONTRACT.followUpBoundary.implementsAutomatedRoiModel, false);
});

test("governed launches fail closed when owner, cost, access, or controls are missing", () => {
  const missingControl = validateLaunchReadiness(
    {
      intendedBusinessOutcome: "Reduce repetitive support triage.",
      successSignal: "First response drafted from approved knowledge in under two minutes.",
      owner: "ops-lead",
      costCap: { amount: 200, currency: "USD", period: "month" },
      approvalRule: "owner-approval-required",
      failureRule: "pause-after-two-unsafe-drafts",
      rollbackExpectation: "disable capability and restore manual triage",
      reviewDate: "2026-07-29",
      accessConfirmation: { systems: ["helpdesk"], dataClasses: ["approved-kb"], confirmedBy: "ops-lead" },
    },
    { governedCapability: true },
  );

  assert.equal(missingControl.ok, false);
  assert.match(missingControl.errors.join("\n"), /controlConfirmation is required/);

  const missingAccess = validateLaunchReadiness(
    {
      intendedBusinessOutcome: "Reduce repetitive support triage.",
      successSignal: "First response drafted from approved knowledge in under two minutes.",
      owner: "ops-lead",
      costCap: { amount: 200, currency: "USD", period: "month" },
      approvalRule: "owner-approval-required",
      failureRule: "pause-after-two-unsafe-drafts",
      rollbackExpectation: "disable capability and restore manual triage",
      reviewDate: "2026-07-29",
      controlConfirmation: { pause: true, disable: true, rollback: true, confirmedBy: "ops-lead" },
    },
    { governedCapability: true },
  );

  assert.equal(missingAccess.ok, false);
  assert.match(missingAccess.errors.join("\n"), /accessConfirmation is required/);

  const missingOwner = validateLaunchReadiness(
    {
      intendedBusinessOutcome: "Reduce repetitive support triage.",
      successSignal: "First response drafted from approved knowledge in under two minutes.",
      costCap: { amount: 200, currency: "USD", period: "month" },
      approvalRule: "owner-approval-required",
      failureRule: "pause-after-two-unsafe-drafts",
      rollbackExpectation: "disable capability and restore manual triage",
      reviewDate: "2026-07-29",
      accessConfirmation: { systems: ["helpdesk"], dataClasses: ["approved-kb"], confirmedBy: "ops-lead" },
      controlConfirmation: { pause: true, disable: true, rollback: true, confirmedBy: "ops-lead" },
    },
    { governedCapability: true },
  );

  assert.equal(missingOwner.ok, false);
  assert.match(missingOwner.errors.join("\n"), /owner is required/);

  const missingCost = validateLaunchReadiness(
    {
      intendedBusinessOutcome: "Reduce repetitive support triage.",
      successSignal: "First response drafted from approved knowledge in under two minutes.",
      owner: "ops-lead",
      approvalRule: "owner-approval-required",
      failureRule: "pause-after-two-unsafe-drafts",
      rollbackExpectation: "disable capability and restore manual triage",
      reviewDate: "2026-07-29",
      accessConfirmation: { systems: ["helpdesk"], dataClasses: ["approved-kb"], confirmedBy: "ops-lead" },
      controlConfirmation: { pause: true, disable: true, rollback: true, confirmedBy: "ops-lead" },
    },
    { governedCapability: true },
  );

  assert.equal(missingCost.ok, false);
  assert.match(missingCost.errors.join("\n"), /costCap is required/);
});

test("live provider success cannot be claimed without provider-backed evidence", () => {
  const result = validateLaunchReadiness(
    {
      intendedBusinessOutcome: "Reduce repetitive support triage.",
      successSignal: "First response drafted from approved knowledge in under two minutes.",
      owner: "ops-lead",
      costCap: { amount: 200, currency: "USD", period: "month" },
      approvalRule: "owner-approval-required",
      failureRule: "pause-after-two-unsafe-drafts",
      rollbackExpectation: "disable capability and restore manual triage",
      reviewDate: "2026-07-29",
      accessConfirmation: { systems: ["helpdesk"], dataClasses: ["approved-kb"], confirmedBy: "ops-lead" },
      controlConfirmation: { pause: true, disable: true, rollback: true, confirmedBy: "ops-lead" },
      launchEvidence: { safeTestAttached: true, providerBacked: false, claimedLiveProviderSuccess: true },
    },
    { governedCapability: true },
  );

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /provider-backed evidence/);
});

test("scope validation rejects analytics warehouse, automated ROI, or customer-success expansion", () => {
  const invalid = structuredClone(PRE_LAUNCH_OUTCOME_CONTRACT);
  invalid.scopeIn.push("Build an analytics warehouse and automated ROI model for the whole customer success lifecycle.");

  const result = validateOutcomeContractDefinition(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /scope creep/i);
});
