import { type JsonValue } from "./json.js";
const REQUIRED_M1_EVIDENCE = Object.freeze([
  "garbage-inventory-schema",
  "cleanup-eligibility-state-machine",
  "drift-orphan-handoff",
  "policy-retention-window-fixture",
  "support-escalation-export",
  "scope-boundary-register",
]);

const REQUIRED_EVIDENCE = Object.freeze([
  "owner",
  "resource-identity",
  "source-of-truth",
  "last-observed",
  "eligibility-decision",
  "policy-window",
  "support-handoff",
]);

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "provider",
    pattern: /\b(provider adapter|provider sweeper|cloud delete|live cloud|real azure|real aws|real gcp)\b/i,
  },
  {
    label: "runtime",
    pattern:
      /\b(production cleanup daemon|cleanup daemon|mutate real resource|live delete|destroy real|sweep live)\b/i,
  },
  {
    label: "retention",
    pattern: /\b(legal retention|data retention policy|customer data deletion|records retention)\b/i,
  },
  {
    label: "billing",
    pattern: /\b(invoice|billing|payment|tax|chargeback|subscription)\b/i,
  },
  {
    label: "drift",
    pattern: /\b(replace drift|build drift detection|implement drift refresh|refresh loop runtime)\b/i,
  },
]);

export const REQUIRED_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

export const RESOURCE_GARBAGE_COLLECTION_SCOPE = Object.freeze({
  issue: "HOBO-443",
  project: "Resource Garbage Collection",
  phase: "M0",
  goal:
    "Define Resource Garbage Collection scope and acceptance so HoBo has an accepted safe cleanup boundary for orphan inventory, cleanup eligibility, and support handoff before any live sweeper or provider adapter work begins.",
  personas: Object.freeze([
    {
      id: "platform-engineer",
      name: "Platform engineer",
      need: "Needs a deterministic cleanup model that distinguishes safe cleanup evidence from provider mutation work.",
    },
    {
      id: "sre-operator",
      name: "SRE operator",
      need: "Needs drift, rollback, and residue signals routed to cleanup without hiding uncertainty or racing active deploys.",
    },
    {
      id: "support-operator",
      name: "Support operator",
      need: "Needs customer-safe owner, state, limitation, and escalation evidence for unreclaimed resources.",
    },
    {
      id: "security-reviewer",
      name: "Security reviewer",
      need: "Needs fail-closed cleanup eligibility and retention boundaries before any destructive action is allowed.",
    },
  ]),
  scopeIn: Object.freeze([
    "Define garbage classes for created-but-not-in-state objects, destroyed-in-state-but-live resources, deprecated generated artifacts, expired preview resources, and failed-cleanup residue.",
    "Record cleanup states from suspected through inventoried, quarantined, eligible, swept, and escalated.",
    "Define required orphan inventory evidence: owner, resource identity, source of truth, last observed timestamp, eligibility decision, policy window, and support handoff.",
    "Map service, UX, security, and support boundaries for safe cleanup claims.",
    "List M1 evidence required before downstream cleanup schema, eligibility, policy, drift handoff, and support work can begin.",
  ]),
  scopeOut: Object.freeze([
    "No provider adapter sweepers, real cloud deletes, production cleanup daemon, or live resource mutation.",
    "No replacement for drift detection, ResourceActor reconciliation, partial-apply compensation, or provider refresh fidelity.",
    "No legal retention policy, customer data deletion policy, billing, chargeback, or tax behavior.",
    "No support desk workflow, ticketing integration, incident automation, or customer notification implementation.",
    "No broad backlog migration or M1-M4 issue creation before this M0 scope record is accepted.",
  ]),
  nonGoals: Object.freeze([
    "Replace drift detection, orphan-sweep, rollback compensation, or ResourceActor runtime contracts.",
    "Make suspected garbage automatically safe to delete without policy-window and owner evidence.",
    "Treat absence from state as proof that a provider object is safe to destroy.",
    "Create implementation follow-ups before M0 acceptance evidence is approved.",
  ]),
  boundaries: Object.freeze([
    {
      id: "service",
      owner: "Resource Garbage Collection",
      promise:
        "Owns cleanup vocabulary, inventory evidence, eligibility states, and M1 proof expectations; live sweep execution is later work.",
    },
    {
      id: "ux",
      owner: "Deployment Dashboard & Topology Explorer",
      promise:
        "May surface cleanup state later, but this M0 record defines information architecture only, not screens.",
    },
    {
      id: "security",
      owner: "Contracts, Policy & Governance",
      promise:
        "Owns destructive-action policy, retention windows, and fail-closed authorization; this record names required handoffs.",
    },
    {
      id: "support",
      owner: "Support Workflow",
      promise:
        "Consumes support-safe cleanup state, owner, limitation, and escalation evidence without adding support tooling.",
    },
  ]),
  garbageClasses: Object.freeze([
    {
      id: "created-but-not-in-state",
      definition:
        "Provider object created before state was recorded, usually from partial-apply or rollback windows.",
    },
    {
      id: "destroyed-in-state-but-live",
      definition:
        "State says destroyed or absent while provider refresh or support evidence still observes a live object.",
    },
    {
      id: "deprecated-generated-artifact",
      definition:
        "Generated artifact or pack retained past its active version window and awaiting retention-safe cleanup.",
    },
    {
      id: "expired-preview-resource",
      definition:
        "Preview or fork-lane resource whose declared lifetime ended but whose owner evidence must still be checked.",
    },
    {
      id: "failed-cleanup-residue",
      definition:
        "Residue from an interrupted cleanup, rollback, or teardown pass that requires resumable evidence.",
    },
  ]),
  cleanupStates: Object.freeze([
    {
      id: "suspected",
      meaning: "A signal suggests possible garbage, but owner and source-of-truth evidence are incomplete.",
    },
    {
      id: "inventoried",
      meaning: "Identity, owner, source-of-truth, and last-observed evidence are recorded.",
    },
    {
      id: "quarantined",
      meaning: "Cleanup is intentionally delayed while policy windows or active deploy conflicts are resolved.",
    },
    {
      id: "eligible",
      meaning: "Policy, owner, support, and source evidence allow a later sweeper to act.",
    },
    {
      id: "swept",
      meaning: "Cleanup result was observed and recorded by later implementation work.",
    },
    {
      id: "escalated",
      meaning: "Evidence is ambiguous or unsafe, so a human/support/SRE handoff is required.",
    },
  ]),
  requiredEvidence: Object.freeze([
    {
      id: "owner",
      owner: "Resource Garbage Collection",
      proof: "Names tenant, project, deployment, actor, or support owner responsible for the item.",
    },
    {
      id: "resource-identity",
      owner: "Control Plane",
      proof: "Records provider-neutral resource identity and provider object reference without deriving authority from aliases.",
    },
    {
      id: "source-of-truth",
      owner: "Drift Reconciliation",
      proof: "Names whether state store, event log, provider refresh, or support evidence is authoritative for the decision.",
    },
    {
      id: "last-observed",
      owner: "Reliability, Observability & Cost",
      proof: "Records when and by which probe/refresh/support source the item was observed.",
    },
    {
      id: "eligibility-decision",
      owner: "Contracts, Policy & Governance",
      proof: "Records fail-closed allowed, delayed, denied, or escalated cleanup posture.",
    },
    {
      id: "policy-window",
      owner: "Security & Governance",
      proof: "Records retention, active-deploy, incident, support, and rollback windows that block destructive action.",
    },
    {
      id: "support-handoff",
      owner: "Support Workflow",
      proof: "Records customer-safe explanation, limitation, escalation owner, and unresolved evidence gap.",
    },
  ]),
  designRefs: Object.freeze([
    "docs/design/control-plane.md#plan-04",
    "docs/design/reliability-observability-cost.md#plan-05",
    "docs/design/operators-sre.md#plan-40",
    "docs/design/developer-experience.md#plan-07",
    "docs/design/contracts-policy-flags.md#plan-29",
    "docs/design/support-sla-channels.md",
  ]),
  adrRefs: Object.freeze([
    "docs/design/adr/01-architecture-core.md#adr-0006",
    "docs/design/adr/01-architecture-core.md#adr-0004",
    "docs/design/adr/03-data-plane.md#adr-0058",
    "docs/design/adr/02-identity-security.md#adr-0094",
    "docs/design/adr/07-portability-extensibility.md#adr-0041",
  ]),
  initiativeDependencies: Object.freeze([
    {
      owner: "Drift Reconciliation",
      boundary:
        "Supplies drift report, source-of-truth, and observed-state signals; Resource Garbage Collection only records cleanup eligibility boundaries.",
    },
    {
      owner: "Control Plane: Planner, Matching & Orchestrator",
      boundary:
        "Owns ResourceActor state, deployment identity, and rollback/compensation events consumed by cleanup evidence.",
    },
    {
      owner: "Providers, IaC & Build Adapters",
      boundary:
        "Owns provider refresh, adapter delete semantics, and future live sweeper execution.",
    },
    {
      owner: "Contracts, Policy & Governance",
      boundary:
        "Owns destructive-action policy gates, retention windows, deny-ceilings, and audit obligations.",
    },
    {
      owner: "Deployment Dashboard & Topology Explorer",
      boundary:
        "Owns future customer/operator visibility over cleanup state without taking destructive-action authority.",
    },
    {
      owner: "Support Workflow",
      boundary:
        "Owns support-safe explanations, ticket routing, customer handoff, and unresolved-garbage escalation later.",
    },
  ]),
  m1Evidence: Object.freeze([
    {
      id: "garbage-inventory-schema",
      mode: "design-record",
      proves: "Garbage class, cleanup state, identity, owner, and evidence fields are stable.",
    },
    {
      id: "cleanup-eligibility-state-machine",
      mode: "contract-test",
      proves: "Suspected, inventoried, quarantined, eligible, swept, and escalated states transition deterministically.",
    },
    {
      id: "drift-orphan-handoff",
      mode: "reference-fixture",
      proves: "Drift/orphan/rollback evidence is consumed without implementing drift detection or provider sweepers.",
    },
    {
      id: "policy-retention-window-fixture",
      mode: "policy-fixture",
      proves: "Cleanup fails closed while policy, incident, support, active-deploy, or retention windows are unresolved.",
    },
    {
      id: "support-escalation-export",
      mode: "support-handoff",
      proves: "Support can explain owner, state, risk, limitation, evidence gap, and escalation path.",
    },
    {
      id: "scope-boundary-register",
      mode: "audit-fixture",
      proves: "Provider adapters, live deletes, retention law, billing, drift runtime, and support tooling are routed out.",
    },
  ]),
  followUpGate: Object.freeze({
    rule:
      "Create M1/M2/M3/M4 Resource Garbage Collection design or implementation issues only after this M0 scope record and executable proof are accepted.",
  }),
});

export function canCreateResourceGarbageCollectionFollowUp({
  phase,
  m0Accepted,
}: {
  phase: string;
  m0Accepted: boolean;
}) {
  if (!IMPLEMENTATION_PHASES.has(phase)) {
    return {
      allowed: true,
      reason: "Phase does not depend on the M0 Resource Garbage Collection gate.",
    };
  }

  if (m0Accepted) {
    return {
      allowed: true,
      reason: "M0 Resource Garbage Collection scope and acceptance evidence has been accepted.",
    };
  }

  return {
    allowed: false,
    reason: "M1/M2/M3/M4 follow-up issues wait for accepted M0 Resource Garbage Collection scope.",
  };
}

export function classifyResourceGarbageCollectionDecision(decision: JsonValue) {
  const text = String(decision ?? "").toLowerCase();

  if (/\b(provider adapter|provider sweeper|real azure|real aws|real gcp|live cloud)\b/.test(text)) {
    return { owner: "Providers, IaC & Build Adapters", inScope: false };
  }

  if (/\b(drift detection|drift refresh|refresh loop|drift report)\b/.test(text)) {
    return { owner: "Drift Reconciliation", inScope: false };
  }

  if (/\b(support ticket|support workflow|customer escalation|support escalation)\b/.test(text)) {
    return { owner: "Support Workflow", inScope: false };
  }

  if (/\b(billing|invoice|payment|tax|chargeback|usage reconciliation)\b/.test(text)) {
    return { owner: "Usage Metering", inScope: false };
  }

  if (/\b(policy engine|retention law|deny-ceiling|destructive authorization)\b/.test(text)) {
    return { owner: "Contracts, Policy & Governance", inScope: false };
  }

  return { owner: "Resource Garbage Collection", inScope: true };
}

export function validateResourceGarbageCollectionScope(scope: {
  issue?: string;
  phase?: string;
  boundaries?: ReadonlyArray<{ id: string }>;
  m1Evidence?: ReadonlyArray<{ id: string }>;
  requiredEvidence?: ReadonlyArray<{ id: string }>;
  scopeIn?: ReadonlyArray<string>;
}) {
  const errors = [];

  if (scope.issue !== "HOBO-443") {
    errors.push("Scope record must be tied to HOBO-443.");
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
      errors.push(`Missing required cleanup evidence: ${field}.`);
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
