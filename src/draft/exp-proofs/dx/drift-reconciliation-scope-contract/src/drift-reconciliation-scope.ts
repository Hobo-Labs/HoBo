import { type JsonValue } from "./json.js";
const REQUIRED_M1_EVIDENCE = Object.freeze([
  "drift-report-schema",
  "source-of-truth-fixture",
  "reconciliation-decision-state-machine",
  "resourceactor-handoff-fixture",
  "garbage-collection-handoff",
  "support-export-contract",
  "scope-boundary-register",
]);

const REQUIRED_EVIDENCE = Object.freeze([
  "resource-identity",
  "desired-state-ref",
  "observed-state-ref",
  "source-of-truth",
  "last-refresh",
  "policy-decision",
  "support-handoff",
]);

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "provider",
    pattern:
      /\b(provider refresh scheduler|provider adapter|live provider api|live azure|live aws|live gcp|polls live)\b/i,
  },
  {
    label: "runtime",
    pattern:
      /\b(resourceactor reconcile|resourceactor runtime|reconcile command|change resourceactor|runtime behavior)\b/i,
  },
  {
    label: "remediation",
    pattern:
      /\b(autonomous remediation|auto remediation|self-heal|heal drift|mutates real cloud|mutate real cloud|real cloud resources)\b/i,
  },
  {
    label: "cleanup",
    pattern: /\b(garbage sweeper|destructive cleanup|live delete|destroy real|sweep live)\b/i,
  },
  {
    label: "support",
    pattern: /\b(support ticketing|support desk|ticket integration|incident automation)\b/i,
  },
  {
    label: "billing",
    pattern: /\b(invoice|billing|payment|tax|chargeback|usage adjustment)\b/i,
  },
]);

export const REQUIRED_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

export const DRIFT_RECONCILIATION_SCOPE = Object.freeze({
  issue: "HOBO-442",
  project: "Drift Reconciliation",
  phase: "M0",
  goal:
    "Define Drift Reconciliation scope and acceptance so HoBo has an accepted source of truth for observed drift, desired-state comparisons, reconciliation decisions, and owner handoffs before provider refresh, ResourceActor reconciliation, or autonomous remediation work begins.",
  personas: Object.freeze([
    {
      id: "platform-engineer",
      name: "Platform engineer",
      need: "Needs a deterministic vocabulary for comparing desired state, observed state, and the authority that wins when they diverge.",
    },
    {
      id: "sre-operator",
      name: "SRE operator",
      need: "Needs drift evidence, uncertainty, escalation, and recovery routing without hidden repair attempts.",
    },
    {
      id: "support-operator",
      name: "Support operator",
      need: "Needs customer-safe explanation fields for unresolved, ignored, or escalated drift.",
    },
    {
      id: "security-reviewer",
      name: "Security reviewer",
      need: "Needs reconciliation decisions to fail closed before any live mutation or destructive cleanup is authorized.",
    },
  ]),
  scopeIn: Object.freeze([
    "Define drift classes for observed state diffs, missing provider resources, extra provider resources, configuration divergence, adopted resource drift, and stale observations.",
    "Record reconciliation states from detected through classified, source-of-truth-pinned, proposed, reconciling, ignored, escalated, and resolved.",
    "Define required reconciliation evidence: resource identity, desired-state reference, observed-state reference, source of truth, last refresh, policy decision, and support handoff.",
    "Map service, UX, security, and support boundaries for drift report claims and reconciliation handoffs.",
    "List M1 evidence required before downstream drift schemas, state machines, ResourceActor handoffs, cleanup handoffs, or support exports can begin.",
  ]),
  scopeOut: Object.freeze([
    "No provider refresh scheduler, live provider API polling, provider adapter implementation, or cloud observation runtime.",
    "No ResourceActor runtime changes, reconcile command implementation, event-store projector, or production read model.",
    "No autonomous remediation, self-healing, real cloud mutation, or drift repair workflow.",
    "No garbage sweeper, destructive cleanup, support ticketing, billing adjustment, or customer notification implementation.",
    "No broad M1/M2/M3/M4 follow-up issue creation before this M0 scope record is accepted.",
  ]),
  nonGoals: Object.freeze([
    "Replace provider refresh, ResourceActor reconciliation, autonomous remediation, or Resource Garbage Collection.",
    "Treat an observed provider object as authoritative without recording source-of-truth and policy evidence.",
    "Hide stale observations, ambiguous ownership, or unsafe reconciliation behind a success state.",
    "Create implementation follow-ups before M0 acceptance evidence is approved.",
  ]),
  boundaries: Object.freeze([
    {
      id: "service",
      owner: "Drift Reconciliation",
      promise:
        "Owns drift vocabulary, evidence envelope, reconciliation states, and M1 proof expectations; runtime refresh and repair remain later work.",
    },
    {
      id: "ux",
      owner: "Deployment Dashboard & Topology Explorer",
      promise:
        "May surface drift status later, but this M0 record defines information architecture only, not screens.",
    },
    {
      id: "security",
      owner: "Contracts, Policy & Governance",
      promise:
        "Owns policy decisions, deny posture, and mutation authorization; this record names required handoffs.",
    },
    {
      id: "support",
      owner: "Support Workflow",
      promise:
        "Consumes customer-safe drift status, limitation, and escalation evidence without adding support tooling.",
    },
  ]),
  driftClasses: Object.freeze([
    {
      id: "observed-state-diff",
      definition:
        "Provider observation differs from the desired state or projected ResourceActor snapshot.",
    },
    {
      id: "missing-provider-resource",
      definition:
        "HoBo state expects a resource, but provider observation cannot find a matching object.",
    },
    {
      id: "extra-provider-resource",
      definition:
        "Provider observation sees an object that HoBo state does not currently own or expect.",
    },
    {
      id: "configuration-divergence",
      definition:
        "The object exists, but material configuration differs from desired or accepted state.",
    },
    {
      id: "adopted-resource-drift",
      definition:
        "An imported or adopted resource diverges from its accepted ownership or configuration envelope.",
    },
    {
      id: "stale-observation",
      definition:
        "The latest observation is too old, partial, or conflicted to support a reconciliation decision.",
    },
  ]),
  reconciliationStates: Object.freeze([
    {
      id: "detected",
      meaning: "A signal indicates possible drift, but classification and authority are incomplete.",
    },
    {
      id: "classified",
      meaning: "Drift class, identity, and observed/desired references are recorded.",
    },
    {
      id: "source-of-truth-pinned",
      meaning: "The authoritative state source for the decision is explicitly named.",
    },
    {
      id: "proposed",
      meaning: "A later reconcile action is proposed but not yet authorized or applied.",
    },
    {
      id: "reconciling",
      meaning: "Later implementation work is executing an authorized reconcile path.",
    },
    {
      id: "ignored",
      meaning: "The diff is accepted as intentional or non-actionable with evidence.",
    },
    {
      id: "escalated",
      meaning: "Evidence is ambiguous or unsafe, so SRE/support/security handoff is required.",
    },
    {
      id: "resolved",
      meaning: "A later observation verifies that the drift decision no longer requires action.",
    },
  ]),
  requiredEvidence: Object.freeze([
    {
      id: "resource-identity",
      owner: "Control Plane",
      proof: "Records provider-neutral identity, provider object reference, and ownership context.",
    },
    {
      id: "desired-state-ref",
      owner: "Control Plane",
      proof: "Names the desired set, ResourceActor snapshot, manifest, or event-derived target.",
    },
    {
      id: "observed-state-ref",
      owner: "Providers, IaC & Build Adapters",
      proof: "Names the provider refresh report, observation timestamp, and source fixture.",
    },
    {
      id: "source-of-truth",
      owner: "Drift Reconciliation",
      proof: "Names whether desired state, provider observation, event log, support evidence, or policy wins.",
    },
    {
      id: "last-refresh",
      owner: "Reliability, Observability & Cost",
      proof: "Records the refresh age, freshness posture, and stale-observation uncertainty.",
    },
    {
      id: "policy-decision",
      owner: "Contracts, Policy & Governance",
      proof: "Records fail-closed allowed, denied, delayed, ignored, or escalated reconciliation posture.",
    },
    {
      id: "support-handoff",
      owner: "Support Workflow",
      proof: "Records customer-safe status, limitation, evidence gap, and escalation owner.",
    },
  ]),
  designRefs: Object.freeze([
    "docs/design/control-plane.md#plan-04",
    "docs/design/reliability-observability-cost.md#plan-05",
    "docs/design/operators-sre.md#plan-40",
    "docs/design/contracts-policy-flags.md#plan-29",
    "docs/design/resource-garbage-collection.md",
    "docs/design/support-sla-channels.md",
  ]),
  adrRefs: Object.freeze([
    "docs/design/adr/01-architecture-core.md#adr-0004",
    "docs/design/adr/01-architecture-core.md#adr-0006",
    "docs/design/adr/03-data-plane.md#adr-0058",
    "docs/design/adr/02-identity-security.md#adr-0094",
    "docs/design/adr/07-portability-extensibility.md#adr-0041",
  ]),
  initiativeDependencies: Object.freeze([
    {
      owner: "Control Plane: Planner, Matching & Orchestrator",
      boundary:
        "Owns ResourceActor state, desired-set snapshots, reconciliation command semantics, and later runtime application.",
    },
    {
      owner: "Providers, IaC & Build Adapters",
      boundary:
        "Owns provider refresh, live API observation, import semantics, and adapter-specific drift evidence.",
    },
    {
      owner: "Resource Garbage Collection",
      boundary:
        "Consumes extra or missing provider-resource evidence for garbage eligibility without owning drift classification.",
    },
    {
      owner: "Contracts, Policy & Governance",
      boundary:
        "Owns deny ceilings, policy decisions, mutation authorization, and audit obligations.",
    },
    {
      owner: "Operators & SRE Crew",
      boundary:
        "Owns operational triage and escalation when drift evidence is stale, ambiguous, or unsafe.",
    },
    {
      owner: "Support Workflow",
      boundary:
        "Owns customer-safe explanation, unresolved-drift handoff, and support routing later.",
    },
  ]),
  m1Evidence: Object.freeze([
    {
      id: "drift-report-schema",
      mode: "design-record",
      proves: "Drift class, reconciliation state, identity, desired/observed refs, and evidence fields are stable.",
    },
    {
      id: "source-of-truth-fixture",
      mode: "reference-fixture",
      proves: "Conflicting desired, observed, support, policy, and event evidence resolves deterministically.",
    },
    {
      id: "reconciliation-decision-state-machine",
      mode: "contract-test",
      proves: "Detected, classified, source-of-truth-pinned, proposed, reconciling, ignored, escalated, and resolved transitions are bounded.",
    },
    {
      id: "resourceactor-handoff-fixture",
      mode: "consumer-contract",
      proves: "ResourceActor receives only parsed drift decisions and keeps runtime reconcile behavior out of M0.",
    },
    {
      id: "garbage-collection-handoff",
      mode: "integration-fixture",
      proves: "Extra or missing provider resources hand off to cleanup eligibility without destructive action.",
    },
    {
      id: "support-export-contract",
      mode: "support-handoff",
      proves: "Support can explain drift status, limitation, evidence gap, and escalation path.",
    },
    {
      id: "scope-boundary-register",
      mode: "audit-fixture",
      proves: "Provider refresh, ResourceActor runtime, remediation, cleanup, support ticketing, and billing are routed out.",
    },
  ]),
  followUpGate: Object.freeze({
    rule:
      "Create M1/M2/M3/M4 Drift Reconciliation design or implementation issues only after this M0 scope record and executable proof are accepted.",
  }),
});

export function canCreateDriftReconciliationFollowUp({
  phase,
  m0Accepted,
}: {
  phase: string;
  m0Accepted: boolean;
}) {
  if (!IMPLEMENTATION_PHASES.has(phase)) {
    return {
      allowed: true,
      reason: "Phase does not depend on the M0 Drift Reconciliation gate.",
    };
  }

  if (m0Accepted) {
    return {
      allowed: true,
      reason: "M0 Drift Reconciliation scope and acceptance evidence has been accepted.",
    };
  }

  return {
    allowed: false,
    reason: "M1/M2/M3/M4 follow-up issues wait for accepted M0 Drift Reconciliation scope.",
  };
}

export function classifyDriftReconciliationDecision(decision: JsonValue) {
  const text = String(decision ?? "").toLowerCase();

  if (/\b(provider refresh|provider adapter|live azure|live aws|live gcp|live api)\b/.test(text)) {
    return { owner: "Providers, IaC & Build Adapters", inScope: false };
  }

  if (/\b(resourceactor|reconcile command|desired set|runtime apply)\b/.test(text)) {
    return { owner: "Control Plane: Planner, Matching & Orchestrator", inScope: false };
  }

  if (/\b(garbage eligibility|garbage collection|cleanup eligibility|orphan cleanup)\b/.test(text)) {
    return { owner: "Resource Garbage Collection", inScope: false };
  }

  if (/\b(support ticket|support workflow|customer escalation|support escalation)\b/.test(text)) {
    return { owner: "Support Workflow", inScope: false };
  }

  if (/\b(billing|invoice|payment|tax|chargeback|usage adjustment)\b/.test(text)) {
    return { owner: "Usage Metering", inScope: false };
  }

  return { owner: "Drift Reconciliation", inScope: true };
}

export function validateDriftReconciliationScope(scope: {
  issue?: string;
  phase?: string;
  boundaries?: ReadonlyArray<{ id: string }>;
  m1Evidence?: ReadonlyArray<{ id: string }>;
  requiredEvidence?: ReadonlyArray<{ id: string }>;
  scopeIn?: ReadonlyArray<string>;
}) {
  const errors = [];

  if (scope.issue !== "HOBO-442") {
    errors.push("Scope record must be tied to HOBO-442.");
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
      errors.push(`Missing required drift evidence: ${field}.`);
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
