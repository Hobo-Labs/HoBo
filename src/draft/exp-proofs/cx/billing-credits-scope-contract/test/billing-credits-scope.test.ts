import assert from "node:assert/strict";
import { test } from "vitest";

import {
  BILLING_CREDITS_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreateBillingCreditsFollowUp,
  classifyBillingCreditsDecision,
  validateBillingCreditsScope,
} from "../src/billing-credits-scope.js";

test("M0 record states goal, personas, scope, non-goals, and operating boundaries", () => {
  const result = validateBillingCreditsScope(BILLING_CREDITS_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(BILLING_CREDITS_SCOPE.issue, "HOBO-418");
  assert.equal(BILLING_CREDITS_SCOPE.phase, "M0");
  assert.match(BILLING_CREDITS_SCOPE.goal, /billing/i);
  assert.match(BILLING_CREDITS_SCOPE.goal, /credits/i);
  assert.deepEqual(
    BILLING_CREDITS_SCOPE.personas.map((persona) => persona.role),
    [
      "workspace owner",
      "platform engineer",
      "billing operator",
      "support engineer",
      "security and compliance reviewer",
    ],
  );
  assert.deepEqual(Object.keys(BILLING_CREDITS_SCOPE.boundaries), REQUIRED_BOUNDARIES);
  assert.ok(BILLING_CREDITS_SCOPE.scopeIn.length >= 5);
  assert.ok(BILLING_CREDITS_SCOPE.scopeOut.length >= 6);
  assert.ok(BILLING_CREDITS_SCOPE.nonGoals.length >= 4);
});

test("M0 record maps design dependencies and owning initiatives without taking adjacent scope", () => {
  assert.deepEqual(
    BILLING_CREDITS_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/reliability-observability-cost.md#plan-05",
      "docs/design/contracts-policy-flags.md#plan-29",
      "docs/design/governance-planes.md#plan-46",
      "docs/design/adr/04-governance-verification.md#adr-0039",
      "HOBO-417",
      "HOBO-489",
      "HOBO-490",
      "HOBO-513",
    ],
  );
  assert.deepEqual(
    BILLING_CREDITS_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Billing & Credits",
      "Usage Metering",
      "Entitlements & Plan Limits",
      "Tax, Currency & Receipt Obligations",
      "Support Workflow",
      "V1 Legal, Privacy & Terms Readiness",
      "V1 Release Program & Cutline",
    ],
  );
  assert.equal(
    BILLING_CREDITS_SCOPE.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M1 evidence names the contract proof required before design and implementation follow-ups", () => {
  assert.deepEqual(
    BILLING_CREDITS_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "commercial-scope-map",
      "billing-lifecycle-state-model",
      "credit-ledger-and-entitlement-boundary",
      "usage-to-invoice-reconciliation-inputs",
      "customer-visible-billing-limitations",
      "support-and-audit-handoff",
    ],
  );

  assert.equal(
    BILLING_CREDITS_SCOPE.m1Evidence.every(
      (evidence) => evidence.owner && evidence.proofMode && evidence.source && evidence.proves,
    ),
    true,
  );
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateBillingCreditsFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateBillingCreditsFollowUp({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateBillingCreditsFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateBillingCreditsFollowUp({ phase: "M0", m0Accepted: true }), false);
});

test("decision classifier routes adjacent billing work to owning initiatives", () => {
  assert.deepEqual(classifyBillingCreditsDecision("meter usage events into invoiceable quantities"), {
    owner: "Usage Metering",
    inScope: false,
  });
  assert.deepEqual(classifyBillingCreditsDecision("enforce plan quota at deployment time"), {
    owner: "Entitlements & Plan Limits",
    inScope: false,
  });
  assert.deepEqual(classifyBillingCreditsDecision("collect VAT tax for a customer region"), {
    owner: "Tax, Currency & Receipt Obligations",
    inScope: false,
  });
  assert.deepEqual(classifyBillingCreditsDecision("record supported billing modes and credit boundaries"), {
    owner: "Billing & Credits",
    inScope: true,
  });
});

test("scope validation rejects live provider, tax, metering, entitlement, and pricing implementation creep", () => {
  const result = validateBillingCreditsScope({
    ...BILLING_CREDITS_SCOPE,
    scopeIn: [
      ...BILLING_CREDITS_SCOPE.scopeIn,
      "Implement live Stripe provider checkout, usage metering, quota enforcement, tax calculation, and final pricing pages.",
    ],
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("scope validation requires proof source for M1 evidence and explicit customer-visible limits", () => {
  const invalid = structuredClone(BILLING_CREDITS_SCOPE);
  invalid.customerVisibleLimitations = [];
  invalid.m1Evidence = [
    ...invalid.m1Evidence,
    {
      kind: "billing-ready-claim",
      owner: "Billing & Credits",
      proofMode: "design-record",
      proves: "Billing is ready for launch.",
    },
  ];

  const result = validateBillingCreditsScope(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /customer-visible billing limitations/);
  assert.match(result.errors.join("\n"), /source/i);
});
