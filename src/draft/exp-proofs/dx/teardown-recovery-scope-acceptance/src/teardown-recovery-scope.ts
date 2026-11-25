import { type JsonValue } from "./json.js";
const REQUIRED_M1_EVIDENCE = Object.freeze([
  "teardown-state-schema",
  "dependency-drain-matrix",
  "recovery-decision-table",
  "cleanup-handoff-fixture",
  "support-escalation-export",
  "scope-boundary-register",
]);

const REQUIRED_EVIDENCE = Object.freeze([
  "owner",
  "scope",
  "last-known-state",
  "dependency-drain",
  "backup-or-rollback-reference",
  "cleanup-handoff",
  "support-handoff",
  "policy-decision",
]);

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "provider",
    pattern: /\b(provider adapter|provider delete|provider mutation|live provider|real aws|real azure|real gcp|real cloud)\b/i,
  },
  {
    label: "runtime",
    pattern:
      /\b(production teardown runner|teardown runner|restore runtime|mutate live|live environment|destructive execution|execute teardown)\b/i,
  },
  {
    label: "billing",
    pattern: /\b(refunds?|invoices?|billing|payments?|tax|chargebacks?|subscriptions?)\b/i,
  },
  {
    label: "support",
    pattern: /\b(support ticket|ticket queue|sla automation|helpdesk|customer notification)\b/i,
  },
  {
    label: "downstream",
    pattern: /\b(create downstream|m1-m4 implementation|follow-up implementation)\b/i,
  },
]);

export const REQUIRED_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

export const TEARDOWN_RECOVERY_SCOPE = Object.freeze({
  issue: "HOBO-444",
  project: "Teardown & Recovery",
  phase: "M0",
  goal:
    "Define Teardown and Recovery scope and acceptance so HoBo has accepted safe teardown, dependency drain, recovery decision, cleanup handoff, and support evidence before production teardown or restore implementation work begins.",
  personas: Object.freeze([
    {
      id: "platform-engineer",
      name: "Platform engineer",
      need: "Needs a deterministic teardown boundary that names affected scope, dependencies, rollback posture, cleanup handoff, and recovery options before implementation work starts.",
    },
    {
      id: "sre-operator",
      name: "SRE operator",
      need: "Needs resumable teardown and recovery evidence for failed deletes, interrupted drains, rollback, restore, and escalation.",
    },
    {
      id: "support-operator",
      name: "Support operator",
      need: "Needs customer-safe state, owner, limitation, evidence gap, and next-action routing when teardown or recovery stalls.",
    },
    {
      id: "security-reviewer",
      name: "Security reviewer",
      need: "Needs policy decisions, audit state, destructive-action boundaries, and no live credential or customer-data mutation in M0.",
    },
    {
      id: "customer-admin",
      name: "Customer admin",
      need: "Needs clear product language for what teardown can claim, what is recoverable, and which states remain unsupported.",
    },
  ]),
  scopeIn: Object.freeze([
    "Define teardown states for requested, blocked, draining, teardown-ready, recoverable, terminal, and escalated lifecycle records.",
    "Define dependency-drain evidence for dependents, pending operations, active incidents, provider-state uncertainty, and customer-visible impact.",
    "Define recovery decision modes for resume, rollback, restore-from-evidence, and manual escalation without executing those paths.",
    "Define cleanup and resource-garbage-collection handoff evidence for residual resources, orphan candidates, and unresolved provider state.",
    "Map service, UX, security, and support boundaries plus M1 evidence requirements before teardown/recovery implementation work fans out.",
  ]),
  scopeOut: Object.freeze([
    "No live provider deletes, provider adapter mutation, production teardown runner, or destructive execution.",
    "No backup restore runtime, disaster recovery runner, live restore, migration rollback executor, or customer data recovery.",
    "No support ticket queue, SLA automation, helpdesk integration, customer notification workflow, or incident command automation.",
    "No refund, invoice, billing, tax, chargeback, subscription, or commercial offboarding behavior.",
    "No M1-M4 design or implementation issue creation before this M0 scope record is accepted.",
  ]),
  nonGoals: Object.freeze([
    "Build production teardown execution, provider delete adapters, restore services, or support tooling.",
    "Replace Environment Lifecycle, Resource Garbage Collection, Backup & Restore, Upgrade & Migration Engine, or Support Workflow records.",
    "Treat a terminal product state as proof that provider resources were destroyed.",
    "Claim production teardown or recovery readiness before deterministic M1 fixtures prove the path.",
  ]),
  boundaries: Object.freeze([
    {
      id: "service",
      owner: "Teardown & Recovery",
      promise:
        "Owns teardown state, drain evidence, recovery decision, cleanup handoff, and follow-up gate; runtime execution remains later work.",
    },
    {
      id: "ux",
      owner: "Admin Console / Deployment Dashboard",
      promise:
        "May later surface teardown/recovery state and warnings; this M0 record defines labels and evidence only, not screens.",
    },
    {
      id: "security",
      owner: "Contracts, Policy & Governance",
      promise:
        "Owns destructive-action policy, tenant boundary, credential, and audit obligations; M0 only names required decision evidence.",
    },
    {
      id: "support",
      owner: "Support Workflow",
      promise:
        "Consumes safe state, owner, limitation, and escalation evidence without adding support queues or customer notification execution.",
    },
  ]),
  teardownStates: Object.freeze([
    {
      id: "requested",
      meaning: "Teardown intent exists but scope, owner, dependency, and policy evidence are incomplete.",
    },
    {
      id: "blocked",
      meaning: "Teardown cannot proceed because dependency, policy, incident, backup, or support evidence is missing.",
    },
    {
      id: "draining",
      meaning: "Later implementation may drain dependents, traffic, queues, jobs, or leases; M0 only records the expected evidence.",
    },
    {
      id: "teardown-ready",
      meaning: "All required evidence exists for a future implementation to begin destructive work.",
    },
    {
      id: "recoverable",
      meaning: "A recoverable state names rollback, restore, resume, or escalation evidence before terminal claims.",
    },
    {
      id: "terminal",
      meaning: "Product lifecycle ended, while provider cleanup and proof of destruction remain separately evidenced.",
    },
    {
      id: "escalated",
      meaning: "State is ambiguous or unsafe, so ownership moves to a human/support/SRE handoff.",
    },
  ]),
  recoveryModes: Object.freeze([
    {
      id: "resume",
      meaning: "Continue an interrupted teardown only after idempotency and dependency evidence are present.",
    },
    {
      id: "rollback",
      meaning: "Return to the last accepted product state using rollback evidence from deployment or upgrade records.",
    },
    {
      id: "restore-from-evidence",
      meaning: "Use an accepted backup/restore reference without implementing restore runtime in this issue.",
    },
    {
      id: "manual-escalation",
      meaning: "Route unresolved or unsafe states to named support/SRE/security owners.",
    },
  ]),
  requiredEvidence: Object.freeze([
    {
      id: "owner",
      owner: "Teardown & Recovery",
      proof: "Names tenant, workspace, project, environment, and accountable actor or owner.",
    },
    {
      id: "scope",
      owner: "Environment Lifecycle",
      proof: "Names project, environment, deployment, resource, and support-visible impact boundaries.",
    },
    {
      id: "last-known-state",
      owner: "Control Plane: Planner, Matching & Orchestrator",
      proof: "Records the latest accepted product, resource, and deployment state before teardown or recovery.",
    },
    {
      id: "dependency-drain",
      owner: "Control Plane: Planner, Matching & Orchestrator",
      proof: "Records dependents, active operations, leases, queues, traffic, or incidents that block teardown.",
    },
    {
      id: "backup-or-rollback-reference",
      owner: "Backup & Restore",
      proof: "Names restore point, rollback evidence, unsupported state, or explicit limitation before recovery claims.",
    },
    {
      id: "cleanup-handoff",
      owner: "Resource Garbage Collection",
      proof: "Records residual resources, orphan candidates, and cleanup eligibility evidence for later sweepers.",
    },
    {
      id: "support-handoff",
      owner: "Support Workflow",
      proof: "Records customer-safe explanation, limitation, escalation owner, and next action.",
    },
    {
      id: "policy-decision",
      owner: "Contracts, Policy & Governance",
      proof: "Records destructive-action approval, denial, hold, or manual escalation evidence.",
    },
  ]),
  designRefs: Object.freeze([
    "docs/design/control-plane.md#plan-04",
    "docs/design/reliability-observability-cost.md#plan-05",
    "docs/design/developer-experience.md#plan-07",
    "docs/design/platform-engineering.md#plan-25",
    "docs/design/environment-lifecycle.md",
    "docs/design/resource-garbage-collection.md",
    "docs/design/backup-restore.md",
    "docs/design/upgrade-migration-engine.md",
    "docs/design/support-sla-channels.md",
  ]),
  adrRefs: Object.freeze([
    "docs/design/adr/01-architecture-core.md#adr-0004",
    "docs/design/adr/01-architecture-core.md#adr-0006",
    "docs/design/adr/03-data-plane.md#adr-0058",
    "docs/design/adr/07-portability-extensibility.md#adr-0041",
    "docs/design/adr/02-identity-security.md#adr-0094",
  ]),
  initiativeDependencies: Object.freeze([
    {
      owner: "Teardown & Recovery",
      boundary:
        "Owns accepted state vocabulary, dependency drain evidence, recovery decision table, cleanup handoff, and M1 proof gate.",
    },
    {
      owner: "Environment Lifecycle",
      boundary:
        "Supplies environment state, owner, archive/delete/restore vocabulary, and support-safe lifecycle boundaries.",
    },
    {
      owner: "Resource Garbage Collection",
      boundary:
        "Owns orphan, residue, cleanup eligibility, policy-window, and sweeper handoff evidence.",
    },
    {
      owner: "Backup & Restore",
      boundary:
        "Owns restore points, RPO/RTO drill evidence, unsupported recovery states, and production restore limitations.",
    },
    {
      owner: "Upgrade & Migration Engine",
      boundary:
        "Owns upgrade rollback guidance, migration dry-run facts, compatibility blockers, and upgrade recovery evidence.",
    },
    {
      owner: "Support Workflow",
      boundary:
        "Owns support-safe routing, customer explanation, escalation, and ticket/SLA implementation outside this issue.",
    },
    {
      owner: "Control Plane: Planner, Matching & Orchestrator",
      boundary:
        "Owns ResourceActor state, dependency graph, compensation choreography, and future teardown execution.",
    },
    {
      owner: "Contracts, Policy & Governance",
      boundary:
        "Owns destructive-action authorization, deny ceilings, obligations, audit, and policy decision evidence.",
    },
  ]),
  m1Evidence: Object.freeze([
    {
      id: "teardown-state-schema",
      mode: "design-record",
      proves: "Teardown states, recovery modes, owner, scope, dependency, policy, cleanup, and support evidence fields are stable.",
    },
    {
      id: "dependency-drain-matrix",
      mode: "reference-fixture",
      proves: "Dependents, active operations, traffic, leases, incidents, and provider uncertainty block teardown until named evidence is present.",
    },
    {
      id: "recovery-decision-table",
      mode: "contract-test",
      proves: "Resume, rollback, restore-from-evidence, and manual escalation decisions are deterministic and proof-backed.",
    },
    {
      id: "cleanup-handoff-fixture",
      mode: "audit-fixture",
      proves: "Residual resources and orphan candidates route to Resource Garbage Collection instead of silent provider mutation.",
    },
    {
      id: "support-escalation-export",
      mode: "support-handoff",
      proves: "Support can export customer-safe state, limitation, owner, evidence gap, and next action.",
    },
    {
      id: "scope-boundary-register",
      mode: "policy-fixture",
      proves: "Provider deletes, runtime execution, restore services, billing, support tooling, and downstream issue creation route out.",
    },
  ]),
  followUpGate: Object.freeze({
    rule:
      "Create M1/M2/M3/M4 Teardown & Recovery design or implementation issues only after this M0 scope record and executable proof are accepted.",
  }),
});

export function canCreateTeardownRecoveryFollowUp({
  phase,
  m0Accepted,
}: {
  phase: string;
  m0Accepted: boolean;
}) {
  if (!IMPLEMENTATION_PHASES.has(phase)) {
    return {
      allowed: true,
      reason: "Phase does not depend on the M0 Teardown & Recovery gate.",
    };
  }

  if (m0Accepted) {
    return {
      allowed: true,
      reason: "M0 Teardown & Recovery scope and acceptance evidence has been accepted.",
    };
  }

  return {
    allowed: false,
    reason: "M1/M2/M3/M4 follow-up issues wait for accepted M0 Teardown & Recovery scope.",
  };
}

export function classifyTeardownRecoveryDecision(decision: JsonValue) {
  const text = String(decision ?? "").toLowerCase();

  if (/\b(provider adapter|provider delete|real azure|real aws|real gcp|live provider)\b/.test(text)) {
    return { owner: "Providers, IaC & Build Adapters", inScope: false };
  }

  if (/\b(backup restore|restore drill|rpo|rto|recovery readiness)\b/.test(text)) {
    return { owner: "Backup & Restore", inScope: false };
  }

  if (/\b(resource garbage|cleanup sweeper|orphan|residue)\b/.test(text)) {
    return { owner: "Resource Garbage Collection", inScope: false };
  }

  if (/\b(upgrade|migration|compatibility|rollback runner)\b/.test(text)) {
    return { owner: "Upgrade & Migration Engine", inScope: false };
  }

  if (/\b(support ticket|ticket queue|sla|helpdesk|customer notification)\b/.test(text)) {
    return { owner: "Support Workflow", inScope: false };
  }

  if (/\b(refunds?|invoices?|billing|payments?|tax|chargebacks?)\b/.test(text)) {
    return { owner: "Usage Metering", inScope: false };
  }

  if (/\b(policy engine|deny-ceiling|destructive authorization)\b/.test(text)) {
    return { owner: "Contracts, Policy & Governance", inScope: false };
  }

  return { owner: "Teardown & Recovery", inScope: true };
}

export function validateTeardownRecoveryScope(scope: {
  issue?: string;
  phase?: string;
  boundaries?: ReadonlyArray<{ id: string }>;
  m1Evidence?: ReadonlyArray<{ id: string }>;
  requiredEvidence?: ReadonlyArray<{ id: string }>;
  scopeIn?: ReadonlyArray<string>;
}) {
  const errors = [];

  if (scope.issue !== "HOBO-444") {
    errors.push("Scope record must be tied to HOBO-444.");
  }

  if (scope.phase !== "M0") {
    errors.push("Scope record must remain an M0 acceptance record.");
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

  for (const field of REQUIRED_EVIDENCE) {
    if (!scope.requiredEvidence?.some((entry) => entry.id === field)) {
      errors.push(`Missing required teardown/recovery evidence: ${field}.`);
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
