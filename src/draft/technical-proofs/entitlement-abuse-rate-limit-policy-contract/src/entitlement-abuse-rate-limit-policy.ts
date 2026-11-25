const REQUIRED_LIMIT_TYPES = Object.freeze([
  "request-rate",
  "concurrency",
  "runtime-usage",
  "generation-run",
  "spend-reservation",
  "support-tier",
]);

const REQUIRED_RATE_LIMIT_BEHAVIORS = Object.freeze(["soft-warn", "backpressure", "hard-deny", "manual-hold"]);
const REQUIRED_CUSTOMER_STATES = Object.freeze(["normal", "grace", "appeal-open", "suspended", "recovered"]);
const REQUIRED_RESPONSE_IDS = Object.freeze([
  "runaway-usage",
  "rate-limit-exceeded",
  "suspected-fraud",
  "abuse-confirmed",
  "false-positive",
]);

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "fraud scoring",
    pattern: /\b(fraud scoring engine|risk model|production risk model|model selection|scoring vendor)\b/i,
  },
  {
    label: "runtime implementation",
    pattern: /\b(build|implement|wire|ship)\b.{0,80}\b(rate limiter|runtime service|suspension automation|quota enforcer)\b/i,
  },
  {
    label: "billing implementation",
    pattern: /\b(payment provider|chargeback|refund workflow|invoice workflow|live billing|provider fraud webhook)\b/i,
  },
  {
    label: "support implementation",
    pattern: /\b(helpdesk integration|support ticket automation|appeal queue implementation)\b/i,
  },
]);

type IdentifiedPolicyEntry = {
  readonly id: string;
};

type AbuseResponsePolicyEntry = IdentifiedPolicyEntry & {
  readonly auditEvidence?: readonly string[];
  readonly customerCommunication?: string;
  readonly recoveryPath?: string;
};

type SupportOverridePolicyEntry = {
  readonly id?: string;
  readonly requiresAudit?: boolean;
};

type EntitlementAbuseRateLimitPolicyLike = {
  readonly issue?: string;
  readonly phase?: string;
  readonly limitTypes?: readonly IdentifiedPolicyEntry[];
  readonly rateLimitBehaviors?: readonly IdentifiedPolicyEntry[];
  readonly customerStates?: readonly IdentifiedPolicyEntry[];
  readonly responseMatrix?: readonly AbuseResponsePolicyEntry[];
  readonly boundaries?: readonly IdentifiedPolicyEntry[];
  readonly supportOverrides?: readonly SupportOverridePolicyEntry[];
  readonly scopeIn?: readonly string[];
};

export const REQUIRED_BOUNDARIES = Object.freeze([
  "service",
  "billing",
  "tenant-quotas",
  "security",
  "support",
]);

export const ENTITLEMENT_ABUSE_RATE_LIMIT_POLICY = Object.freeze({
  issue: "HOBO-491",
  project: "Entitlements & Plan Limits",
  phase: "M0",
  goal:
    "Define a customer-safe entitlement abuse, rate-limit, and fraud response policy without selecting a fraud scoring engine or building runtime enforcement.",
  scopeIn: Object.freeze([
    "Define entitlement limit types that can trigger abuse, rate-limit, grace, suspension, appeal, and support override handling.",
    "Define rate-limit response behavior for soft warning, backpressure, hard denial, and manual hold states.",
    "Define customer-safe grace, appeal, suspension, and recovery states with communication and support handoff evidence.",
    "Define abuse and suspected-fraud response rows with audit evidence, customer communication, and recovery path.",
    "Map billing, tenant quota, security verification, and support boundaries without implementing those adjacent systems.",
  ]),
  scopeOut: Object.freeze([
    "No fraud scoring engine selection, risk-model tuning, scoring vendor choice, or production model calibration.",
    "No rate limiter runtime service, quota enforcer, suspension automation, or live enforcement implementation.",
    "No payment provider integration, invoice workflow, refund workflow, chargeback workflow, or live fraud webhook.",
    "No support ticket automation, appeal queue implementation, or helpdesk integration.",
    "No live customer suspension, customer-data access, production fraud investigation, or final legal policy text.",
  ]),
  limitTypes: Object.freeze([
    { id: "request-rate", owner: "Tenant Isolation & Quotas" },
    { id: "concurrency", owner: "Tenant Isolation & Quotas" },
    { id: "runtime-usage", owner: "Usage Metering" },
    { id: "generation-run", owner: "Usage Metering" },
    { id: "spend-reservation", owner: "Billing & Credits" },
    { id: "support-tier", owner: "Support Workflow" },
  ]),
  rateLimitBehaviors: Object.freeze([
    {
      id: "soft-warn",
      customerVisible: true,
      auditEvent: "entitlement.RateLimitWarned",
      rule: "Warn before denial when usage is near a published entitlement limit.",
    },
    {
      id: "backpressure",
      customerVisible: true,
      auditEvent: "entitlement.BackpressureApplied",
      rule: "Slow or queue non-critical work while preserving export and support paths.",
    },
    {
      id: "hard-deny",
      customerVisible: true,
      auditEvent: "entitlement.ActionDenied",
      rule: "Deny new limit-consuming actions when grace is exhausted or policy requires fail-closed behavior.",
    },
    {
      id: "manual-hold",
      customerVisible: true,
      auditEvent: "entitlement.ManualHoldOpened",
      rule: "Hold risky expansion until support, security, or billing owner records a decision.",
    },
  ]),
  customerStates: Object.freeze([
    { id: "normal", supportVisible: true, recoveryRequired: false },
    { id: "grace", supportVisible: true, recoveryRequired: true },
    { id: "appeal-open", supportVisible: true, recoveryRequired: true },
    { id: "suspended", supportVisible: true, recoveryRequired: true },
    { id: "recovered", supportVisible: true, recoveryRequired: false },
  ]),
  appealPolicy: Object.freeze({
    owner: "Support Workflow",
    requiredFields: Object.freeze(["customer-safe-reason", "evidence-link", "decision-owner", "next-review-at"]),
    rule: "Appeals require support ownership and audit evidence before any override or recovery claim.",
  }),
  supportOverrides: Object.freeze([
    {
      id: "temporary-grace-extension",
      requiresAudit: true,
      requiresTtl: true,
      owner: "Support Workflow",
    },
    {
      id: "manual-limit-exception",
      requiresAudit: true,
      requiresTtl: true,
      owner: "Entitlements & Plan Limits",
    },
    {
      id: "security-release-hold",
      requiresAudit: true,
      requiresTtl: false,
      owner: "Security Verification",
    },
  ]),
  responseMatrix: Object.freeze([
    {
      id: "runaway-usage",
      auditEvidence: Object.freeze(["metering-fact-ref", "limit-decision-event", "support-owner"]),
      customerCommunication: "Explain the exceeded limit, current grace or denial state, and support route.",
      recoveryPath: "Usage returns below threshold or support records a temporary grace extension.",
    },
    {
      id: "rate-limit-exceeded",
      auditEvidence: Object.freeze(["quota-dimension", "rate-limit-behavior", "retry-after-window"]),
      customerCommunication: "Show backpressure or denial reason with retry and upgrade/support path.",
      recoveryPath: "Retry after the published window or accepted entitlement change.",
    },
    {
      id: "suspected-fraud",
      auditEvidence: Object.freeze(["trigger-source", "security-owner", "manual-review-record"]),
      customerCommunication: "Use safe account-review language without exposing detection internals.",
      recoveryPath: "Security or billing owner clears the hold and support records the customer-safe outcome.",
    },
    {
      id: "abuse-confirmed",
      auditEvidence: Object.freeze(["policy-decision", "customer-impact-summary", "appeal-route"]),
      customerCommunication: "State the policy outcome, preserved export/support access, and appeal channel.",
      recoveryPath: "Customer remediates the abuse condition or owner approves a bounded reinstatement.",
    },
    {
      id: "false-positive",
      auditEvidence: Object.freeze(["reviewer", "reversal-reason", "customer-notice"]),
      customerCommunication: "Acknowledge restored access and summarize the safe correction.",
      recoveryPath: "Reopen normal entitlement state and retain the corrected audit trail.",
    },
  ]),
  boundaries: Object.freeze([
    {
      id: "service",
      owner: "Entitlements & Plan Limits",
      rule: "Owns policy states, response rows, support override fields, and acceptance proof.",
    },
    {
      id: "billing",
      owner: "Billing & Credits",
      rule: "Owns plan/payment states, refunds, chargebacks, and money movement; this policy only consumes billing posture.",
    },
    {
      id: "tenant-quotas",
      owner: "Tenant Isolation & Quotas",
      rule: "Owns runtime quota dimensions, noisy-neighbor handling, and enforcement evidence.",
    },
    {
      id: "security",
      owner: "Security Verification",
      rule: "Owns suspected fraud review, security launch blockers, and sensitive evidence handling.",
    },
    {
      id: "support",
      owner: "Support Workflow",
      rule: "Owns appeal intake, customer-safe communication, and escalation workflow later.",
    },
  ]),
  designRefs: Object.freeze([
    "docs/design/entitlements-plan-limits.md",
    "docs/design/billing-launch-policy.md",
    "docs/design/usage-metering.md",
    "docs/design/tenant-isolation-quotas.md",
    "docs/design/security-verification.md",
    "docs/design/support-sla-channels.md",
  ]),
  adrRefs: Object.freeze([
    "docs/design/adr/02-identity-security.md#adr-0039",
    "docs/design/adr/02-identity-security.md#adr-0074",
    "docs/design/adr/02-identity-security.md#adr-0077",
    "docs/design/adr/02-identity-security.md#adr-0080",
  ]),
});

export function canPublishAbusePolicyFollowUp({
  phase,
  policyAccepted,
}: {
  phase: string;
  policyAccepted: boolean;
}) {
  if (!IMPLEMENTATION_PHASES.has(phase)) {
    return { allowed: true, reason: "Phase does not depend on the HOBO-491 policy acceptance gate." };
  }
  if (policyAccepted) {
    return { allowed: true, reason: "HOBO-491 abuse and rate-limit response policy is accepted." };
  }
  return {
    allowed: false,
    reason: "M1-M4 entitlement abuse, rate-limit, and fraud-response work waits for accepted HOBO-491 policy.",
  };
}

export function classifyAbusePolicyDecision(decision: string) {
  const text = String(decision ?? "").toLowerCase();

  if (/\b(fraud scoring|risk model|scoring model|scoring vendor)\b/.test(text)) {
    return { owner: "Security Verification", inScope: false };
  }
  if (/\b(invoice|chargeback|refund|payment|checkout|billing)\b/.test(text)) {
    return { owner: "Billing & Credits", inScope: false };
  }
  if (/\b(tenant quota|runtime enforcement|quota runtime|noisy neighbor|rate limiter service)\b/.test(text)) {
    return { owner: "Tenant Isolation & Quotas", inScope: false };
  }
  if (/\b(support ticket automation|helpdesk|appeal queue)\b/.test(text)) {
    return { owner: "Support Workflow", inScope: false };
  }

  return { owner: "Entitlements & Plan Limits", inScope: true };
}

export function validateEntitlementAbuseRateLimitPolicy(policy: EntitlementAbuseRateLimitPolicyLike) {
  const errors: string[] = [];

  if (policy.issue !== "HOBO-491") {
    errors.push("Policy record must be tied to HOBO-491.");
  }
  if (policy.phase !== "M0") {
    errors.push("Policy record must remain an M0 acceptance record.");
  }

  for (const limitType of REQUIRED_LIMIT_TYPES) {
    if (!policy.limitTypes?.some((entry) => entry.id === limitType)) {
      errors.push(`Missing entitlement limit type: ${limitType}.`);
    }
  }
  for (const behavior of REQUIRED_RATE_LIMIT_BEHAVIORS) {
    if (!policy.rateLimitBehaviors?.some((entry) => entry.id === behavior)) {
      errors.push(`Missing rate-limit behavior: ${behavior}.`);
    }
  }
  for (const state of REQUIRED_CUSTOMER_STATES) {
    if (!policy.customerStates?.some((entry) => entry.id === state)) {
      errors.push(`Missing customer state: ${state}.`);
    }
  }
  for (const responseId of REQUIRED_RESPONSE_IDS) {
    const response = policy.responseMatrix?.find((entry) => entry.id === responseId);
    if (!response) {
      errors.push(`Missing response row: ${responseId}.`);
      continue;
    }
    if ((response.auditEvidence ?? []).length < 2) {
      errors.push(`Response ${responseId} needs audit evidence.`);
    }
    if (!response.customerCommunication) {
      errors.push(`Response ${responseId} needs customer communication.`);
    }
    if (!response.recoveryPath) {
      errors.push(`Response ${responseId} needs recovery path.`);
    }
  }
  for (const boundary of REQUIRED_BOUNDARIES) {
    if (!policy.boundaries?.some((entry) => entry.id === boundary)) {
      errors.push(`Missing boundary: ${boundary}.`);
    }
  }
  for (const item of policy.supportOverrides ?? []) {
    if (item.requiresAudit !== true) {
      errors.push(`Support override ${item.id ?? "<unknown>"} must require audit.`);
    }
  }
  for (const item of policy.scopeIn ?? []) {
    for (const { label, pattern } of FORBIDDEN_SCOPE_PATTERNS) {
      if (pattern.test(item)) {
        errors.push(`M0 scope-in includes out-of-scope ${label} work: ${item}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
