import { isJsonObject } from "./json.js";
export const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"];

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);
const VALID_PROOF_MODES = new Set([
  "design-record",
  "contract-test",
  "reference-fixture",
  "audit-fixture",
  "support-handoff",
  "policy-fixture",
]);

const REQUIRED_DEPENDENCIES = [
  "docs/design/organization-workspace-model.md",
  "docs/design/settings-project-lifecycle.md",
  "docs/design/tenant-isolation-quotas.md",
  "docs/design/developer-experience.md#plan-07",
  "docs/design/security-networking.md#plan-12",
  "docs/design/adr/02-identity-security.md#adr-0074",
  "docs/design/adr/02-identity-security.md#adr-0077",
];

const FORBIDDEN_SCOPE_PATTERNS = [
  /\brbac enforcement\b/i,
  /\bpolicy engine\b/i,
  /\bscim sync\b/i,
  /\bidentity provider integration\b/i,
  /\badmin console\b/i,
  /\binvite email\b/i,
  /\bprovider access\b/i,
  /\bbilling\b/i,
  /\bentitlement\b/i,
  /\btenant quota\b/i,
  /\blive customer data\b/i,
  /\bproduction org/i,
];

export const MEMBER_RBAC_ADMINISTRATION_SCOPE = {
  issue: "HOBO-416",
  project: "Member/RBAC Administration",
  phase: "M0",
  goal:
    "Define Member/RBAC Administration M0 scope so HoBo has accepted member lifecycle, role administration, project-bound authorization, and audit boundaries before RBAC design/build issues fan out.",
  personas: [
    {
      role: "workspace admin",
      need: "Understand member lifecycle states, invitation posture, and which role changes require later policy approval.",
    },
    {
      role: "security/policy admin",
      need: "Review default roles, custom-role boundaries, separation-of-duties obligations, and no-self-escalation evidence before implementation.",
    },
    {
      role: "project owner",
      need: "Know which project-scoped grants, ownership transfers, and lifecycle actions route through RBAC instead of project settings.",
    },
    {
      role: "support auditor",
      need: "Inspect member, role, approval, and audit evidence without gaining permission to mutate access.",
    },
  ],
  scopeIn: [
    "Define accepted member lifecycle states and administration responsibilities for v1 product surfaces.",
    "Define role administration boundaries for built-in roles, custom-role handoff, project-scoped grants, and approval obligations.",
    "Record SSO/SCIM and manual invite assumptions as M1 contract inputs without integrating an identity provider.",
    "Map service, UX, security, and support boundaries for member and RBAC administration.",
    "List M1-ready evidence for membership state, role authority, SSO/SCIM binding, no-self-escalation, audit/support export, and scope boundary proof.",
  ],
  scopeOut: [
    "Do not build the RBAC enforcement engine, policy engine, role-binding runtime, or default role action matrix in this issue.",
    "Do not integrate SSO/SCIM providers, synchronize identity groups, issue tokens, or implement identity-provider administration.",
    "Do not implement admin-console screens, invitation email delivery, onboarding flows, or support ticket workflows.",
    "Do not implement tenant isolation, tenant quota enforcement, billing, entitlements, provider access, or live customer-data migration.",
    "Do not create production organizations, live memberships, static credentials, or follow-up M1-M4 implementation issues before M0 acceptance.",
  ],
  nonGoals: [
    "Replace ADR-0074 org governance or the existing policy-plane decision model.",
    "Rebuild the already-scoped default role action matrix, RBAC role binding, or no-privilege-escalation contract packages.",
    "Resolve genesis admin, break-glass, or hosted-operator business policy in this issue.",
  ],
  boundaries: {
    service:
      "Member/RBAC Administration defines member lifecycle and role-admin records; service persistence and policy evaluation remain later implementation work.",
    ux:
      "Member/RBAC Administration defines information architecture and action classes; Admin Console owns screens and interaction flows.",
    security:
      "Member/RBAC Administration names least-privilege, no-self-escalation, SSO/SCIM, and audit expectations without implementing authorization.",
    support:
      "Member/RBAC Administration defines support-visible audit/export evidence; Support Workflow owns tickets, SLA, and escalation execution.",
  },
  dependencies: [
    {
      source: "docs/design/organization-workspace-model.md",
      reason: "Supplies the account, organization, workspace, project, tenant, and environment vocabulary that RBAC must not replace.",
    },
    {
      source: "docs/design/settings-project-lifecycle.md",
      reason: "Defines project ownership and lifecycle actions that later role authority must govern.",
    },
    {
      source: "docs/design/tenant-isolation-quotas.md",
      reason: "Defines tenant and quota boundaries that member/admin permissions can expose but not enforce in this issue.",
    },
    {
      source: "docs/design/developer-experience.md#plan-07",
      reason: "Defines dashboard and developer surfaces that consume project-scoped governance and role visibility.",
    },
    {
      source: "docs/design/security-networking.md#plan-12",
      reason: "Defines platform tenancy, zero-trust posture, and org governance over HoBo's control-plane surface.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0074",
      reason: "Pins RBAC, mandatory policy rules, deny ceilings, SSO/SCIM role binding, and audit obligations as the owning decision.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0077",
      reason: "Pins project and environment as rollup and authorization dimensions for role-scoped operations surfaces.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Member/RBAC Administration",
      consumes: "Owns accepted member lifecycle, role-administration, approval, and audit evidence boundaries.",
      scopeBoundary: "This issue defines scope and acceptance; it does not build RBAC services or policy evaluation.",
    },
    {
      owner: "Organization & Workspace Model",
      consumes: "Supplies account, organization, workspace, project, tenant, and environment nouns for member administration.",
      scopeBoundary: "This issue does not redefine workspace ownership or create new scope nouns.",
    },
    {
      owner: "Settings & Project Lifecycle",
      consumes: "Uses role authority requirements for project ownership, transfer, suspend, archive, restore, and delete decisions.",
      scopeBoundary: "Settings and lifecycle state machines remain outside Member/RBAC M0.",
    },
    {
      owner: "Tenant Isolation & Quotas",
      consumes: "Uses member/admin role boundaries for later tenant/quota visibility and override controls.",
      scopeBoundary: "Tenant isolation, quota enforcement, and noisy-neighbor proof remain with Tenant Isolation & Quotas.",
    },
    {
      owner: "Security Verification",
      consumes: "Uses no-self-escalation, deny-by-default, and audit expectations as M1 security evidence inputs.",
      scopeBoundary: "Security conformance, leak tests, and full policy-engine verification stay in Security Verification.",
    },
    {
      owner: "Support Workflow",
      consumes: "Uses member, role, approval, and audit export fields for support-safe triage and handoff.",
      scopeBoundary: "Support ticketing, SLA routing, and escalation execution stay in Support Workflow.",
    },
  ],
  m1Evidence: [
    {
      kind: "membership-state-model",
      owner: "Member/RBAC Administration",
      proofMode: "design-record",
      proves: "Invited, active, suspended, removed, and externally-managed membership states are named with owner and audit expectations.",
    },
    {
      kind: "role-authority-matrix",
      owner: "Security/policy admin",
      proofMode: "reference-fixture",
      proves: "Built-in roles, custom-role handoff, project-scoped grants, and approval obligations can be represented without enforcement code.",
    },
    {
      kind: "sso-scim-binding-fixture",
      owner: "Workspace admin",
      proofMode: "contract-test",
      proves: "External group bindings and manual invite fallback are explicit inputs to later role-binding design.",
    },
    {
      kind: "no-self-escalation-gate",
      owner: "Security Verification",
      proofMode: "contract-test",
      proves: "Role changes that would grant beyond the actor's authority require denial or an approval obligation.",
    },
    {
      kind: "audit-support-export",
      owner: "Support Workflow",
      proofMode: "support-handoff",
      proves: "Support can inspect member, role, approval, source, timestamp, and redaction state without mutating access.",
    },
    {
      kind: "scope-boundary-register",
      owner: "Member/RBAC Administration",
      proofMode: "policy-fixture",
      proves: "RBAC enforcement, SSO/SCIM sync, admin UI, tenant/quota, billing, provider, and live-data work route to owning initiatives.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 member, RBAC, SSO/SCIM, admin-console, support, or security implementation issues must not be created until this record is accepted.",
  },
};

export function canCreateFollowUpIssue({ phase, m0Accepted }) {
  return Boolean(m0Accepted) && IMPLEMENTATION_PHASES.has(phase);
}

export function classifyMemberRbacDecision(decision) {
  const text = String(decision ?? "").toLowerCase();

  if (/\bcross-tenant\b|\bleak\b|\bsecurity verification\b|\bthreat\b/.test(text)) {
    return { owner: "Security Verification", inScope: false };
  }
  if (/\btenant\b|\bquota\b|\bisolation\b|\bnoisy-neighbor\b/.test(text)) {
    return { owner: "Tenant Isolation & Quotas", inScope: false };
  }
  if (/\bproject lifecycle\b|\barchive\b|\brestore\b|\bsettings\b|\benvironment\b/.test(text)) {
    return { owner: "Settings & Project Lifecycle", inScope: false };
  }
  if (/\bsupport\b|\bticket\b|\bsla\b|\bescalation\b/.test(text)) {
    return { owner: "Support Workflow", inScope: false };
  }
  if (/\bmember\b|\brbac\b|\brole\b|\binvite\b|\bapproval\b|\bscim\b|\bsso\b/.test(text)) {
    return { owner: "Member/RBAC Administration", inScope: true };
  }

  return { owner: "Member/RBAC Administration", inScope: true };
}

export function validateMemberRbacAdministrationScope(scope) {
  const errors = [];

  if (!scope || !isJsonObject(scope)) {
    return { ok: false, errors: ["scope record is required"] };
  }
  if (scope.issue !== "HOBO-416") {
    errors.push("issue must be HOBO-416");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!scope.goal?.toLowerCase().includes("member")) {
    errors.push("goal must name member administration");
  }
  if (!scope.goal?.includes("RBAC")) {
    errors.push("goal must name RBAC");
  }
  if ((scope.personas ?? []).length < 4) {
    errors.push("at least four personas are required");
  }
  if ((scope.scopeIn ?? []).length < 5) {
    errors.push("scope in must have at least five entries");
  }
  if ((scope.scopeOut ?? []).length < 5) {
    errors.push("scope out must have at least five entries");
  }

  for (const key of REQUIRED_BOUNDARIES) {
    if (!scope.boundaries?.[key]) {
      errors.push(`missing ${key} boundary`);
    }
  }

  for (const entry of scope.scopeIn ?? []) {
    if (FORBIDDEN_SCOPE_PATTERNS.some((pattern) => pattern.test(entry))) {
      errors.push(`scope creep: ${entry}`);
    }
  }

  const sources = (scope.dependencies ?? []).map((dependency) => dependency.source);
  if (JSON.stringify(sources) !== JSON.stringify(REQUIRED_DEPENDENCIES)) {
    errors.push("design dependencies must map to org/workspace, settings, tenancy, DX, security, RBAC governance, and project/environment sources");
  }
  for (const dependency of scope.dependencies ?? []) {
    if (!dependency.source || !dependency.reason) {
      errors.push(`dependency ${dependency.source ?? "<missing>"} must include a reason`);
    }
  }

  if ((scope.initiativeDependencies ?? []).length < 6) {
    errors.push("owning initiative dependencies must map consuming productization projects");
  }
  for (const dependency of scope.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
    }
  }

  for (const evidence of scope.m1Evidence ?? []) {
    if (!evidence.kind || !evidence.owner || !evidence.proves) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must name kind, owner, and proof`);
    }
    if (!VALID_PROOF_MODES.has(evidence.proofMode)) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must declare a proof mode`);
    }
  }

  if (!scope.followUpGate?.allowedAfter || !scope.followUpGate?.blockedBefore) {
    errors.push("follow-up gate must record allowed-after and blocked-before states");
  }

  return { ok: errors.length === 0, errors };
}
