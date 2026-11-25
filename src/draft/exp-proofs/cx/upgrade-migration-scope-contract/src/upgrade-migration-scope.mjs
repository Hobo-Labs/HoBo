const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const REQUIRED_M1_EVIDENCE = Object.freeze([
  "upgrade-scope-record",
  "compatibility-input-matrix",
  "migration-dry-run-contract",
  "rollback-evidence-fixture",
  "release-notes-support-handoff",
  "scope-boundary-register",
]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "upgrade runner",
    pattern: /\b(production upgrade runner|live upgrade runner|upgrade executor)\b/i,
  },
  {
    label: "migration execution",
    pattern: /\b(live schema migration|run migrations?|execute migrations?|data rewrite)\b/i,
  },
  {
    label: "rollback execution",
    pattern: /\b(rollback executor|execute rollback|restore rollback)\b/i,
  },
  {
    label: "backup restore",
    pattern: /\b(backup restore|restore execution|production restore)\b/i,
  },
  {
    label: "provider state",
    pattern: /\b(provider state rewrite|iac state rewrite|live provider state)\b/i,
  },
]);

export const REQUIRED_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

export const UPGRADE_MIGRATION_SCOPE = Object.freeze({
  issue: "HOBO-430",
  project: "Upgrade & Migration Engine",
  phase: "M0",
  goal:
    "Define the Upgrade & Migration Engine productization scope so upgrade paths, compatibility inputs, migration dry-runs, rollback evidence, and support handoffs have accepted M0 boundaries before design/build issues fan out.",
  personas: Object.freeze([
    {
      id: "release-owner",
      need: "Needs beta, RC, and GA upgrade gates with evidence links and explicit accepted risk boundaries.",
    },
    {
      id: "platform-engineer",
      need: "Needs compatibility and migration contracts before runtime, data, provider, or installer work starts.",
    },
    {
      id: "devops-operator",
      need: "Needs dry-run, backup prerequisite, rollback, and recovery evidence before self-host or hosted upgrades are attempted.",
    },
    {
      id: "support-operator",
      need: "Needs customer-safe upgrade status, blocker reasons, rollback guidance, and escalation ownership.",
    },
    {
      id: "security-compliance-reviewer",
      need: "Needs audit, backup, data handling, and unsupported-path evidence before customer upgrade promises are made.",
    },
  ]),
  scopeIn: Object.freeze([
    "Define upgrade path classes for hosted control plane, self-host Yard, local/dev runtime, SDK/package, and data-shape changes.",
    "Record compatibility matrix inputs, including current version, target version, component-host/WIT pins, manifest version, data schema posture, and provider/IaC state dependencies.",
    "Define migration dry-run output: preflight status, required backup evidence, migration plan summary, blocked reasons, rollback evidence, and support handoff.",
    "Map service, UX, security, and support boundaries for upgrade and migration claims.",
    "List M1 evidence required before downstream design/build issues can begin.",
  ]),
  scopeOut: Object.freeze([
    "No production upgrade runner, updater service, package manager publishing, or hosted rollout implementation.",
    "No live schema migration, data rewrite, provider/IaC state rewrite, or component-host upgrade execution.",
    "No backup restore implementation, rollback executor, disaster recovery runner, or customer data migration.",
    "No compatibility matrix UI, release notes publication, customer communication workflow, or support ticket automation.",
    "No tenant, billing, RBAC, marketplace, or installer behavior beyond named dependency boundaries.",
  ]),
  nonGoals: Object.freeze([
    "Replace data-plane schema versioning, adopt-in-place importers, component-host pinning, or distributed-artifact version policy.",
    "Approve any current upgrade path as customer-ready.",
    "Create M1, M2, M3, or M4 implementation issues before M0 scope and acceptance evidence is approved.",
  ]),
  boundaries: Object.freeze([
    {
      id: "service",
      owner: "Upgrade & Migration Engine",
      promise:
        "Owns upgrade path classes, dry-run contract shape, blocker taxonomy, rollback-evidence requirements, and M1 proof expectations; execution services are later work.",
    },
    {
      id: "ux",
      owner: "Compatibility Matrix / Release Notes",
      promise:
        "May later expose upgrade status, known limitations, and upgrade guides; this M0 record defines information architecture only.",
    },
    {
      id: "security",
      owner: "Security Verification / Compliance Evidence Pack",
      promise:
        "Consumes backup, data-handling, audit, and unsupported-path evidence without implementing credential, data, or restore operations.",
    },
    {
      id: "support",
      owner: "Support Workflow",
      promise:
        "Consumes blocked-path reasons, rollback guidance, escalation owner, and customer-safe limitations without adding ticketing automation.",
    },
  ]),
  designRefs: Object.freeze([
    "docs/design/release-notes-upgrade-guide.md",
    "docs/design/contracts-policy-flags.md#plan-29",
    "docs/design/data-plane.md#plan-32",
    "docs/design/wasm-runtime-wit.md#plan-20",
    "docs/design/walkthrough.md",
  ]),
  adrRefs: Object.freeze([
    "docs/design/adr/03-data-plane.md#adr-0032",
    "docs/design/adr/07-portability-extensibility.md#adr-0041",
    "docs/design/adr/07-portability-extensibility.md#adr-0057",
    "docs/design/adr/07-portability-extensibility.md#adr-0095",
  ]),
  initiativeDependencies: Object.freeze([
    {
      owner: "Compatibility Matrix",
      boundary:
        "Supplies supported version, platform, component-host, and provider compatibility inputs; UI and matrix engine work stay out.",
    },
    {
      owner: "Backup & Restore",
      boundary:
        "Supplies backup requirement and restore evidence expectations before upgrade execution; backup restore implementation stays out.",
    },
    {
      owner: "V1 Release Notes & Upgrade Guide",
      boundary:
        "Consumes upgrade limitations, rollback guidance, and customer-facing notes; publication and launch copy stay out.",
    },
    {
      owner: "Support Workflow",
      boundary:
        "Consumes blocked-path reason, escalation owner, and customer-safe troubleshooting text; support queues and SLAs stay out.",
    },
    {
      owner: "Provider/IaC State Owners",
      boundary:
        "Own provider and IaC state migration behavior, drift repair, and live state mutation; this M0 record only names handoff evidence.",
    },
    {
      owner: "Data Plane",
      boundary:
        "Owns schema versioning, expand/migrate/contract, replay rebuild, and data portability behavior; this issue records dry-run inputs only.",
    },
  ]),
  upgradePathClasses: Object.freeze([
    "hosted-control-plane",
    "self-host-yard",
    "local-dev-runtime",
    "sdk-package",
    "data-shape",
  ]),
  dryRunOutputs: Object.freeze([
    "preflight-status",
    "compatibility-inputs",
    "backup-requirement",
    "migration-plan-summary",
    "blocked-reasons",
    "rollback-evidence",
    "support-handoff",
  ]),
  m1Evidence: Object.freeze([
    {
      id: "upgrade-scope-record",
      owner: "release-owner",
      mode: "design-record",
      source: "docs/design/upgrade-migration-engine.md",
      proves: "Upgrade path classes, personas, boundaries, and non-goals are accepted.",
    },
    {
      id: "compatibility-input-matrix",
      owner: "platform-engineer",
      mode: "reference-fixture",
      source: "docs/design/upgrade-migration-engine.md#compatibility-inputs",
      proves: "Current and target versions, platform support, component-host pins, and provider dependencies are named before execution.",
    },
    {
      id: "migration-dry-run-contract",
      owner: "platform-engineer",
      mode: "contract-test",
      source: "docs/design/upgrade-migration-engine.md#migration-dry-run-output",
      proves: "Dry-run output contains preflight, backup, migration plan, blocked reason, rollback, and support facts.",
    },
    {
      id: "rollback-evidence-fixture",
      owner: "devops-operator",
      mode: "reference-fixture",
      source: "docs/design/upgrade-migration-engine.md#rollback-and-recovery-boundaries",
      proves: "Rollback evidence is required before support or release can describe an upgrade path as recoverable.",
    },
    {
      id: "release-notes-support-handoff",
      owner: "support-operator",
      mode: "support-handoff",
      source: "docs/design/release-notes-upgrade-guide.md",
      proves: "Release notes, upgrade guide, troubleshooting, and escalation inputs are named without publishing them in this slice.",
    },
    {
      id: "scope-boundary-register",
      owner: "security-compliance-reviewer",
      mode: "policy-fixture",
      source: "docs/design/upgrade-migration-engine.md#scope-out-and-non-goals",
      proves: "Live migration, rollback execution, backup restore, provider state mutation, UI, and support automation are routed out.",
    },
  ]),
  followUpGate: Object.freeze({
    rule:
      "Create M1/M2/M3/M4 upgrade and migration implementation issues only after this M0 scope record and executable proof are accepted.",
  }),
});

export function canCreateUpgradeMigrationFollowUp({ phase, m0Accepted }) {
  if (!IMPLEMENTATION_PHASES.has(phase)) {
    return {
      allowed: true,
      reason: "Phase does not depend on the M0 Upgrade & Migration Engine gate.",
    };
  }

  if (m0Accepted) {
    return {
      allowed: true,
      reason: "M0 Upgrade & Migration Engine scope and acceptance evidence has been accepted.",
    };
  }

  return {
    allowed: false,
    reason: "M1/M2/M3/M4 follow-up issues wait for accepted M0 upgrade and migration scope.",
  };
}

export function classifyUpgradeMigrationDecision(decision) {
  const text = String(decision ?? "").toLowerCase();

  if (/\b(backup restore|restore execution|backup drill|rpo|rto)\b/.test(text)) {
    return { owner: "Backup & Restore", inScope: false };
  }

  if (/\b(release notes|upgrade guide|customer upgrade|known limitation)\b/.test(text)) {
    return { owner: "V1 Release Notes & Upgrade Guide", inScope: false };
  }

  if (/\b(compatibility matrix ui|compatibility matrix engine|browser support matrix|platform matrix)\b/.test(text)) {
    return { owner: "Compatibility Matrix", inScope: false };
  }

  if (/\b(provider state|iac state|live provider|provisioned resource)\b/.test(text)) {
    return { owner: "Provider/IaC State Owners", inScope: false };
  }

  if (/\b(live schema migration|data rewrite|replay rebuild implementation|crypto-shred)\b/.test(text)) {
    return { owner: "Data Plane", inScope: false };
  }

  return { owner: "Upgrade & Migration Engine", inScope: true };
}

export function validateUpgradeMigrationScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-430") {
    errors.push("Scope record must be tied to HOBO-430.");
  }

  if (scope.phase !== "M0") {
    errors.push("Scope record must remain an M0 acceptance record.");
  }

  if (!/upgrade/i.test(scope.goal ?? "")) {
    errors.push("Goal must name upgrade.");
  }

  if (!/migration/i.test(scope.goal ?? "")) {
    errors.push("Goal must name migration.");
  }

  if ((scope.personas ?? []).length < 5) {
    errors.push("At least five personas are required.");
  }

  for (const boundary of REQUIRED_BOUNDARIES) {
    if (!scope.boundaries?.some((entry) => entry.id === boundary)) {
      errors.push(`Missing ${boundary} boundary.`);
    }
  }

  if ((scope.scopeIn ?? []).length < 5) {
    errors.push("Scope-in must list at least five accepted boundaries.");
  }

  if ((scope.scopeOut ?? []).length < 5) {
    errors.push("Scope-out must list at least five non-goals.");
  }

  for (const item of scope.scopeIn ?? []) {
    for (const { label, pattern } of FORBIDDEN_SCOPE_PATTERNS) {
      if (pattern.test(item)) {
        errors.push(`scope creep into ${label}: ${item}`);
      }
    }
  }

  for (const evidence of REQUIRED_M1_EVIDENCE) {
    if (!scope.m1Evidence?.some((entry) => entry.id === evidence)) {
      errors.push(`Missing M1 evidence: ${evidence}.`);
    }
  }

  for (const evidence of scope.m1Evidence ?? []) {
    if (!evidence.owner || !evidence.mode || !evidence.source || !evidence.proves) {
      errors.push(`Evidence ${evidence.id ?? "<unknown>"} must name owner, mode, source, and proof.`);
    }
  }

  for (const output of [
    "preflight-status",
    "compatibility-inputs",
    "backup-requirement",
    "migration-plan-summary",
    "blocked-reasons",
    "rollback-evidence",
    "support-handoff",
  ]) {
    if (!scope.dryRunOutputs?.includes(output)) {
      errors.push(`Missing dry-run output: ${output}.`);
    }
  }

  if (!scope.followUpGate?.rule) {
    errors.push("Follow-up gate rule is required.");
  }

  return { ok: errors.length === 0, errors };
}
