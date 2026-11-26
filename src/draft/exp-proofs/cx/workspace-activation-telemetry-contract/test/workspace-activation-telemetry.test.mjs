import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_ACTIVATION_EVENTS,
  REQUIRED_PRIVACY_RULES,
  WORKSPACE_ACTIVATION_TELEMETRY_CONTRACT,
  validateActivationContract,
  validateTelemetryClaim,
} from "../src/workspace-activation-telemetry.mjs";

test("M0 contract defines the required workspace activation funnel events", () => {
  const result = validateActivationContract(WORKSPACE_ACTIVATION_TELEMETRY_CONTRACT);

  assert.deepEqual(result.errors, []);
  assert.equal(WORKSPACE_ACTIVATION_TELEMETRY_CONTRACT.issue, "HOBO-486");
  assert.equal(WORKSPACE_ACTIVATION_TELEMETRY_CONTRACT.phase, "M0");
  assert.deepEqual(
    WORKSPACE_ACTIVATION_TELEMETRY_CONTRACT.events.map((event) => event.id),
    REQUIRED_ACTIVATION_EVENTS,
  );
});

test("each activation event maps a product question and support or recovery use", () => {
  for (const event of WORKSPACE_ACTIVATION_TELEMETRY_CONTRACT.events) {
    assert.ok(event.productQuestion, `${event.id} missing product question`);
    assert.ok(event.supportOrRecoveryUse, `${event.id} missing support or recovery use`);
    assert.ok(event.ownerProject, `${event.id} missing owner project`);
    assert.ok(event.evidenceMode, `${event.id} missing evidence mode`);
  }
});

test("privacy constraints cover retention, opt-out behavior, and PII exclusions", () => {
  assert.deepEqual(
    WORKSPACE_ACTIVATION_TELEMETRY_CONTRACT.privacyRules.map((rule) => rule.id),
    REQUIRED_PRIVACY_RULES,
  );

  for (const rule of WORKSPACE_ACTIVATION_TELEMETRY_CONTRACT.privacyRules) {
    assert.ok(rule.constraint, `${rule.id} missing constraint`);
    assert.ok(rule.retention, `${rule.id} missing retention`);
    assert.ok(rule.customerChoice, `${rule.id} missing customer choice`);
    assert.ok(rule.exclusion, `${rule.id} missing exclusion`);
  }
});

test("telemetry claims fail closed when required funnel events or owner mappings are missing", () => {
  const result = validateTelemetryClaim(
    {
      events: REQUIRED_ACTIVATION_EVENTS.filter((event) => event !== "first-successful-handoff"),
      ownerMappings: {
        "account-created": "Workspace & Onboarding UX",
        "workspace-created": "Workspace & Onboarding UX",
      },
      privacyRules: REQUIRED_PRIVACY_RULES,
    },
    { launchClaim: true },
  );

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /first-successful-handoff is required/);
  assert.match(result.errors.join("\n"), /project-created owner mapping is required/);
});

test("scope validation rejects live analytics vendors, behavioral tracking, and raw PII telemetry", () => {
  const invalid = structuredClone(WORKSPACE_ACTIVATION_TELEMETRY_CONTRACT);
  invalid.scopeIn.push("Select a live analytics vendor and capture broad behavioral tracking.");
  invalid.events[0] = {
    ...invalid.events[0],
    capturedFields: [...invalid.events[0].capturedFields, "rawEmail", "secretValue"],
  };

  const result = validateActivationContract(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /live analytics vendor/i);
  assert.match(result.errors.join("\n"), /broad behavioral tracking/i);
  assert.match(result.errors.join("\n"), /rawEmail is forbidden/i);
  assert.match(result.errors.join("\n"), /secretValue is forbidden/i);
});
