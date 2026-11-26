import assert from "node:assert/strict";
import { test } from "vitest";

import {
  BILLING_LAUNCH_POLICY,
  REQUIRED_POLICY_SECTIONS,
  validateBillingLaunchPolicy,
} from "../src/billing-launch-policy.js";

test("M0 policy defines plans, credits, invoices, payment states, refunds, and v1 scope-out", () => {
  const result = validateBillingLaunchPolicy(BILLING_LAUNCH_POLICY);

  assert.deepEqual(result.errors, []);
  assert.equal(BILLING_LAUNCH_POLICY.issue, "HOBO-489");
  assert.equal(BILLING_LAUNCH_POLICY.phase, "M0");
  assert.deepEqual(
    REQUIRED_POLICY_SECTIONS,
    [
      "supportedPlans",
      "prepaidCredits",
      "invoiceTiming",
      "paymentFailureStates",
      "refundAndCreditCorrections",
      "v1ScopeOut",
    ],
  );
  for (const section of REQUIRED_POLICY_SECTIONS) {
    assert.ok(BILLING_LAUNCH_POLICY[section].length > 0, `${section} must be defined`);
  }
});

test("each billing lifecycle state maps customer messaging, support action, audit evidence, and entitlement impact", () => {
  assert.deepEqual(
    BILLING_LAUNCH_POLICY.lifecycleStates.map((state) => state.id),
    [
      "trial.active",
      "subscription.active",
      "credits.depleted",
      "invoice.open",
      "payment.past-due",
      "payment.suspended",
      "refund.pending",
      "credit.corrected",
    ],
  );

  for (const state of BILLING_LAUNCH_POLICY.lifecycleStates) {
    assert.ok(state.customerMessage, `${state.id} missing customerMessage`);
    assert.ok(state.supportAction, `${state.id} missing supportAction`);
    assert.ok(state.auditEvidence, `${state.id} missing auditEvidence`);
    assert.ok(state.entitlementImpact, `${state.id} missing entitlementImpact`);
  }
});

test("provider integration boundaries and mocked-provider assumptions are explicit", () => {
  assert.deepEqual(
    BILLING_LAUNCH_POLICY.providerBoundaries.map((boundary) => boundary.id),
    [
      "provider.checkout-session",
      "provider.webhook-events",
      "provider.invoice-sync",
      "provider.money-movement",
    ],
  );

  for (const boundary of BILLING_LAUNCH_POLICY.providerBoundaries) {
    assert.ok(boundary.v1Assumption, `${boundary.id} missing v1Assumption`);
    assert.ok(boundary.mockedProviderBehavior, `${boundary.id} missing mockedProviderBehavior`);
    assert.ok(boundary.scopeBoundary, `${boundary.id} missing scopeBoundary`);
  }
});

test("legal and privacy inputs are linked as blockers or explicit launch limitations", () => {
  assert.deepEqual(
    BILLING_LAUNCH_POLICY.legalPrivacyInputs.map((input) => input.id),
    [
      "legal.terms-of-service",
      "legal.refund-policy",
      "privacy.billing-data-retention",
      "compliance.tax-currency-receipts",
    ],
  );
  assert.equal(
    BILLING_LAUNCH_POLICY.legalPrivacyInputs.every((input) => ["blocker", "limitation"].includes(input.launchDisposition)),
    true,
  );
  assert.equal(
    BILLING_LAUNCH_POLICY.legalPrivacyInputs.every((input) => input.ownerProject && input.evidenceLink),
    true,
  );
});

test("validation rejects scope creep, missing entitlement impact, and unresolved legal inputs", () => {
  const invalid = structuredClone(BILLING_LAUNCH_POLICY);
  invalid.lifecycleStates[0] = {
    ...invalid.lifecycleStates[0],
    entitlementImpact: "",
  };
  invalid.providerBoundaries.push({
    id: "provider.live-tax-engine",
    v1Assumption: "Run live tax calculation during HOBO-489.",
    mockedProviderBehavior: "none",
    scopeBoundary: "Implement tax engine now.",
    workKind: "live-provider-integration",
  });
  invalid.legalPrivacyInputs[0] = {
    ...invalid.legalPrivacyInputs[0],
    launchDisposition: "accepted",
  };
  invalid.v1ScopeOut = invalid.v1ScopeOut.filter((item) => item.id !== "scope-out.tax-engine");

  const result = validateBillingLaunchPolicy(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /trial\.active missing entitlementImpact/);
  assert.match(result.errors.join("\n"), /live-provider-integration is out of scope/);
  assert.match(result.errors.join("\n"), /legal\.terms-of-service must be blocker or limitation/);
  assert.match(result.errors.join("\n"), /scope-out\.tax-engine is required/);
});

test("validation requires lifecycle, provider-boundary, and legal input sections", () => {
  const result = validateBillingLaunchPolicy({
    ...BILLING_LAUNCH_POLICY,
    lifecycleStates: [],
    providerBoundaries: [],
    legalPrivacyInputs: [],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /lifecycleStates must be a non-empty list/);
  assert.match(result.errors.join("\n"), /providerBoundaries must be a non-empty list/);
  assert.match(result.errors.join("\n"), /legalPrivacyInputs must be a non-empty list/);
});
