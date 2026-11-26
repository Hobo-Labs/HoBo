import { isJsonObject, type JsonValue } from "./json.js";
export type ChaosResiliencePhase = "M0" | "M1" | "M2" | "M3" | "M4";

export const REQUIRED_OPERATING_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

export const REQUIRED_M1_EVIDENCE = Object.freeze([
  "scope-record",
  "experiment-inventory",
  "steady-state-hypothesis-fixture",
  "fault-boundary-policy",
  "blast-radius-abort-evidence",
  "support-and-release-handoff",
]);

const IMPLEMENTATION_PHASES = new Set<ChaosResiliencePhase>(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "live chaos runner",
    pattern: /\b(live chaos runner|production fault|production chaos|provider adapter|provider mutation|fault injection)\b/i,
  },
  {
    label: "Golden Suite implementation",
    pattern: /\b(full Golden Suite|Golden Suite implementation|SLO computation engine|rollout adapter)\b/i,
  },
  {
    label: "SRE remediation",
    pattern: /\b(SRE remediation engine|incident workflow|runbook engine|postmortem workflow)\b/i,
  },
  {
    label: "dashboard UI",
    pattern: /\b(dashboard UI|status-page UI|React screen|product screen)\b/i,
  },
  {
    label: "support workflow",
    pattern: /\b(support queue|customer communication workflow|support ticket|SLA workflow)\b/i,
  },
  {
    label: "credential mutation",
    pattern: /\b(credential mutation|tenant data access|live customer traffic|policy bypass|destructive test)\b/i,
  },
]);

export const CHAOS_RESILIENCE_TESTS_SCOPE = {
  schema: "hobo.chaos-resilience-tests-scope/v1",
  issue: "HOBO-439",
  project: "Chaos & Resilience Tests",
  phase: "M0" as const,
  goal:
    "Define Chaos & Resilience Tests M0 scope so resilience owners can agree on controlled failure experiments, steady-state evidence, blast-radius boundaries, and follow-up proof gates before chaos execution work begins.",
  sourceRefs: [
    "Linear HOBO-439 issue body",
    "docs/patterns/chaos-engineering.md",
    "docs/design/reliability-observability-cost.md#plan-05",
    "docs/design/generated-stack.md#plan-09",
    "docs/design/operators-sre.md#plan-40",
    "docs/design/adr/02-identity-security.md#adr-0047",
    "docs/design/adr/02-identity-security.md#adr-0082",
  ],
  personas: [
    {
      id: "sre-operator",
      need: "Needs bounded chaos evidence that proves recovery behavior without surprising production or hiding abort conditions.",
    },
    {
      id: "release-owner",
      need: "Needs beta, release-candidate, and GA readiness signals that separate accepted resilience evidence from unrun experiments.",
    },
    {
      id: "platform-engineer",
      need: "Needs clear fixture, runtime-local, Camp, and provider-boundary requirements before building automation.",
    },
    {
      id: "security-lead",
      need: "Needs policy, tenant isolation, credential, and no-live-mutation boundaries for every fault-injection lane.",
    },
    {
      id: "support-operator",
      need: "Needs retained evidence, limitation notes, and owner handoffs when a resilience gap becomes customer-facing.",
    },
  ],
  scopeIn: [
    "Name the user/business goal and primary personas for Chaos & Resilience Tests.",
    "Record the M0 scope for steady-state hypotheses, failure injections, blast-radius controls, abort rules, evidence retention, and owner handoffs.",
    "Map service, UX, security, and support boundaries without implementing a chaos runner, fault injector, dashboard, or live provider lane.",
    "Map owning initiative dependencies for reliability, E2E testing, security verification, release cutline, support, and Operators/SRE.",
    "List M1 evidence required before design and contract proof issues can fan out.",
    "Record the follow-up gate that blocks M1/M2/M3/M4 chaos and resilience automation until this M0 scope is accepted.",
  ],
  scopeOut: [
    "No live chaos runner, production fault injection, provider mutation, Kubernetes CRD adapter, or external chaos engine integration.",
    "No full Golden Suite implementation, SLO computation engine, rollout adapter, SRE remediation engine, or incident workflow.",
    "No dashboard, status-page UI, support queue, customer communication workflow, or release go/no-go decision.",
    "No credential mutation, tenant data access, destructive test, live customer traffic, or policy bypass.",
    "No follow-up M1-M4 execution issue starts until HOBO-439 M0 acceptance is recorded.",
  ],
  nonGoals: [
    "Prove production resilience or authorize production chaos.",
    "Replace HOBO-329 Golden Suite chaos verification or Operators/SRE remediation work.",
    "Implement external fault primitives, provider adapters, dashboards, SLO engines, or support workflows.",
    "Create downstream automation issues before M0 scope acceptance.",
  ],
  operatingBoundaries: [
    {
      id: "service",
      owner: "Chaos & Resilience Tests",
      promise:
        "Owns accepted experiment scope, evidence fields, follow-up gate, and boundary vocabulary; runner and provider adapter implementation remain later work.",
    },
    {
      id: "ux",
      owner: "V1 Release Program & Cutline",
      promise:
        "Consumes evidence state for release readiness; dashboard screens and status-page publishing remain outside this M0 issue.",
    },
    {
      id: "security",
      owner: "Security Verification",
      promise:
        "Owns tenant isolation, policy gating, credential safety, and live-mutation refusal for fault-injection lanes.",
    },
    {
      id: "support",
      owner: "V1 Launch Support Desk & Escalation",
      promise:
        "Owns customer-safe limitation notes, evidence retention handoff, and escalation routing after a resilience gap is found.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Chaos & Resilience Tests",
      boundary: "Owns this M0 scope record, evidence checklist, and follow-up gate.",
    },
    {
      owner: "Reliability, Observability & Cost",
      boundary: "Owns SLO, error-budget, recovery, cost, and observability signal semantics consumed by experiments.",
    },
    {
      owner: "E2E Test Matrix",
      boundary: "Owns journey rows and deterministic fixtures that chaos scenarios may extend with failure evidence.",
    },
    {
      owner: "Security Verification",
      boundary: "Owns policy, tenant isolation, credential safety, and destructive-test refusal criteria.",
    },
    {
      owner: "V1 Release Program & Cutline",
      boundary: "Consumes resilience evidence, known gaps, and accepted limitations in release readiness decisions.",
    },
    {
      owner: "V1 Launch Support Desk & Escalation",
      boundary: "Owns support routing, customer-safe handoffs, and limitation wording when gaps are found.",
    },
    {
      owner: "Operators/SRE",
      boundary: "Owns later incident, runbook, remediation, and postmortem-by-replay execution paths.",
    },
  ],
  m1Evidence: [
    {
      id: "scope-record",
      owner: "Chaos & Resilience Tests",
      minimumProof: "Accepted design record, traceability row, and executable scope package for HOBO-439.",
    },
    {
      id: "experiment-inventory",
      owner: "Chaos & Resilience Tests",
      minimumProof: "Each scenario names hypothesis, injected fault, target, environment, owner, and release phase.",
    },
    {
      id: "steady-state-hypothesis-fixture",
      owner: "Reliability, Observability & Cost",
      minimumProof: "Fixture names SLO, metric source, baseline window, pass threshold, fail threshold, and observed evidence.",
    },
    {
      id: "fault-boundary-policy",
      owner: "Security Verification",
      minimumProof: "Policy fixture rejects live customer traffic, credential access, tenant leakage, and unapproved destructive faults.",
    },
    {
      id: "blast-radius-abort-evidence",
      owner: "Operators/SRE",
      minimumProof: "Contract fixture proves blast-radius limit, armed abort condition, cleanup obligation, and fail-closed state.",
    },
    {
      id: "support-and-release-handoff",
      owner: "V1 Launch Support Desk & Escalation",
      minimumProof: "Handoff records gap, owner, retained evidence, customer-safe wording, and release limitation state.",
    },
  ],
  followUpGate: {
    owner: "Chaos & Resilience Tests",
    rule: "M1-M4 follow-up issues may start only after HOBO-439 M0 scope acceptance is recorded.",
  },
} as const;

export function validateChaosResilienceScope(record: typeof CHAOS_RESILIENCE_TESTS_SCOPE) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["chaos resilience scope record is required"] };
  }
  if (record.issue !== "HOBO-439") errors.push("issue must be HOBO-439");
  if (record.phase !== "M0") errors.push("phase must be M0");
  if (!record.goal || !/Chaos & Resilience Tests/i.test(record.goal)) {
    errors.push("goal must name Chaos & Resilience Tests");
  }

  for (const section of ["personas", "scopeIn", "scopeOut", "nonGoals", "initiativeDependencies", "m1Evidence"] as const) {
    if (!Array.isArray(record[section]) || record[section].length === 0) {
      errors.push(`${section} must be a non-empty list`);
    }
  }

  const boundaryIds = new Set(record.operatingBoundaries?.map((boundary) => boundary.id) ?? []);
  for (const boundary of REQUIRED_OPERATING_BOUNDARIES) {
    if (!boundaryIds.has(boundary)) errors.push(`missing ${boundary} operating boundary`);
  }

  const evidenceIds = new Set(record.m1Evidence?.map((evidence) => evidence.id) ?? []);
  for (const evidence of REQUIRED_M1_EVIDENCE) {
    if (!evidenceIds.has(evidence)) errors.push(`missing ${evidence} M1 evidence`);
  }

  const scopedText = [...(record.scopeIn ?? [])].join("\n");
  for (const forbidden of FORBIDDEN_SCOPE_PATTERNS) {
    if (forbidden.pattern.test(scopedText)) {
      errors.push(`scope creep: ${forbidden.label}`);
    }
  }

  if (!record.followUpGate?.rule || !/M1-M4/.test(record.followUpGate.rule)) {
    errors.push("follow-up gate must block M1-M4 work until M0 acceptance");
  }

  return { ok: errors.length === 0, errors };
}

export function canStartChaosResilienceFollowUp({
  phase,
  m0Accepted,
}: {
  phase: ChaosResiliencePhase;
  m0Accepted: boolean;
}) {
  if (!IMPLEMENTATION_PHASES.has(phase)) return { allowed: true };
  if (m0Accepted) return { allowed: true };
  return {
    allowed: false,
    reason: "Chaos & Resilience Tests M1-M4 follow-up work is blocked until HOBO-439 M0 scope is accepted.",
  };
}

export interface ChaosResilienceClassification {
  owner: string;
  inScope: boolean;
}

export function classifyChaosResilienceRequest(request: JsonValue): ChaosResilienceClassification {
  const text = String(request ?? "").toLowerCase();

  if (/\bslo\b|\bburn\b|\bmetric\b|\bobservability\b|\bcapacity\b|\berror budget\b/.test(text)) {
    return { owner: "Reliability, Observability & Cost", inScope: false };
  }
  if (/\bcredential\b|\btenant\b|\bpolicy\b|\blive fault\b|\bdestructive\b/.test(text)) {
    return { owner: "Security Verification", inScope: false };
  }
  if (/\bsre\b|\brunbook\b|\bremediation\b|\bincident workflow\b|\bpostmortem\b/.test(text)) {
    return { owner: "Operators/SRE", inScope: false };
  }
  if (/\bsupport\b|\bcustomer\b|\bincident update\b|\bcommunication\b|\bsla\b/.test(text)) {
    return { owner: "V1 Launch Support Desk & Escalation", inScope: false };
  }

  return { owner: "Chaos & Resilience Tests", inScope: true };
}
