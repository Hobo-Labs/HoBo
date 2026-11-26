const REQUIRED_M1_EVIDENCE = Object.freeze([
  "tenant-axis-model",
  "cross-tenant-leak-gate",
  "quota-policy-fixture",
  "noisy-neighbor-fixture",
  "showback-support-handoff",
  "scope-boundary-register",
]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "billing",
    pattern: /\b(invoice|subscription|payment|chargeback|billing engine|money movement)\b/i,
  },
  {
    label: "runtime",
    pattern:
      /\b(implement|build|ship|provision|create)\b.{0,48}\b(runtime|quota enforcer|isolation engine|policy engine|provider|dedicated yard)\b/i,
  },
  {
    label: "RBAC",
    pattern: /\b(member invite|role grant|rbac enforcement|authorization engine)\b/i,
  },
  {
    label: "live customer data",
    pattern: /\b(live customer data|production tenant|customer migration)\b/i,
  },
  {
    label: "tenant admin UI",
    pattern: /\b(self-service admin ui|tenant administration console)\b/i,
  },
]);

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

export const REQUIRED_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

export const TENANT_ISOLATION_QUOTAS_SCOPE = Object.freeze({
  issue: "HOBO-415",
  project: "Tenant Isolation & Quotas",
  phase: "M0",
  goal:
    "Make the tenant isolation and quota promise explicit enough that M1 design can prove boundaries before any runtime, billing, RBAC, or provider implementation begins.",
  personas: Object.freeze([
    {
      id: "workspace-admin",
      name: "Workspace administrator",
      need: "Understands which tenants, projects, and app tenants are isolated and where quotas become visible before launch.",
    },
    {
      id: "platform-engineer",
      name: "Platform engineer",
      need: "Needs owned boundaries for platform tenant containment, quota policy fixtures, and noisy-neighbor evidence.",
    },
    {
      id: "app-developer",
      name: "Application developer",
      need: "Declares app tenancy without learning HoBo platform tenancy internals or receiving misleading billing promises.",
    },
    {
      id: "support-operator",
      name: "Support operator",
      need: "Needs a support-safe map from tenant identifiers to escalation evidence without cross-tenant disclosure.",
    },
  ]),
  scopeIn: Object.freeze([
    "Define the platform tenant, project, app tenant, and end-user axes as distinct ownership and isolation dimensions.",
    "Record the v1 tenancy models: pooled, region-pooled, siloed, and bridge, including what each can and cannot guarantee.",
    "Name quota dimensions for request rate, concurrency, projection lag, connection pool partitioning, sink storage caps, and spend reservations.",
    "Map service, UX, security, and support boundaries for tenant isolation and quota claims.",
    "List the M1 evidence required before downstream design/build issues can be created.",
  ]),
  scopeOut: Object.freeze([
    "Billing, subscriptions, invoices, payment handling, tax, and chargeback implementation.",
    "Runtime tenant isolation engines, policy enforcement engines, quota enforcers, provider provisioning, or dedicated Yard creation.",
    "Member invite flows, RBAC administration surfaces, and authorization grant implementation.",
    "Tenant self-service admin UI beyond evidence fields and support-visible handoff requirements.",
    "Live customer data migration, production tenant rollout, or customer-facing launch readiness claims.",
  ]),
  nonGoals: Object.freeze([
    "Replace the Bindle, Camp, Yard, and Junction infrastructure containment model.",
    "Collapse platform tenants and app tenants into one generic tenant identifier.",
    "Promise noisy-neighbor elimination for pooled or region-pooled app tenancy.",
    "Create M1, M2, M3, or M4 implementation issues before M0 scope and acceptance evidence is approved.",
  ]),
  boundaries: Object.freeze([
    {
      id: "service",
      owner: "Tenant Isolation & Quotas",
      promise:
        "Owns the accepted terminology, tenancy-model choices, quota dimensions, and proof expectations; runtime services implement them later.",
    },
    {
      id: "ux",
      owner: "Settings & Project Lifecycle",
      promise:
        "Surfaces tenant and quota evidence as read-only product claims until a later UX issue owns configuration or mutation.",
    },
    {
      id: "security",
      owner: "Security Verification",
      promise:
        "Requires cross-tenant-leak, no-tenant fail-closed, and noisy-neighbor guard evidence before design leaves M1.",
    },
    {
      id: "support",
      owner: "Support Workflow",
      promise:
        "Defines support-safe identifiers, escalation handoffs, and redaction rules without adding support tooling in M0.",
    },
  ]),
  tenantAxes: Object.freeze([
    {
      id: "platform-tenant",
      definition:
        "The hard HoBo boundary for data, compute, credentials, network, policy, and support disclosure.",
    },
    {
      id: "project",
      definition:
        "A planning and rollup grouping inside exactly one platform tenant; it never spans platform tenants.",
    },
    {
      id: "app-tenant",
      definition:
        "The application's own customer or tenant partition carried in app context and verified by conformance later.",
    },
    {
      id: "end-user",
      definition:
        "A principal inside an app tenant whose identity does not expand platform tenant or app tenant scope.",
    },
  ]),
  tenancyModels: Object.freeze([
    {
      id: "pooled",
      guarantee:
        "Shared infrastructure with tenant-aware context, guards, quotas, and conformance; noisy-neighbor risk is bounded.",
    },
    {
      id: "region-pooled",
      guarantee:
        "Pooled by region or residency slice with the same tenant guards plus region-aware placement evidence.",
    },
    {
      id: "siloed",
      guarantee:
        "Dedicated infrastructure for one app tenant or cohort where runtime proof can remove pooled noisy-neighbor coupling.",
    },
    {
      id: "bridge",
      guarantee:
        "Explicit transition posture for mixed models where routing and evidence prove which side owns each tenant path.",
    },
  ]),
  quotaDimensions: Object.freeze([
    {
      id: "request-rate",
      owner: "Tenant Isolation & Quotas",
      proof: "M1 fixture declares per-tenant request budgets and denial semantics.",
    },
    {
      id: "concurrency",
      owner: "Tenant Isolation & Quotas",
      proof: "M1 fixture declares concurrent work limits and saturation behavior.",
    },
    {
      id: "projection-lag",
      owner: "Data Plane",
      proof: "M1 fixture records per-tenant lag budgets and stale-label behavior.",
    },
    {
      id: "connection-pool",
      owner: "Security Verification",
      proof: "M1 fixture records partitioning requirements for pooled stores and search paths.",
    },
    {
      id: "sink-storage",
      owner: "Reliability, Observability & Cost",
      proof: "M1 fixture records per-tenant sink storage caps and exhaustion handling.",
    },
    {
      id: "spend-reservation",
      owner: "Billing & Credits",
      proof: "M1 handoff records showback or reservation evidence only; money movement stays out.",
    },
  ]),
  designRefs: Object.freeze([
    "docs/design/security-networking.md#plan-50",
    "docs/design/security-networking.md#plan-12",
    "docs/design/architecture.md#plan-10",
    "docs/design/developer-experience.md#plan-49",
  ]),
  adrRefs: Object.freeze([
    "docs/design/adr/02-identity-security.md#adr-0039",
    "docs/design/adr/02-identity-security.md#adr-0074",
    "docs/design/adr/02-identity-security.md#adr-0077",
    "docs/design/adr/02-identity-security.md#adr-0079",
    "docs/design/adr/02-identity-security.md#adr-0080",
  ]),
  initiativeDependencies: Object.freeze([
    {
      owner: "Organization & Workspace Model",
      boundary: "Supplies account, organization, workspace, project, and environment vocabulary.",
    },
    {
      owner: "Settings & Project Lifecycle",
      boundary: "Owns settings and project lifecycle surfaces that may later expose accepted tenant/quota claims.",
    },
    {
      owner: "Member/RBAC Administration",
      boundary: "Owns owner and operator grants; this scope records required handoff only.",
    },
    {
      owner: "Billing & Credits",
      boundary: "Provides showback only in this scope; billing, invoices, payments, and chargeback stay out.",
    },
    {
      owner: "Security Verification",
      boundary: "Owns M1 leak, fail-closed, and noisy-neighbor conformance proof.",
    },
    {
      owner: "Support Workflow",
      boundary: "Owns support escalation, safe identifiers, and customer communication templates later.",
    },
  ]),
  m1Evidence: Object.freeze([
    {
      id: "tenant-axis-model",
      mode: "design-record",
      proves: "Platform tenant, project, app tenant, and end-user axes remain distinct.",
    },
    {
      id: "cross-tenant-leak-gate",
      mode: "conformance-gate",
      proves: "Positive and negative leak cases fail closed when tenant context is missing or mismatched.",
    },
    {
      id: "quota-policy-fixture",
      mode: "reference-fixture",
      proves: "Quota dimensions, decisions, and denial reasons are declared before implementation.",
    },
    {
      id: "noisy-neighbor-fixture",
      mode: "contract-test",
      proves: "Pooled models bound noisy-neighbor impact and siloed models remove shared contention.",
    },
    {
      id: "showback-support-handoff",
      mode: "support-handoff",
      proves: "Support and showback surfaces disclose only approved tenant and quota evidence.",
    },
    {
      id: "scope-boundary-register",
      mode: "policy-fixture",
      proves: "Billing, RBAC, runtime, provider, and customer-data work is routed to owning initiatives.",
    },
  ]),
  followUpGate: Object.freeze({
    rule:
      "Create M1/M2/M3/M4 follow-up issues only after this M0 scope record and executable proof are accepted.",
  }),
});

export function canCreateFollowUpIssue({ phase, m0Accepted }) {
  if (!IMPLEMENTATION_PHASES.has(phase)) {
    return { allowed: true, reason: "Phase does not depend on the M0 productization gate." };
  }

  if (m0Accepted) {
    return { allowed: true, reason: "M0 scope and acceptance evidence has been accepted." };
  }

  return {
    allowed: false,
    reason: "M1/M2/M3/M4 follow-up issues wait for accepted M0 tenant isolation and quota scope.",
  };
}

export function classifyTenantIsolationDecision(decision) {
  const text = String(decision ?? "").toLowerCase();

  if (/\b(invoice|subscription|billing|payment|chargeback|tax)\b/.test(text)) {
    return { owner: "Billing & Credits", inScope: false };
  }

  if (/\b(member|role|rbac|grant|invite|permission)\b/.test(text)) {
    return { owner: "Member/RBAC Administration", inScope: false };
  }

  if (/\b(project|environment|setting|lifecycle)\b/.test(text)) {
    return { owner: "Settings & Project Lifecycle", inScope: false };
  }

  if (/\b(support|ticket|escalation|status page|sla)\b/.test(text)) {
    return { owner: "Support Workflow", inScope: false };
  }

  if (/\b(conformance|leak|fail-closed|threat|noisy-neighbor|quota|tenant|isolation)\b/.test(text)) {
    return { owner: "Tenant Isolation & Quotas", inScope: true };
  }

  return { owner: "Tenant Isolation & Quotas", inScope: true };
}

export function validateTenantIsolationQuotasScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-415") {
    errors.push("Scope record must be tied to HOBO-415.");
  }

  if (scope.phase !== "M0") {
    errors.push("Scope record must remain an M0 acceptance record.");
  }

  for (const boundary of REQUIRED_BOUNDARIES) {
    if (!scope.boundaries?.some((entry) => entry.id === boundary)) {
      errors.push(`Missing ${boundary} boundary.`);
    }
  }

  const axisIds = new Set(scope.tenantAxes?.map((axis) => axis.id) ?? []);
  if (!axisIds.has("platform-tenant") || !axisIds.has("app-tenant")) {
    errors.push("Scope must keep platform tenant and app tenant axes separate.");
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

  return { ok: errors.length === 0, errors };
}
