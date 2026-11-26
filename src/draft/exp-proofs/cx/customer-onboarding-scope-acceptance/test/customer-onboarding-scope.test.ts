import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  CUSTOMER_ONBOARDING_SCOPE,
  REQUIRED_M1_EVIDENCE,
  REQUIRED_OPERATING_BOUNDARIES,
  canStartCustomerOnboardingFollowUp,
  classifyCustomerOnboardingClaim,
  validateCustomerOnboardingScope,
} from "../src/customer-onboarding-scope.ts";

test("M0 scope record states the customer-onboarding goal, personas, scope, and boundaries", () => {
  const result = validateCustomerOnboardingScope(CUSTOMER_ONBOARDING_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(CUSTOMER_ONBOARDING_SCOPE.issue, "HOBO-449");
  assert.equal(CUSTOMER_ONBOARDING_SCOPE.phase, "M0");
  assert.match(CUSTOMER_ONBOARDING_SCOPE.goal, /Customer Onboarding/i);
  assert.deepEqual(
    CUSTOMER_ONBOARDING_SCOPE.personas.map((persona) => persona.id),
    [
      "pilot-customer-admin",
      "first-time-app-developer",
      "customer-success-lead",
      "support-operator",
      "security-reviewer",
    ],
  );
  assert.deepEqual(
    CUSTOMER_ONBOARDING_SCOPE.operatingBoundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_OPERATING_BOUNDARIES].sort(),
  );
});

test("owning dependencies and M1 evidence are explicit before follow-up work can start", () => {
  assert.deepEqual(
    CUSTOMER_ONBOARDING_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Customer Onboarding",
      "Workspace & Onboarding UX",
      "Persona Operating Profile",
      "Pre-Launch Outcome Contract",
      "V1 Beta Pilot & Feedback Loop",
      "V1 Launch Support Desk & Escalation",
      "V1 Release Program & Cutline",
    ],
  );
  assert.deepEqual(
    CUSTOMER_ONBOARDING_SCOPE.m1Evidence.map((evidence) => evidence.id).sort(),
    [...REQUIRED_M1_EVIDENCE].sort(),
  );
});

test("M1-M4 follow-up issues stay blocked until M0 acceptance is recorded", () => {
  for (const phase of ["M1", "M2", "M3", "M4"] as const) {
    assert.equal(canStartCustomerOnboardingFollowUp({ phase, m0Accepted: false }).allowed, false);
    assert.equal(canStartCustomerOnboardingFollowUp({ phase, m0Accepted: true }).allowed, true);
  }

  assert.equal(canStartCustomerOnboardingFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("scope validation rejects customer-success system, CRM, and live customer-data creep", () => {
  const invalid = structuredClone(CUSTOMER_ONBOARDING_SCOPE);
  invalid.scopeIn.push("Build the CRM integration and customer-success automation workflow.");
  invalid.scopeIn.push("Import live customer data and production tenant records.");
  invalid.scopeIn.push("Publish launch marketing pages and final sales enablement copy.");

  const result = validateCustomerOnboardingScope(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /customer-success system/i);
  assert.match(result.errors.join("\n"), /live customer data/i);
  assert.match(result.errors.join("\n"), /marketing or sales/i);
});

test("customer-facing onboarding claims require proof mode and source evidence", () => {
  assert.deepEqual(
    classifyCustomerOnboardingClaim({
      audience: "customer-facing",
      claim: "",
      proofMode: "contract-test",
      source: "src/draft/customer-onboarding-scope-acceptance",
    }),
    {
      allowed: false,
      reason: "Customer onboarding claims must state the claimed onboarding readiness boundary.",
    },
  );

  assert.deepEqual(
    classifyCustomerOnboardingClaim({
      audience: "customer-facing",
      claim: "HoBo has a validated first-customer onboarding path.",
    }),
    {
      allowed: false,
      reason: "Customer-facing onboarding claims require proof mode and source evidence.",
    },
  );

  assert.equal(
    classifyCustomerOnboardingClaim({
      audience: "customer-facing",
      claim: "Customer Onboarding M0 scope is accepted.",
      proofMode: "contract-test",
      source: "src/draft/customer-onboarding-scope-acceptance",
    }).allowed,
    true,
  );
});

test("M0 scope proof cannot support production launch or go-live claims", () => {
  for (const claim of [
    "Customer Onboarding is ready for production customers.",
    "HoBo provides a guaranteed go-live path for first customers.",
    "Customer onboarding includes final launch copy for sales enablement.",
  ]) {
    const result = classifyCustomerOnboardingClaim({
      audience: "customer-facing",
      claim,
      proofMode: "contract-test",
      source: "src/draft/customer-onboarding-scope-acceptance",
    });

    assert.equal(result.allowed, false, claim);
    assert.match(result.reason, /M0 scope proof cannot support/);
  }
});

test("architecture evidence names customer-onboarding schema, parsed types, and event boundary", () => {
  const architecture = readFileSync(new URL("../ARCHITECTURE.md", import.meta.url), "utf8");
  const pact = JSON.parse(
    readFileSync(
      new URL("../contracts/pacts/customer-onboarding-scope.pact.json", import.meta.url),
      "utf8",
    ),
  );
  const proto = readFileSync(
    new URL("../proto/customer_onboarding_scope.proto", import.meta.url),
    "utf8",
  );
  const cue = readFileSync(new URL("../cue/customer_onboarding_scope.cue", import.meta.url), "utf8");

  assert.equal(pact.consumer.name, "BetaPilotReadinessGate");
  assert.equal(pact.provider.name, "CustomerOnboardingScopeRecord");
  assert.ok(pact.interactions.length >= 2);

  for (const typeName of [
    "CustomerOnboardingScope",
    "CustomerOnboardingPersona",
    "CustomerOnboardingBoundary",
    "CustomerOnboardingEvidence",
    "CustomerOnboardingState",
  ]) {
    assert.match(proto, new RegExp(`(?:message|enum) ${typeName}`));
    assert.match(cue, new RegExp(`#${typeName}:`));
  }

  assert.match(architecture, /parse, don't validate/i);
  assert.match(architecture, /derived domain\s+types/i);
  assert.match(architecture, /Command/i);
  assert.match(architecture, /Events/i);
  assert.match(architecture, /Actor/i);
  assert.match(architecture, /event-store/i);
  assert.match(architecture, /projection/i);
  assert.match(architecture, /Snapshot/i);
  assert.match(architecture, /read store/i);
});
