import { isJsonObject, type JsonValue } from "./json.js";
export const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"] as const;

type Boundary = (typeof REQUIRED_BOUNDARIES)[number];

type ProofMode =
  | "design-record"
  | "contract-test"
  | "reference-fixture"
  | "audit-fixture"
  | "support-handoff"
  | "policy-fixture";

interface Persona {
  role: string;
  need: string;
}

interface Dependency {
  source: string;
  reason: string;
}

interface InitiativeDependency {
  owner: string;
  consumes: string;
  scopeBoundary: string;
}

interface AuditFactClass {
  id: string;
  owner: string;
  eventFamilies: string[];
  customerVisible: boolean;
  redactionRequired: boolean;
}

interface EvidenceItem {
  kind: string;
  owner: string;
  proofMode: ProofMode;
  proves: string;
}

interface ExportEvidence {
  id: string;
  owner: string;
  redacted: boolean;
  includes: string[];
}

interface FollowUpGate {
  allowedAfter: string;
  blockedBefore: string;
}

interface AuditExplorerScope {
  issue: string;
  project: string;
  phase: string;
  goal: string;
  personas: Persona[];
  scopeIn: string[];
  scopeOut: string[];
  nonGoals: string[];
  boundaries: Record<Boundary, string>;
  dependencies: Dependency[];
  initiativeDependencies: InitiativeDependency[];
  auditFactClasses: AuditFactClass[];
  queryFilterAxes: string[];
  exportEvidence: ExportEvidence[];
  m1Evidence: EvidenceItem[];
  followUpGate: FollowUpGate;
}

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);
const VALID_PROOF_MODES = new Set<ProofMode>([
  "design-record",
  "contract-test",
  "reference-fixture",
  "audit-fixture",
  "support-handoff",
  "policy-fixture",
]);

const REQUIRED_DEPENDENCIES = [
  "docs/design/developer-experience.md#plan-07",
  "docs/design/developer-experience.md#plan-49",
  "docs/design/data-plane.md#plan-11",
  "docs/design/contracts-policy-flags.md#plan-29",
  "docs/design/ai-native-agent-auth.md#plan-06",
  "docs/design/governance-planes.md#plan-46",
  "docs/design/adr/02-identity-security.md#adr-0046",
  "docs/design/adr/02-identity-security.md#adr-0074",
  "docs/design/adr/02-identity-security.md#adr-0077",
  "docs/design/adr/03-data-plane.md#adr-0050",
];

const FORBIDDEN_SCOPE_PATTERNS = [
  /\breact screens?\b/i,
  /\bui implementation\b/i,
  /\bcomponent implementation\b/i,
  /\bevent[- ]store projector runtime\b/i,
  /\bprojector runtime\b/i,
  /\bsearch index\b/i,
  /\bsiem export service\b/i,
  /\bexport service\b/i,
  /\brbac enforcement\b/i,
  /\bpolicy engine\b/i,
  /\brole binding\b/i,
  /\bmutate live customer data\b/i,
  /\blive customer data\b/i,
  /\braw customer data\b/i,
  /\bprovider credentials?\b/i,
  /\bsecret material\b/i,
  /\bsupport ticket\b/i,
  /\bsla workflow\b/i,
  /\bfollow-up implementation issues?\b/i,
];

export const AUDIT_EXPLORER_SCOPE: AuditExplorerScope = {
  issue: "HOBO-427",
  project: "Audit Explorer",
  phase: "M0",
  goal:
    "Define Audit Explorer M0 scope so security reviewers, support operators, workspace administrators, platform engineers, and governance leads have accepted audit fact, query, export, redaction, and boundary evidence before audit-explorer design/build issues fan out.",
  personas: [
    {
      role: "security/compliance reviewer",
      need: "Prove who did what, under which policy decision, and with which redaction state without exposing credential material.",
    },
    {
      role: "support operator",
      need: "Inspect customer-safe audit context for incident handoff without taking ticketing or SLA workflow scope.",
    },
    {
      role: "workspace admin",
      need: "Review project, environment, principal, agent, and export activity inside tenant and RBAC boundaries.",
    },
    {
      role: "platform engineer",
      need: "Debug control-plane decisions, deploy actions, policy gates, and token-broker events from replayable projections.",
    },
    {
      role: "governance lead",
      need: "Assemble evidence packets and OCSF-aligned export requirements with retention and redaction status.",
    },
  ],
  scopeIn: [
    "Define Audit Explorer user/business goal, personas, and accepted M0 audit-read scope.",
    "Define audit fact classes for policy decisions, credential events, control-plane actions, deployment/run/resource events, support handoff, and export redaction evidence.",
    "Define tenant-first query filter axes and read-only export evidence shape for later contract proof.",
    "Map service, UX, security, and support boundaries across Admin Console, Support Workflow, Security Verification, Governance/Compliance Evidence, Data Plane, CLI/MCP, and Identity/Auth.",
    "List M1-ready evidence for audit fact contracts, filter contracts, redaction fixtures, export manifests, support handoff context, replay reconstruction, and follow-up gating.",
  ],
  scopeOut: [
    "Do not build Audit Explorer screens, routes, components, client state, or interaction flows in this issue.",
    "Do not implement event-store storage, projector runtime, search indexing, pagination, SIEM connectors, or export delivery services.",
    "Do not implement RBAC enforcement, policy evaluation, role binding, break-glass access, or authorization runtime.",
    "Do not read provider credentials, expose credential material, search unredacted customer content, mutate customer state, or execute admin/support actions.",
    "Do not create M1-M4 implementation issues until this M0 acceptance record is accepted.",
  ],
  nonGoals: [
    "Replace Admin Console navigation, Support Workflow ticketing, Security Verification suites, or the Data Plane event-store contract.",
    "Resolve legal retention obligations, customer assurance language, or public compliance claims.",
    "Define production export pricing, storage retention runtime, or OCSF delivery mechanics.",
  ],
  boundaries: {
    service:
      "Audit Explorer defines read-only audit fact, filter, and export contract boundaries; event-store persistence, projector runtime, search indexing, and export delivery remain later service work.",
    ux:
      "Audit Explorer defines information architecture, query axes, empty/error states, and evidence classes; it does not build screens, components, routes, or interactions in this issue.",
    security:
      "Audit Explorer requires tenant-first filters, least-privilege read authority, redaction, no credential-material exposure, and replayable policy evidence without implementing authorization.",
    support:
      "Audit Explorer defines customer-safe support context and handoff fields; Support Workflow owns tickets, SLA routing, and escalation execution.",
  },
  dependencies: [
    {
      source: "docs/design/developer-experience.md#plan-07",
      reason: "Defines dashboard, run inspection, replay, and audit surfaces that Audit Explorer later specializes.",
    },
    {
      source: "docs/design/developer-experience.md#plan-49",
      reason: "Defines operations dashboard and status-page projections that must consume the same read-model discipline.",
    },
    {
      source: "docs/design/data-plane.md#plan-11",
      reason: "Defines event audit trail, identity/auth events, projections, and read models as the source for audit exploration.",
    },
    {
      source: "docs/design/contracts-policy-flags.md#plan-29",
      reason: "Defines policy decisions, control-plane action audit, governance exports, and boundary standards consumed by audit facts.",
    },
    {
      source: "docs/design/ai-native-agent-auth.md#plan-06",
      reason: "Defines credential audit events for grants, token use, revocation, and delegated agent activity.",
    },
    {
      source: "docs/design/governance-planes.md#plan-46",
      reason: "Defines governance evidence and compliance export expectations that Audit Explorer must route to owning initiatives.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0046",
      reason: "Pins OCSF, trace propagation, boundary standards, and replayable audit envelopes.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0074",
      reason: "Pins org governance, RBAC, mandatory policy rules, deny ceilings, and audit obligations.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0077",
      reason: "Pins projects and environments as tenant-first grouping dimensions for dashboard and status surfaces.",
    },
    {
      source: "docs/design/adr/03-data-plane.md#adr-0050",
      reason: "Pins event-sourced projections, materialized views, read stores, and replay semantics.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Audit Explorer",
      consumes: "Owns accepted audit fact classes, tenant-first filters, export evidence shape, and M1 proof gates.",
      scopeBoundary: "This issue defines scope and acceptance; it does not build UI, search, projector, or export runtime.",
    },
    {
      owner: "Admin Console",
      consumes: "Exposes future navigation entry points and workspace/project/environment context for audit exploration.",
      scopeBoundary: "Admin Console owns UI navigation and action-intent surfaces, not audit fact semantics.",
    },
    {
      owner: "Support Workflow",
      consumes: "Uses customer-safe audit context, incident identifiers, redaction status, and handoff summaries.",
      scopeBoundary: "Ticket queues, SLA routing, escalations, and customer communications remain outside Audit Explorer.",
    },
    {
      owner: "Security Verification",
      consumes: "Uses no-credential-exposure, redaction, tenant isolation, and policy-decision fixtures as conformance inputs.",
      scopeBoundary: "RBAC enforcement, policy engines, leak tests, and authorization runtime stay with Security Verification.",
    },
    {
      owner: "Governance/Compliance Evidence",
      consumes: "Uses export manifest fields, OCSF alignment, retention markers, and evidence packet requirements.",
      scopeBoundary: "Legal retention rules, compliance claims, and export delivery remain owning-governance work.",
    },
    {
      owner: "Data Plane",
      consumes: "Supplies event-store envelopes, projection semantics, replay cursors, materialized views, and read-store snapshots.",
      scopeBoundary: "Event storage, projector runtime, search indexing, pagination, and snapshot persistence remain Data Plane work.",
    },
    {
      owner: "CLI/MCP & Developer Experience",
      consumes: "Uses audit read models for inspect/replay commands and diagnostic entry points.",
      scopeBoundary: "CLI verbs, MCP tools, and dashboard interactions are not implemented in this issue.",
    },
    {
      owner: "Identity/Auth",
      consumes: "Supplies credential audit facts, principal references, delegated agent grants, and revocation evidence.",
      scopeBoundary: "Token brokerage, session revocation, credential issuance, and identity policy remain Identity/Auth work.",
    },
  ],
  auditFactClasses: [
    {
      id: "policy-decision-audit",
      owner: "Security Verification",
      eventFamilies: ["policy.Decided", "policy.Denied", "policy.OverrideRejected"],
      customerVisible: true,
      redactionRequired: true,
    },
    {
      id: "credential-audit",
      owner: "Identity/Auth",
      eventFamilies: ["token.Granted", "token.Used", "token.Revoked"],
      customerVisible: false,
      redactionRequired: true,
    },
    {
      id: "control-plane-action-audit",
      owner: "Admin Console",
      eventFamilies: ["policy.Decided", "crew.ActionProposed", "deployment.PlanRejected"],
      customerVisible: true,
      redactionRequired: true,
    },
    {
      id: "deployment-run-resource-audit",
      owner: "Data Plane",
      eventFamilies: ["deployment.*", "run.*", "resource.*"],
      customerVisible: true,
      redactionRequired: true,
    },
    {
      id: "support-escalation-audit",
      owner: "Support Workflow",
      eventFamilies: ["incident.Opened", "crew.HandoffRequested"],
      customerVisible: false,
      redactionRequired: true,
    },
    {
      id: "export-redaction-audit",
      owner: "Governance/Compliance Evidence",
      eventFamilies: ["data.Classified", "erasure.Requested", "erasure.Completed"],
      customerVisible: true,
      redactionRequired: true,
    },
  ],
  queryFilterAxes: [
    "tenant",
    "project",
    "environment",
    "principal",
    "agent",
    "action",
    "resource",
    "time",
    "policy-decision",
    "evidence-kind",
    "redaction-state",
    "correlation-id",
  ],
  exportEvidence: [
    {
      id: "actor-action-target-timestamp",
      owner: "Audit Explorer",
      redacted: true,
      includes: ["tenant", "actor", "action", "target", "timestamp", "correlation-id"],
    },
    {
      id: "policy-decision-context",
      owner: "Security Verification",
      redacted: true,
      includes: ["decision-id", "rule-id", "effect", "denial-reason", "redaction-state"],
    },
    {
      id: "credential-event-summary",
      owner: "Identity/Auth",
      redacted: true,
      includes: ["principal", "grant-id", "event-family", "revocation-state", "redaction-state"],
    },
    {
      id: "support-handoff-summary",
      owner: "Support Workflow",
      redacted: true,
      includes: ["incident-id", "customer-safe-context", "owner", "redaction-state"],
    },
    {
      id: "ocsf-evidence-manifest",
      owner: "Governance/Compliance Evidence",
      redacted: true,
      includes: ["schema-family", "retention-marker", "export-id", "redaction-state"],
    },
  ],
  m1Evidence: [
    {
      kind: "audit-fact-class-register",
      owner: "Audit Explorer",
      proofMode: "design-record",
      proves: "Policy, credential, control-plane, deployment/run/resource, support, and export-redaction audit fact classes are named with owners.",
    },
    {
      kind: "query-filter-contract",
      owner: "Audit Explorer",
      proofMode: "contract-test",
      proves: "Tenant-first filter axes, project/environment grouping, principal/action/resource/time filters, and redaction state are contract-visible.",
    },
    {
      kind: "redaction-and-no-secret-fixture",
      owner: "Security Verification",
      proofMode: "audit-fixture",
      proves: "Audit facts include redaction status and reject credential material or unredacted customer content exposure.",
    },
    {
      kind: "export-evidence-manifest",
      owner: "Governance/Compliance Evidence",
      proofMode: "reference-fixture",
      proves: "OCSF-aligned export evidence names schema family, actor/action/target/timestamp, retention marker, and redaction state.",
    },
    {
      kind: "support-handoff-context",
      owner: "Support Workflow",
      proofMode: "support-handoff",
      proves: "Support context can be attached to an incident handoff without implementing ticket queues or SLA automation.",
    },
    {
      kind: "replay-reconstruction-fixture",
      owner: "Data Plane",
      proofMode: "audit-fixture",
      proves: "Projection snapshots can be reconstructed from event families without bypassing event-store/read-store ownership.",
    },
    {
      kind: "follow-up-issue-gate",
      owner: "Audit Explorer",
      proofMode: "policy-fixture",
      proves: "M1/M2/M3/M4 Audit Explorer issues remain blocked until this M0 record is accepted.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 Audit Explorer UI, service, support, export, security, data-plane, CLI/MCP, or identity implementation issues must not be created until this record is accepted.",
  },
};

export function canCreateAuditExplorerFollowUp({
  phase,
  m0Accepted,
}: {
  phase: string;
  m0Accepted: boolean;
}): boolean {
  return Boolean(m0Accepted) && IMPLEMENTATION_PHASES.has(phase);
}

export interface ScopeClassification {
  owner: string;
  inScope: boolean;
}

export interface ScopeValidation {
  ok: boolean;
  errors: string[];
}

export function classifyAuditExplorerRequest(request: JsonValue): ScopeClassification {
  const text = String(request ?? "").toLowerCase();

  if (/\b(provider credential|credential secret|secret material|leak|cross-tenant)\b/.test(text)) {
    return { owner: "Security Verification", inScope: false };
  }
  if (/\brbac\b|\brole binding\b|\bpolicy engine\b|\benforce\b|\bauthorization runtime\b/.test(text)) {
    return { owner: "Security Verification", inScope: false };
  }
  if (/\bsupport ticket\b|\bticket queue\b|\bsla\b|\bescalation workflow\b/.test(text)) {
    return { owner: "Support Workflow", inScope: false };
  }
  if (/\bui screen\b|\breact\b|\bcomponent\b|\broute\b|\binteraction\b/.test(text)) {
    return { owner: "Admin Console", inScope: false };
  }
  if (/\bevent-store\b|\bprojector\b|\bsearch index\b|\bpagination\b|\bread store runtime\b/.test(text)) {
    return { owner: "Data Plane", inScope: false };
  }
  if (/\bsiem\b|\bocsf delivery\b|\blegal retention\b|\bcompliance claim\b/.test(text)) {
    return { owner: "Governance/Compliance Evidence", inScope: false };
  }
  if (/\bcli\b|\bmcp\b|\binspect command\b/.test(text)) {
    return { owner: "CLI/MCP & Developer Experience", inScope: false };
  }

  return { owner: "Audit Explorer", inScope: true };
}

export function validateAuditExplorerScope(scope: AuditExplorerScope | JsonValue): ScopeValidation {
  const errors: string[] = [];

  if (!scope || !isJsonObject(scope)) {
    return { ok: false, errors: ["scope record is required"] };
  }

  // SAFETY: `const record = scope as Partial<AuditExplorerScope>;` is required at this I/O or test boundary.
  const record = scope as Partial<AuditExplorerScope>;

  if (record.issue !== "HOBO-427") {
    errors.push("issue must be HOBO-427");
  }
  if (record.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!record.goal?.toLowerCase().includes("audit explorer")) {
    errors.push("goal must name Audit Explorer");
  }
  if ((record.personas ?? []).length < 5) {
    errors.push("at least five personas are required");
  }
  if ((record.scopeIn ?? []).length < 5) {
    errors.push("scope in must have at least five entries");
  }
  if ((record.scopeOut ?? []).length < 5) {
    errors.push("scope out must have at least five entries");
  }

  for (const key of REQUIRED_BOUNDARIES) {
    if (!record.boundaries?.[key]) {
      errors.push(`missing ${key} boundary`);
    }
  }

  for (const entry of record.scopeIn ?? []) {
    if (FORBIDDEN_SCOPE_PATTERNS.some((pattern) => pattern.test(entry))) {
      errors.push(`scope creep: ${entry}`);
    }
  }

  const sources = (record.dependencies ?? []).map((dependency) => dependency.source);
  if (JSON.stringify(sources) !== JSON.stringify(REQUIRED_DEPENDENCIES)) {
    errors.push("design dependencies must map to DX, data-plane, policy, auth, governance, and ADR sources");
  }
  for (const dependency of record.dependencies ?? []) {
    if (!dependency.source || !dependency.reason) {
      errors.push(`dependency ${dependency.source ?? "<missing>"} must include a reason`);
    }
  }

  if ((record.initiativeDependencies ?? []).length < 8) {
    errors.push("owning initiative dependencies must map consuming productization projects");
  }
  for (const dependency of record.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
    }
  }

  if ((record.auditFactClasses ?? []).length < 6) {
    errors.push("audit fact classes must cover policy, credential, control-plane, deployment, support, and export facts");
  }
  for (const fact of record.auditFactClasses ?? []) {
    if (!fact.id || !fact.owner || fact.eventFamilies.length === 0) {
      errors.push(`audit fact ${fact.id ?? "<unknown>"} must name id, owner, and event families`);
    }
    if (!fact.redactionRequired) {
      errors.push(`audit fact ${fact.id} must require redaction`);
    }
  }

  if (JSON.stringify((record.queryFilterAxes ?? []).slice(0, 2)) !== JSON.stringify(["tenant", "project"])) {
    errors.push("query filter axes must start with tenant and project");
  }
  if (!(record.queryFilterAxes ?? []).includes("redaction-state")) {
    errors.push("query filter axes must include redaction state");
  }

  for (const evidence of record.exportEvidence ?? []) {
    if (!evidence.id || !evidence.owner || evidence.includes.length === 0) {
      errors.push(`export evidence ${evidence.id ?? "<unknown>"} must name id, owner, and included fields`);
    }
    if (!evidence.redacted) {
      errors.push(`export evidence ${evidence.id} must be redacted`);
    }
  }

  for (const evidence of record.m1Evidence ?? []) {
    if (!evidence.kind || !evidence.owner || !evidence.proves) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must name kind, owner, and proof`);
    }
    if (!VALID_PROOF_MODES.has(evidence.proofMode)) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must declare a proof mode`);
    }
  }

  if (!record.followUpGate?.allowedAfter || !record.followUpGate?.blockedBefore) {
    errors.push("follow-up gate must record allowed-after and blocked-before states");
  }

  return { ok: errors.length === 0, errors };
}
