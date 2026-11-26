import assert from "node:assert/strict";
import { test } from "vitest";

import {
  BREAK_GLASS_BOUNDARY_CONTRACT,
  classifyBreakGlassRequest,
  evaluateBreakGlassSession,
  validateBreakGlassBoundaryContract,
} from "../src/breakglass-boundaries.ts";

test("policy contract defines actors, approvals, audit events, TTL, notification, and revocation", () => {
  const result = validateBreakGlassBoundaryContract(BREAK_GLASS_BOUNDARY_CONTRACT);

  assert.deepEqual(result.errors, []);
  assert.equal(BREAK_GLASS_BOUNDARY_CONTRACT.issue, "HOBO-495");
  assert.equal(BREAK_GLASS_BOUNDARY_CONTRACT.phase, "M0");
  assert.deepEqual(
    BREAK_GLASS_BOUNDARY_CONTRACT.roles.map((role) => role.id),
    ["support-operator", "security-approver", "incident-commander", "customer-admin"],
  );
  assert.deepEqual(BREAK_GLASS_BOUNDARY_CONTRACT.requiredAuditEvents, [
    "breakglass.requested",
    "breakglass.approved",
    "breakglass.started",
    "breakglass.used",
    "breakglass.revoked",
  ]);
  assert.equal(BREAK_GLASS_BOUNDARY_CONTRACT.maxTtlMinutes, 60);
  assert.match(BREAK_GLASS_BOUNDARY_CONTRACT.customerNotificationPosture, /documented decision/i);
  assert.match(BREAK_GLASS_BOUNDARY_CONTRACT.revocationRule, /revoke/i);
});

test("boundaries cover tenant data, support debugging, billing, policy override, and incident response", () => {
  assert.deepEqual(
    BREAK_GLASS_BOUNDARY_CONTRACT.accessClasses.map((accessClass) => accessClass.id),
    [
      "tenant-data-inspection",
      "support-debug-context",
      "billing-adjustment-review",
      "policy-override-review",
      "incident-response-emergency",
    ],
  );

  assert.equal(
    BREAK_GLASS_BOUNDARY_CONTRACT.accessClasses.every(
      (accessClass) =>
        accessClass.owner &&
        accessClass.approvalPath.length > 0 &&
        accessClass.auditEvents.length > 0 &&
        accessClass.maxTtlMinutes <= BREAK_GLASS_BOUNDARY_CONTRACT.maxTtlMinutes,
    ),
    true,
  );
});

test("default posture is least privilege and unsupported emergency actions are explicit", () => {
  assert.equal(BREAK_GLASS_BOUNDARY_CONTRACT.defaultPosture, "deny-by-default");
  assert.match(BREAK_GLASS_BOUNDARY_CONTRACT.leastPrivilegeRule, /narrowest/i);
  assert.deepEqual(
    BREAK_GLASS_BOUNDARY_CONTRACT.unsupportedActions.map((action) => action.id),
    [
      "static-breakglass-account",
      "self-approved-session",
      "raw-provider-credential-access",
      "silent-policy-bypass",
      "unbounded-live-data-mutation",
      "indefinite-session",
      "tooling-implementation",
    ],
  );
});

test("session evaluation refuses missing approval, self-approval, expired TTL, missing audit, and unsupported actions", () => {
  const approvedSession = evaluateBreakGlassSession(BREAK_GLASS_BOUNDARY_CONTRACT, {
    accessClassId: "support-debug-context",
    requestedBy: "support-operator",
    approvedBy: "security-approver",
    now: "2026-06-30T05:00:00.000Z",
    expiresAt: "2026-06-30T05:30:00.000Z",
    auditEventIds: ["breakglass.requested", "breakglass.approved", "breakglass.started"],
    customerNotificationDecision: "notify-named-customer-admin-after-redaction",
  });

  assert.deepEqual(approvedSession, { allowed: true, reason: "session-boundary-accepted" });

  assert.equal(
    evaluateBreakGlassSession(BREAK_GLASS_BOUNDARY_CONTRACT, {
      accessClassId: "support-debug-context",
      requestedBy: "support-operator",
      now: "2026-06-30T05:00:00.000Z",
      expiresAt: "2026-06-30T05:30:00.000Z",
      auditEventIds: ["breakglass.requested", "breakglass.started"],
      customerNotificationDecision: "notify-named-customer-admin-after-redaction",
    }).reason,
    "missing-approval",
  );

  assert.equal(
    evaluateBreakGlassSession(BREAK_GLASS_BOUNDARY_CONTRACT, {
      accessClassId: "support-debug-context",
      requestedBy: "support-operator",
      approvedBy: "support-operator",
      now: "2026-06-30T05:00:00.000Z",
      expiresAt: "2026-06-30T05:30:00.000Z",
      auditEventIds: ["breakglass.requested", "breakglass.approved", "breakglass.started"],
      customerNotificationDecision: "notify-named-customer-admin-after-redaction",
    }).reason,
    "self-approval-denied",
  );

  assert.equal(
    evaluateBreakGlassSession(BREAK_GLASS_BOUNDARY_CONTRACT, {
      accessClassId: "support-debug-context",
      requestedBy: "support-operator",
      approvedBy: "security-approver",
      now: "2026-06-30T05:00:00.000Z",
      expiresAt: "2026-06-30T06:30:00.000Z",
      auditEventIds: ["breakglass.requested", "breakglass.approved", "breakglass.started"],
      customerNotificationDecision: "notify-named-customer-admin-after-redaction",
    }).reason,
    "ttl-exceeds-policy",
  );

  assert.equal(
    evaluateBreakGlassSession(BREAK_GLASS_BOUNDARY_CONTRACT, {
      accessClassId: "tooling-implementation",
      requestedBy: "support-operator",
      approvedBy: "security-approver",
      now: "2026-06-30T05:00:00.000Z",
      expiresAt: "2026-06-30T05:30:00.000Z",
      auditEventIds: ["breakglass.requested", "breakglass.approved", "breakglass.started"],
      customerNotificationDecision: "notify-named-customer-admin-after-redaction",
    }).reason,
    "unsupported-emergency-action",
  );
});

test("request classification routes support/admin needs without granting live tooling scope", () => {
  assert.deepEqual(classifyBreakGlassRequest("inspect tenant data for a support incident"), {
    owner: "Security Verification",
    accessClassId: "tenant-data-inspection",
    inScope: true,
  });
  assert.deepEqual(classifyBreakGlassRequest("review a billing adjustment override"), {
    owner: "Billing / Entitlements",
    accessClassId: "billing-adjustment-review",
    inScope: true,
  });
  assert.deepEqual(classifyBreakGlassRequest("build break-glass admin UI"), {
    owner: "Admin Console M1+ implementation",
    accessClassId: "tooling-implementation",
    inScope: false,
  });
});
