import assert from "node:assert/strict";
import { test } from "vitest";

import {
  PRODUCT_NOTIFICATION_TAXONOMY,
  REQUIRED_NOTIFICATION_CLASSES,
  canCreateNotificationFollowUp,
  evaluateNotificationReadiness,
  validateProductNotificationTaxonomy,
} from "../src/product-notification-taxonomy.mjs";

test("HOBO-506 record defines required v1 notification classes and launch ownership", () => {
  const result = validateProductNotificationTaxonomy(PRODUCT_NOTIFICATION_TAXONOMY);

  assert.deepEqual(result.errors, []);
  assert.equal(PRODUCT_NOTIFICATION_TAXONOMY.issue, "HOBO-506");
  assert.equal(PRODUCT_NOTIFICATION_TAXONOMY.phase, "M0");
  assert.deepEqual(
    PRODUCT_NOTIFICATION_TAXONOMY.notificationClasses.map((item) => item.id),
    REQUIRED_NOTIFICATION_CLASSES,
  );

  for (const notificationClass of PRODUCT_NOTIFICATION_TAXONOMY.notificationClasses) {
    assert.ok(notificationClass.channelChoices.length > 0, `${notificationClass.id} missing channels`);
    assert.ok(notificationClass.ownerProject, `${notificationClass.id} missing owner project`);
    assert.ok(notificationClass.copyOwner, `${notificationClass.id} missing copy owner`);
    assert.ok(notificationClass.triggerSource, `${notificationClass.id} missing trigger source`);
    assert.ok(notificationClass.supportVisibility, `${notificationClass.id} missing support visibility`);
    assert.ok(notificationClass.auditVisibility, `${notificationClass.id} missing audit visibility`);
  }
});

test("preferences and consent distinguish transactional messages from optional nudges", () => {
  assert.deepEqual(
    PRODUCT_NOTIFICATION_TAXONOMY.preferencePolicy.transactionalClasses,
    ["workspace-invite", "account-lifecycle", "deployment-status", "billing-entitlement"],
  );
  assert.deepEqual(
    PRODUCT_NOTIFICATION_TAXONOMY.preferencePolicy.optionalClasses,
    ["onboarding-nudge", "marketplace-publisher", "support-handoff"],
  );
  assert.equal(PRODUCT_NOTIFICATION_TAXONOMY.preferencePolicy.legalPrivacyRoute.owner, "V1 Legal, Privacy & Terms Readiness");
  assert.equal(PRODUCT_NOTIFICATION_TAXONOMY.preferencePolicy.optionalOptOutRequired, true);
});

test("delivery evidence covers mocked providers, failures, dedupe, retry, audit, and safe templates", () => {
  assert.deepEqual(
    PRODUCT_NOTIFICATION_TAXONOMY.deliveryEvidence.mockedProviderBoundaries.map((boundary) => boundary.id),
    ["email-provider", "in-app-renderer", "webhook-gateway"],
  );
  assert.ok(PRODUCT_NOTIFICATION_TAXONOMY.deliveryEvidence.failureHandling.bounce);
  assert.ok(PRODUCT_NOTIFICATION_TAXONOMY.deliveryEvidence.failureHandling.failedDelivery);
  assert.ok(PRODUCT_NOTIFICATION_TAXONOMY.deliveryEvidence.dedupe.idempotencyKey);
  assert.ok(PRODUCT_NOTIFICATION_TAXONOMY.deliveryEvidence.retry.maxAttempts > 0);
  assert.deepEqual(PRODUCT_NOTIFICATION_TAXONOMY.deliveryEvidence.auditTrail.events, [
    "notification.Requested",
    "notification.Delivered",
    "notification.Bounced",
    "notification.Failed",
  ]);

  for (const template of PRODUCT_NOTIFICATION_TAXONOMY.deliveryEvidence.customerSafeTemplates) {
    assert.ok(template.reviewOwner, `${template.id} missing review owner`);
    assert.equal(template.redactionRequired, true, `${template.id} must be redaction-gated`);
    assert.ok(template.requiredFields.length > 0, `${template.id} missing required fields`);
  }
});

test("scope-out separates lifecycle notifications from incident, status-page, marketing, and notification-center work", () => {
  assert.deepEqual(
    PRODUCT_NOTIFICATION_TAXONOMY.scopeOut.map((item) => item.id),
    [
      "incident-communications",
      "status-page-updates",
      "marketing-email",
      "post-v1-notification-center",
      "live-email-service-implementation",
    ],
  );
});

test("M1 follow-up work stays blocked until required classes and boundaries are accepted", () => {
  assert.deepEqual(canCreateNotificationFollowUp({ phase: "M1", m0Accepted: false }), {
    allowed: false,
    reason: "HOBO-506 M0 product notification taxonomy is not accepted.",
  });
  assert.deepEqual(canCreateNotificationFollowUp({ phase: "M1", m0Accepted: true }), {
    allowed: true,
    reason: "Notification follow-up may reference the accepted HOBO-506 taxonomy.",
  });
  assert.equal(canCreateNotificationFollowUp({ phase: "M0", m0Accepted: true }).allowed, false);
});

test("customer readiness check requires receive, understand, opt-out where appropriate, and support evidence", () => {
  const optionalClass = PRODUCT_NOTIFICATION_TAXONOMY.notificationClasses.find(
    (item) => item.id === "onboarding-nudge",
  );
  const transactionalClass = PRODUCT_NOTIFICATION_TAXONOMY.notificationClasses.find(
    (item) => item.id === "billing-entitlement",
  );

  assert.deepEqual(
    evaluateNotificationReadiness(optionalClass, {
      channelFixture: true,
      templateReviewed: true,
      preferenceHonored: true,
      supportAuditEvidence: true,
    }),
    { ok: true, errors: [] },
  );
  assert.deepEqual(
    evaluateNotificationReadiness(transactionalClass, {
      channelFixture: true,
      templateReviewed: true,
      supportAuditEvidence: true,
    }),
    { ok: true, errors: [] },
  );
});

test("validation rejects email-service implementation scope creep and scattered ownerless classes", () => {
  const invalid = structuredClone(PRODUCT_NOTIFICATION_TAXONOMY);
  invalid.scopeIn.push("Implement SendGrid email service delivery and SMTP retry workers now.");
  invalid.notificationClasses[0] = {
    ...invalid.notificationClasses[0],
    ownerProject: "",
    copyOwner: "",
    supportVisibility: "",
  };
  invalid.deliveryEvidence.mockedProviderBoundaries[0] = {
    ...invalid.deliveryEvidence.mockedProviderBoundaries[0],
    workKind: "live-provider-integration",
  };

  const result = validateProductNotificationTaxonomy(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /email service implementation is scope-out/);
  assert.match(result.errors.join("\n"), /workspace-invite missing ownerProject/);
  assert.match(result.errors.join("\n"), /workspace-invite missing copyOwner/);
  assert.match(result.errors.join("\n"), /workspace-invite missing supportVisibility/);
  assert.match(result.errors.join("\n"), /live-provider-integration is out of scope/);
});

test("readiness fails closed when optional consent, template review, or support evidence is missing", () => {
  const optionalClass = PRODUCT_NOTIFICATION_TAXONOMY.notificationClasses.find(
    (item) => item.id === "marketplace-publisher",
  );

  const result = evaluateNotificationReadiness(optionalClass, {
    channelFixture: true,
    templateReviewed: false,
    preferenceHonored: false,
    supportAuditEvidence: false,
  });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /template review/);
  assert.match(result.errors.join("\n"), /opt-out/);
  assert.match(result.errors.join("\n"), /support audit evidence/);
});
