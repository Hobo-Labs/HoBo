const REQUIRED_M1_EVIDENCE = Object.freeze([
  "plan-entitlement-taxonomy",
  "limit-decision-fixture",
  "usage-metering-handoff",
  "customer-visible-limit-copy",
  "support-override-audit",
  "scope-boundary-register",
]);

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "billing",
    pattern: /\b(invoice|payment|refund|tax|chargeback|checkout|billing engine|money movement)\b/i,
  },
  {
    label: "runtime enforcement",
    pattern: /\b(implement|build|ship|provision|create)\b.{0,64}\b(runtime quota|quota enforcer|policy engine|rate limiter)\b/i,
  },
  {
    label: "RBAC",
    pattern: /\b(rbac|role grant|member invite|authorization grant|permission administration)\b/i,
  },
  {
    label: "provider",
    pattern: /\b(provider quota|provider billing|live provider|provider sync)\b/i,
  },
  {
    label: "abuse response",
    pattern: /\b(abuse|fraud|appeals?|suspension automation)\b/i,
  },
]);

export const REQUIRED_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

export const ENTITLEMENTS_PLAN_LIMITS_SCOPE = Object.freeze({
  issue: "HOBO-419",
  project: "Entitlements & Plan Limits",
  phase: "M0",
  goal:
    "Define Entitlements & Plan Limits M0 scope so plan tier promises, entitlement categories, plan limit decisions, customer-visible limit copy, support overrides, and M1 evidence are accepted before enforcement work begins.",
  personas: Object.freeze([
    {
      id: "workspace-admin",
      need: "Understands which plan tier, workspace limits, grace states, and visible upgrade paths apply before launch.",
    },
    {
      id: "platform-engineer",
      need: "Needs a precise decision fixture for later policy gates, quotas, and runtime enforcement without building them here.",
    },
    {
      id: "billing-finops-owner",
      need: "Needs plan and usage handoff boundaries that reuse billing and metering evidence without turning this issue into invoicing.",
    },
    {
      id: "support-operator",
      need: "Needs safe limit explanations, override evidence, TTL, and escalation ownership without hidden quota grants.",
    },
    {
      id: "security-compliance-reviewer",
      need: "Confirms entitlement decisions are auditable, least-privilege, and do not bypass mandatory policy or tenant isolation.",
    },
  ]),
  scopeIn: Object.freeze([
    "Define accepted plan tier names and entitlement categories for private beta, paid team, and enterprise manual launch posture.",
    "Define limit decision states for allowed, warned, grace, denied, suspended, and override-approved cases.",
    "Map plan limit types for seats, projects, environments, runtime usage, request rate, concurrency, generation runs, spend reservation, and support tier.",
    "Record customer-visible copy and support/audit handoff rules for limit denials, grace, suspension, and approved overrides.",
    "List M1 evidence required before policy gates, runtime quota enforcement, billing integration, or settings UX work can fan out.",
  ]),
  scopeOut: Object.freeze([
    "No invoice generation, checkout, payment collection, refund processing, tax, chargeback, or money movement.",
    "No runtime quota enforcer, policy engine, rate limiter, provider quota sync, or production entitlement service.",
    "No member invite flow, RBAC role grants, authorization engine, or account administration UI.",
    "No abuse/fraud investigation workflow, appeals process, suspension automation, or rate-limit response policy.",
    "No live customer plan mutation, customer-facing billing page, provider credential storage, or final legal pricing claim.",
    "No M1-M4 design or implementation issue creation before M0 acceptance is recorded.",
  ]),
  nonGoals: Object.freeze([
    "Replace Billing & Credits launch policy.",
    "Replace Usage Metering showback facts or MeteringView/CreditLedger contracts.",
    "Replace Tenant Isolation & Quotas runtime isolation proof.",
    "Approve launch pricing, packaging, legal terms, or customer contracts.",
  ]),
  boundaries: Object.freeze([
    {
      id: "service",
      owner: "Entitlements & Plan Limits",
      promise:
        "Owns accepted plan tier, limit type, decision-state, override, and M1 evidence records; runtime services implement later.",
    },
    {
      id: "ux",
      owner: "Settings & Project Lifecycle",
      promise:
        "May later expose limit copy, upgrade prompts, and read-only entitlement state; mutation UX is out of this M0 issue.",
    },
    {
      id: "security",
      owner: "Security Verification",
      promise:
        "Requires auditability, least privilege, mandatory policy compatibility, and no hidden bypass for overrides.",
    },
    {
      id: "support",
      owner: "Support Workflow",
      promise:
        "Receives customer-safe denial reasons, override TTL, audit evidence, and escalation ownership without silent quota grants.",
    },
  ]),
  designRefs: Object.freeze([
    "docs/design/usage-metering.md",
    "docs/design/billing-launch-policy.md",
    "docs/design/tenant-isolation-quotas.md",
    "docs/design/reliability-observability-cost.md#plan-05",
    "docs/design/security-networking.md#plan-50",
  ]),
  adrRefs: Object.freeze([
    "docs/design/adr/02-identity-security.md#adr-0039",
    "docs/design/adr/02-identity-security.md#adr-0074",
    "docs/design/adr/07-portability-extensibility.md#adr-0064",
  ]),
  initiativeDependencies: Object.freeze([
    {
      owner: "Entitlements & Plan Limits",
      boundary: "Owns plan tier taxonomy, limit decision states, override evidence, and the M0 follow-up gate.",
    },
    {
      owner: "Usage Metering",
      boundary: "Supplies usage facts and metering dimensions consumed by future limit decisions.",
    },
    {
      owner: "Billing & Credits",
      boundary: "Supplies plans and payment states; invoices, payment, refunds, tax, and pricing remain there.",
    },
    {
      owner: "Tenant Isolation & Quotas",
      boundary: "Supplies tenant and quota vocabulary; runtime isolation and noisy-neighbor proof remain there.",
    },
    {
      owner: "Settings & Project Lifecycle",
      boundary: "Owns later workspace/project settings UX that may expose accepted entitlement state.",
    },
    {
      owner: "Support Workflow",
      boundary: "Owns support queues, escalation, customer communication, and manual override operating procedure later.",
    },
    {
      owner: "V1 Release Program & Cutline",
      boundary: "Uses M0 acceptance to decide when downstream M1-M4 issues may be created.",
    },
  ]),
  planTiers: Object.freeze([
    {
      id: "private-beta-free",
      promise: "Free private beta workspace with explicit beta limits and no invoice generation.",
    },
    {
      id: "team-paid",
      promise: "Paid team posture can receive higher workspace/project limits after billing approval.",
    },
    {
      id: "enterprise-manual",
      promise: "Enterprise limits are contract-defined and manually reviewed before automated enforcement.",
    },
  ]),
  limitTypes: Object.freeze([
    { id: "workspace-seat", owner: "Settings & Project Lifecycle" },
    { id: "project-count", owner: "Settings & Project Lifecycle" },
    { id: "environment-count", owner: "Settings & Project Lifecycle" },
    { id: "runtime-usage", owner: "Usage Metering" },
    { id: "request-rate", owner: "Tenant Isolation & Quotas" },
    { id: "concurrency", owner: "Tenant Isolation & Quotas" },
    { id: "generation-run", owner: "Usage Metering" },
    { id: "spend-reservation", owner: "Billing & Credits" },
    { id: "support-tier", owner: "Support Workflow" },
  ]),
  decisionStates: Object.freeze([
    {
      id: "entitlement.allowed",
      customerVisible: false,
      auditRequired: true,
    },
    {
      id: "entitlement.warn",
      customerVisible: true,
      auditRequired: true,
    },
    {
      id: "entitlement.grace",
      customerVisible: true,
      auditRequired: true,
    },
    {
      id: "entitlement.denied",
      customerVisible: true,
      auditRequired: true,
    },
    {
      id: "entitlement.suspended",
      customerVisible: true,
      auditRequired: true,
    },
    {
      id: "entitlement.override-approved",
      customerVisible: true,
      auditRequired: true,
      requiresTtl: true,
    },
  ]),
  m1Evidence: Object.freeze([
    {
      id: "plan-entitlement-taxonomy",
      mode: "design-record",
      proves: "Plan tiers, entitlement categories, and unsupported plan claims are explicit.",
    },
    {
      id: "limit-decision-fixture",
      mode: "contract-test",
      proves: "Allowed, warn, grace, denied, suspended, and override decisions are deterministic.",
    },
    {
      id: "usage-metering-handoff",
      mode: "reference-fixture",
      proves: "Usage-driven limits cite metering facts and do not invent hidden counters.",
    },
    {
      id: "customer-visible-limit-copy",
      mode: "ux-copy-record",
      proves: "Denials and grace states have customer-safe copy and upgrade/support routing.",
    },
    {
      id: "support-override-audit",
      mode: "audit-fixture",
      proves: "Manual overrides require owner, reason, TTL, and audit event before enforcement work begins.",
    },
    {
      id: "scope-boundary-register",
      mode: "policy-fixture",
      proves: "Billing, runtime enforcement, RBAC, provider sync, abuse/fraud, and live-customer work route elsewhere.",
    },
  ]),
  followUpGate: Object.freeze({
    rule:
      "Create M1/M2/M3/M4 Entitlements & Plan Limits follow-up issues only after this M0 scope record and executable proof are accepted.",
  }),
});

export function canCreateEntitlementsFollowUp({ phase, m0Accepted }) {
  if (!IMPLEMENTATION_PHASES.has(phase)) {
    return { allowed: true, reason: "Phase does not depend on the M0 productization gate." };
  }
  if (m0Accepted) {
    return { allowed: true, reason: "M0 Entitlements & Plan Limits scope is accepted." };
  }
  return {
    allowed: false,
    reason: "M1-M4 follow-up work waits for accepted M0 Entitlements & Plan Limits scope.",
  };
}

export function classifyEntitlementDecision(decision) {
  const text = String(decision ?? "").toLowerCase();

  if (/\b(invoice|payment|refund|tax|checkout|chargeback|pricing)\b/.test(text)) {
    return { owner: "Billing & Credits", inScope: false };
  }
  if (/\b(usage|metering|meter|showback|dimension)\b/.test(text)) {
    return { owner: "Usage Metering", inScope: false };
  }
  if (/\b(tenant|noisy neighbor|isolation|app tenant)\b/.test(text)) {
    return { owner: "Tenant Isolation & Quotas", inScope: false };
  }
  if (/\b(member|role|rbac|invite|grant)\b/.test(text)) {
    return { owner: "Member/RBAC Administration", inScope: false };
  }
  if (/\b(fraud|abuse|appeal|rate limit escalation)\b/.test(text)) {
    return { owner: "Entitlement Abuse & Fraud Response", inScope: false };
  }
  return { owner: "Entitlements & Plan Limits", inScope: true };
}

export function validateEntitlementsPlanLimitsScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-419") {
    errors.push("Scope record must be tied to HOBO-419.");
  }
  if (scope.phase !== "M0") {
    errors.push("Scope record must remain an M0 acceptance record.");
  }
  if (!/entitlement/i.test(scope.goal ?? "")) {
    errors.push("Goal must name entitlements.");
  }
  if (!/plan limit/i.test(scope.goal ?? "")) {
    errors.push("Goal must name plan limits.");
  }
  if ((scope.personas ?? []).length < 5) {
    errors.push("At least five primary personas are required.");
  }

  for (const boundary of REQUIRED_BOUNDARIES) {
    if (!scope.boundaries?.some((entry) => entry.id === boundary)) {
      errors.push(`Missing ${boundary} boundary.`);
    }
  }

  const requiredLimitTypes = new Set([
    "workspace-seat",
    "project-count",
    "environment-count",
    "runtime-usage",
    "request-rate",
    "concurrency",
    "generation-run",
    "spend-reservation",
    "support-tier",
  ]);
  const limitTypes = new Set(scope.limitTypes?.map((limit) => limit.id) ?? []);
  for (const limitType of requiredLimitTypes) {
    if (!limitTypes.has(limitType)) {
      errors.push(`Missing limit type: ${limitType}.`);
    }
  }

  for (const evidence of REQUIRED_M1_EVIDENCE) {
    if (!scope.m1Evidence?.some((entry) => entry.id === evidence)) {
      errors.push(`Missing M1 evidence: ${evidence}.`);
    }
  }

  for (const item of scope.scopeIn ?? []) {
    for (const { label, pattern } of FORBIDDEN_SCOPE_PATTERNS) {
      if (pattern.test(item)) {
        errors.push(`M0 scope-in includes out-of-scope ${label} work: ${item}`);
      }
    }
  }

  for (const state of scope.decisionStates ?? []) {
    if (!state.id || state.auditRequired !== true) {
      errors.push(`Decision state ${state.id ?? "<unknown>"} must require audit evidence.`);
    }
    if (state.id === "entitlement.override-approved" && state.requiresTtl !== true) {
      errors.push("Entitlement overrides require a TTL.");
    }
  }

  return { ok: errors.length === 0, errors };
}
