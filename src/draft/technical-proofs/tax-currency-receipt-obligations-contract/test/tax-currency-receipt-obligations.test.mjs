import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_LAUNCH_MODES,
  REQUIRED_OBLIGATION_DOMAINS,
  TAX_CURRENCY_RECEIPT_OBLIGATIONS,
  canCreateTaxEngineWork,
  classifyUnsupportedJurisdictions,
  validateTaxCurrencyReceiptObligations,
} from "../src/tax-currency-receipt-obligations.mjs";

test("M0 record defines supported currencies, tax posture, invoices, receipts, identity fields, zero-decimal handling, and unsupported jurisdictions", () => {
  const result = validateTaxCurrencyReceiptObligations(TAX_CURRENCY_RECEIPT_OBLIGATIONS);

  assert.deepEqual(result.errors, []);
  assert.equal(TAX_CURRENCY_RECEIPT_OBLIGATIONS.issue, "HOBO-513");
  assert.equal(TAX_CURRENCY_RECEIPT_OBLIGATIONS.phase, "M0");
  assert.deepEqual(
    TAX_CURRENCY_RECEIPT_OBLIGATIONS.obligationDomains.map((domain) => domain.id),
    REQUIRED_OBLIGATION_DOMAINS,
  );
});

test("launch modes map beta, paid GA, manual invoicing, prepaid credits, subscriptions, and marketplace payout hooks", () => {
  assert.deepEqual(
    TAX_CURRENCY_RECEIPT_OBLIGATIONS.launchModeMappings.map((mode) => mode.id),
    REQUIRED_LAUNCH_MODES,
  );

  for (const mode of TAX_CURRENCY_RECEIPT_OBLIGATIONS.launchModeMappings) {
    assert.ok(mode.requiredBefore, `${mode.id} requiredBefore`);
    assert.ok(mode.evidenceOwner, `${mode.id} evidenceOwner`);
    assert.ok(mode.customerVisibleLimit, `${mode.id} customerVisibleLimit`);
    assert.ok(mode.blockingUnknowns.length > 0, `${mode.id} blockingUnknowns`);
  }
});

test("vendor assumptions and customer-visible limitations are explicit", () => {
  assert.deepEqual(
    TAX_CURRENCY_RECEIPT_OBLIGATIONS.providerAssumptions.map((assumption) => assumption.id),
    [
      "provider.tax-determination",
      "provider.invoice-rendering",
      "provider.receipt-delivery",
      "provider.marketplace-payout-documents",
    ],
  );
  assert.deepEqual(
    TAX_CURRENCY_RECEIPT_OBLIGATIONS.customerVisibleLimitations.map((limitation) => limitation.id),
    [
      "limitation.no-automated-tax-calculation",
      "limitation.usd-first-launch",
      "limitation.unsupported-jurisdictions-visible",
      "limitation.marketplace-payout-tax-documents-deferred",
    ],
  );
});

test("disputes, corrections, refunds, and usage reconciliation link to existing billing and metering issues", () => {
  assert.deepEqual(
    TAX_CURRENCY_RECEIPT_OBLIGATIONS.reconciliationLinks.map((link) => link.issue),
    ["HOBO-489", "HOBO-490", "HOBO-417", "HOBO-418"],
  );

  for (const link of TAX_CURRENCY_RECEIPT_OBLIGATIONS.reconciliationLinks) {
    assert.ok(link.workflow, `${link.issue} workflow`);
    assert.ok(link.handoffEvidence, `${link.issue} handoffEvidence`);
  }
});

test("unsupported jurisdictions classify as launch blockers or customer-visible limitations", () => {
  assert.deepEqual(classifyUnsupportedJurisdictions(TAX_CURRENCY_RECEIPT_OBLIGATIONS), {
    blockers: ["paid-ga-tax-collection", "manual-invoice-tax-review"],
    limitations: ["non-us-self-serve-signup", "marketplace-payout-tax-documents"],
  });
});

test("tax engine implementation stays blocked unless the v1 cutline explicitly requires it", () => {
  assert.equal(canCreateTaxEngineWork({ phase: "M1", v1CutlineRequiresTaxEngine: false }), false);
  assert.equal(canCreateTaxEngineWork({ phase: "M0", v1CutlineRequiresTaxEngine: true }), false);
  assert.equal(canCreateTaxEngineWork({ phase: "M1", v1CutlineRequiresTaxEngine: true }), true);
});

test("validation rejects plan-pricing-only claims and tax-engine scope creep", () => {
  const invalid = structuredClone(TAX_CURRENCY_RECEIPT_OBLIGATIONS);
  invalid.scopeIn.push("Implement a tax engine and jurisdiction decisioning service for launch.");
  invalid.obligationDomains = invalid.obligationDomains.filter((domain) => domain.id !== "tax-vat-sales-tax");
  invalid.launchModeMappings = invalid.launchModeMappings.filter((mode) => mode.id !== "marketplace-payout-hooks");
  invalid.commercialReadinessClaim = {
    claim: "Billing is launch-ready because plans and prices exist.",
    evidence: ["plans", "pricing"],
  };

  const result = validateTaxCurrencyReceiptObligations(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /missing obligation domain tax-vat-sales-tax/);
  assert.match(result.errors.join("\n"), /missing launch mode marketplace-payout-hooks/);
  assert.match(result.errors.join("\n"), /scope creep/i);
  assert.match(result.errors.join("\n"), /commercial readiness requires tax, currency, receipt, and invoice obligation evidence/);
});
