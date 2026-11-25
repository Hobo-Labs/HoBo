const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"];
const VALID_PROOF_MODES = new Set([
  "design-record",
  "contract-test",
  "reference-fixture",
  "telemetry-contract",
  "support-handoff",
]);
const FOLLOW_UP_PHASES = new Set(["M1", "M2", "M3", "M4"]);
const FORBIDDEN_SCOPE_PATTERNS = [
  /production dashboard/i,
  /billing-backed/i,
  /auth implementation/i,
  /account service/i,
  /production instrumentation/i,
  /customer onboarding script/i,
  /live customer/i,
];

export const WORKSPACE_ONBOARDING_SCOPE = {
  issue: "HOBO-409",
  project: "Workspace & Onboarding UX",
  phase: "M0",
  goal:
    "Define the Workspace & Onboarding UX productization scope so first-run HoBo users can move from account/workspace setup to project creation, plan preview, launch, recovery, and value proof without hidden implementation work.",
  personas: [
    {
      role: "first-time app developer",
      need: "Understand the shortest path from workspace creation to first safe plan and deploy evidence.",
    },
    {
      role: "team admin",
      need: "Know which organization, member, project, and environment decisions are required before a team can invite others.",
    },
    {
      role: "platform engineer",
      need: "See where provider defaults, approved catalogs, policy gates, and inferred Camp approval are prerequisites.",
    },
    {
      role: "support operator",
      need: "Use first-run state, failure reasons, and handoff evidence to diagnose stalled onboarding without reading private logs.",
    },
  ],
  scopeIn: [
    "First-run activation rail from invite or anonymous try-it path through workspace, project, plan preview, deploy attempt, recovery, and value proof.",
    "Workspace and project lifecycle states that onboarding UX may show before implementation issues exist.",
    "Persona-specific scope boundaries for app developer, team admin, platform engineer, and support operator paths.",
    "M1-ready evidence map for onboarding scenarios, telemetry events, state model, recovery fixtures, and support handoff.",
  ],
  scopeOut: [
    "Building the dashboard, settings screens, account service, auth flow, billing flow, or production instrumentation.",
    "Creating customer onboarding scripts, support runbooks, notification copy, or launch marketing pages.",
    "Provisioning live infrastructure, using live customer data, or claiming production activation metrics.",
    "Creating M1-M4 implementation issues before this M0 record is accepted.",
  ],
  nonGoals: [
    "Replace the role walkthrough or worked example.",
    "Define final visual design, UI copy, or accessibility audit output.",
    "Resolve billing, entitlement, compliance, legal, support, or incident-communication policy.",
  ],
  boundaries: {
    service:
      "Workspace onboarding defines state and evidence contracts only; account, auth, billing, notification, and project services remain in their owner projects.",
    ux:
      "UX scope is journey and acceptance shape, not final screens, design system components, or dashboard implementation.",
    security:
      "Onboarding cannot bypass auth, policy, provider approval, inferred-Camp approval, or no-static-key rules to make the first run look successful.",
    support:
      "Support handoff records stalled state, owner, safe next action, and evidence source; support scripts and SLAs remain separate.",
  },
  dependencies: [
    {
      source: "docs/design/vision.md#plan-17",
      reason: "Keeps onboarding aligned with the Lakebed-competitive first-run promise.",
    },
    {
      source: "docs/design/developer-experience.md#plan-07",
      reason: "Defines the hobo new, hobo dev, hobo up, plan, inspect, and logs surfaces that first-run UX exposes.",
    },
    {
      source: "docs/design/walkthrough.md",
      reason: "Defines hosted HoBo cloud versus self-hosted Yard prerequisites and the app-developer first-run flow.",
    },
    {
      source: "docs/design/worked-example.md#plan-19",
      reason: "Provides the snapshop example path that onboarding can use as a stable activation fixture.",
    },
    {
      source: "docs/design/example-apps.md",
      reason: "Supplies accepted example proof modes and command paths without making onboarding own examples.",
    },
    {
      source: "docs/design/adr/07-portability-extensibility.md#adr-0064",
      reason: "Keeps monetization/business mechanics outside this platform scope record.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Workspace & Onboarding UX",
      consumes: "Owns the accepted activation rail, first-run state model, and UX proof requirements.",
      scopeBoundary: "This issue defines scope and acceptance; implementation waits for later phases.",
    },
    {
      owner: "Settings & Project Lifecycle",
      consumes: "Project creation, environment selection, and settings states feed onboarding entry and exit criteria.",
      scopeBoundary: "Settings screens and lifecycle APIs remain outside onboarding M0.",
    },
    {
      owner: "Organization & Workspace Model",
      consumes: "Organization, workspace, member, and invite states are prerequisites for team onboarding.",
      scopeBoundary: "Org model implementation and RBAC behavior remain outside onboarding M0.",
    },
    {
      owner: "Example Apps",
      consumes: "Accepted examples can provide first-run fixtures and command paths.",
      scopeBoundary: "Onboarding consumes example proof modes; it does not build examples.",
    },
    {
      owner: "Customer Onboarding",
      consumes: "Pilot scripts can reuse the first-run rail and success/failure categories.",
      scopeBoundary: "Customer scripts, pilot notes, and customer-success process stay in Customer Onboarding.",
    },
    {
      owner: "Support Workflow",
      consumes: "Support handoff needs stalled-state and evidence fields from onboarding.",
      scopeBoundary: "Support SLA, queues, and escalation process stay in Support Workflow.",
    },
    {
      owner: "V1 Release Program & Cutline",
      consumes: "Readiness dashboard and go/no-go records classify onboarding gaps by blocker category.",
      scopeBoundary: "Release decisions, accepted risks, and launch notes stay in the cutline project.",
    },
  ],
  m1Evidence: [
    {
      kind: "activation-rail-map",
      owner: "Workspace & Onboarding UX",
      proofMode: "design-record",
      source: "docs/design/workspace-onboarding-ux.md",
      proves: "Each onboarding stage has an entry condition, exit condition, evidence object, and owning project.",
    },
    {
      kind: "persona-first-run-scenarios",
      owner: "Workspace & Onboarding UX",
      proofMode: "reference-fixture",
      source: "docs/design/walkthrough.md",
      proves: "App developer, admin, platform engineer, and support paths can be exercised without hidden local knowledge.",
    },
    {
      kind: "workspace-state-model",
      owner: "Organization & Workspace Model",
      proofMode: "contract-test",
      source: "docs/design/workspace-onboarding-ux.md",
      proves: "Workspace, project, environment, and provider-readiness states are explicit and cannot be represented as green when missing.",
    },
    {
      kind: "telemetry-event-contract",
      owner: "Workspace & Onboarding UX",
      proofMode: "telemetry-contract",
      source: "docs/design/workspace-onboarding-ux.md",
      proves: "Activation events have privacy constraints, support use, and product question ownership.",
    },
    {
      kind: "recovery-and-handoff-fixtures",
      owner: "Support Workflow",
      proofMode: "support-handoff",
      source: "docs/design/workspace-onboarding-ux.md",
      proves: "Blocked onboarding states carry safe next action, owner, and evidence source for support.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 design, implementation, instrumentation, and support-workflow issues must not be created until this record is accepted.",
  },
};

export function canCreateWorkspaceOnboardingFollowUp({ phase, m0Accepted }) {
  return Boolean(m0Accepted) && FOLLOW_UP_PHASES.has(phase);
}

export function validateWorkspaceOnboardingScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-409") {
    errors.push("issue must be HOBO-409");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!scope.goal?.toLowerCase().includes("workspace") || !scope.goal?.toLowerCase().includes("onboarding")) {
    errors.push("goal must name Workspace & Onboarding UX");
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

  if ((scope.dependencies ?? []).length < 6) {
    errors.push("design dependencies must map to positioning, DX, walkthrough, worked example, examples, and scope ADR");
  }

  if ((scope.initiativeDependencies ?? []).length < 7) {
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
