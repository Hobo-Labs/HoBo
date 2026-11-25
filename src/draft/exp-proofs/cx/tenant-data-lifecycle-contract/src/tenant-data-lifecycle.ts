import { type JsonValue } from "./json.js";
type TenantDataClassId =
  | "customer-product-data"
  | "telemetry"
  | "logs"
  | "generated-artifacts"
  | "support-data"
  | "billing-data"
  | "audit-data";

type TenantDataClass = Readonly<{
  id: TenantDataClassId;
  retention: string;
  deletionExportExpectation: string;
  residencySensitivity: string;
  owner: string;
  v1Limitation: string;
}>;

type DeletionObligation = Readonly<{
  id:
    | "supported-export"
    | "supported-delete"
    | "manual-review"
    | "deferred-retention"
    | "impossible-with-rationale";
  customerMessage: string;
  owner: string;
  auditEvidence: string;
}>;

type InitiativeDependency = Readonly<{
  owner: string;
  boundary: string;
}>;

type M1Evidence = Readonly<{
  id:
    | "data-inventory-register"
    | "retention-matrix"
    | "deletion-export-obligation-fixture"
    | "account-closure-routing"
    | "residency-sensitivity-map"
    | "support-assurance-handoff"
    | "scope-boundary-register";
  mode: string;
  proves: string;
}>;

type TenantDataLifecycleScope = Readonly<{
  issue: "HOBO-492";
  project: "Compliance Evidence Pack";
  phase: "M0";
  goal: string;
  dataClasses: readonly TenantDataClass[];
  scopeIn: readonly string[];
  scopeOut: readonly string[];
  nonGoals: readonly string[];
  deletionObligations: readonly DeletionObligation[];
  designRefs: readonly string[];
  adrRefs: readonly string[];
  initiativeDependencies: readonly InitiativeDependency[];
  m1Evidence: readonly M1Evidence[];
  followUpGate: Readonly<{
    rule: string;
  }>;
}>;

type MutableTenantDataLifecycleScope = Omit<TenantDataLifecycleScope, "scopeIn"> & {
  scopeIn: string[];
};

type ScopeValidationTarget = Partial<TenantDataLifecycleScope> & {
  dataClasses?: readonly Partial<TenantDataClass>[];
  m1Evidence?: readonly Partial<M1Evidence>[];
  deletionObligations?: readonly Partial<DeletionObligation>[];
  scopeIn?: readonly string[];
};

type FollowUpGateRequest = Readonly<{
  phase: string;
  m0Accepted: boolean;
}>;

type GateDecision = Readonly<{
  allowed: boolean;
  reason: string;
}>;

type WorkClassification = Readonly<{
  owner: string;
  inScope: boolean;
}>;

const REQUIRED_DATA_CLASSES = Object.freeze([
  "customer-product-data",
  "telemetry",
  "logs",
  "generated-artifacts",
  "support-data",
  "billing-data",
  "audit-data",
]) satisfies readonly TenantDataClassId[];

const REQUIRED_M1_EVIDENCE = Object.freeze([
  "data-inventory-register",
  "retention-matrix",
  "deletion-export-obligation-fixture",
  "account-closure-routing",
  "residency-sensitivity-map",
  "support-assurance-handoff",
  "scope-boundary-register",
]) satisfies readonly M1Evidence["id"][];

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "legal approval",
    pattern: /\b(approve|ratify|publish)\b.{0,48}\b(dpa|legal|privacy policy|terms)\b/i,
  },
  {
    label: "live deletion",
    pattern: /\b(implement|build|run|automate)\b.{0,64}\b(live customer data deletion|production deletion|account closure automation|erasure workflow)\b/i,
  },
  {
    label: "storage implementation",
    pattern: /\b(implement|build|provision|ship)\b.{0,64}\b(storage|retention job|purge job|backup service|artifact store)\b/i,
  },
  {
    label: "customer data access",
    pattern: /\b(grant|allow|approve)\b.{0,64}\b(customer data access|production customer data|tenant data access)\b/i,
  },
]);

export const TENANT_DATA_LIFECYCLE_SCOPE: TenantDataLifecycleScope = Object.freeze({
  issue: "HOBO-492",
  project: "Compliance Evidence Pack",
  phase: "M0",
  goal:
    "Define the v1 tenant data inventory, deletion/export obligations, retention posture, residency sensitivity, and owner handoffs before privacy, support, backup, or customer-assurance work can overclaim readiness.",
  dataClasses: Object.freeze([
    {
      id: "customer-product-data",
      retention: "Retained only by accepted product data stores and backup/restore evidence windows.",
      deletionExportExpectation:
        "Supported export and deletion request path must be named before customer data enters beta.",
      residencySensitivity: "High; residency posture must be stated per tenant and launch environment.",
      owner: "Compliance Evidence Pack",
      v1Limitation: "No production customer-data deletion automation is claimed by this M0 record.",
    },
    {
      id: "telemetry",
      retention: "Bound by privacy-reviewed telemetry purpose and workspace activation evidence.",
      deletionExportExpectation:
        "Export/delete posture must distinguish aggregate metrics from tenant-identifiable telemetry.",
      residencySensitivity: "Medium; privacy owner reviews PII exclusions and region sensitivity.",
      owner: "Workspace & Onboarding UX",
      v1Limitation: "No telemetry opt-out or deletion workflow implementation is built here.",
    },
    {
      id: "logs",
      retention: "Operational logs retain only redacted diagnostic context for support and security windows.",
      deletionExportExpectation:
        "Export/delete posture must distinguish customer-visible logs from internal diagnostic logs.",
      residencySensitivity: "Medium; log redaction and support access boundaries are required.",
      owner: "Support Workflow",
      v1Limitation: "No live log pipeline, tailing service, or deletion runner is implemented here.",
    },
    {
      id: "generated-artifacts",
      retention: "Generated code, manifests, certifications, and provenance follow artifact-retention classes.",
      deletionExportExpectation:
        "Export and deletion must preserve provenance/yank obligations and customer-access boundaries.",
      residencySensitivity: "Medium; artifact storage location and provenance retention are explicit.",
      owner: "Provenance & Retention",
      v1Limitation: "No artifact store mutation, purge, or provenance invalidation runner is built here.",
    },
    {
      id: "support-data",
      retention: "Support bundles and tickets retain redacted evidence for launch support windows.",
      deletionExportExpectation:
        "Support data deletion/export must preserve audit and incident evidence handoffs.",
      residencySensitivity: "High when bundles contain tenant identifiers or customer-provided content.",
      owner: "Support Workflow",
      v1Limitation: "No helpdesk, ticket queue, or customer data access approval is implemented here.",
    },
    {
      id: "billing-data",
      retention: "Billing, invoice, receipt, and tax metadata are retained by billing/legal owners.",
      deletionExportExpectation:
        "Deletion/export posture distinguishes legal retention obligations from customer-request cleanup.",
      residencySensitivity: "High; financial and tax records require legal/privacy owner review.",
      owner: "Billing & Credits",
      v1Limitation: "No invoicing, payment, tax, or money movement system is implemented here.",
    },
    {
      id: "audit-data",
      retention: "Security, policy, break-glass, and support audit records retain integrity evidence.",
      deletionExportExpectation:
        "Deletion/export posture must preserve immutable audit requirements and customer assurance evidence.",
      residencySensitivity: "High; audit exports require security/compliance approval boundaries.",
      owner: "Security Verification",
      v1Limitation: "No SIEM export, audit erasure, or compliance approval workflow is built here.",
    },
  ]),
  scopeIn: Object.freeze([
    "Define customer data classes, telemetry, logs, generated artifacts, support data, billing data, and audit data for v1 customer assurance.",
    "Record retention, deletion/export expectation, residency sensitivity, owner, and v1 limitation for every data class.",
    "Define deletion and account-closure obligation states for supported, manual, deferred, and impossible-with-rationale requests.",
    "Map legal/privacy, security, backup/restore, support, provenance, and tenant-isolation handoffs.",
    "List M1 evidence required before deletion/export implementation, support tooling, backup service, storage retention, or legal approval work can fan out.",
  ]),
  scopeOut: Object.freeze([
    "No final DPA, privacy policy, legal terms, subprocessor approval, or legal signoff claim.",
    "No live customer data deletion, account closure automation, erasure workflow, or production data mutation.",
    "No storage backend, retention scheduler, purge job, backup service, artifact store, or SIEM export implementation.",
    "No support desk implementation, direct production customer data access, or break-glass access approval.",
    "No billing, invoice, tax, payment, or refund system work.",
    "No M1-M4 follow-up implementation issue creation before M0 acceptance is recorded.",
  ]),
  nonGoals: Object.freeze([
    "Replace legal/privacy launch readiness or final legal owner approval.",
    "Replace Backup & Restore drill evidence or Provenance & Retention artifact classes.",
    "Promise production deletion/export automation before deterministic M1 proof exists.",
    "Use live customer data or grant support access in this M0 record.",
  ]),
  deletionObligations: Object.freeze([
    {
      id: "supported-export",
      customerMessage: "Export is supported when the data class has an accepted export source and owner.",
      owner: "Compliance Evidence Pack",
      auditEvidence: "export-request record with data class, tenant, owner, source, and completion evidence",
    },
    {
      id: "supported-delete",
      customerMessage: "Deletion is supported when the data class has accepted erasure evidence and no legal retention block.",
      owner: "Compliance Evidence Pack",
      auditEvidence: "deletion-request record with data class, tenant, owner, deletion evidence, and retained-exception list",
    },
    {
      id: "manual-review",
      customerMessage: "Manual review is required when support, security, billing, or legal ownership must approve the path.",
      owner: "Support Workflow",
      auditEvidence: "manual-review record with reviewer, reason, decision, and customer communication owner",
    },
    {
      id: "deferred-retention",
      customerMessage: "Deletion is deferred when legal retention, audit integrity, or recovery evidence must be retained.",
      owner: "Legal, Privacy & Terms Readiness",
      auditEvidence: "retention-deferral record with rationale, expiry, owner, and customer-safe limitation",
    },
    {
      id: "impossible-with-rationale",
      customerMessage: "Deletion/export is impossible only with explicit technical or legal rationale and owner signoff.",
      owner: "Compliance Evidence Pack",
      auditEvidence: "impossible-request record with rationale, owner, affected data classes, and appeal route",
    },
  ]),
  designRefs: Object.freeze([
    "docs/design/legal-privacy-terms-readiness.md",
    "docs/design/security-verification.md",
    "docs/design/backup-restore.md",
    "docs/design/support-sla-channels.md",
    "docs/design/provenance-retention.md",
    "docs/design/tenant-isolation-quotas.md",
  ]),
  adrRefs: Object.freeze([
    "docs/design/adr/02-identity-security.md#adr-0023",
    "docs/design/adr/02-identity-security.md#adr-0060",
    "docs/design/adr/02-identity-security.md#adr-0074",
    "docs/design/adr/02-identity-security.md#adr-0080",
    "docs/design/adr/07-portability-extensibility.md#adr-0064",
  ]),
  initiativeDependencies: Object.freeze([
    {
      owner: "Compliance Evidence Pack",
      boundary:
        "Owns the tenant data inventory, lifecycle obligation matrix, customer assurance evidence packet, and M0 follow-up gate.",
    },
    {
      owner: "Legal, Privacy & Terms Readiness",
      boundary:
        "Owns DPA, privacy notice, legal terms, subprocessor approval, and legal retention exceptions.",
    },
    {
      owner: "Security Verification",
      boundary:
        "Owns vulnerability, audit, break-glass, customer data risk, and security claim verification evidence.",
    },
    {
      owner: "Backup & Restore",
      boundary:
        "Owns backup-source inventory, restore drill evidence, RPO/RTO limits, and recovery retention handoffs.",
    },
    {
      owner: "Support Workflow",
      boundary:
        "Owns support intake, customer-safe routing, support-data redaction, and manual review handoff.",
    },
    {
      owner: "Provenance & Retention",
      boundary:
        "Owns generated artifact provenance, retention classes, support debug access, and invalidation evidence.",
    },
    {
      owner: "Tenant Isolation & Quotas",
      boundary:
        "Owns tenant axis vocabulary and prevents tenant data inventory from collapsing platform/app tenants.",
    },
  ]),
  m1Evidence: Object.freeze([
    {
      id: "data-inventory-register",
      mode: "design-record",
      proves: "Every v1 data class names owner, retention, deletion/export expectation, residency sensitivity, and limitation.",
    },
    {
      id: "retention-matrix",
      mode: "policy-fixture",
      proves: "Retention windows and retained exceptions are explicit before customer assurance claims.",
    },
    {
      id: "deletion-export-obligation-fixture",
      mode: "contract-test",
      proves: "Supported, manual, deferred, and impossible deletion/export requests route deterministically.",
    },
    {
      id: "account-closure-routing",
      mode: "support-handoff",
      proves: "Account closure distinguishes cleanup, retained legal/audit records, and customer messaging.",
    },
    {
      id: "residency-sensitivity-map",
      mode: "privacy-review",
      proves: "Data classes requiring residency or PII review are visible before implementation.",
    },
    {
      id: "support-assurance-handoff",
      mode: "customer-assurance-packet",
      proves: "Support and customer assurance requests cite accepted evidence without overclaiming automation.",
    },
    {
      id: "scope-boundary-register",
      mode: "policy-fixture",
      proves: "Legal approval, live deletion, storage implementation, support access, billing, and SIEM work route elsewhere.",
    },
  ]),
  followUpGate: Object.freeze({
    rule:
      "Create M1/M2/M3/M4 tenant data lifecycle follow-up issues only after this M0 scope record and executable proof are accepted.",
  }),
});

export function canCreateTenantDataFollowUp({ phase, m0Accepted }: FollowUpGateRequest): GateDecision {
  if (!IMPLEMENTATION_PHASES.has(phase)) {
    return { allowed: true, reason: "Phase does not depend on the M0 tenant data lifecycle gate." };
  }

  if (m0Accepted) {
    return { allowed: true, reason: "M0 tenant data lifecycle scope has been accepted." };
  }

  return {
    allowed: false,
    reason: "M1-M4 follow-up work waits for accepted M0 tenant data lifecycle scope.",
  };
}

export function classifyTenantDataLifecycleDecision(decision: JsonValue): WorkClassification {
  const text = String(decision ?? "").toLowerCase();

  if (/\b(dpa|legal terms|privacy policy|subprocessor|legal)\b/.test(text)) {
    return { owner: "Legal, Privacy & Terms Readiness", inScope: false };
  }
  if (/\b(security|audit|break-glass|vulnerability|customer data risk)\b/.test(text)) {
    return { owner: "Security Verification", inScope: false };
  }
  if (/\b(backup|restore|recovery|rpo|rto)\b/.test(text)) {
    return { owner: "Backup & Restore", inScope: false };
  }
  if (/\b(support|ticket|customer data access|manual review)\b/.test(text)) {
    return { owner: "Support Workflow", inScope: false };
  }
  if (/\b(provenance|artifact|generated artifact|retention class)\b/.test(text)) {
    return { owner: "Provenance & Retention", inScope: false };
  }

  return { owner: "Compliance Evidence Pack", inScope: true };
}

export function validateTenantDataLifecycleScope(scope: ScopeValidationTarget): GateDecision & { errors: string[] } {
  const errors = [];

  if (scope?.issue !== "HOBO-492") {
    errors.push("Scope record must be tied to HOBO-492.");
  }
  if (scope?.phase !== "M0") {
    errors.push("Scope record must remain an M0 acceptance record.");
  }

  const dataClassIds = new Set(scope.dataClasses?.map((dataClass) => dataClass.id) ?? []);
  for (const dataClass of REQUIRED_DATA_CLASSES) {
    if (!dataClassIds.has(dataClass)) {
      errors.push(`Missing tenant data class: ${dataClass}.`);
    }
  }

  for (const dataClass of scope.dataClasses ?? []) {
    if (
      !dataClass.retention ||
      !dataClass.deletionExportExpectation ||
      !dataClass.residencySensitivity ||
      !dataClass.owner ||
      !dataClass.v1Limitation
    ) {
      errors.push(`Data class ${dataClass.id ?? "<unknown>"} is missing lifecycle fields.`);
    }
  }

  for (const evidence of REQUIRED_M1_EVIDENCE) {
    if (!scope.m1Evidence?.some((entry) => entry.id === evidence)) {
      errors.push(`Missing M1 evidence: ${evidence}.`);
    }
  }

  for (const obligation of scope.deletionObligations ?? []) {
    if (!obligation.customerMessage || !obligation.owner || !obligation.auditEvidence) {
      errors.push(`Deletion obligation ${obligation.id ?? "<unknown>"} is missing routing fields.`);
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

export function cloneMutableTenantDataLifecycleScope(): MutableTenantDataLifecycleScope {
  return {
    ...TENANT_DATA_LIFECYCLE_SCOPE,
    scopeIn: [...TENANT_DATA_LIFECYCLE_SCOPE.scopeIn],
  };
}
