import assert from "node:assert/strict";
import { test } from "vitest";

import {
  PERSONA_OPERATING_PROFILE_CONTRACT,
  REQUIRED_PROFILE_FIELDS,
  REQUIRED_RECOMMENDATION_USES,
  REQUIRED_RIGHTS,
  validateOperatingProfileContract,
  validateRecommendationMemoryClaim,
} from "../src/persona-operating-profile.mjs";

test("M0 profile contract defines the minimal operating profile fields", () => {
  const result = validateOperatingProfileContract(PERSONA_OPERATING_PROFILE_CONTRACT);

  assert.deepEqual(result.errors, []);
  assert.equal(PERSONA_OPERATING_PROFILE_CONTRACT.issue, "HOBO-507");
  assert.equal(PERSONA_OPERATING_PROFILE_CONTRACT.phase, "M0");
  assert.deepEqual(
    PERSONA_OPERATING_PROFILE_CONTRACT.fields.map((field) => field.id),
    REQUIRED_PROFILE_FIELDS,
  );
});

test("profile fields map to personas, onboarding defaults, safe tests, approval, cost, settings, and telemetry", () => {
  for (const field of PERSONA_OPERATING_PROFILE_CONTRACT.fields) {
    assert.ok(field.personas.length > 0, `${field.id} missing persona mapping`);
    assert.ok(field.onboardingDefault, `${field.id} missing onboarding default`);
    assert.ok(field.safeTestUse, `${field.id} missing safe-test mapping`);
    assert.ok(field.approvalDefault, `${field.id} missing approval default`);
    assert.ok(field.costCapUse, `${field.id} missing cost-cap mapping`);
    assert.ok(field.workspaceSetting, `${field.id} missing workspace setting`);
    assert.ok(field.telemetryUse, `${field.id} missing telemetry mapping`);
  }
});

test("privacy rules cover retention, edit, delete, export, and tenant boundaries", () => {
  assert.deepEqual(
    PERSONA_OPERATING_PROFILE_CONTRACT.privacyRights.map((right) => right.id),
    REQUIRED_RIGHTS,
  );

  for (const right of PERSONA_OPERATING_PROFILE_CONTRACT.privacyRights) {
    assert.ok(right.policy, `${right.id} missing policy`);
    assert.ok(right.owner, `${right.id} missing owner`);
    assert.ok(right.customerVisible, `${right.id} missing customer-visible posture`);
  }
});

test("recommendation memory is v1-bounded and preserves QUI-91 as evidence", () => {
  assert.deepEqual(
    PERSONA_OPERATING_PROFILE_CONTRACT.recommendationUses.map((use) => use.id),
    REQUIRED_RECOMMENDATION_USES,
  );
  assert.equal(PERSONA_OPERATING_PROFILE_CONTRACT.sourceIssue, "QUI-91");
  assert.ok(PERSONA_OPERATING_PROFILE_CONTRACT.postV1Boundaries.length > 0);

  const result = validateRecommendationMemoryClaim({
    sourceIssue: "QUI-91",
    uses: REQUIRED_RECOMMENDATION_USES,
    memoryScope: "tenant-workspace",
    evidenceMode: "contract-record",
  });

  assert.equal(result.ok, true);
});

test("scope guards reject ML personalization, broad tracking, and cross-tenant memory", () => {
  const invalid = structuredClone(PERSONA_OPERATING_PROFILE_CONTRACT);
  invalid.scopeIn.push("Build an ML personalization platform with broad behavioral tracking.");
  invalid.recommendationMemory.scope = "cross-tenant";

  const result = validateOperatingProfileContract(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /ML personalization platform/i);
  assert.match(result.errors.join("\n"), /broad behavioral tracking/i);
  assert.match(result.errors.join("\n"), /cross-tenant recommendation memory/i);
});

test("launch recommendation claims fail closed without required uses and source evidence", () => {
  const result = validateRecommendationMemoryClaim({
    sourceIssue: "copied-backlog",
    uses: ["recommendation-ranking"],
    memoryScope: "global",
    evidenceMode: "implementation-backlog",
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /QUI-91 evidence source is required/);
  assert.match(result.errors.join("\n"), /safe-test-defaults is required/);
  assert.match(result.errors.join("\n"), /tenant-workspace memory scope is required/);
  assert.match(result.errors.join("\n"), /contract-record evidence mode is required/);
});
