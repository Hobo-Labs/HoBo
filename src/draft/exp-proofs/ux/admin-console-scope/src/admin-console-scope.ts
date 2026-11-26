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

interface ReadModelClass {
  id: string;
  owner: string;
  customerVisible: boolean;
  launchCritical: boolean;
}

interface EvidenceItem {
  kind: string;
  owner: string;
  proofMode: ProofMode;
  proves: string;
}

interface FollowUpGate {
  allowedAfter: string;
  blockedBefore: string;
}

interface AdminConsoleScope {
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
  readModelClasses: ReadModelClass[];
  actionIntentCategories: string[];
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
  "docs/design/organization-workspace-model.md",
  "docs/design/settings-project-lifecycle.md",
  "docs/design/member-rbac-administration.md",
  "docs/design/tenant-isolation-quotas.md",
  "docs/design/support-sla-channels.md",
  "docs/design/security-networking.md#plan-50",
  "docs/design/adr/02-identity-security.md#adr-0074",
  "docs/design/adr/02-identity-security.md#adr-0077",
  "docs/design/adr/02-identity-security.md#adr-0080",
];

const FORBIDDEN_SCOPE_PATTERNS = [
  /\breact screens?\b/i,
  /\badmin console screens?\b/i,
  /\bui implementation\b/i,
  /\brbac enforcement\b/i,
  /\bpolicy engine\b/i,
  /\bmutate live customer data\b/i,
  /\blive customer data\b/i,
  /\bprovider credentials?\b/i,
  /\blive provider\b/i,
  /\bbilling\b/i,
  /\btenant quota\b/i,
  /\bsupport ticket\b/i,
  /\bstatus-page publishing\b/i,
  /\bincident publishing\b/i,
];

export const ADMIN_CONSOLE_SCOPE: AdminConsoleScope = {
  issue: "HOBO-425",
  project: "Admin Console",
  phase: "M0",
  goal:
    "Define Admin Console M0 scope so workspace administrators, project owners, support operators, and security reviewers have accepted information architecture, action intent, audit, and boundary evidence before admin-console design/build issues fan out.",
  personas: [
    {
      role: "workspace admin",
      need: "Understand organization, workspace, project, tenant, entitlement, and environment state without hidden authority assumptions.",
    },
    {
      role: "project owner",
      need: "See project health, ownership, lifecycle state, and pending admin actions without taking provider or runtime implementation scope.",
    },
    {
      role: "support operator",
      need: "Inspect customer-safe context, audit summaries, and escalation owners without mutating customer data.",
    },
    {
      role: "security/policy admin",
      need: "Review least-privilege action classes, break-glass visibility, redaction rules, and no-secret exposure before implementation.",
    },
  ],
  scopeIn: [
    "Define launch-critical Admin Console information architecture for organization, workspace, project, tenant, environment, entitlement, support, and security visibility.",
    "Define read-model classes and ownership for status cards, audit summaries, support context, lifecycle state, and broker/environment proposal visibility.",
    "Define action-intent categories, approval handoffs, and denial states while routing execution to owning initiatives.",
    "Map service, UX, security, and support boundaries for admin-console product scope.",
    "List M1-ready evidence for navigation, read-model contracts, action-intent matrix, audit/redaction export, break-glass visibility, and scope boundary proof.",
  ],
  scopeOut: [
    "Do not build React screens, routes, components, client state, or interaction flows in this issue.",
    "Do not implement RBAC enforcement, policy evaluation, member lifecycle changes, SSO/SCIM sync, or role binding.",
    "Do not implement tenant isolation, quota enforcement, billing, entitlements, rate limits, support ticket queues, or incident/status-page publishing.",
    "Do not read or store provider credentials, mutate live customer data, provision resources, or execute admin actions.",
    "Do not create production admin roles, live break-glass sessions, static credentials, or follow-up M1-M4 implementation issues before M0 acceptance.",
  ],
  nonGoals: [
    "Replace the existing Developer Experience dashboard, Settings & Project Lifecycle, or Member/RBAC scope records.",
    "Resolve break-glass business policy, legal support commitments, or customer success workflows.",
    "Implement the Meta-cloud Broker environment proposal UI or Yard planner behavior.",
  ],
  boundaries: {
    service:
      "Admin Console defines read-model and action-intent contract boundaries; service persistence, projector runtime, and mutation execution remain later implementation work.",
    ux:
      "Admin Console defines navigation and information architecture; it does not build screens, component behavior, or interaction flows in this issue.",
    security:
      "Admin Console names least-privilege, redaction, break-glass visibility, and no-secret exposure requirements without implementing authorization.",
    support:
      "Admin Console defines support-visible context and handoff fields; Support Workflow owns tickets, SLA routing, and escalation execution.",
  },
  dependencies: [
    {
      source: "docs/design/developer-experience.md#plan-07",
      reason: "Defines the dashboard and operations experience where Admin Console surfaces are later exposed.",
    },
    {
      source: "docs/design/organization-workspace-model.md",
      reason: "Supplies account, organization, workspace, project, tenant, and environment nouns the console must display without redefining them.",
    },
    {
      source: "docs/design/settings-project-lifecycle.md",
      reason: "Defines project state, settings ownership, and lifecycle transitions consumed as read-model inputs.",
    },
    {
      source: "docs/design/member-rbac-administration.md",
      reason: "Defines role, membership, approval, and audit boundaries for later admin actions.",
    },
    {
      source: "docs/design/tenant-isolation-quotas.md",
      reason: "Defines tenant and quota dimensions the console may expose while leaving enforcement out of scope.",
    },
    {
      source: "docs/design/support-sla-channels.md",
      reason: "Defines support context, SLA, and escalation handoffs consumed by support-visible console views.",
    },
    {
      source: "docs/design/security-networking.md#plan-50",
      reason: "Defines tenant isolation and security/networking boundaries for admin visibility.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0074",
      reason: "Pins org governance, RBAC, mandatory policy rules, deny ceilings, and audit obligations.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0077",
      reason: "Pins projects and environments as grouping dimensions for operations dashboards and status surfaces.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0080",
      reason: "Pins tenant isolation by construction and cross-tenant leak conformance as hard security boundaries.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Admin Console",
      consumes: "Owns accepted admin-console navigation, read-model classes, action-intent categories, and evidence gates.",
      scopeBoundary: "This issue defines scope and acceptance; it does not build UI or service runtime.",
    },
    {
      owner: "Settings & Project Lifecycle",
      consumes: "Supplies project state, owners, lifecycle transitions, and settings classes for console read models.",
      scopeBoundary: "Lifecycle state machines and settings mutation remain outside Admin Console M0.",
    },
    {
      owner: "Member/RBAC Administration",
      consumes: "Supplies role authority, membership, approval, no-self-escalation, and audit evidence for later admin actions.",
      scopeBoundary: "RBAC enforcement, SSO/SCIM, member workflows, and policy evaluation stay with Member/RBAC.",
    },
    {
      owner: "Tenant Isolation & Quotas",
      consumes: "Supplies tenant, quota, limit, and noisy-neighbor visibility for console summaries.",
      scopeBoundary: "Tenant isolation, quota enforcement, and billing/entitlement behavior remain outside Admin Console.",
    },
    {
      owner: "Support Workflow",
      consumes: "Uses console-safe context, redaction state, owners, and escalation fields for support triage.",
      scopeBoundary: "Ticketing, SLA routing, and support automation stay in Support Workflow.",
    },
    {
      owner: "Security Verification",
      consumes: "Uses redaction, no-secret exposure, break-glass visibility, and cross-tenant guardrails as M1 evidence inputs.",
      scopeBoundary: "Security conformance suites, credential checks, and leak tests stay in Security Verification.",
    },
    {
      owner: "Meta-cloud Broker",
      consumes: "Supplies broker environment proposal and approval visibility requirements for later admin surfaces.",
      scopeBoundary: "Broker resolution, Yard planner behavior, provider mapping, and receipt mutation stay outside Admin Console.",
    },
  ],
  readModelClasses: [
    {
      id: "workspace-overview",
      owner: "Admin Console",
      customerVisible: true,
      launchCritical: true,
    },
    {
      id: "project-lifecycle-summary",
      owner: "Settings & Project Lifecycle",
      customerVisible: true,
      launchCritical: true,
    },
    {
      id: "member-role-summary",
      owner: "Member/RBAC Administration",
      customerVisible: true,
      launchCritical: true,
    },
    {
      id: "tenant-quota-summary",
      owner: "Tenant Isolation & Quotas",
      customerVisible: true,
      launchCritical: true,
    },
    {
      id: "support-debug-context",
      owner: "Support Workflow",
      customerVisible: false,
      launchCritical: true,
    },
    {
      id: "security-audit-redaction",
      owner: "Security Verification",
      customerVisible: false,
      launchCritical: true,
    },
  ],
  actionIntentCategories: [
    "inspect",
    "request-change",
    "approve-or-deny",
    "escalate-to-support",
    "export-audit-summary",
    "view-break-glass-state",
  ],
  m1Evidence: [
    {
      kind: "navigation-information-architecture",
      owner: "Admin Console",
      proofMode: "design-record",
      proves: "Admin Console navigation names workspace, project, tenant, environment, support, and security surfaces without UI implementation.",
    },
    {
      kind: "read-model-contract",
      owner: "Admin Console",
      proofMode: "contract-test",
      proves: "Each console read-model class has owner, visibility, launch criticality, and redaction state.",
    },
    {
      kind: "action-intent-matrix",
      owner: "Member/RBAC Administration",
      proofMode: "reference-fixture",
      proves: "Inspect, request, approve/deny, support escalation, audit export, and break-glass visibility are represented without executing mutations.",
    },
    {
      kind: "audit-redaction-export",
      owner: "Security Verification",
      proofMode: "audit-fixture",
      proves: "Support and security summaries expose owners, timestamps, actions, and redaction state without secrets or raw customer data.",
    },
    {
      kind: "break-glass-visibility-fixture",
      owner: "Security/policy admin",
      proofMode: "policy-fixture",
      proves: "Break-glass state can be visible and auditable without granting live access or credentials.",
    },
    {
      kind: "scope-boundary-register",
      owner: "Admin Console",
      proofMode: "support-handoff",
      proves: "UI implementation, RBAC, quota, billing, support workflow, provider credential, live data, and broker runtime work route to owning initiatives.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 admin-console design, UI, service, support, RBAC, quota, broker, or security implementation issues must not be created until this record is accepted.",
  },
};

export function canCreateFollowUpIssue({
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

export function classifyAdminConsoleRequest(request: JsonValue): ScopeClassification {
  const text = String(request ?? "").toLowerCase();

  if (/\bprovider credentials?\b|\bsecret\b|\braw credential\b|\bleak\b|\bcross-tenant\b/.test(text)) {
    return { owner: "Security Verification", inScope: false };
  }
  if (/\brbac\b|\brole binding\b|\bmember\b|\bscim\b|\bsso\b|\bpolicy\b/.test(text)) {
    return { owner: "Member/RBAC Administration", inScope: false };
  }
  if (/\btenant quota\b|\bquota\b|\bentitlement\b|\bbilling\b|\brate limit\b/.test(text)) {
    return { owner: "Tenant Isolation & Quotas", inScope: false };
  }
  if (/\bsupport ticket\b|\bticket queue\b|\bsla\b|\bescalation workflow\b/.test(text)) {
    return { owner: "Support Workflow", inScope: false };
  }
  if (/\bbroker\b|\bresolution receipt\b|\bmapping\b/.test(text)) {
    return { owner: "Meta-cloud Broker", inScope: false };
  }

  return { owner: "Admin Console", inScope: true };
}

export function validateAdminConsoleScope(scope: JsonValue): ScopeValidation {
  const errors: string[] = [];

  if (!scope || !isJsonObject(scope)) {
    return { ok: false, errors: ["scope record is required"] };
  }

  // SAFETY: `const record = scope as Partial<AdminConsoleScope>;` is required at this I/O or test boundary.
  const record = scope as Partial<AdminConsoleScope>;

  if (record.issue !== "HOBO-425") {
    errors.push("issue must be HOBO-425");
  }
  if (record.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!record.goal?.toLowerCase().includes("admin console")) {
    errors.push("goal must name admin console");
  }
  if ((record.personas ?? []).length < 4) {
    errors.push("at least four personas are required");
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
    errors.push("design dependencies must map to DX, workspace, settings, RBAC, tenant, support, security, and ADR sources");
  }
  for (const dependency of record.dependencies ?? []) {
    if (!dependency.source || !dependency.reason) {
      errors.push(`dependency ${dependency.source ?? "<missing>"} must include a reason`);
    }
  }

  if ((record.initiativeDependencies ?? []).length < 7) {
    errors.push("owning initiative dependencies must map consuming productization projects");
  }
  for (const dependency of record.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
    }
  }

  if ((record.readModelClasses ?? []).length < 6) {
    errors.push("read-model classes must include workspace, project, role, tenant, support, and security classes");
  }
  if ((record.actionIntentCategories ?? []).length < 6) {
    errors.push("action intent categories must cover inspect, request, approve/deny, support, audit, and break-glass states");
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
