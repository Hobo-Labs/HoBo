import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ENTITLEMENTS_PLAN_LIMITS_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreateEntitlementsFollowUp,
  classifyEntitlementDecision,
  validateEntitlementsPlanLimitsScope,
} from "../src/entitlements-plan-limits.mjs";

test("M0 record states entitlement and plan-limit goal, personas, scope, and boundaries", () => {
  const result = validateEntitlementsPlanLimitsScope(ENTITLEMENTS_PLAN_LIMITS_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(ENTITLEMENTS_PLAN_LIMITS_SCOPE.issue, "HOBO-419");
  assert.equal(ENTITLEMENTS_PLAN_LIMITS_SCOPE.phase, "M0");
  assert.match(ENTITLEMENTS_PLAN_LIMITS_SCOPE.goal, /entitlement/i);
  assert.match(ENTITLEMENTS_PLAN_LIMITS_SCOPE.goal, /plan limit/i);
  assert.deepEqual(
    ENTITLEMENTS_PLAN_LIMITS_SCOPE.personas.map((persona) => persona.id),
    [
      "workspace-admin",
      "platform-engineer",
      "billing-finops-owner",
      "support-operator",
      "security-compliance-reviewer",
    ],
  );
  assert.deepEqual(
    ENTITLEMENTS_PLAN_LIMITS_SCOPE.boundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_BOUNDARIES].sort(),
  );
  assert.ok(ENTITLEMENTS_PLAN_LIMITS_SCOPE.scopeIn.some((item) => /plan tier/i.test(item)));
  assert.ok(ENTITLEMENTS_PLAN_LIMITS_SCOPE.scopeIn.some((item) => /limit decision/i.test(item)));
  assert.ok(ENTITLEMENTS_PLAN_LIMITS_SCOPE.scopeOut.some((item) => /invoice/i.test(item)));
});

test("M0 record maps authoritative design sources and owning initiative dependencies", () => {
  assert.deepEqual(ENTITLEMENTS_PLAN_LIMITS_SCOPE.designRefs, [
    "docs/design/usage-metering.md",
    "docs/design/billing-launch-policy.md",
    "docs/design/tenant-isolation-quotas.md",
    "docs/design/reliability-observability-cost.md#plan-05",
    "docs/design/security-networking.md#plan-50",
  ]);
  assert.deepEqual(ENTITLEMENTS_PLAN_LIMITS_SCOPE.adrRefs, [
    "docs/design/adr/02-identity-security.md#adr-0039",
    "docs/design/adr/02-identity-security.md#adr-0074",
    "docs/design/adr/07-portability-extensibility.md#adr-0064",
  ]);
  assert.ok(
    ENTITLEMENTS_PLAN_LIMITS_SCOPE.initiativeDependencies.some(
      (dependency) =>
        dependency.owner === "Usage Metering" &&
        /usage facts/i.test(dependency.boundary),
    ),
  );
  assert.ok(
    ENTITLEMENTS_PLAN_LIMITS_SCOPE.initiativeDependencies.some(
      (dependency) =>
        dependency.owner === "Billing & Credits" &&
        /plans and payment states/i.test(dependency.boundary),
    ),
  );
});

test("plan tiers, limit types, and decision states are explicit before M1 proof", () => {
  assert.deepEqual(
    ENTITLEMENTS_PLAN_LIMITS_SCOPE.planTiers.map((tier) => tier.id),
    ["private-beta-free", "team-paid", "enterprise-manual"],
  );
  assert.deepEqual(
    ENTITLEMENTS_PLAN_LIMITS_SCOPE.limitTypes.map((limit) => limit.id),
    [
      "workspace-seat",
      "project-count",
      "environment-count",
      "runtime-usage",
      "request-rate",
      "concurrency",
      "generation-run",
      "spend-reservation",
      "support-tier",
    ],
  );
  assert.deepEqual(
    ENTITLEMENTS_PLAN_LIMITS_SCOPE.decisionStates.map((state) => state.id),
    [
      "entitlement.allowed",
      "entitlement.warn",
      "entitlement.grace",
      "entitlement.denied",
      "entitlement.suspended",
      "entitlement.override-approved",
    ],
  );
});

test("M1 evidence gate blocks follow-up work until M0 acceptance is recorded", () => {
  assert.deepEqual(
    ENTITLEMENTS_PLAN_LIMITS_SCOPE.m1Evidence.map((evidence) => evidence.id),
    [
      "plan-entitlement-taxonomy",
      "limit-decision-fixture",
      "usage-metering-handoff",
      "customer-visible-limit-copy",
      "support-override-audit",
      "scope-boundary-register",
    ],
  );
  assert.equal(canCreateEntitlementsFollowUp({ phase: "M1", m0Accepted: false }).allowed, false);
  assert.equal(canCreateEntitlementsFollowUp({ phase: "M2", m0Accepted: false }).allowed, false);
  assert.equal(canCreateEntitlementsFollowUp({ phase: "M1", m0Accepted: true }).allowed, true);
  assert.equal(canCreateEntitlementsFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("scope validation rejects billing, runtime enforcement, RBAC, provider, and fraud-response creep", () => {
  const invalid = structuredClone(ENTITLEMENTS_PLAN_LIMITS_SCOPE);
  invalid.scopeIn.push("Build invoice generation, payment collection, and refund processing.");
  invalid.scopeIn.push("Implement the runtime quota enforcer and provider quota sync.");
  invalid.scopeIn.push("Ship RBAC role grants and member invite flows.");
  invalid.scopeIn.push("Implement entitlement abuse and fraud response automation.");

  const result = validateEntitlementsPlanLimitsScope(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /billing/i);
  assert.match(result.errors.join("\n"), /runtime enforcement/i);
  assert.match(result.errors.join("\n"), /RBAC/i);
  assert.match(result.errors.join("\n"), /provider/i);
  assert.match(result.errors.join("\n"), /abuse response/i);
});

test("decision classifier routes adjacent work to owning initiatives", () => {
  assert.equal(
    classifyEntitlementDecision("plan tier limit decision and override audit").owner,
    "Entitlements & Plan Limits",
  );
  assert.equal(
    classifyEntitlementDecision("usage facts and metering dimensions").owner,
    "Usage Metering",
  );
  assert.equal(
    classifyEntitlementDecision("invoice payment refund and tax").owner,
    "Billing & Credits",
  );
  assert.equal(
    classifyEntitlementDecision("tenant quota noisy neighbor isolation").owner,
    "Tenant Isolation & Quotas",
  );
  assert.equal(
    classifyEntitlementDecision("member role grant and RBAC invite").owner,
    "Member/RBAC Administration",
  );
  assert.equal(
    classifyEntitlementDecision("fraud abuse rate limit escalation").owner,
    "Entitlement Abuse & Fraud Response",
  );
});
