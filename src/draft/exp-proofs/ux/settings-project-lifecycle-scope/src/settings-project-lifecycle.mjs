export const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"];

const VALID_PROOF_MODES = new Set([
  "design-record",
  "contract-test",
  "reference-fixture",
  "audit-fixture",
  "support-handoff",
]);

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = [
  /admin console/i,
  /rbac enforcement/i,
  /tenant quota/i,
  /billing/i,
  /provider credential/i,
  /live provider/i,
];

export const SETTINGS_PROJECT_LIFECYCLE_SCOPE = {
  issue: "HOBO-412",
  project: "Settings & Project Lifecycle",
  phase: "M0",
  goal:
    "Define the Settings & Project Lifecycle productization scope so workspace settings, project creation, lifecycle states, and support-visible ownership rules have accepted M0 boundaries before design/build issues fan out.",
  personas: [
    {
      role: "workspace admin",
      need: "Understand which workspace and project settings are launch-critical and which require later governance proof.",
    },
    {
      role: "project owner",
      need: "Create, archive, restore, and hand off projects without unclear ownership or hidden service assumptions.",
    },
    {
      role: "platform engineer",
      need: "Know which project lifecycle states downstream deployment, environment, and quota work can rely on.",
    },
    {
      role: "support operator",
      need: "Inspect settings, lifecycle state, owners, and audit evidence without taking admin-console implementation scope.",
    },
  ],
  scopeIn: [
    "Canonical workspace and project settings classes with owner, customer visibility, launch criticality, and follow-up evidence requirement.",
    "Project lifecycle state model covering draft, active, suspended, archived, restore-pending, and deleted-terminal states.",
    "Lifecycle transition ownership for create, rename, transfer, suspend, archive, restore, and delete decisions.",
    "Audit and support-export requirements for settings changes and lifecycle transitions.",
    "M1-ready evidence checklist for schema, state-machine, audit event, RBAC-boundary, and support handoff proofs.",
  ],
  scopeOut: [
    "No admin console workflow implementation.",
    "No RBAC enforcement engine or member-management UI.",
    "No tenant quota metering, billing, or entitlement enforcement.",
    "No environment lifecycle implementation beyond project boundary dependencies.",
    "No live provider provisioning, provider credentials, or project resource deletion.",
  ],
  nonGoals: [
    "Replace the existing project/environment design model.",
    "Define customer onboarding or support SLA promises.",
    "Create downstream M1-M4 execution issues before M0 scope is accepted.",
  ],
  boundaries: {
    service:
      "Settings and project lifecycle are product control-plane records; this issue does not build the service runtime or persistence layer.",
    ux:
      "UX scope is the accepted information architecture for settings and lifecycle actions, not admin-console screens or interaction flows.",
    security:
      "The record names ownership, audit, and RBAC dependency boundaries without implementing authorization or static credentials.",
    support:
      "Support can rely on lifecycle state, owner, and audit export requirements; ticketing workflow and SLA promises remain separate support work.",
  },
  dependencies: [
    {
      source: "docs/design/developer-experience.md#plan-07",
      reason: "Defines dashboard and project-facing developer experience surfaces that consume settings/lifecycle state.",
    },
    {
      source: "docs/design/architecture.md#plan-10",
      reason: "Defines repository and control-plane shape that settings/project records must fit without adding runtime implementation.",
    },
    {
      source: "docs/design/security-networking.md#plan-50",
      reason: "Defines tenant isolation concerns consumed as boundaries, not implemented inside this M0 scope.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0077",
      reason: "Projects and environments are grouping dimensions for operations dashboards and status surfaces.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0074",
      reason: "Org governance and RBAC are mandatory dependencies, but enforcement is out of this issue.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Settings & Project Lifecycle",
      consumes: "Owns the accepted settings classes, lifecycle states, transition owners, and M1 evidence checklist.",
      scopeBoundary: "This issue defines the scope record; it does not build the settings service.",
    },
    {
      owner: "Member/RBAC Administration",
      consumes: "Uses ownership and transition authority requirements to define later member and role administration.",
      scopeBoundary: "RBAC enforcement and member workflows remain in Member/RBAC Administration.",
    },
    {
      owner: "Tenant Isolation & Quotas",
      consumes: "Uses project state and ownership as inputs for tenant and quota policy.",
      scopeBoundary: "Quota accounting, limits, and isolation proof stay in Tenant Isolation & Quotas.",
    },
    {
      owner: "Environment Lifecycle",
      consumes: "Uses project lifecycle state as a parent boundary for environment create/archive/restore behavior.",
      scopeBoundary: "Environment state machines and cleanup behavior remain in Environment Lifecycle.",
    },
    {
      owner: "Deployment Dashboard & Topology Explorer",
      consumes: "Displays project lifecycle and owner metadata alongside deployment/topology state.",
      scopeBoundary: "Dashboard implementation and topology visualization remain outside Settings M0.",
    },
    {
      owner: "Support Workflow",
      consumes: "Uses support-visible settings, owners, and audit exports for triage and handoff.",
      scopeBoundary: "Support routing, SLA, and escalation flows remain in Support Workflow.",
    },
  ],
  settingsClasses: [
    {
      id: "workspace-profile",
      owner: "workspace admin",
      customerVisible: true,
      launchCritical: true,
    },
    {
      id: "project-metadata",
      owner: "project owner",
      customerVisible: true,
      launchCritical: true,
    },
    {
      id: "lifecycle-controls",
      owner: "workspace admin",
      customerVisible: true,
      launchCritical: true,
    },
    {
      id: "support-audit-export",
      owner: "support operator",
      customerVisible: false,
      launchCritical: true,
    },
  ],
  lifecycleStates: [
    "draft",
    "active",
    "suspended",
    "archived",
    "restore-pending",
    "deleted-terminal",
  ],
  m1Evidence: [
    {
      kind: "settings-schema",
      owner: "workspace admin",
      proofMode: "design-record",
      proves: "Every settings class has owner, visibility, launch criticality, and support visibility.",
    },
    {
      kind: "project-lifecycle-state-machine",
      owner: "project owner",
      proofMode: "contract-test",
      proves: "Project lifecycle states and allowed transition classes are deterministic.",
    },
    {
      kind: "audit-event-fixture",
      owner: "platform engineer",
      proofMode: "audit-fixture",
      proves: "Settings and lifecycle changes produce replayable owner/action/state evidence.",
    },
    {
      kind: "rbac-boundary-matrix",
      owner: "workspace admin",
      proofMode: "reference-fixture",
      proves: "RBAC dependency handoff is explicit without implementing authorization.",
    },
    {
      kind: "support-export-contract",
      owner: "support operator",
      proofMode: "support-handoff",
      proves: "Support receives state, owner, last-change, and redaction boundaries.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 design or implementation issues must not be created until this record is accepted.",
  },
};

export function canCreateFollowUpIssue({ phase, m0Accepted }) {
  return Boolean(m0Accepted) && IMPLEMENTATION_PHASES.has(phase);
}

export function validateSettingsProjectLifecycleScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-412") {
    errors.push("issue must be HOBO-412");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!scope.goal?.toLowerCase().includes("settings")) {
    errors.push("goal must name settings");
  }
  if (!scope.goal?.toLowerCase().includes("project lifecycle")) {
    errors.push("goal must name project lifecycle");
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

  const requiredSources = [
    "docs/design/developer-experience.md#plan-07",
    "docs/design/architecture.md#plan-10",
    "docs/design/security-networking.md#plan-50",
    "docs/design/adr/02-identity-security.md#adr-0077",
    "docs/design/adr/02-identity-security.md#adr-0074",
  ];
  const sources = (scope.dependencies ?? []).map((dependency) => dependency.source);
  if (JSON.stringify(sources) !== JSON.stringify(requiredSources)) {
    errors.push("design dependencies must map to DX, architecture, tenancy, projects/environments, and RBAC governance");
  }

  if ((scope.initiativeDependencies ?? []).length < 6) {
    errors.push("owning initiative dependencies must map to consuming productization projects");
  }
  for (const dependency of scope.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
    }
  }

  if ((scope.settingsClasses ?? []).length < 4) {
    errors.push("settings classes must include workspace, project, lifecycle, and support audit classes");
  }
  if ((scope.lifecycleStates ?? []).length < 6) {
    errors.push("lifecycle states must cover draft, active, suspended, archived, restore-pending, and deleted-terminal");
  }

  for (const evidence of scope.m1Evidence ?? []) {
    if (!evidence.owner || !evidence.proves) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must name owner and proof`);
    }
    if (!VALID_PROOF_MODES.has(evidence.proofMode)) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must declare a proof mode`);
    }
  }

  if (!scope.followUpGate?.allowedAfter || !scope.followUpGate?.blockedBefore) {
    errors.push("follow-up gate must record allowed-after and blocked-before states");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
