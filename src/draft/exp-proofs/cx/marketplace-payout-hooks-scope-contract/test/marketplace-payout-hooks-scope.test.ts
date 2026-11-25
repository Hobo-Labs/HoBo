import assert from "node:assert/strict";
import { test } from "vitest";

import {
  MARKETPLACE_PAYOUT_HOOKS_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreateMarketplacePayoutFollowUp,
  validateMarketplacePayoutHooksScope,
} from "../src/marketplace-payout-hooks-scope.js";

test("M0 record states goal, personas, scope, non-goals, and operating boundaries", () => {
  const result = validateMarketplacePayoutHooksScope(MARKETPLACE_PAYOUT_HOOKS_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(MARKETPLACE_PAYOUT_HOOKS_SCOPE.issue, "HOBO-420");
  assert.equal(MARKETPLACE_PAYOUT_HOOKS_SCOPE.phase, "M0");
  assert.match(MARKETPLACE_PAYOUT_HOOKS_SCOPE.goal, /marketplace payout hooks/i);
  assert.match(MARKETPLACE_PAYOUT_HOOKS_SCOPE.goal, /publisher payout readiness/i);
  assert.deepEqual(
    MARKETPLACE_PAYOUT_HOOKS_SCOPE.personas.map((persona) => persona.role),
    [
      "marketplace operator",
      "publisher owner",
      "billing/compliance owner",
      "support operator",
      "release owner",
    ],
  );
  assert.deepEqual(Object.keys(MARKETPLACE_PAYOUT_HOOKS_SCOPE.boundaries), REQUIRED_BOUNDARIES);
  assert.ok(MARKETPLACE_PAYOUT_HOOKS_SCOPE.scopeIn.length >= 5);
  assert.ok(MARKETPLACE_PAYOUT_HOOKS_SCOPE.scopeOut.length >= 6);
});

test("M0 record maps dependencies to authoritative design sources", () => {
  assert.deepEqual(
    MARKETPLACE_PAYOUT_HOOKS_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/marketplace-publisher-trust-evidence.md",
      "docs/design/capability-review-approval.md",
      "docs/design/org-catalogs.md",
      "docs/design/billing-launch-policy.md",
      "docs/design/tax-currency-receipt-obligations.md",
      "docs/design/launch-support-escalation.md",
      "docs/design/adr/07-portability-extensibility.md#adr-0064",
    ],
  );
});

test("M0 record maps owning initiative dependencies without taking their scope", () => {
  assert.deepEqual(
    MARKETPLACE_PAYOUT_HOOKS_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Marketplace Payout Hooks",
      "Capability Review & Approval",
      "Publisher Portal",
      "Billing & Credits",
      "Tax, Currency, Receipt Obligations",
      "Org Catalogs",
      "Support Workflow",
      "V1 Release Program & Cutline",
    ],
  );
  assert.equal(
    MARKETPLACE_PAYOUT_HOOKS_SCOPE.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M0 record lists payout lifecycle states and evidence required before M1 contract proof", () => {
  assert.deepEqual(MARKETPLACE_PAYOUT_HOOKS_SCOPE.payoutHookStates, [
    "not-eligible",
    "eligible-for-review",
    "tax-documents-required",
    "payout-method-required",
    "approved-for-payout",
    "payout-held",
    "payout-disabled",
  ]);
  assert.deepEqual(
    MARKETPLACE_PAYOUT_HOOKS_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "publisher-eligibility-fixture",
      "payout-state-model",
      "tax-identity-handoff",
      "billing-reconciliation-handoff",
      "support-hold-reason-export",
      "scope-boundary-register",
    ],
  );
  assert.equal(
    MARKETPLACE_PAYOUT_HOOKS_SCOPE.m1Evidence.every(
      (evidence) => evidence.owner && evidence.proofMode && evidence.source && evidence.proves,
    ),
    true,
  );
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateMarketplacePayoutFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateMarketplacePayoutFollowUp({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateMarketplacePayoutFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateMarketplacePayoutFollowUp({ phase: "M0", m0Accepted: true }), false);
});

test("scope validation rejects live payout, settlement, tax, provider, UI, or revenue-share creep", () => {
  const result = validateMarketplacePayoutHooksScope({
    ...MARKETPLACE_PAYOUT_HOOKS_SCOPE,
    scopeIn: [
      ...MARKETPLACE_PAYOUT_HOOKS_SCOPE.scopeIn,
      "Build live payout provider integration, settlement, tax forms, payout UI, and revenue-share calculation.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("scope validation fails closed when payout claims lack proof source or owner route", () => {
  const result = validateMarketplacePayoutHooksScope({
    ...MARKETPLACE_PAYOUT_HOOKS_SCOPE,
    payoutHookStates: MARKETPLACE_PAYOUT_HOOKS_SCOPE.payoutHookStates.filter(
      (state) => state !== "payout-held",
    ),
    m1Evidence: [
      ...MARKETPLACE_PAYOUT_HOOKS_SCOPE.m1Evidence,
      {
        kind: "payout-provider-ready",
        owner: "marketplace operator",
        proofMode: "contract-test",
        proves: "Publishers can receive payouts.",
      },
    ],
  });

  assert.match(result.errors.join("\n"), /payout state missing: payout-held/i);
  assert.match(result.errors.join("\n"), /source/i);
});
