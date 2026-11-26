export const REQUIRED_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

const REQUIRED_M1_EVIDENCE = Object.freeze([
  "environment-schema",
  "lifecycle-state-machine",
  "transition-owner-matrix",
  "audit-event-fixture",
  "support-export-contract",
  "scope-boundary-register",
]);

const REQUIRED_ENVIRONMENT_EVIDENCE = Object.freeze([
  "parent-project",
  "environment-owner",
  "tenant-boundary",
  "policy-class",
  "last-deployment-signal",
  "restore-point",
  "cleanup-handoff",
  "support-export",
]);

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "runtime",
    pattern: /\b(service runtime|persistence layer|runtime service|production service)\b/i,
  },
  {
    label: "provider",
    pattern: /\b(live provider|provider resources?|dns|provision real|real cloud)\b/i,
  },
  {
    label: "admin",
    pattern: /\b(admin console screens?|approval workflows?|ui implementation)\b/i,
  },
  {
    label: "rbac",
    pattern: /\b(rbac enforcement|member role binding|authorization engine|role binding)\b/i,
  },
  {
    label: "quota",
    pattern: /\b(tenant quota|billing limits?|entitlement enforcement|metering)\b/i,
  },
  {
    label: "cleanup",
    pattern:
      /\b(live garbage collection|backup[/-]restore operations?|backup[/-]restore runtime|cleanup sweeper|resource cleanup|drift detection|teardown execution)\b/i,
  },
]);

export const ENVIRONMENT_LIFECYCLE_SCOPE = Object.freeze({
  issue: "HOBO-414",
  project: "Environment Lifecycle",
  phase: "M0",
  goal:
    "Define Environment Lifecycle scope and acceptance so project-owned environments, lifecycle states, transition owners, and support evidence have accepted M0 boundaries before design/build issues fan out.",
  personas: Object.freeze([
    {
      id: "workspace-admin",
      name: "Workspace admin",
      need:
        "Needs to understand which environments exist, who owns them, and which lifecycle actions require later approval proof.",
    },
    {
      id: "project-owner",
      name: "Project owner",
      need:
        "Needs deterministic create, suspend, archive, restore, and delete semantics without hidden provider or quota authority.",
    },
    {
      id: "platform-engineer",
      name: "Platform engineer",
      need:
        "Needs environment state and transition evidence that downstream deploy, preview, rollback, and topology work can consume.",
    },
    {
      id: "support-operator",
      name: "Support operator",
      need:
        "Needs customer-safe state, owner, evidence gaps, and escalation paths for environment recovery or cleanup handoff.",
    },
  ]),
  scopeIn: Object.freeze([
    "Define launch environment classes for local-dev, preview, development, staging, production, and ephemeral environments.",
    "Record lifecycle states from requested through provisioning-blocked, active, suspended, archived, restore-pending, deleting, and deleted-terminal.",
    "Define transition ownership for create, activate, suspend, archive, restore, delete, fork, and promote decisions.",
    "Define required evidence fields for parent project, environment owner, tenant boundary, policy class, deployment signal, restore point, cleanup handoff, and support export.",
    "Map service, UX, security, and support boundaries for downstream M1 design and contract proof.",
    "List M1 evidence required before schema, state-machine, audit, support, topology, or environment UX work can depend on this record.",
  ]),
  scopeOut: Object.freeze([
    "No environment service runtime, database, API, queue, or persistence implementation.",
    "No live provider provisioning, DNS, gateway routing, deployment execution, or infrastructure mutation.",
    "No admin-console screens, approval flows, client state, or interaction implementation.",
    "No RBAC enforcement, member role binding, policy-engine implementation, static credentials, or authorization runtime.",
    "No tenant quota, billing, entitlement enforcement, usage metering, or cost-routing behavior.",
    "No backup/restore runtime, live garbage collection, resource cleanup sweeper, drift detection, or teardown execution.",
    "No downstream M1-M4 issue creation before this M0 scope record is accepted.",
  ]),
  nonGoals: Object.freeze([
    "Replace Settings & Project Lifecycle project states or ownership rules.",
    "Build provider, DNS, gateway, deploy, teardown, backup, restore, or cleanup runtime behavior.",
    "Define billing, quota, entitlement, or RBAC enforcement semantics.",
    "Create implementation follow-ups before M0 acceptance evidence is approved.",
  ]),
  boundaries: Object.freeze([
    {
      id: "service",
      owner: "Environment Lifecycle",
      promise:
        "Owns environment classes, states, transition owners, and evidence fields; service runtime and persistence remain later work.",
    },
    {
      id: "ux",
      owner: "Admin Console / Developer Experience",
      promise:
        "Defines information architecture and state labels only; screens, routes, and interaction flows remain later UX implementation work.",
    },
    {
      id: "security",
      owner: "Member/RBAC Administration and Tenant Isolation & Quotas",
      promise:
        "Names RBAC, policy, tenant, and quota handoffs without implementing authorization, enforcement, or secrets.",
    },
    {
      id: "support",
      owner: "Support Workflow",
      promise:
        "Defines customer-safe support exports, evidence gaps, and escalation owners without ticketing or SLA automation.",
    },
  ]),
  environmentClasses: Object.freeze([
    {
      id: "local-dev",
      definition: "Developer-owned local or simulated environment with no hosted availability claim.",
    },
    {
      id: "preview",
      definition: "Short-lived review environment tied to a branch, pull request, or fork lane.",
    },
    {
      id: "development",
      definition: "Shared non-production environment for active project iteration.",
    },
    {
      id: "staging",
      definition: "Release-candidate environment for production-like validation and support rehearsal.",
    },
    {
      id: "production",
      definition: "Customer-impacting environment that requires explicit ownership, policy, and support evidence.",
    },
    {
      id: "ephemeral",
      definition: "TTL-bound environment that must carry expiry, cleanup, and support handoff evidence.",
    },
  ]),
  lifecycleStates: Object.freeze([
    {
      id: "requested",
      meaning: "Environment intent exists but downstream provisioning, tenancy, or policy proof is not accepted.",
    },
    {
      id: "provisioning-blocked",
      meaning: "Environment cannot become active until an owner, tenant, provider, policy, or support blocker resolves.",
    },
    {
      id: "active",
      meaning: "Environment can be referenced by deployments, dashboards, support exports, and topology records.",
    },
    {
      id: "suspended",
      meaning: "Environment remains inspectable while new deploy or mutation actions are blocked.",
    },
    {
      id: "archived",
      meaning: "Environment is hidden from default active views but retains restore, support, and cleanup evidence.",
    },
    {
      id: "restore-pending",
      meaning: "Restore is requested and waiting for backup, tenant, policy, and resource checks.",
    },
    {
      id: "deleting",
      meaning: "Deletion intent is recorded but later cleanup/teardown evidence is still outstanding.",
    },
    {
      id: "deleted-terminal",
      meaning: "Product lifecycle has ended for the environment without claiming provider resources were removed.",
    },
  ]),
  requiredEvidence: Object.freeze([
    {
      id: "parent-project",
      owner: "Settings & Project Lifecycle",
      proof: "Names the project state and owner boundary that allows the environment to exist.",
    },
    {
      id: "environment-owner",
      owner: "Environment Lifecycle",
      proof: "Names accountable workspace, project, support, or automation owner for lifecycle decisions.",
    },
    {
      id: "tenant-boundary",
      owner: "Tenant Isolation & Quotas",
      proof: "Records tenant isolation context without enforcing quotas or resource limits.",
    },
    {
      id: "policy-class",
      owner: "Member/RBAC Administration",
      proof: "Records approval and role-dependency class without implementing authorization.",
    },
    {
      id: "last-deployment-signal",
      owner: "Deployment Dashboard & Topology Explorer",
      proof: "Records the latest deployment/topology signal without implementing deploy or dashboard runtime.",
    },
    {
      id: "restore-point",
      owner: "Backup & Restore",
      proof: "Records whether restore evidence exists without performing backup or restore work.",
    },
    {
      id: "cleanup-handoff",
      owner: "Resource Garbage Collection",
      proof: "Records archived/deleting/deleted-terminal cleanup handoff without sweeping live resources.",
    },
    {
      id: "support-export",
      owner: "Support Workflow",
      proof: "Records customer-safe owner, state, limitation, and escalation evidence for support.",
    },
  ]),
  designRefs: Object.freeze([
    "docs/design/settings-project-lifecycle.md",
    "docs/design/organization-workspace-model.md",
    "docs/design/developer-experience.md#plan-07",
    "docs/design/platform-engineering.md#plan-25",
    "docs/design/security-networking.md#plan-50",
    "docs/design/support-sla-channels.md",
    "docs/design/backup-restore.md",
    "docs/design/resource-garbage-collection.md",
  ]),
  adrRefs: Object.freeze([
    "docs/design/adr/02-identity-security.md#adr-0077",
    "docs/design/adr/02-identity-security.md#adr-0079",
    "docs/design/adr/02-identity-security.md#adr-0080",
    "docs/design/adr/07-portability-extensibility.md#adr-0042",
  ]),
  initiativeDependencies: Object.freeze([
    {
      owner: "Environment Lifecycle",
      boundary:
        "Owns the accepted environment taxonomy, lifecycle states, transition-owner matrix, evidence fields, and M1 proof gate.",
    },
    {
      owner: "Settings & Project Lifecycle",
      boundary:
        "Supplies parent project states, ownership, archive/restore/delete boundaries, and settings metadata consumed by environment state.",
    },
    {
      owner: "Admin Console",
      boundary:
        "May expose environment state and approval intent later; UI screens, approvals, and client flows remain outside this M0 record.",
    },
    {
      owner: "Deployment Dashboard & Topology Explorer",
      boundary:
        "Consumes environment state and last deployment/topology signal; dashboard implementation and topology visualization stay out of scope.",
    },
    {
      owner: "Tenant Isolation & Quotas",
      boundary:
        "Consumes environment tenant boundaries; quota accounting, noisy-neighbor controls, and enforcement remain separate.",
    },
    {
      owner: "Backup & Restore",
      boundary:
        "Consumes restore-pending and restore-point evidence; backup and restore drills or runtime behavior remain separate.",
    },
    {
      owner: "Resource Garbage Collection",
      boundary:
        "Consumes archived, deleting, and deleted-terminal handoffs; live cleanup, teardown, and provider sweepers remain separate.",
    },
    {
      owner: "Support Workflow",
      boundary:
        "Consumes customer-safe lifecycle state, owner, evidence gaps, and escalation fields without adding ticketing or SLA automation.",
    },
  ]),
  m1Evidence: Object.freeze([
    {
      id: "environment-schema",
      mode: "design-record",
      proves: "Environment classes, lifecycle states, parent project, tenant, owner, and policy fields are stable.",
    },
    {
      id: "lifecycle-state-machine",
      mode: "contract-test",
      proves: "Requested, blocked, active, suspended, archived, restore-pending, deleting, and terminal states transition deterministically.",
    },
    {
      id: "transition-owner-matrix",
      mode: "reference-fixture",
      proves: "Create, activate, suspend, archive, restore, delete, fork, and promote decisions route to named owners.",
    },
    {
      id: "audit-event-fixture",
      mode: "audit-fixture",
      proves: "Environment lifecycle changes emit owner/action/state evidence without implementing event storage.",
    },
    {
      id: "support-export-contract",
      mode: "support-handoff",
      proves: "Support can inspect customer-safe state, owner, limitation, unresolved evidence, and escalation path.",
    },
    {
      id: "scope-boundary-register",
      mode: "audit-fixture",
      proves: "Runtime, provider, admin, RBAC, quota, backup/restore, cleanup, and M1-M4 follow-up work are routed out.",
    },
  ]),
  followUpGate: Object.freeze({
    rule:
      "Create M1/M2/M3/M4 Environment Lifecycle design or implementation issues only after this M0 scope record and executable proof are accepted.",
  }),
});

export function canCreateEnvironmentLifecycleFollowUp({ phase, m0Accepted }) {
  if (!IMPLEMENTATION_PHASES.has(phase)) {
    return {
      allowed: true,
      reason: "Phase does not depend on the M0 Environment Lifecycle gate.",
    };
  }

  if (m0Accepted) {
    return {
      allowed: true,
      reason: "M0 Environment Lifecycle scope and acceptance evidence has been accepted.",
    };
  }

  return {
    allowed: false,
    reason: "M1/M2/M3/M4 follow-up issues wait for accepted M0 Environment Lifecycle scope.",
  };
}

export function classifyEnvironmentLifecycleDecision(decision) {
  const text = String(decision ?? "").toLowerCase();

  if (/\b(project archive|project lifecycle|project owner|workspace setting)\b/.test(text)) {
    return { owner: "Settings & Project Lifecycle", inScope: false };
  }
  if (/\b(admin console|approval screen|interaction flow|client state)\b/.test(text)) {
    return { owner: "Admin Console", inScope: false };
  }
  if (/\b(deployment dashboard|topology|last deployment|deploy signal)\b/.test(text)) {
    return { owner: "Deployment Dashboard & Topology Explorer", inScope: false };
  }
  if (/\b(tenant quota|quota enforcement|billing limit|noisy neighbor)\b/.test(text)) {
    return { owner: "Tenant Isolation & Quotas", inScope: false };
  }
  if (/\b(backup restore|restore drill|restore runtime|backup job)\b/.test(text)) {
    return { owner: "Backup & Restore", inScope: false };
  }
  if (/\b(garbage collection|cleanup sweeper|live resource cleanup|teardown execution)\b/.test(text)) {
    return { owner: "Resource Garbage Collection", inScope: false };
  }
  if (/\b(support ticket|sla|escalation workflow)\b/.test(text)) {
    return { owner: "Support Workflow", inScope: false };
  }

  return { owner: "Environment Lifecycle", inScope: true };
}

export function validateEnvironmentLifecycleScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-414") {
    errors.push("Scope record must be tied to HOBO-414.");
  }
  if (scope.phase !== "M0") {
    errors.push("Scope record must remain an M0 acceptance record.");
  }
  if (!scope.goal?.toLowerCase().includes("environment lifecycle")) {
    errors.push("Goal must name Environment Lifecycle.");
  }
  if ((scope.personas ?? []).length < 4) {
    errors.push("At least four primary personas are required.");
  }
  if ((scope.scopeIn ?? []).length < 5) {
    errors.push("Scope in must record at least five launch-critical entries.");
  }
  if ((scope.scopeOut ?? []).length < 6) {
    errors.push("Scope out must reject adjacent implementation work.");
  }

  for (const boundary of REQUIRED_BOUNDARIES) {
    if (!scope.boundaries?.some((entry) => entry.id === boundary)) {
      errors.push(`Missing ${boundary} boundary.`);
    }
  }
  for (const evidence of REQUIRED_M1_EVIDENCE) {
    if (!scope.m1Evidence?.some((entry) => entry.id === evidence)) {
      errors.push(`Missing M1 evidence: ${evidence}.`);
    }
  }
  for (const field of REQUIRED_ENVIRONMENT_EVIDENCE) {
    if (!scope.requiredEvidence?.some((entry) => entry.id === field)) {
      errors.push(`Missing required environment evidence: ${field}.`);
    }
  }
  for (const evidence of scope.m1Evidence ?? []) {
    if (!evidence.mode || !evidence.proves) {
      errors.push(`Evidence ${evidence.id ?? "<unknown>"} must name proof mode and proof.`);
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
