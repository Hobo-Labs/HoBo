import { isJsonObject } from "./json.js";
export const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"];

const FOLLOW_UP_PHASES = new Set(["M1", "M2", "M3", "M4"]);
const VALID_PROOF_MODES = new Set([
  "design-record",
  "contract-test",
  "reference-fixture",
  "release-handoff",
  "support-handoff",
  "security-review",
]);

const FORBIDDEN_SCOPE_PATTERNS = [
  /load runner/i,
  /stress test/i,
  /benchmark lab/i,
  /live provider/i,
  /real cloud/i,
  /production load/i,
  /autoscaling implementation/i,
  /chaos experiment/i,
  /final .*launch decision/i,
  /GA launch decision/i,
];

const REQUIRED_DEPENDENCIES = [
  "docs/design/reliability-observability-cost.md#plan-05",
  "docs/design/e2e-test-matrix.md",
  "docs/design/launch-e2e-persona-matrix.md",
  "docs/design/pre-launch-outcome-contract.md",
  "docs/design/adr/02-identity-security.md#adr-0045",
  "docs/design/adr/02-identity-security.md#adr-0082",
];

export const PERFORMANCE_LOAD_TESTS_SCOPE = {
  issue: "HOBO-440",
  project: "Performance & Load Tests",
  phase: "M0",
  goal:
    "Define Performance & Load Tests productization scope so launch-readiness checks have accepted workload scenarios, capacity evidence, thresholds, ownership, and follow-up gates before design/build issues fan out.",
  personas: [
    {
      role: "release owner",
      need: "Know which performance evidence gates beta, release-candidate, and GA readiness and which gaps block launch claims.",
    },
    {
      role: "platform engineer",
      need: "Understand workload models, fixture boundaries, and capacity envelopes before building load-test automation.",
    },
    {
      role: "sre operator",
      need: "Map latency, saturation, SLO burn, abort, and rollback evidence into operational launch decisions.",
    },
    {
      role: "finops reviewer",
      need: "See expected-load and capacity assumptions without turning this M0 issue into cost-routing or billing work.",
    },
    {
      role: "support operator",
      need: "Receive retained evidence, limitation notes, and owner handoffs for performance incidents and customer questions.",
    },
  ],
  scopeIn: [
    "Define the M0 Performance & Load Tests product scope, accepted personas, and launch-readiness goal.",
    "Define mandatory scenario dimensions: journey, workload model, expected load, environment, fixture data, mocked/live boundary, measured signal, capacity envelope, pass threshold, fail threshold, abort rule, owner, and release phase.",
    "Define service, UX, security, and support boundaries for performance evidence without building the load-test execution system.",
    "Define M1-ready evidence for scenario inventory, workload model fixture, capacity envelope schema, threshold and abort policy, and evidence retention/support handoff.",
    "Define follow-up gate rules so M1/M2/M3/M4 performance automation, CI lanes, provider exercises, SLO tuning, and support artifacts wait for accepted M0 scope.",
  ],
  scopeOut: [
    "No load runner, benchmark lab, browser performance lab, or CI execution lane implementation.",
    "No live provider stress test, real cloud mutation, production load, or autoscaling implementation.",
    "No chaos experiment orchestration, resilience drill execution, or full Golden Suite implementation.",
    "No final beta, release-candidate, or GA launch decision.",
    "No provider pricing, billing, Dispatcher/CreditLedger routing, or entitlement enforcement.",
    "No automatic creation of downstream M1-M4 implementation issues before M0 acceptance.",
  ],
  nonGoals: [
    "Replace the E2E Test Matrix or its launch persona journeys.",
    "Ratify production SLO targets beyond the existing ADR-0045 SLO-as-code boundary.",
    "Build observability pipelines, load generators, dashboards, or support tooling.",
    "Claim customer-visible capacity without accepted fixture or live-provider evidence.",
  ],
  boundaries: {
    service:
      "Performance & Load Tests defines accepted scenarios, workload models, thresholds, evidence fields, and owners; service teams own the later runner, CI lane, provider fixtures, and persistence.",
    ux:
      "UX scope is limited to evidence fields needed by launch status, plan review, and diagnostics; product screens, dashboards, and visual performance reports are outside M0.",
    security:
      "Performance evidence must preserve tenant isolation, redaction, safe synthetic data, and no-secret load logs; scanners, policy gates, and vulnerability handling stay in Security Verification.",
    support:
      "Support receives retained run evidence, limitation notes, abort reasons, and owner handoffs; ticket routing, SLA promises, and incident communication execution remain separate.",
  },
  dependencies: [
    {
      source: "docs/design/reliability-observability-cost.md#plan-05",
      reason: "Defines SLOs, error-budget gates, observability signals, capacity targets, and cost visibility consumed by performance evidence.",
    },
    {
      source: "docs/design/e2e-test-matrix.md",
      reason: "Defines launch journey rows and fixture boundaries that performance scenarios extend with expected-load evidence.",
    },
    {
      source: "docs/design/launch-e2e-persona-matrix.md",
      reason: "Defines persona journey thresholds that later performance rows must not silently weaken or override.",
    },
    {
      source: "docs/design/pre-launch-outcome-contract.md",
      reason: "Defines outcome and safe-test evidence that performance/load claims compare against before launch.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0045",
      reason: "Pins SLO-as-code and error-budget gating as the reliability contract behind performance thresholds.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0082",
      reason: "Pins Golden Suites and A2H handoff so load evidence can fail closed without becoming a launch bypass.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Performance & Load Tests",
      consumes: "Owns accepted scenario dimensions, capacity evidence checklist, threshold policy, and follow-up gate.",
      scopeBoundary: "This issue defines scope and acceptance; it does not build the performance runner.",
    },
    {
      owner: "E2E Test Matrix",
      consumes: "Provides journey, persona, fixture, mocked/live boundary, owner, and release-phase rows.",
      scopeBoundary: "E2E journey inventory remains the owner of end-to-end row coverage.",
    },
    {
      owner: "V1 Release Program & Cutline",
      consumes: "Uses performance evidence state, known gaps, and accepted limitations in beta/RC/GA decisions.",
      scopeBoundary: "Release go/no-go and accepted-risk workflows remain release-program scope.",
    },
    {
      owner: "Reliability, Observability & Cost",
      consumes: "Provides SLO, latency, saturation, burn-rate, and capacity signal semantics.",
      scopeBoundary: "Telemetry pipelines, SLO computation engines, budgets, and alerting stay in reliability/FinOps scope.",
    },
    {
      owner: "Support Workflow",
      consumes: "Uses retained evidence, abort reasons, and owner handoffs for performance incidents and customer questions.",
      scopeBoundary: "Support queues, SLA commitments, escalation, and customer communication execution stay in Support Workflow.",
    },
    {
      owner: "Security Verification",
      consumes: "Reviews safe synthetic data, tenant isolation, redaction, and secret-free evidence requirements.",
      scopeBoundary: "Security scanners, policy engines, and vulnerability handling stay in Security Verification.",
    },
  ],
  scenarioDimensions: [
    "journey",
    "workloadModel",
    "expectedLoad",
    "environment",
    "fixtureData",
    "mockedLiveBoundary",
    "measuredSignal",
    "capacityEnvelope",
    "passThreshold",
    "failThreshold",
    "abortRule",
    "owner",
    "releasePhase",
  ],
  m1Evidence: [
    {
      kind: "scenario-inventory",
      owner: "Performance & Load Tests",
      proofMode: "design-record",
      source: "docs/design/performance-load-tests.md#required-scenario-dimensions",
      proves: "Every launch-relevant journey names expected load, measured signal, thresholds, owner, and release phase.",
    },
    {
      kind: "workload-model-fixture",
      owner: "Platform engineering",
      proofMode: "reference-fixture",
      source: "docs/design/performance-load-tests.md#evidence-required-for-m1",
      proves: "Synthetic workload inputs are deterministic, tenant-safe, and explicit about mocked/live boundaries.",
    },
    {
      kind: "capacity-envelope-schema",
      owner: "SRE operator",
      proofMode: "contract-test",
      source: "docs/design/performance-load-tests.md#evidence-required-for-m1",
      proves: "Capacity evidence has stable fields for load, duration, saturation, latency, error budget, and abort state.",
    },
    {
      kind: "threshold-and-abort-policy",
      owner: "Reliability, Observability & Cost",
      proofMode: "contract-test",
      source: "docs/design/performance-load-tests.md#service-ux-security-and-support-boundaries",
      proves: "Threshold breaches fail closed, preserve raw evidence, and route to owner review instead of silent pass.",
    },
    {
      kind: "evidence-retention-and-support-handoff",
      owner: "Support Workflow",
      proofMode: "support-handoff",
      source: "docs/design/performance-load-tests.md#owning-initiative-dependencies",
      proves: "Support can explain load-test state, limitations, and next owner without owning the runner implementation.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 performance automation, CI lanes, provider exercises, SLO tuning, capacity dashboard, and support follow-ups must wait for this accepted M0 scope.",
  },
};

export function canCreatePerformanceLoadFollowUp({ phase, m0Accepted }) {
  return Boolean(m0Accepted) && FOLLOW_UP_PHASES.has(phase);
}

export function classifyPerformanceEvidenceGap(gap) {
  const text = gap ?? "";

  if (/journey|expected-load|persona|fixture row|matrix/i.test(text)) {
    return "E2E Test Matrix";
  }
  if (/slo|burn|latency|saturation|capacity|threshold|availability|observability/i.test(text)) {
    return "Reliability, Observability & Cost";
  }
  if (/support|retention|handoff|customer question|limitation/i.test(text)) {
    return "Support Workflow";
  }
  if (/secret|tenant|redaction|synthetic|isolation|security/i.test(text)) {
    return "Security Verification";
  }
  if (/release|cutline|beta|ga|rc|launch decision/i.test(text)) {
    return "V1 Release Program & Cutline";
  }

  return "Performance & Load Tests";
}

export function validatePerformanceLoadTestsScope(scope) {
  const errors = [];

  if (!scope || !isJsonObject(scope)) {
    return { ok: false, errors: ["scope record is required"] };
  }
  if (scope.issue !== "HOBO-440") {
    errors.push("issue must be HOBO-440");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!scope.goal?.includes("Performance & Load Tests")) {
    errors.push("goal must name Performance & Load Tests");
  }

  for (const collection of ["personas", "scopeIn", "scopeOut", "nonGoals", "dependencies", "initiativeDependencies", "m1Evidence"]) {
    if (!Array.isArray(scope[collection]) || scope[collection].length === 0) {
      errors.push(`${collection} must be a non-empty list`);
    }
  }
  if ((scope.personas ?? []).length < 5) {
    errors.push("at least five personas are required");
  }
  if ((scope.scopeIn ?? []).length < 5) {
    errors.push("scope in must have at least five entries");
  }
  if ((scope.scopeOut ?? []).length < 5) {
    errors.push("scope out must have at least five entries");
  }
  if ((scope.nonGoals ?? []).length < 3) {
    errors.push("non-goals must have at least three entries");
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
    errors.push("design dependencies must map to reliability, e2e, launch persona, outcome, SLO, and Golden Suite sources");
  }

  for (const dependency of scope.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
    }
  }
  for (const dimension of ["journey", "workloadModel", "expectedLoad", "capacityEnvelope", "passThreshold", "failThreshold", "owner"]) {
    if (!(scope.scenarioDimensions ?? []).includes(dimension)) {
      errors.push(`required scenario dimension missing: ${dimension}`);
    }
  }
  for (const evidence of scope.m1Evidence ?? []) {
    if (!evidence.owner || !evidence.proves || !evidence.source) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must name owner, source, and proof`);
    }
    if (!VALID_PROOF_MODES.has(evidence.proofMode)) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must declare a valid proof mode`);
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
