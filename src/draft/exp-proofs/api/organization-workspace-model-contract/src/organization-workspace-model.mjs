import { isJsonObject } from "./json.js";
const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"];
const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);
const VALID_PROOF_MODES = new Set([
  "design-record",
  "contract-test",
  "reference-fixture",
  "support-handoff",
]);
const SCOPE_CREEP_PATTERNS = [
  /\bbuild\b/i,
  /\bimplement\b/i,
  /\bship\b/i,
  /production workspace/i,
  /real customer data/i,
  /live customer/i,
  /invite flow/i,
  /rbac engine/i,
  /quota enforcement/i,
];

export const ORGANIZATION_WORKSPACE_MODEL = {
  issue: "HOBO-413",
  project: "Organization & Workspace Model",
  phase: "M0",
  goal:
    "Define the Organization and Workspace Model M0 scope so HoBo can distinguish account, organization, workspace, project, tenant, and environment responsibilities before adjacent productization work fans out.",
  personas: [
    {
      role: "workspace admin",
      need: "Understand what an organization owns, what a workspace contains, and which actions need member or policy approval.",
    },
    {
      role: "platform engineer",
      need: "Map workspaces to Projects, Environments, Camps, Yards, and tenant boundaries without creating a hidden runtime model.",
    },
    {
      role: "app developer",
      need: "Know where first project creation, settings, default environment, and deploy ownership appear in onboarding.",
    },
    {
      role: "support/operator",
      need: "Route org/workspace incidents, audit exports, ownership disputes, and unsupported account shapes to the right owner.",
    },
  ],
  scopeIn: [
    "Define the canonical account, organization, workspace, project, tenant, and environment vocabulary for v1 product surfaces.",
    "Define ownership, lifecycle, and boundary rules that adjacent M0 projects can consume without expanding this issue into implementation.",
    "Define the service, UX, security, and support boundaries for workspace creation, project grouping, member visibility, and audit handoff.",
    "Define M1-ready evidence for domain model fixtures, RBAC handoff, tenant/quota handoff, project lifecycle handoff, and support export handoff.",
    "Define follow-up gate rules so M1/M2/M3/M4 implementation issues wait for accepted M0 scope.",
  ],
  scopeOut: [
    "Do not build workspace creation, invite, member management, RBAC, quota, or tenant isolation runtime behavior in this issue.",
    "Do not create customer data, production organizations, live workspaces, or provider resources.",
    "Do not define billing account, entitlement, payment, tax, or commercial packaging behavior.",
    "Do not implement project settings, environment lifecycle, onboarding telemetry, or dashboard UI.",
    "Do not resolve launch support, legal/privacy, or customer-success process ownership beyond routing boundaries.",
  ],
  nonGoals: [
    "Replace the existing Bindle/Camp/Yard/Junction scope model.",
    "Create a new organization-scoped runtime primitive.",
    "Create downstream M1-M4 execution issues before M0 acceptance.",
  ],
  boundaries: {
    service:
      "Organization & Workspace Model defines product ownership and grouping semantics; service implementation stays with Settings & Project Lifecycle and adjacent capability projects.",
    ux:
      "Organization & Workspace Model defines the nouns and first-run surface responsibilities; Workspace & Onboarding UX owns screen flows, activation telemetry, and UI copy.",
    security:
      "Organization & Workspace Model defines which security handoffs are required; Member/RBAC Administration and Tenant Isolation & Quotas own enforcement, policy, and isolation implementation.",
    support:
      "Organization & Workspace Model defines support-visible ownership and audit/export expectations; launch support owns response targets and escalation execution.",
  },
  dependencies: [
    {
      source: "docs/design/architecture.md#plan-10",
      reason: "Defines project/package architecture and the existing scope vocabulary that productized workspaces must not replace.",
    },
    {
      source: "docs/design/developer-experience.md#plan-07",
      reason: "Defines dashboard, status, CLI, inspect, and project-facing developer surfaces that consume workspace/project nouns.",
    },
    {
      source: "docs/design/security-networking.md#plan-50",
      reason: "Defines app-tenant and tenant-routing boundaries that the workspace model must route to, not implement.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0074",
      reason: "Pins org governance, RBAC, mandatory rules, and control-plane action taxonomy as security-owned scope.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0079",
      reason: "Pins app multi-tenancy as a separate model consumed by product workspaces.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0080",
      reason: "Pins tenant isolation conformance and prevents workspace scope from making unsupported isolation claims.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Organization & Workspace Model",
      consumes: "The accepted vocabulary and owner map become the M1 input for organization/workspace domain fixtures.",
      scopeBoundary: "This issue records scope and acceptance only; it does not build workspace runtime behavior.",
    },
    {
      owner: "Tenant Isolation & Quotas",
      consumes: "Workspace and tenant boundary definitions identify where isolation and quota claims must be enforced.",
      scopeBoundary: "Quota accounting, tenant isolation, and cross-tenant leak prevention remain outside this M0 scope.",
    },
    {
      owner: "Member/RBAC Administration",
      consumes: "Organization roles, workspace membership visibility, and approval nouns feed RBAC design.",
      scopeBoundary: "Member invitations, SSO/SCIM, role bindings, and policy enforcement stay in RBAC scope.",
    },
    {
      owner: "Settings & Project Lifecycle",
      consumes: "Project and environment ownership rules define which settings/lifecycle surfaces belong under a workspace.",
      scopeBoundary: "Project creation, archive/restore, environment lifecycle, and settings UI are not built here.",
    },
    {
      owner: "Workspace & Onboarding UX",
      consumes: "First workspace/project activation can use the accepted nouns and unsupported-state wording.",
      scopeBoundary: "Onboarding flows, activation metrics, and dashboard IA remain in Workspace & Onboarding UX.",
    },
    {
      owner: "V1 Release Program & Cutline",
      consumes: "Unsupported organization shapes and missing evidence route into launch limitation or blocker taxonomy.",
      scopeBoundary: "Go/no-go decisions, blocker exceptions, and launch notes stay with the release cutline.",
    },
  ],
  m1Evidence: [
    {
      kind: "domain-model",
      owner: "Organization & Workspace Model",
      proofMode: "design-record",
      proves: "Canonical nouns, allowed relationships, ownership rules, and unsupported shapes are stable enough for M1 proof.",
    },
    {
      kind: "membership-rbac-handshake",
      owner: "Member/RBAC Administration",
      proofMode: "contract-test",
      proves: "Workspace roles, approvals, and membership visibility are consumed by RBAC without hidden enforcement here.",
    },
    {
      kind: "tenant-quota-handshake",
      owner: "Tenant Isolation & Quotas",
      proofMode: "contract-test",
      proves: "Workspace and tenant boundaries route isolation and quota claims to the owning project.",
    },
    {
      kind: "project-lifecycle-handshake",
      owner: "Settings & Project Lifecycle",
      proofMode: "reference-fixture",
      proves: "Workspace-scoped project/environment lifecycle states can be represented without adding runtime primitives.",
    },
    {
      kind: "support-audit-export",
      owner: "V1 Launch Support Desk & Escalation",
      proofMode: "support-handoff",
      proves: "Support can identify workspace owner, project, environment, tenant boundary, and unsupported-state reason.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 domain, RBAC, tenant/quota, settings, onboarding, or support implementation issues must not be created until this record is accepted.",
  },
};

export function canCreateFollowUpIssue({ phase, m0Accepted }) {
  return Boolean(m0Accepted) && IMPLEMENTATION_PHASES.has(phase);
}

export function classifyWorkspaceDecision(decision) {
  const text = decision ?? "";

  if (/invite|member|role|approval|rbac/i.test(text)) {
    return "Member/RBAC Administration";
  }
  if (/tenant|quota|isolation|cross-tenant/i.test(text)) {
    return "Tenant Isolation & Quotas";
  }
  if (/project|environment|archive|restore|settings/i.test(text)) {
    return "Settings & Project Lifecycle";
  }
  if (/onboarding|activation|first workspace|workspace activation/i.test(text)) {
    return "Workspace & Onboarding UX";
  }

  return "Organization & Workspace Model";
}

export function validateOrganizationWorkspaceModel(model) {
  const errors = [];

  if (!model || !isJsonObject(model)) {
    return { ok: false, errors: ["model is required"] };
  }
  if (model.issue !== "HOBO-413") {
    errors.push("issue must be HOBO-413");
  }
  if (model.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!model.goal?.toLowerCase().includes("organization and workspace")) {
    errors.push("goal must name Organization and Workspace Model");
  }

  for (const collection of ["personas", "scopeIn", "scopeOut", "nonGoals", "dependencies", "initiativeDependencies", "m1Evidence"]) {
    if (!Array.isArray(model[collection]) || model[collection].length === 0) {
      errors.push(`${collection} must be a non-empty list`);
    }
  }

  for (const key of REQUIRED_BOUNDARIES) {
    const rule = model.boundaries?.[key];
    if (!rule) {
      errors.push(`missing ${key} boundary`);
    } else if (!rule.includes("Organization & Workspace Model")) {
      errors.push(`${key} boundary must name Organization & Workspace Model`);
    }
  }

  for (const item of model.scopeIn ?? []) {
    if (SCOPE_CREEP_PATTERNS.some((pattern) => pattern.test(item))) {
      errors.push(`scope creep: ${item}`);
    }
  }

  for (const dependency of model.dependencies ?? []) {
    if (!dependency.source?.startsWith("docs/design/") || !dependency.reason) {
      errors.push(`dependency ${dependency.source ?? "<missing>"} must cite design source and reason`);
    }
  }

  for (const dependency of model.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
    }
  }

  for (const evidence of model.m1Evidence ?? []) {
    if (!evidence.kind || !evidence.owner || !evidence.proves) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must name kind, owner, and proof`);
    }
    if (!VALID_PROOF_MODES.has(evidence.proofMode)) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must declare a valid proof mode`);
    }
  }

  if (!model.followUpGate?.allowedAfter || !model.followUpGate?.blockedBefore) {
    errors.push("follow-up gate must record allowed-after and blocked-before states");
  }

  return { ok: errors.length === 0, errors };
}
