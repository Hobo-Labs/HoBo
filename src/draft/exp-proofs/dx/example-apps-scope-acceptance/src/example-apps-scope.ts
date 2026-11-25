const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"];
const VALID_PROOF_MODES = new Set([
  "design-record",
  "contract-test",
  "live-recording",
  "reference-fixture",
  "simulated-reference",
]);
const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);
const FORBIDDEN_SCOPE_PATTERNS = [
  /production-hosted/i,
  /real customer data/i,
  /launch demo app/i,
  /marketing site/i,
  /provider credential/i,
];

export const EXAMPLE_APPS_SCOPE = {
  issue: "HOBO-435",
  project: "Example Apps",
  phase: "M0",
  goal:
    "Define the Example Apps productization scope so HoBo has trustworthy example apps that prove the platform story without becoming hidden product implementation.",
  personas: [
    {
      role: "app developer evaluator",
      need: "See a minimal path from scaffold to local run to deploy evidence.",
    },
    {
      role: "platform engineer evaluator",
      need: "See how examples stay provider agnostic while exposing Camp and provider mapping decisions.",
    },
    {
      role: "agent builder",
      need: "Use examples as stable MCP and CLI fixtures without static keys or undocumented setup.",
    },
    {
      role: "demo maintainer",
      need: "Know which proof assets, fixtures, and recordings must be refreshed for launch demos.",
    },
  ],
  scopeIn: [
    "Canonical example-app catalog with persona, template, command path, and proof owner per example.",
    "Snapshop remains the anchor end-to-end example for app developer, platform engineer, GitOps, SecOps, DevOps, and SRE narratives.",
    "Example proof requirements distinguish live behavior, contract-test behavior, recorded demo evidence, and simulated reference fixtures.",
    "M1-ready acceptance checklist for scaffold smoke tests, command transcripts, recordings, docs, and failure-mode contracts.",
  ],
  scopeOut: [
    "Building or shipping the actual example applications.",
    "Creating launch marketing pages, screenshots, or final demo videos.",
    "Provisioning real cloud resources or storing provider credentials.",
    "Defining customer onboarding, support-desk, billing, or legal launch processes.",
  ],
  nonGoals: [
    "Replace the existing worked example or role walkthrough.",
    "Add new lifecycle CLI verbs for examples.",
    "Claim production readiness from reference fixtures alone.",
  ],
  boundaries: {
    service:
      "Example apps are reference and contract-proof artifacts; they do not carry a hosted production SLA.",
    ux:
      "Example UX covers scaffold, local run, deploy, inspect, and failure recovery evidence; polish and marketing layout are separate launch-demo work.",
    security:
      "Examples never embed secrets, provider keys, customer data, or bypassed policy gates; claims name live versus simulated proof mode.",
    support:
      "Maintenance means fixtures, docs, tests, and recordings stay refreshable; customer support scripts live in Customer Onboarding.",
  },
  dependencies: [
    {
      source: "docs/design/worked-example.md#plan-19",
      reason: "Keeps snapshop as the compressed end-to-end product story.",
    },
    {
      source: "docs/design/walkthrough.md",
      reason: "Defines the six-role example lifecycle and shared snapshop app.",
    },
    {
      source: "docs/design/developer-experience.md#plan-07",
      reason: "Defines scaffold, dev, up, inspect, logs, and onboarding command behavior.",
    },
    {
      source: "docs/design/authoring-resources-wiring.md#plan-21",
      reason: "Defines resource collection, manifest IR, and inferred permissions used by examples.",
    },
    {
      source: "docs/design/adr/07-portability-extensibility.md#adr-0064",
      reason: "Keeps product UI generation and business mechanics out of Example Apps scope.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Example Apps",
      consumes: "HOBO-488 launch demo golden path can consume the accepted catalog and proof-mode rules.",
      scopeBoundary: "This issue defines the scope; it does not author the launch demo path.",
    },
    {
      owner: "V1 Launch Site, Messaging & Demo Assets",
      consumes: "Claim register and demo assets need Example Apps proof modes before making public claims.",
      scopeBoundary: "Marketing copy, launch pages, and final assets remain outside Example Apps M0.",
    },
    {
      owner: "Workspace & Onboarding UX",
      consumes: "First-run telemetry and workspace activation can use example command paths as fixtures.",
      scopeBoundary: "Activation metrics and product UX instrumentation remain in the onboarding UX project.",
    },
    {
      owner: "Customer Onboarding",
      consumes: "Pilot onboarding can reuse accepted example paths as comparable first-success scripts.",
      scopeBoundary: "Customer-success scripts and support handoff remain in Customer Onboarding.",
    },
    {
      owner: "V1 Release Program & Cutline",
      consumes: "Known-limitations and readiness dashboards can classify example claims by proof mode.",
      scopeBoundary: "Go/no-go, legal, support, and release-note decisions remain in release-readiness projects.",
    },
  ],
  m1Evidence: [
    {
      kind: "catalog",
      owner: "demo maintainer",
      proofMode: "design-record",
      proves: "Every example has a persona, command path, boundary owner, and refresh obligation.",
    },
    {
      kind: "scaffold-smoke",
      owner: "app developer evaluator",
      proofMode: "contract-test",
      proves: "Each supported template can scaffold, run locally, and expose a manifest fixture.",
    },
    {
      kind: "command-transcript",
      owner: "agent builder",
      proofMode: "reference-fixture",
      proves: "CLI and MCP command paths are reproducible without private local knowledge.",
    },
    {
      kind: "proof-assets",
      owner: "demo maintainer",
      proofMode: "live-recording",
      proves: "Launch-facing demos have screenshots, recordings, and expected outputs tied to real or declared simulated behavior.",
    },
    {
      kind: "failure-mode-contracts",
      owner: "platform engineer evaluator",
      proofMode: "contract-test",
      proves: "Examples include refusal, policy denial, missing secret, and unsupported provider recovery evidence.",
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

export function validateExampleAppsScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-435") {
    errors.push("issue must be HOBO-435");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!scope.goal?.toLowerCase().includes("example apps")) {
    errors.push("goal must name Example Apps");
  }
  if ((scope.personas ?? []).length < 3) {
    errors.push("at least three personas are required");
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

  for (const evidence of scope.m1Evidence ?? []) {
    if (!evidence.owner || !evidence.proves) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must name owner and proof`);
    }
    if (!VALID_PROOF_MODES.has(evidence.proofMode)) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must declare a proof mode`);
    }
  }

  if ((scope.dependencies ?? []).length < 5) {
    errors.push("design dependencies must map to worked example, walkthrough, DX, authoring, and scope ADR");
  }
  if ((scope.initiativeDependencies ?? []).length < 5) {
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
