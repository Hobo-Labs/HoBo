export const REQUIRED_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

const REQUIRED_M1_EVIDENCE = Object.freeze([
  "upgrade-scenario-matrix",
  "fixture-corpus",
  "preflight-contract",
  "migration-dry-run-report",
  "rollback-drill-fixture",
  "compatibility-result-schema",
  "support-troubleshooting-map",
]);

const REQUIRED_UPGRADE_EVIDENCE = Object.freeze([
  "source-version",
  "target-version",
  "deployment-mode",
  "compatibility-matrix-ref",
  "preflight-result",
  "backup-restore-proof",
  "migration-plan",
  "rollback-proof",
  "security-review-state",
  "support-handoff",
]);

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "runner",
    pattern: /\b(production upgrade test runner|test runner|scheduler|orchestrator|ci service)\b/i,
  },
  {
    label: "migration",
    pattern: /\b(live schema migration|schema migrations?|customer data rewrites?|data rewrites?|execute live)\b/i,
  },
  {
    label: "restore",
    pattern: /\b(live backup restore|backup restore|rollback operations?|restore runner|tenant restore)\b/i,
  },
  {
    label: "ui",
    pattern: /\b(compatibility dashboard|upgrade wizard|ui implementation|rendered screen)\b/i,
  },
  {
    label: "release",
    pattern: /\b(publish final release notes|approve launch blockers?|release approval|go\/no-go decision)\b/i,
  },
  {
    label: "support",
    pattern: /\b(support ticket automation|customer notifications?|helpdesk integration|support queue)\b/i,
  },
  {
    label: "security",
    pattern: /\b(real secrets?|scan customer environments?|customer environment scan|credential collection)\b/i,
  },
]);

export const UPGRADE_TEST_SUITE_SCOPE = Object.freeze({
  issue: "HOBO-433",
  project: "Upgrade Test Suite",
  phase: "M0",
  goal:
    "Define Upgrade Test Suite scope and acceptance so release, platform, DevOps, support, and security owners know which upgrade evidence must exist before design/build issues fan out.",
  personas: Object.freeze([
    {
      id: "release-owner",
      name: "Release owner",
      need:
        "Needs beta, release-candidate, and GA upgrade evidence without turning this scope record into a launch approval.",
    },
    {
      id: "platform-engineer",
      name: "Platform engineer",
      need:
        "Needs deterministic upgrade scenarios, fixtures, compatibility inputs, and pass/fail states before harness work begins.",
    },
    {
      id: "devops-operator",
      name: "DevOps operator",
      need:
        "Needs self-host and local/dev upgrade expectations, rollback prerequisites, and recovery evidence before attempting upgrades.",
    },
    {
      id: "support-operator",
      name: "Support operator",
      need:
        "Needs blocked-upgrade reasons, troubleshooting handoff fields, and customer-safe limitation language.",
    },
    {
      id: "security-reviewer",
      name: "Security reviewer",
      need:
        "Needs backup, data-handling, secret-handling, and waiver evidence before any upgrade path becomes customer-facing.",
    },
  ]),
  scopeIn: Object.freeze([
    "Define upgrade scenario classes for hosted control plane, self-host Yard, local/dev runtime, SDK/package, and data-shape changes.",
    "Record required evidence fields for source version, target version, deployment mode, compatibility matrix reference, preflight, backup/restore proof, migration plan, rollback proof, security review, and support handoff.",
    "Define result states for passed, blocked, unsupported, needs-manual-review, waived-with-risk, and failed upgrade suite outcomes.",
    "Map service, UX, security, and support boundaries for upgrade test suite evidence and downstream handoffs.",
    "List owning initiative dependencies across Upgrade & Migration Engine, Compatibility Matrix, Backup & Restore, Bootstrap Installer, Release Notes, Security Verification, and Support Workflow.",
    "List M1 evidence required before a test harness, fixture corpus, dry-run report, compatibility result schema, or support troubleshooting map can depend on this record.",
  ]),
  scopeOut: Object.freeze([
    "No production upgrade test runner, scheduler, CI service, hosted rollout controller, or execution orchestrator.",
    "No live schema migration, customer data rewrite, provider/IaC state mutation, or projection rebuild.",
    "No live backup restore, rollback operation, disaster recovery runner, or tenant restore execution.",
    "No compatibility dashboard, upgrade wizard, release UI, browser grid, or device-lab implementation.",
    "No final release-note publication, release approval, launch-blocker resolution, or go/no-go decision.",
    "No support ticket automation, helpdesk integration, customer notification workflow, or SLA commitment.",
    "No real secret collection, customer environment scan, credential persistence, or live tenant data use.",
    "No downstream M1-M4 issue creation before this M0 scope record is accepted.",
  ]),
  nonGoals: Object.freeze([
    "Replace Upgrade & Migration Engine dry-run contract or build live migration behavior.",
    "Replace Compatibility Matrix browser, device, platform, package, or runtime support decisions.",
    "Replace Backup & Restore rollback drills or prove production recovery readiness.",
    "Publish final release notes, approve launch risks, or create support automation.",
    "Execute live migration, rollback, restore, provider-state, or customer-data operations.",
  ]),
  boundaries: Object.freeze([
    {
      id: "service",
      owner: "Upgrade Test Suite",
      promise:
        "Owns scenario taxonomy, required evidence, result states, and M1 suite proof expectations; execution services remain later work.",
    },
    {
      id: "ux",
      owner: "Release Notes, Compatibility Matrix, and Support Workflow",
      promise:
        "Defines future customer-safe labels, limitations, and troubleshooting evidence; dashboards and wizards remain out of scope.",
    },
    {
      id: "security",
      owner: "Security Verification and Tenant Data Lifecycle",
      promise:
        "Names backup, data-handling, secret-handling, waiver, and audit evidence without touching credentials or live customer data.",
    },
    {
      id: "support",
      owner: "Support Workflow",
      promise:
        "Defines blocked-path reasons, escalation owner, troubleshooting handoff, and rollback guidance without support tooling.",
    },
  ]),
  scenarioClasses: Object.freeze([
    {
      id: "hosted-control-plane",
      definition:
        "Hosted control-plane version transition using release gate, tenant-impact classification, rollback posture, and support handoff evidence.",
    },
    {
      id: "self-host-yard",
      definition:
        "Operator-owned Yard upgrade path with source/target versions, offline constraints, backup prerequisite, and recovery notes.",
    },
    {
      id: "local-dev-runtime",
      definition:
        "Local CLI/runtime upgrade fixture with component-host pin, unsupported toolchain routing, and no production parity claim.",
    },
    {
      id: "sdk-package",
      definition:
        "SDK/package compatibility window with WIT/API posture, deprecation note, and consumer proof expectation.",
    },
    {
      id: "data-shape",
      definition:
        "Schema or data-shape transition with migration dry-run facts, snapshot requirement, and rollback evidence requirement.",
    },
  ]),
  requiredEvidence: Object.freeze([
    {
      id: "source-version",
      owner: "Upgrade & Migration Engine",
      proof: "Names the starting HoBo version, package, manifest, WIT, or schema version under test.",
    },
    {
      id: "target-version",
      owner: "Upgrade & Migration Engine",
      proof: "Names the destination version and whether it is beta, release-candidate, or GA.",
    },
    {
      id: "deployment-mode",
      owner: "Bootstrap Installer",
      proof: "Classifies SaaS, self-host, local/dev, SDK/package, or data-shape path before support claims.",
    },
    {
      id: "compatibility-matrix-ref",
      owner: "Compatibility Matrix",
      proof: "Links browser, device, platform, component-host, provider, package, or runtime compatibility evidence.",
    },
    {
      id: "preflight-result",
      owner: "Upgrade Test Suite",
      proof: "Records deterministic pass, blocked, unsupported, manual-review, waived, or failed preflight result.",
    },
    {
      id: "backup-restore-proof",
      owner: "Backup & Restore",
      proof: "Names backup prerequisite, restore drill, unsupported restore state, or accepted limitation.",
    },
    {
      id: "migration-plan",
      owner: "Upgrade & Migration Engine",
      proof: "Links dry-run plan summary, blocked reasons, and non-mutating migration facts.",
    },
    {
      id: "rollback-proof",
      owner: "Backup & Restore",
      proof: "Names rollback evidence before any path is described as recoverable.",
    },
    {
      id: "security-review-state",
      owner: "Security Verification",
      proof: "Records waiver, blocker, customer-data, secret-handling, and fix-verification posture.",
    },
    {
      id: "support-handoff",
      owner: "Support Workflow",
      proof: "Names customer-safe troubleshooting owner, escalation path, limitation, and next action.",
    },
  ]),
  resultStates: Object.freeze([
    {
      id: "passed",
      meaning: "All required evidence exists for the declared path without unaccepted launch risk.",
    },
    {
      id: "blocked",
      meaning: "A required compatibility, backup, security, release, or support gate is missing or failed.",
    },
    {
      id: "unsupported",
      meaning: "The path is explicitly outside v1 support and must route to release notes or limitations.",
    },
    {
      id: "needs-manual-review",
      meaning: "A human owner must evaluate evidence before release or support can present the result.",
    },
    {
      id: "waived-with-risk",
      meaning: "A release owner accepted a bounded risk with owner, expiry, mitigation, and customer-safe note.",
    },
    {
      id: "failed",
      meaning: "The suite found a regression or incompatible path that cannot be represented as supportable.",
    },
  ]),
  designRefs: Object.freeze([
    "docs/design/release-notes-upgrade-guide.md",
    "docs/design/compatibility-matrix.md",
    "docs/design/backup-restore.md",
    "docs/design/bootstrap-installer.md",
    "docs/design/tenant-data-lifecycle.md",
    "docs/design/security-verification.md",
    "docs/design/support-sla-channels.md",
    "docs/design/upgrade-migration-engine.md",
  ]),
  adrRefs: Object.freeze([
    "docs/design/adr/03-data-plane.md#adr-0032",
    "docs/design/adr/07-portability-extensibility.md#adr-0041",
    "docs/design/adr/07-portability-extensibility.md#adr-0042",
    "docs/design/adr/07-portability-extensibility.md#adr-0057",
    "docs/design/adr/02-identity-security.md#adr-0082",
  ]),
  initiativeDependencies: Object.freeze([
    {
      owner: "Upgrade Test Suite",
      boundary:
        "Owns scenario taxonomy, evidence fields, result states, suite proof expectations, and follow-up gate.",
    },
    {
      owner: "Upgrade & Migration Engine",
      boundary:
        "Provides upgrade classes, dry-run facts, migration plan summaries, blocked reasons, and non-mutating upgrade posture.",
    },
    {
      owner: "Compatibility Matrix",
      boundary:
        "Provides supported surface and environment evidence; matrix engine, UI, browser grid, and platform lab remain separate.",
    },
    {
      owner: "Backup & Restore",
      boundary:
        "Provides backup, restore, rollback, and recovery drill evidence; live restore and rollback execution remain separate.",
    },
    {
      owner: "Bootstrap Installer",
      boundary:
        "Provides SaaS, self-host, and local/dev bootstrap smoke input; installer, first deploy, and recovery implementation remain separate.",
    },
    {
      owner: "V1 Release Notes & Upgrade Guide",
      boundary:
        "Publishes accepted upgrade support language only after evidence exists; final copy and release approval remain separate.",
    },
    {
      owner: "Security Verification",
      boundary:
        "Consumes customer-data, secret-handling, waiver, fix-verification, and blocker evidence without granting production access.",
    },
    {
      owner: "Support Workflow",
      boundary:
        "Consumes blocked-path reasons, troubleshooting handoffs, rollback guidance, and limitations without support automation.",
    },
  ]),
  m1Evidence: Object.freeze([
    {
      id: "upgrade-scenario-matrix",
      mode: "design-record",
      proves: "Hosted, self-host, local/dev, SDK/package, and data-shape upgrade paths have accepted coverage rows.",
    },
    {
      id: "fixture-corpus",
      mode: "reference-fixture",
      proves: "Deterministic tenant, project, manifest, package, and data-shape fixtures exist without live customer data.",
    },
    {
      id: "preflight-contract",
      mode: "contract-test",
      proves: "Preflight result states are stable and fail closed when evidence is missing.",
    },
    {
      id: "migration-dry-run-report",
      mode: "contract-test",
      proves: "Dry-run output includes compatibility, backup, migration plan, blocked reason, rollback, and support facts.",
    },
    {
      id: "rollback-drill-fixture",
      mode: "recovery-fixture",
      proves: "Rollback evidence is required before release or support describes a path as recoverable.",
    },
    {
      id: "compatibility-result-schema",
      mode: "schema",
      proves: "Compatibility results carry source/target/version/platform/provider support evidence and unsupported routing.",
    },
    {
      id: "support-troubleshooting-map",
      mode: "support-handoff",
      proves: "Support can route blocked, unsupported, manual-review, waived, or failed outcomes with owner and next action.",
    },
  ]),
  followUpGate: Object.freeze({
    rule:
      "Create M1/M2/M3/M4 Upgrade Test Suite design or implementation issues only after this M0 scope record and executable proof are accepted.",
  }),
});

export function canCreateUpgradeTestSuiteFollowUp({ phase, m0Accepted }) {
  if (!IMPLEMENTATION_PHASES.has(phase)) {
    return {
      allowed: true,
      reason: "Phase does not depend on the M0 Upgrade Test Suite gate.",
    };
  }

  if (m0Accepted) {
    return {
      allowed: true,
      reason: "M0 Upgrade Test Suite scope and acceptance evidence has been accepted.",
    };
  }

  return {
    allowed: false,
    reason: "M1/M2/M3/M4 follow-up issues wait for accepted M0 Upgrade Test Suite scope.",
  };
}

export function classifyUpgradeTestSuiteDecision(decision) {
  const text = String(decision ?? "").toLowerCase();

  if (/\b(upgrade migration|migration dry-run|dry-run engine|upgrade runner)\b/.test(text)) {
    return { owner: "Upgrade & Migration Engine", inScope: false };
  }
  if (/\b(compatibility matrix|browser compatibility|platform support|device matrix)\b/.test(text)) {
    return { owner: "Compatibility Matrix", inScope: false };
  }
  if (/\b(backup restore|restore drill|rollback drill|recovery drill)\b/.test(text)) {
    return { owner: "Backup & Restore", inScope: false };
  }
  if (/\b(bootstrap smoke|installer|first project|first deploy)\b/.test(text)) {
    return { owner: "Bootstrap Installer", inScope: false };
  }
  if (/\b(release notes|upgrade guide|known limitation|publication)\b/.test(text)) {
    return { owner: "V1 Release Notes & Upgrade Guide", inScope: false };
  }
  if (/\b(security verification|security waiver|customer data|secret handling)\b/.test(text)) {
    return { owner: "Security Verification", inScope: false };
  }
  if (/\b(support ticket|support automation|troubleshooting|sla)\b/.test(text)) {
    return { owner: "Support Workflow", inScope: false };
  }

  return { owner: "Upgrade Test Suite", inScope: true };
}

export function validateUpgradeTestSuiteScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-433") {
    errors.push("Scope record must be tied to HOBO-433.");
  }
  if (scope.phase !== "M0") {
    errors.push("Scope record must remain an M0 acceptance record.");
  }
  if (!scope.goal?.toLowerCase().includes("upgrade test suite")) {
    errors.push("Goal must name Upgrade Test Suite.");
  }
  if ((scope.personas ?? []).length < 5) {
    errors.push("At least five primary personas are required.");
  }
  if ((scope.scopeIn ?? []).length < 5) {
    errors.push("Scope in must record at least five launch-critical entries.");
  }
  if ((scope.scopeOut ?? []).length < 6) {
    errors.push("Scope out must reject adjacent implementation work.");
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
  for (const field of REQUIRED_UPGRADE_EVIDENCE) {
    if (!scope.requiredEvidence?.some((entry) => entry.id === field)) {
      errors.push(`Missing required upgrade evidence: ${field}.`);
    }
  }
  for (const evidence of scope.m1Evidence ?? []) {
    if (!evidence.mode || !evidence.proves) {
      errors.push(`Evidence ${evidence.id ?? "<unknown>"} must name proof mode and proof.`);
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
