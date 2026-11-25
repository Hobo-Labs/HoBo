const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"];
const VALID_PROOF_MODES = new Set([
  "design-record",
  "contract-test",
  "reference-fixture",
  "agent-fixture",
  "accessibility-note",
  "support-handoff",
]);
const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);
const FORBIDDEN_SCOPE_PATTERNS = [
  /production docs portal/i,
  /launch marketing/i,
  /marketing tutorial/i,
  /real customer data/i,
  /(use|using|store|storing|embed|embedding|capture|capturing).*provider credential/i,
  /build .*app/i,
  /ship .*ui/i,
];

export const TUTORIALS_WALKTHROUGHS_SCOPE = {
  issue: "HOBO-436",
  project: "Tutorials & Walkthroughs",
  phase: "M0",
  goal:
    "Define the Tutorials and Walkthroughs productization scope so HoBo has role-based learning paths, agent-readable walkthroughs, and launch-safe proof expectations without turning tutorials into hidden product implementation.",
  personas: [
    {
      role: "first-time app developer",
      need: "Follow a short path from concept to local run, plan, deploy attempt, recovery, and inspection evidence.",
    },
    {
      role: "coding agent",
      need: "Use deterministic tutorial steps, command transcripts, and fixtures without private local knowledge.",
    },
    {
      role: "platform engineer evaluator",
      need: "See where provider defaults, catalogs, policy gates, and self-host setup enter the walkthrough.",
    },
    {
      role: "docs maintainer",
      need: "Know which tutorials are canonical, what evidence refreshes them, and which owners maintain each path.",
    },
    {
      role: "support operator",
      need: "Map stuck tutorial states to safe next actions, owners, and support handoff records.",
    },
  ],
  scopeIn: [
    "Canonical tutorial map with persona, entry condition, command path, expected evidence, and owner per tutorial.",
    "Role walkthrough paths for app developer, platform engineer, GitOps, SecOps, DevOps, and SRE that consume the accepted role walkthrough rather than replacing it.",
    "Agent-readable step fixtures and command transcripts for tutorial paths that can be replayed without live provider credentials.",
    "Proof-mode rules that distinguish design record, contract test, reference fixture, agent fixture, accessibility note, and support handoff evidence.",
    "M1-ready acceptance checklist for tutorial map, persona scenarios, transcripts, agent fixtures, accessibility/localization notes, and support handoff fixtures.",
  ],
  scopeOut: [
    "Building the production docs portal, tutorial frontend, or marketing site.",
    "Authoring final launch marketing copy, demo videos, screenshots, or public campaign pages.",
    "Provisioning live cloud resources, using provider credentials, or capturing real customer data.",
    "Changing CLI verbs, SDK behavior, provider mappings, auth flows, billing, or support SLA implementation.",
    "Creating downstream M1-M4 implementation issues before this M0 scope record is accepted.",
  ],
  nonGoals: [
    "Replace the existing role walkthrough or worked example.",
    "Build example applications or the launch demo golden path.",
    "Define final visual design, tutorial CMS behavior, or docs portal navigation.",
    "Claim production readiness from reference fixtures alone.",
  ],
  boundaries: {
    service:
      "Tutorials define learning and proof contracts only; docs portal hosting, search, analytics, and CMS services remain in their owner projects.",
    ux:
      "Tutorial UX covers journey shape, step states, evidence, and accessibility notes, not final screens, navigation, or marketing polish.",
    security:
      "Tutorials cannot embed static keys, provider credentials, customer data, or policy bypasses; every claim names its proof mode and live-versus-simulated boundary.",
    support:
      "Support handoff records stuck step, likely owner, safe next action, and evidence source; support queues, SLAs, and escalation process remain separate.",
  },
  dependencies: [
    {
      source: "docs/design/walkthrough.md",
      reason: "Defines the six-role ideal-state journey that tutorials must consume and make executable.",
    },
    {
      source: "docs/design/worked-example.md#plan-19",
      reason: "Keeps snapshop as the compact end-to-end example that tutorial paths can reference.",
    },
    {
      source: "docs/design/developer-experience.md#plan-07",
      reason: "Defines CLI, dashboard, local-dev, and inspection surfaces that tutorial steps exercise.",
    },
    {
      source: "docs/design/example-apps.md",
      reason: "Supplies example-app proof modes and fixtures that tutorials can reuse.",
    },
    {
      source: "docs/design/workspace-onboarding-ux.md",
      reason: "Defines first-run activation stages and stalled-state handoff inputs consumed by tutorials.",
    },
    {
      source: "docs/design/adr/07-portability-extensibility.md#adr-0064",
      reason: "Keeps business mechanics, monetization, and marketing surfaces outside tutorial scope.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Tutorials & Walkthroughs",
      consumes: "Accepted tutorial map, proof-mode rules, persona scenarios, transcripts, and follow-up gate.",
      scopeBoundary: "This issue defines scope and acceptance; it does not build the docs portal or final tutorials.",
    },
    {
      owner: "Docs Portal",
      consumes: "Tutorial map and evidence states can become portal information architecture inputs.",
      scopeBoundary: "Portal IA, frontend, search, analytics, and publishing remain outside Tutorials M0.",
    },
    {
      owner: "Example Apps",
      consumes: "Tutorial paths can reuse accepted example fixtures and proof modes.",
      scopeBoundary: "Tutorials consume examples; they do not build or certify example applications.",
    },
    {
      owner: "Workspace & Onboarding UX",
      consumes: "First-run states and recovery categories can feed tutorial step status and blocked-state wording.",
      scopeBoundary: "Activation telemetry, product UX, and onboarding implementation remain in onboarding.",
    },
    {
      owner: "Customer Onboarding",
      consumes: "Pilot onboarding scripts can reuse tutorial success/failure categories and comparable transcripts.",
      scopeBoundary: "Customer scripts, cohort feedback, and success process stay in Customer Onboarding.",
    },
    {
      owner: "Support Workflow",
      consumes: "Tutorial stuck states route to safe next action, owner, and evidence source.",
      scopeBoundary: "Support queues, SLA targets, escalation, and tooling remain in Support Workflow.",
    },
    {
      owner: "V1 Launch Site, Messaging & Demo Assets",
      consumes: "Launch claims and demos can reference accepted tutorial proof modes and known limitations.",
      scopeBoundary: "Marketing copy, demo videos, screenshots, and public campaign pages remain outside Tutorials M0.",
    },
    {
      owner: "V1 Release Program & Cutline",
      consumes: "Readiness dashboards can classify tutorial gaps by blocker category and proof mode.",
      scopeBoundary: "Go/no-go, accepted risks, release notes, and launch decisions stay in the cutline project.",
    },
  ],
  m1Evidence: [
    {
      kind: "tutorial-map",
      owner: "docs maintainer",
      proofMode: "design-record",
      proves: "Each canonical tutorial has persona, entry condition, command path, expected evidence, and owner.",
    },
    {
      kind: "persona-walkthrough-scenarios",
      owner: "docs maintainer",
      proofMode: "reference-fixture",
      proves: "App developer, platform engineer, GitOps, SecOps, DevOps, and SRE paths can be exercised consistently.",
    },
    {
      kind: "command-transcripts",
      owner: "coding agent",
      proofMode: "reference-fixture",
      proves: "CLI/MCP tutorial steps are reproducible without private local setup or provider credentials.",
    },
    {
      kind: "agent-run-fixtures",
      owner: "coding agent",
      proofMode: "agent-fixture",
      proves: "Agent-readable tutorial steps include fixtures, expected outputs, and refusal states.",
    },
    {
      kind: "accessibility-and-localization-notes",
      owner: "docs maintainer",
      proofMode: "accessibility-note",
      proves: "Tutorial content identifies keyboard/screen-reader, language, and non-visual evidence obligations before UI work.",
    },
    {
      kind: "support-handoff-fixtures",
      owner: "support operator",
      proofMode: "support-handoff",
      proves: "Blocked tutorial states carry safe next action, owner, and evidence source for support.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 design, docs portal, tutorial implementation, and launch asset issues must not be created until this record is accepted.",
  },
};

export function canCreateFollowUpIssue({ phase, m0Accepted }) {
  return Boolean(m0Accepted) && IMPLEMENTATION_PHASES.has(phase);
}

export function validateTutorialsWalkthroughsScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-436") {
    errors.push("issue must be HOBO-436");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!scope.goal?.toLowerCase().includes("tutorials and walkthroughs")) {
    errors.push("goal must name Tutorials and Walkthroughs");
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

  for (const evidence of scope.m1Evidence ?? []) {
    if (!evidence.owner || !evidence.proves) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must name owner and proof`);
    }
    if (!VALID_PROOF_MODES.has(evidence.proofMode)) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must declare a proof mode`);
    }
  }

  if ((scope.dependencies ?? []).length < 6) {
    errors.push("design dependencies must map to walkthrough, worked example, DX, example apps, onboarding, and scope ADR");
  }
  if ((scope.initiativeDependencies ?? []).length < 8) {
    errors.push("owning initiative dependencies must map to consuming productization projects");
  }
  for (const dependency of scope.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
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
