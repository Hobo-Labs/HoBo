const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"];
const VALID_PROOF_MODES = new Set([
  "design-record",
  "contract-test",
  "reference-fixture",
  "support-handoff",
]);
const FOLLOW_UP_PHASES = new Set(["M1", "M2", "M3", "M4"]);
const FORBIDDEN_SCOPE_PATTERNS = [
  /production dashboard/i,
  /apply the plan/i,
  /live provider/i,
  /provider credential/i,
  /planner implementation/i,
  /provisioner/i,
];

export const PLAN_DIFF_VIEWER_SCOPE = {
  issue: "HOBO-411",
  project: "Plan/Diff Viewer",
  phase: "M0",
  goal:
    "Define the Plan/Diff Viewer productization scope so app developers and operators can review deployment plan changes, risk, cost, and approval evidence before any deploy path claims launch readiness.",
  personas: [
    {
      role: "app developer reviewer",
      need: "Understand what changed in a proposed deployment before approving or revising it.",
    },
    {
      role: "platform engineer approver",
      need: "Validate provider, environment, topology, capacity, and cost deltas without running apply.",
    },
    {
      role: "security reviewer",
      need: "See policy, credential, permission, and data-boundary impacts before a plan can proceed.",
    },
    {
      role: "support operator",
      need: "Diagnose blocked or confusing plan states from a stable evidence object and owner map.",
    },
  ],
  scopeIn: [
    "Plan and diff review scope for DeploymentPlan, ResourcePlan, topology, policy, cost, and approval evidence.",
    "Persona-specific review states for app developer, platform engineer, security reviewer, and support operator paths.",
    "Service, UX, security, and support boundaries for what the viewer may claim at M0.",
    "M1-ready evidence map for fixtures, annotations, copy, and support handoff records.",
  ],
  scopeOut: [
    "Implementing planner, matcher, provisioner, apply, rollback, or live provider integrations.",
    "Building the production dashboard, final UI components, command implementation, or approval workflow.",
    "Calling live cloud cost APIs, storing provider credentials, or executing infrastructure changes.",
    "Creating M1-M4 design or implementation issues before this M0 scope record is accepted.",
  ],
  nonGoals: [
    "Replace the DeploymentPlan IR, Matching, or control-plane planner contracts.",
    "Define billing, entitlement, quota, or marketplace payout behavior.",
    "Claim production launch readiness from static mocks or incomplete plan evidence.",
  ],
  boundaries: {
    service:
      "Plan/Diff Viewer defines review evidence and state contracts only; planner, matcher, provisioner, billing, and approval services remain in their owner projects.",
    ux:
      "UX scope is information architecture, review states, and acceptance shape, not final dashboard implementation or design-system components.",
    security:
      "Viewer output must not hide policy denials, broadened permissions, provider credentials, tenant data exposure, or missing approval evidence.",
    support:
      "Support handoff records blocked state, owner, safe next action, and evidence source; support workflow and SLA commitments remain separate.",
  },
  dependencies: [
    {
      source: "docs/design/developer-experience.md#plan-07",
      reason: "Defines the hobo plan, hobo up, inspect, and approval-facing surfaces that the viewer explains.",
    },
    {
      source: "docs/design/control-plane.md#plan-04",
      reason: "Defines DeploymentPlan, ResourcePlan, Matching, Planner, and control-plane evidence boundaries.",
    },
    {
      source: "docs/design/platform-engineering.md#plan-25",
      reason: "Defines environments, provider mapping, GitOps, and operator concerns consumed by plan review.",
    },
    {
      source: "docs/design/reliability-observability-cost.md#plan-05",
      reason: "Defines cost, observability, SLO, and readiness signals that cannot be represented as generic green states.",
    },
    {
      source: "docs/design/contracts-policy-flags.md#plan-29",
      reason: "Defines policy gate, obligation, and compatibility context that must appear in risky diffs.",
    },
    {
      source: "docs/design/adr/01-architecture-core.md#adr-0033",
      reason: "Pins deterministic Matching and Planner selection so plan diffs can be stable and explainable.",
    },
    {
      source: "docs/design/adr/07-portability-extensibility.md#adr-0064",
      reason: "Keeps monetization and business mechanics outside the platform plan-review scope record.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Plan/Diff Viewer",
      consumes: "Owns the accepted M0 review contract, evidence states, and viewer-specific acceptance criteria.",
      scopeBoundary: "This issue defines scope and acceptance; implementation waits for later phases.",
    },
    {
      owner: "Deployment Dashboard & Topology Explorer",
      consumes: "Dashboard surfaces can consume accepted plan and topology diff states.",
      scopeBoundary: "Dashboard layout, navigation, and production UI implementation remain outside this M0 issue.",
    },
    {
      owner: "Workspace & Onboarding UX",
      consumes: "Onboarding can use plan review outcomes as first-run activation and recovery checkpoints.",
      scopeBoundary: "First-run instrumentation and onboarding rails remain in Workspace & Onboarding UX.",
    },
    {
      owner: "Security Verification",
      consumes: "Security launch gates can rely on explicit policy, credential, permission, and tenant-boundary annotations.",
      scopeBoundary: "Security test execution, vulnerability triage, and compliance signoff remain outside Plan/Diff Viewer M0.",
    },
    {
      owner: "Support & Debug Tools",
      consumes: "Support surfaces can reuse blocked-plan owner, safe-action, and evidence-source fields.",
      scopeBoundary: "Support workflows, queues, debug tooling, and SLAs remain in support-owned projects.",
    },
    {
      owner: "V1 Release Program & Cutline",
      consumes: "Readiness and go/no-go records can classify plan-review gaps by blocker category.",
      scopeBoundary: "Launch decisions, accepted risks, and release notes stay in release-readiness projects.",
    },
  ],
  m1Evidence: [
    {
      kind: "plan-diff-state-model",
      owner: "Plan/Diff Viewer",
      proofMode: "design-record",
      source: "docs/design/plan-diff-viewer.md",
      proves: "Each viewer state has an input, output, owner, missing-evidence behavior, and release-gate meaning.",
    },
    {
      kind: "golden-plan-fixtures",
      owner: "Control Plane",
      proofMode: "reference-fixture",
      source: "docs/design/control-plane.md#plan-04",
      proves: "Stable plan and diff examples cover create, update, no-op, destructive, and blocked-plan paths.",
    },
    {
      kind: "risk-and-policy-annotations",
      owner: "Security Verification",
      proofMode: "contract-test",
      source: "docs/design/contracts-policy-flags.md#plan-29",
      proves: "Policy denials, widened permissions, tenant exposure, and missing approvals cannot be hidden in generic plan output.",
    },
    {
      kind: "cost-and-capacity-summary",
      owner: "Reliability, Observability & Cost",
      proofMode: "reference-fixture",
      source: "docs/design/reliability-observability-cost.md#plan-05",
      proves: "Cost, capacity, and SLO-impact summaries are explicit about known, estimated, unavailable, and stale evidence.",
    },
    {
      kind: "blocked-plan-support-handoff",
      owner: "Support & Debug Tools",
      proofMode: "support-handoff",
      source: "docs/design/plan-diff-viewer.md",
      proves: "Blocked or confusing plan states carry owner, safe next action, customer-visible wording, and evidence source.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 design, implementation, dashboard, command, approval, and live-provider issues must not be created until this record is accepted.",
  },
};

export function canCreatePlanDiffViewerFollowUp({ phase, m0Accepted }) {
  return Boolean(m0Accepted) && FOLLOW_UP_PHASES.has(phase);
}

export function validatePlanDiffViewerScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-411") {
    errors.push("issue must be HOBO-411");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!scope.goal?.toLowerCase().includes("plan") || !scope.goal?.toLowerCase().includes("diff")) {
    errors.push("goal must name Plan/Diff Viewer");
  }
  if ((scope.personas ?? []).length < 4) {
    errors.push("at least four personas are required");
  }
  if ((scope.scopeIn ?? []).length < 4) {
    errors.push("scope in must have at least four entries");
  }
  if ((scope.scopeOut ?? []).length < 4) {
    errors.push("scope out must have at least four entries");
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

  if ((scope.dependencies ?? []).length < 7) {
    errors.push("design dependencies must map to DX, control plane, platform engineering, reliability/cost, policy, planner ADR, and scope ADR");
  }

  if ((scope.initiativeDependencies ?? []).length < 6) {
    errors.push("owning initiative dependencies must map to consuming productization projects");
  }
  for (const dependency of scope.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
    }
  }

  for (const evidence of scope.m1Evidence ?? []) {
    if (!evidence.owner || !evidence.proves) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must name owner and proof`);
    }
    if (!VALID_PROOF_MODES.has(evidence.proofMode)) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must declare a proof mode`);
    }
    if (!evidence.source) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must declare a source`);
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
