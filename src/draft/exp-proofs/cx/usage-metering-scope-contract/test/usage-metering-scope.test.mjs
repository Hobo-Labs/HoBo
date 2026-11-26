import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_BOUNDARIES,
  USAGE_METERING_SCOPE,
  canCreateUsageMeteringFollowUp,
  validateUsageMeteringScope,
} from "../src/usage-metering-scope.mjs";

test("M0 record states goal, personas, scope, non-goals, and operating boundaries", () => {
  const result = validateUsageMeteringScope(USAGE_METERING_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(USAGE_METERING_SCOPE.issue, "HOBO-417");
  assert.equal(USAGE_METERING_SCOPE.phase, "M0");
  assert.match(USAGE_METERING_SCOPE.goal, /usage metering/i);
  assert.match(USAGE_METERING_SCOPE.goal, /showback/i);
  assert.deepEqual(
    USAGE_METERING_SCOPE.personas.map((persona) => persona.role),
    [
      "finops owner",
      "platform engineer",
      "billing/support operator",
      "security/compliance reviewer",
    ],
  );
  assert.deepEqual(Object.keys(USAGE_METERING_SCOPE.boundaries), REQUIRED_BOUNDARIES);
  assert.ok(USAGE_METERING_SCOPE.scopeIn.length >= 5);
  assert.ok(USAGE_METERING_SCOPE.scopeOut.length >= 5);
});

test("M0 record maps dependencies to authoritative design sources", () => {
  assert.deepEqual(
    USAGE_METERING_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/reliability-observability-cost.md#plan-05",
      "docs/design/data-plane.md#plan-11",
      "docs/design/billing-launch-policy.md",
      "docs/design/tax-currency-receipt-obligations.md",
      "docs/design/adr/02-identity-security.md#adr-0039",
      "docs/design/adr/01-architecture-core.md#adr-0071",
    ],
  );
});

test("M0 record maps owning initiative dependencies without taking their scope", () => {
  assert.deepEqual(
    USAGE_METERING_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Usage Metering",
      "Billing & Credits",
      "Entitlements & Plan Limits",
      "Compliance Evidence Pack",
      "Support Workflow",
      "V1 Release Program & Cutline",
    ],
  );
  assert.equal(
    USAGE_METERING_SCOPE.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M0 record lists evidence required before M1 design and contract proof", () => {
  assert.deepEqual(
    USAGE_METERING_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "meter-event-fact-catalog",
      "usage-dimension-matrix",
      "reconciliation-fixture",
      "privacy-redaction-policy",
      "support-dispute-handoff",
    ],
  );
  assert.equal(
    USAGE_METERING_SCOPE.m1Evidence.every(
      (evidence) => evidence.owner && evidence.proofMode && evidence.source && evidence.proves,
    ),
    true,
  );
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateUsageMeteringFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateUsageMeteringFollowUp({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateUsageMeteringFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateUsageMeteringFollowUp({ phase: "M0", m0Accepted: true }), false);
});

test("scope validation rejects billing, entitlement, dispatcher, or provider sync creep", () => {
  const result = validateUsageMeteringScope({
    ...USAGE_METERING_SCOPE,
    scopeIn: [
      ...USAGE_METERING_SCOPE.scopeIn,
      "Implement invoice generation, entitlement enforcement, live provider billing sync, and Dispatcher cost routing.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("scope validation requires proof source for usage evidence claims", () => {
  const result = validateUsageMeteringScope({
    ...USAGE_METERING_SCOPE,
    m1Evidence: [
      ...USAGE_METERING_SCOPE.m1Evidence,
      {
        kind: "meter-event-claim",
        owner: "platform engineer",
        proofMode: "contract-test",
        proves: "Metering facts are ready.",
      },
    ],
  });

  assert.match(result.errors.join("\n"), /source/i);
});
