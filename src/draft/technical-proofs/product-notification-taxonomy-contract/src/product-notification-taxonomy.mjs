export const REQUIRED_NOTIFICATION_CLASSES = [
  "workspace-invite",
  "account-lifecycle",
  "onboarding-nudge",
  "deployment-status",
  "billing-entitlement",
  "marketplace-publisher",
  "support-handoff",
];

const FOLLOW_UP_PHASES = new Set(["M1", "M2", "M3", "M4"]);
const REQUIRED_SCOPE_OUT = [
  "incident-communications",
  "status-page-updates",
  "marketing-email",
  "post-v1-notification-center",
  "live-email-service-implementation",
];
const FORBIDDEN_SCOPE_PATTERNS = [
  /\b(implement|build|wire|ship|integrate|operate)\b.*\b(email service|sendgrid|smtp|delivery worker|notification center)\b/i,
  /\b(marketing campaign|marketing email automation|newsletter)\b/i,
];

export const PRODUCT_NOTIFICATION_TAXONOMY = {
  schema: "hobo.product-notification-taxonomy/v1",
  issue: "HOBO-506",
  project: "Product Notifications & Lifecycle Communications",
  phase: "M0",
  goal:
    "Define v1 product lifecycle notification classes, ownership, preference boundaries, and delivery evidence before implementation work can claim customers receive understandable and supportable messages.",
  designRefs: [
    "docs/design/data-plane.md#plan-11",
    "docs/design/adr/03-data-plane.md#adr-0059",
    "docs/design/launch-support-escalation.md",
    "docs/design/billing-launch-policy.md",
    "docs/design/workspace-onboarding-ux.md",
  ],
  scopeIn: [
    "Required v1 lifecycle notification classes and owner routing.",
    "Channel choices, copy owner, trigger source, support visibility, and audit visibility per class.",
    "Preference and consent posture for transactional versus optional messages.",
    "Mocked delivery evidence, failure handling, dedupe, retry, audit trail, and customer-safe templates.",
    "M1 follow-up gate after notification classes and delivery boundaries are accepted.",
  ],
  notificationClasses: [
    {
      id: "workspace-invite",
      label: "Workspace invite",
      channelChoices: ["email", "in-app"],
      ownerProject: "Workspace & Onboarding UX",
      copyOwner: "Workspace onboarding copy owner",
      triggerSource: "workspace.invite-created",
      preference: "transactional",
      supportVisibility: "Invite id, target principal ref, sender workspace, and delivery state are support-visible.",
      auditVisibility: "notification.Requested plus delivery outcome with crypto-shreddable recipient reference.",
    },
    {
      id: "account-lifecycle",
      label: "Account and workspace lifecycle",
      channelChoices: ["email", "in-app"],
      ownerProject: "Settings & Project Lifecycle",
      copyOwner: "Account lifecycle copy owner",
      triggerSource: "account, workspace, or project lifecycle state change",
      preference: "transactional",
      supportVisibility: "Support sees lifecycle event id, affected workspace/project, state, and last delivery outcome.",
      auditVisibility: "Lifecycle message request and outcome are retained as customer-safe audit facts.",
    },
    {
      id: "onboarding-nudge",
      label: "Onboarding nudge",
      channelChoices: ["in-app", "email"],
      ownerProject: "Workspace & Onboarding UX",
      copyOwner: "First-run product copy owner",
      triggerSource: "first-run activation rail stalled or next action available",
      preference: "optional",
      supportVisibility: "Support sees nudge category, current activation stage, and opt-out state.",
      auditVisibility: "Only category, template id, and delivery result are retained; no broad behavioral tracking.",
    },
    {
      id: "deployment-status",
      label: "Deployment status",
      channelChoices: ["in-app", "webhook", "email"],
      ownerProject: "Deployment Dashboard & Topology Explorer",
      copyOwner: "Deployment status copy owner",
      triggerSource: "deployment status, plan approval, rollback, or launch-blocker event",
      preference: "transactional",
      supportVisibility: "Support sees deployment id, environment, status, blocker class, and delivery state.",
      auditVisibility: "Status message links to deployment, blocker, and rollback evidence without provider secrets.",
    },
    {
      id: "billing-entitlement",
      label: "Billing and entitlement",
      channelChoices: ["email", "in-app"],
      ownerProject: "Billing & Credits",
      copyOwner: "Billing launch policy owner",
      triggerSource: "billing lifecycle, invoice, credit, entitlement, or payment state change",
      preference: "transactional",
      supportVisibility: "Support sees customer-safe billing state, entitlement impact, and invoice evidence reference.",
      auditVisibility: "Billing notification facts link to usage and invoice evidence without payment credentials.",
    },
    {
      id: "marketplace-publisher",
      label: "Marketplace and publisher lifecycle",
      channelChoices: ["in-app", "email"],
      ownerProject: "Marketplace UX",
      copyOwner: "Marketplace trust and publisher copy owner",
      triggerSource: "publisher trust tier, listing review, yank, install approval, or org catalog update",
      preference: "optional",
      supportVisibility: "Support sees listing id, publisher id, trust tier, customer-safe warning, and delivery result.",
      auditVisibility: "Marketplace message links to listing and trust evidence without exposing reviewer notes by default.",
    },
    {
      id: "support-handoff",
      label: "Support handoff and lifecycle follow-up",
      channelChoices: ["email", "in-app"],
      ownerProject: "V1 Launch Support Desk & Escalation",
      copyOwner: "Support communications owner",
      triggerSource: "support handoff, readiness gap, accepted limitation, or follow-up owner change",
      preference: "optional",
      supportVisibility: "Support sees handoff reason, owner lane, ticket or incident id, and delivery result.",
      auditVisibility: "Support handoff messages link to approved evidence and redaction review state.",
    },
  ],
  preferencePolicy: {
    transactionalClasses: ["workspace-invite", "account-lifecycle", "deployment-status", "billing-entitlement"],
    optionalClasses: ["onboarding-nudge", "marketplace-publisher", "support-handoff"],
    optionalOptOutRequired: true,
    preferenceSurfaces: ["workspace settings", "profile notification preferences", "support override record"],
    legalPrivacyRoute: {
      owner: "V1 Legal, Privacy & Terms Readiness",
      routesFor: ["consent wording", "privacy notice", "retention dispute", "regional messaging limit"],
    },
  },
  deliveryEvidence: {
    mockedProviderBoundaries: [
      {
        id: "email-provider",
        assumption: "Email delivery is represented by deterministic accepted, bounced, failed, and delayed fixtures.",
        scopeBoundary: "No live SMTP, SendGrid, SES, Mailgun, or stored provider credential integration.",
      },
      {
        id: "in-app-renderer",
        assumption: "In-app delivery is represented by a template/render fixture and read-state fixture.",
        scopeBoundary: "No notification center or production dashboard implementation in HOBO-506.",
      },
      {
        id: "webhook-gateway",
        assumption: "Webhook delivery is represented by signed fixture responses and retry outcomes.",
        scopeBoundary: "No live outbound webhook execution or customer endpoint storage.",
      },
    ],
    failureHandling: {
      bounce: "Bounced email creates customer-safe support evidence and does not retry forever.",
      failedDelivery: "Failed delivery records class, channel, provider fixture reason, and owner lane.",
      delayedDelivery: "Delayed delivery remains visible to support with retry state and next attempt.",
    },
    dedupe: {
      idempotencyKey: "notification class + trigger source id + principal ref + channel",
      duplicatePolicy: "Duplicate provider callbacks converge on one delivery outcome record.",
    },
    retry: {
      maxAttempts: 3,
      backoff: "bounded deterministic backoff in fixture evidence",
      stopCondition: "do not retry after bounce, opt-out, legal hold, or missing template approval",
    },
    auditTrail: {
      events: [
        "notification.Requested",
        "notification.Delivered",
        "notification.Bounced",
        "notification.Failed",
      ],
      piiRule: "Recipient addresses are references, not plaintext audit fields.",
    },
    customerSafeTemplates: [
      {
        id: "template.lifecycle",
        reviewOwner: "product copy owner",
        redactionRequired: true,
        requiredFields: ["subject", "reason", "safe next action", "support reference"],
      },
      {
        id: "template.billing-entitlement",
        reviewOwner: "billing launch policy owner",
        redactionRequired: true,
        requiredFields: ["state", "entitlement impact", "support reference", "billing evidence link"],
      },
      {
        id: "template.deployment-status",
        reviewOwner: "deployment status copy owner",
        redactionRequired: true,
        requiredFields: ["deployment id", "status", "next owner", "safe troubleshooting link"],
      },
    ],
  },
  scopeOut: [
    {
      id: "incident-communications",
      boundary: "Incident and response messaging stays in Launch Support Escalation and Operators/SRE.",
    },
    {
      id: "status-page-updates",
      boundary: "Public status-page publication and subscriber updates stay in Developer Experience status-page work.",
    },
    {
      id: "marketing-email",
      boundary: "Marketing campaigns, newsletters, and nurture automation are not v1 product lifecycle notifications.",
    },
    {
      id: "post-v1-notification-center",
      boundary: "A broad notification-center product surface is deferred until after v1.",
    },
    {
      id: "live-email-service-implementation",
      boundary: "No live email, SMS, push, webhook, or provider delivery service is implemented in HOBO-506.",
    },
  ],
};

export function canCreateNotificationFollowUp({ phase, m0Accepted } = {}) {
  if (!m0Accepted) {
    return {
      allowed: false,
      reason: "HOBO-506 M0 product notification taxonomy is not accepted.",
    };
  }
  if (!FOLLOW_UP_PHASES.has(phase)) {
    return {
      allowed: false,
      reason: "Only M1-M4 notification follow-up work may reference the accepted HOBO-506 taxonomy.",
    };
  }

  return {
    allowed: true,
    reason: "Notification follow-up may reference the accepted HOBO-506 taxonomy.",
  };
}

export function evaluateNotificationReadiness(notificationClass, evidence = {}) {
  const errors = [];

  if (!notificationClass) {
    return { ok: false, errors: ["notification class is required"] };
  }
  if (!evidence.channelFixture) {
    errors.push(`${notificationClass.id} needs a receive-channel fixture`);
  }
  if (!evidence.templateReviewed) {
    errors.push(`${notificationClass.id} needs template review before customers can understand it`);
  }
  if (notificationClass.preference === "optional" && !evidence.preferenceHonored) {
    errors.push(`${notificationClass.id} must honor opt-out preference before send`);
  }
  if (!evidence.supportAuditEvidence) {
    errors.push(`${notificationClass.id} needs support audit evidence`);
  }

  return { ok: errors.length === 0, errors };
}

export function validateProductNotificationTaxonomy(record) {
  const errors = [];

  if (!isPlainObject(record)) {
    return { ok: false, errors: ["product notification taxonomy record is required"] };
  }
  if (record.issue !== "HOBO-506") {
    errors.push("issue must be HOBO-506");
  }
  if (record.phase !== "M0") {
    errors.push("phase must be M0");
  }

  validateNotificationClasses(record, errors);
  validatePreferencePolicy(record.preferencePolicy, errors);
  validateDeliveryEvidence(record.deliveryEvidence, errors);
  validateScope(record, errors);

  return { ok: errors.length === 0, errors };
}

function validateNotificationClasses(record, errors) {
  const ids = (record.notificationClasses ?? []).map((item) => item.id);
  for (const required of REQUIRED_NOTIFICATION_CLASSES) {
    if (!ids.includes(required)) {
      errors.push(`missing notification class: ${required}`);
    }
  }

  for (const notificationClass of record.notificationClasses ?? []) {
    if (!Array.isArray(notificationClass.channelChoices) || notificationClass.channelChoices.length === 0) {
      errors.push(`${notificationClass.id ?? "<missing>"} missing channelChoices`);
    }
    for (const field of ["ownerProject", "copyOwner", "triggerSource", "supportVisibility", "auditVisibility"]) {
      if (!notificationClass[field]) {
        errors.push(`${notificationClass.id ?? "<missing>"} missing ${field}`);
      }
    }
    if (!["transactional", "optional"].includes(notificationClass.preference)) {
      errors.push(`${notificationClass.id ?? "<missing>"} preference must be transactional or optional`);
    }
  }
}

function validatePreferencePolicy(policy, errors) {
  if (!policy?.optionalOptOutRequired) {
    errors.push("optional notification classes must require opt-out support");
  }
  if (!policy?.legalPrivacyRoute?.owner) {
    errors.push("preference policy must route legal/privacy questions to an owner");
  }

  const classified = new Set([
    ...(policy?.transactionalClasses ?? []),
    ...(policy?.optionalClasses ?? []),
  ]);
  for (const required of REQUIRED_NOTIFICATION_CLASSES) {
    if (!classified.has(required)) {
      errors.push(`${required} must be classified as transactional or optional`);
    }
  }
}

function validateDeliveryEvidence(evidence, errors) {
  if (!Array.isArray(evidence?.mockedProviderBoundaries) || evidence.mockedProviderBoundaries.length === 0) {
    errors.push("mocked provider boundaries are required");
  }
  for (const boundary of evidence?.mockedProviderBoundaries ?? []) {
    if (boundary.workKind === "live-provider-integration") {
      errors.push("live-provider-integration is out of scope");
    }
    for (const field of ["assumption", "scopeBoundary"]) {
      if (!boundary[field]) {
        errors.push(`${boundary.id ?? "<missing>"} missing ${field}`);
      }
    }
  }

  if (!evidence?.failureHandling?.bounce) {
    errors.push("bounce handling is required");
  }
  if (!evidence?.failureHandling?.failedDelivery) {
    errors.push("failed delivery handling is required");
  }
  if (!evidence?.dedupe?.idempotencyKey) {
    errors.push("dedupe idempotency key is required");
  }
  if (!evidence?.retry?.maxAttempts) {
    errors.push("retry policy is required");
  }

  for (const eventName of ["notification.Requested", "notification.Delivered"]) {
    if (!evidence?.auditTrail?.events?.includes(eventName)) {
      errors.push(`audit trail must include ${eventName}`);
    }
  }

  if (!Array.isArray(evidence?.customerSafeTemplates) || evidence.customerSafeTemplates.length === 0) {
    errors.push("customer-safe templates are required");
  }
  for (const template of evidence?.customerSafeTemplates ?? []) {
    if (!template.reviewOwner) {
      errors.push(`${template.id ?? "<missing>"} missing review owner`);
    }
    if (!template.redactionRequired) {
      errors.push(`${template.id ?? "<missing>"} requires redaction before customer use`);
    }
    if (!Array.isArray(template.requiredFields) || template.requiredFields.length === 0) {
      errors.push(`${template.id ?? "<missing>"} missing required fields`);
    }
  }
}

function validateScope(record, errors) {
  const scopeOutIds = new Set((record.scopeOut ?? []).map((item) => item.id));
  for (const id of REQUIRED_SCOPE_OUT) {
    if (!scopeOutIds.has(id)) {
      errors.push(`${id} scope-out is required`);
    }
  }
  for (const scopeItem of record.scopeIn ?? []) {
    if (FORBIDDEN_SCOPE_PATTERNS.some((pattern) => pattern.test(scopeItem))) {
      errors.push(`email service implementation is scope-out: ${scopeItem}`);
    }
  }
}

function isPlainObject(value) {
  return value != null && Object.prototype.toString.call(value) === "[object Object]";
}
