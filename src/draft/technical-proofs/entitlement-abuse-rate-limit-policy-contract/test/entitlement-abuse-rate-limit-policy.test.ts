import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ENTITLEMENT_ABUSE_RATE_LIMIT_POLICY,
  REQUIRED_BOUNDARIES,
  canPublishAbusePolicyFollowUp,
  classifyAbusePolicyDecision,
  validateEntitlementAbuseRateLimitPolicy,
} from "../src/entitlement-abuse-rate-limit-policy.ts";

test("policy defines limit types, rate-limit behavior, grace, suspension, appeals, and support overrides", () => {
  const result = validateEntitlementAbuseRateLimitPolicy(ENTITLEMENT_ABUSE_RATE_LIMIT_POLICY);

  assert.deepEqual(result.errors, []);
  assert.equal(ENTITLEMENT_ABUSE_RATE_LIMIT_POLICY.issue, "HOBO-491");
  assert.equal(ENTITLEMENT_ABUSE_RATE_LIMIT_POLICY.phase, "M0");
  assert.deepEqual(
    ENTITLEMENT_ABUSE_RATE_LIMIT_POLICY.limitTypes.map((limit) => limit.id),
    [
      "request-rate",
      "concurrency",
      "runtime-usage",
      "generation-run",
      "spend-reservation",
      "support-tier",
    ],
  );
  assert.deepEqual(
    ENTITLEMENT_ABUSE_RATE_LIMIT_POLICY.rateLimitBehaviors.map((behavior) => behavior.id),
    ["soft-warn", "backpressure", "hard-deny", "manual-hold"],
  );
  assert.deepEqual(
    ENTITLEMENT_ABUSE_RATE_LIMIT_POLICY.customerStates.map((state) => state.id),
    ["normal", "grace", "appeal-open", "suspended", "recovered"],
  );
  assert.ok(ENTITLEMENT_ABUSE_RATE_LIMIT_POLICY.appealPolicy.owner);
  assert.ok(ENTITLEMENT_ABUSE_RATE_LIMIT_POLICY.supportOverrides.every((override) => override.requiresAudit === true));
});

test("abuse and fraud responses carry audit evidence, communication, and recovery paths", () => {
  assert.deepEqual(
    ENTITLEMENT_ABUSE_RATE_LIMIT_POLICY.responseMatrix.map((response) => response.id),
    [
      "runaway-usage",
      "rate-limit-exceeded",
      "suspected-fraud",
      "abuse-confirmed",
      "false-positive",
    ],
  );

  for (const response of ENTITLEMENT_ABUSE_RATE_LIMIT_POLICY.responseMatrix) {
    assert.ok(response.auditEvidence.length >= 2, response.id);
    assert.ok(response.customerCommunication, response.id);
    assert.ok(response.recoveryPath, response.id);
  }
});

test("boundary map routes billing, tenant quotas, security verification, and support to owners", () => {
  assert.deepEqual(
    ENTITLEMENT_ABUSE_RATE_LIMIT_POLICY.boundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_BOUNDARIES].sort(),
  );
  assert.deepEqual(
    ENTITLEMENT_ABUSE_RATE_LIMIT_POLICY.boundaries.map((boundary) => boundary.owner),
    ["Entitlements & Plan Limits", "Billing & Credits", "Tenant Isolation & Quotas", "Security Verification", "Support Workflow"],
  );
});

test("M1 and later work remains gated until HOBO-491 policy acceptance", () => {
  assert.equal(canPublishAbusePolicyFollowUp({ phase: "M1", policyAccepted: false }).allowed, false);
  assert.equal(canPublishAbusePolicyFollowUp({ phase: "M3", policyAccepted: false }).allowed, false);
  assert.equal(canPublishAbusePolicyFollowUp({ phase: "M1", policyAccepted: true }).allowed, true);
  assert.equal(canPublishAbusePolicyFollowUp({ phase: "M0", policyAccepted: false }).allowed, true);
});

test("scope guard rejects fraud scoring engine selection and adjacent implementation creep", () => {
  const invalid = {
    ...ENTITLEMENT_ABUSE_RATE_LIMIT_POLICY,
    scopeIn: [
      ...ENTITLEMENT_ABUSE_RATE_LIMIT_POLICY.scopeIn,
      "Select the fraud scoring engine and tune production risk models.",
      "Build the rate limiter runtime service and wire customer suspension automation.",
      "Implement live payment provider fraud webhooks and chargeback workflows.",
    ],
  };

  const result = validateEntitlementAbuseRateLimitPolicy(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /fraud scoring/i);
  assert.match(result.errors.join("\n"), /runtime implementation/i);
  assert.match(result.errors.join("\n"), /billing implementation/i);
});

test("decision classifier routes adjacent work without silently expanding scope", () => {
  assert.deepEqual(classifyAbusePolicyDecision("customer safe rate limit response policy"), {
    owner: "Entitlements & Plan Limits",
    inScope: true,
  });
  assert.equal(classifyAbusePolicyDecision("fraud scoring model selection").owner, "Security Verification");
  assert.equal(classifyAbusePolicyDecision("invoice chargeback refund workflow").owner, "Billing & Credits");
  assert.equal(classifyAbusePolicyDecision("tenant quota runtime enforcement").owner, "Tenant Isolation & Quotas");
  assert.equal(classifyAbusePolicyDecision("support ticket automation").owner, "Support Workflow");
});
