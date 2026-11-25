export const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"];

const VALID_PROOF_MODES = new Set([
  "design-record",
  "contract-test",
  "reference-fixture",
  "smoke-matrix",
  "support-handoff",
  "security-review",
]);

const FOLLOW_UP_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = [
  /production installer/i,
  /installer scripts/i,
  /live cloud provisioning/i,
  /provision/i,
  /account creation/i,
  /identity provider implementation/i,
  /first deploy execution/i,
  /deploy runtime/i,
  /uninstall cleanup implementation/i,
  /package manager publishing/i,
  /hosted control plane implementation/i,
  /collect secrets/i,
  /store secrets/i,
];

export const BOOTSTRAP_INSTALLER_SCOPE = {
  issue: "HOBO-428",
  project: "Bootstrap Installer",
  phase: "M0",
  goal:
    "Define Bootstrap Installer productization scope so SaaS, self-host, and local/dev bootstrap paths have accepted personas, boundaries, evidence, and follow-up gates before M1 design and contract proof work begins.",
  personas: [
    {
      role: "app developer",
      need: "Install or start HoBo locally, create a first project, and understand which bootstrap states are supported without learning platform internals.",
    },
    {
      role: "platform engineer",
      need: "Know which SaaS, self-host, and local/dev setup paths must be proven before implementation starts.",
    },
    {
      role: "devops operator",
      need: "Plan self-host bootstrap, seed handoff, recovery, and upgrade hooks without relying on undocumented manual setup.",
    },
    {
      role: "support engineer",
      need: "Route failed installs, bootstrap recovery, unsupported environments, and cleanup requests with explicit evidence.",
    },
    {
      role: "security/compliance reviewer",
      need: "Review seed credentials, secret handling, offline mode, audit evidence, and unsupported trust assumptions before customer bootstrap claims.",
    },
  ],
  scopeIn: [
    "Accepted install-path matrix for SaaS bootstrap, self-host bootstrap, and local/dev bootstrap modes.",
    "Required setup stages for preflight, seed/auth handoff, first project, first deploy smoke shape, recovery, and cleanup evidence.",
    "Explicit boundary between Bootstrap Installer scope and Dogfood Yard, Identity, CLI/DX, Support Workflow, and release cutline ownership.",
    "M1-ready evidence checklist for bootstrap path fixtures, seed credential handling, unsupported environment routing, and support troubleshooting handoff.",
    "Follow-up gate that blocks M1-M4 implementation issues until M0 scope and acceptance are recorded.",
  ],
  scopeOut: [
    "No production installer scripts, package manager publishing, native installer binaries, or update service.",
    "No live cloud provisioning, hosted control plane implementation, runtime deployment, first deploy execution, or Yard bootstrap implementation.",
    "No account creation, identity provider implementation, billing signup, tenant provisioning, or production auth flow.",
    "No real secret collection, credential persistence, seed-token minting, or customer environment scanning.",
    "No uninstall cleanup implementation, migration engine, backup/restore implementation, or upgrade runner.",
    "No M1-M4 design or implementation issue creation before M0 acceptance is recorded.",
  ],
  nonGoals: [
    "Replace the self-host bootstrap saga or ADR-0092 seed Yard decision.",
    "Build a production CLI installer, native package, or hosted onboarding service.",
    "Prove real infrastructure provisioning, first deploy, or uninstall behavior in this issue.",
    "Approve customer-facing launch claims for supported platforms without M1 evidence.",
  ],
  boundaries: {
    service:
      "Bootstrap Installer M0 defines accepted setup modes, stages, evidence, and ownership boundaries; it does not build installer services, provisioning, deployment, or runtime components.",
    ux:
      "UX scope is the future setup journey and troubleshooting contract for SaaS, self-host, and local/dev paths, not a rendered installer UI or onboarding wizard.",
    security:
      "Security scope records seed credential, secret handling, offline, and audit expectations without minting real credentials, storing secrets, or scanning live customer environments.",
    support:
      "Support receives setup-stage diagnostics, unsupported-state routing, recovery evidence, and cleanup handoff rules; support queues, SLAs, and remediation execution remain separate.",
  },
  dependencies: [
    {
      source: "docs/design/developer-experience.md#plan-07",
      reason: "Defines developer setup, CLI, dashboard, and status experience that Bootstrap Installer must prepare without implementing.",
    },
    {
      source: "docs/design/walkthrough.md",
      reason: "Defines role journeys where SaaS, self-host, and local/dev bootstrap paths surface to app developers and operators.",
    },
    {
      source: "docs/design/dogfood-yard.md",
      reason: "Defines hosted and self-hosted Yard acceptance scenarios consumed as bootstrap smoke evidence.",
    },
    {
      source: "docs/design/adr/01-architecture-core.md#adr-0092",
      reason: "Pins self-host bootstrap as disposable seed Yard, provenance import, Identity handover, and recovery table.",
    },
    {
      source: "docs/design/adr/07-portability-extensibility.md#adr-0036",
      reason: "Defines air-gapped and sovereign Yard constraints that bootstrap evidence must not overclaim.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0008",
      reason: "Defines keyless agent identity and token broker boundaries consumed by seed/auth handoff evidence.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Bootstrap Installer",
      consumes: "Owns accepted install paths, setup stages, evidence checklist, unsupported-state routing, and follow-up gate.",
      scopeBoundary: "This issue defines scope and acceptance; it does not build installers or provisioning paths.",
    },
    {
      owner: "Dogfood Yard",
      consumes: "Uses bootstrap path expectations as hosted/self-hosted dogfood scenario input.",
      scopeBoundary: "Dogfood acceptance proves Yard scenarios, not installer implementation.",
    },
    {
      owner: "Identity & Auth",
      consumes: "Provides future seed credential, auth handoff, and token broker contracts.",
      scopeBoundary: "Identity provider, seed-token minting, account creation, and tenant auth stay in Identity & Auth.",
    },
    {
      owner: "CLI/MCP & Developer Experience",
      consumes: "Owns future command surface, setup output, and local developer entry points.",
      scopeBoundary: "CLI parser, native packages, onboarding UI, MCP tools, and live deploy commands stay out of this M0 record.",
    },
    {
      owner: "Support Workflow",
      consumes: "Uses setup-stage diagnostics, unsupported-state classifications, and troubleshooting handoff evidence.",
      scopeBoundary: "Ticket queues, support SLAs, escalation, and remediation execution stay in Support Workflow.",
    },
    {
      owner: "V1 Release Program & Cutline",
      consumes: "Uses the accepted M0 record to decide when M1-M4 follow-up issues may be created.",
      scopeBoundary: "Release go/no-go, launch claims, and downstream issue creation remain release-program scope.",
    },
  ],
  installPathMatrix: [
    {
      id: "saas-bootstrap",
      owner: "app developer",
      proves: "Hosted setup can name account, workspace, first project, first deploy smoke shape, recovery, and unsupported states.",
    },
    {
      id: "self-host-bootstrap",
      owner: "devops operator",
      proves: "Self-host setup can name seed Yard, provenance import, Identity handoff, recovery, offline constraints, and cleanup evidence.",
    },
    {
      id: "local-dev-bootstrap",
      owner: "app developer",
      proves: "Local/dev setup can name runtime prerequisites, fixture boundaries, first project, mock deploy shape, and unsupported OS/tool states.",
    },
  ],
  m1Evidence: [
    {
      kind: "install-path-matrix",
      owner: "platform engineer",
      proofMode: "design-record",
      source: "docs/design/bootstrap-installer.md#install-path-matrix",
      proves: "SaaS, self-host, and local/dev setup modes each name user, stages, evidence, and unsupported states.",
    },
    {
      kind: "bootstrap-seed-and-auth-handoff-record",
      owner: "security/compliance reviewer",
      proofMode: "security-review",
      source: "docs/design/bootstrap-installer.md#seed-auth-and-secret-handling",
      proves: "Seed credential, Identity handoff, token broker, and secret-handling assumptions are explicit before implementation.",
    },
    {
      kind: "first-project-and-first-deploy-smoke-shape",
      owner: "app developer",
      proofMode: "smoke-matrix",
      source: "docs/design/bootstrap-installer.md#evidence-required-for-m1",
      proves: "First project and first deploy smoke checks are shaped without claiming real deploy execution in M0.",
    },
    {
      kind: "failure-recovery-and-uninstall-boundary",
      owner: "devops operator",
      proofMode: "reference-fixture",
      source: "docs/design/bootstrap-installer.md#failure-recovery-and-cleanup-boundaries",
      proves: "Failed install, retry, recovery, and cleanup states have named evidence and remain separate from implementation.",
    },
    {
      kind: "support-troubleshooting-handoff",
      owner: "support engineer",
      proofMode: "support-handoff",
      source: "docs/design/bootstrap-installer.md#owning-initiative-dependencies",
      proves: "Support can route bootstrap failures with setup-stage diagnostics and unsupported-state labels.",
    },
    {
      kind: "security-secret-handling-review",
      owner: "security/compliance reviewer",
      proofMode: "security-review",
      source: "docs/design/bootstrap-installer.md#service-ux-security-and-support-boundaries",
      proves: "M1 proof must document no secret persistence, no live environment scan, and no unaudited seed credential path.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 design or implementation issues must not be created until this Bootstrap Installer scope record is accepted.",
  },
};

export function canCreateBootstrapInstallerFollowUp({ phase, m0Accepted }) {
  return Boolean(m0Accepted) && FOLLOW_UP_PHASES.has(phase);
}

export function validateBootstrapInstallerScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-428") {
    errors.push("issue must be HOBO-428");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  for (const term of ["bootstrap installer", "saas", "self-host", "local/dev"]) {
    if (!scope.goal?.toLowerCase().includes(term)) {
      errors.push(`goal must name ${term}`);
    }
  }
  if ((scope.personas ?? []).length < 5) {
    errors.push("at least five personas are required");
  }
  if ((scope.scopeIn ?? []).length < 5) {
    errors.push("scope in must have at least five entries");
  }
  if ((scope.scopeOut ?? []).length < 6) {
    errors.push("scope out must have at least six entries");
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

  const requiredSources = [
    "docs/design/developer-experience.md#plan-07",
    "docs/design/walkthrough.md",
    "docs/design/dogfood-yard.md",
    "docs/design/adr/01-architecture-core.md#adr-0092",
    "docs/design/adr/07-portability-extensibility.md#adr-0036",
    "docs/design/adr/02-identity-security.md#adr-0008",
  ];
  const sources = (scope.dependencies ?? []).map((dependency) => dependency.source);
  if (JSON.stringify(sources) !== JSON.stringify(requiredSources)) {
    errors.push("design dependencies must map to DX, walkthrough, dogfood, bootstrap, air-gap, and identity sources");
  }

  if ((scope.initiativeDependencies ?? []).length < 6) {
    errors.push("owning initiative dependencies must map to consuming productization projects");
  }
  for (const dependency of scope.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
    }
  }

  for (const mode of ["saas-bootstrap", "self-host-bootstrap", "local-dev-bootstrap"]) {
    if (!(scope.installPathMatrix ?? []).some((entry) => entry.id === mode)) {
      errors.push(`install path missing: ${mode}`);
    }
  }

  for (const evidence of scope.m1Evidence ?? []) {
    if (!evidence.owner || !evidence.proves || !evidence.source) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must name owner, source, and proof`);
    }
    if (!VALID_PROOF_MODES.has(evidence.proofMode)) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must declare a proof mode`);
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
