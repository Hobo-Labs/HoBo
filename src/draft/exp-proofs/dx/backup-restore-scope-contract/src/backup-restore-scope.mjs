export const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"];

const VALID_PROOF_MODES = new Set([
  "design-record",
  "contract-test",
  "drill-fixture",
  "recovery-matrix",
  "support-handoff",
  "security-review",
]);

const FOLLOW_UP_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = [
  /production backup storage/i,
  /live customer restore/i,
  /restore execution/i,
  /backup service/i,
  /restore service/i,
  /cross-region scheduler/i,
  /snapshot scheduler/i,
  /provision/i,
  /customer data recovery implementation/i,
  /compliance approval/i,
  /legal approval/i,
  /cloud storage backend/i,
  /live customer data/i,
];

export const BACKUP_RESTORE_SCOPE = {
  issue: "HOBO-429",
  project: "Backup & Restore",
  phase: "M0",
  goal:
    "Define Backup and Restore productization scope so backup sources, restore paths, RPO/RTO expectations, drill evidence, failure recovery, and support/compliance handoffs are accepted before M1 design and contract proof work begins.",
  personas: [
    {
      role: "platform engineer",
      need: "Know which platform data sets and restore paths later design work must prove before launch readiness claims depend on them.",
    },
    {
      role: "sre operator",
      need: "Run or review deterministic backup/restore drills with explicit RPO/RTO, failure, rollback, and escalation evidence.",
    },
    {
      role: "support engineer",
      need: "Route failed backup or restore cases with customer-safe state, owner, limitation, and next-action evidence.",
    },
    {
      role: "security/compliance reviewer",
      need: "Review retention, encryption, access, audit, and customer-assurance boundaries without approving a production recovery program in M0.",
    },
    {
      role: "customer admin",
      need: "Understand what HoBo can claim about recovery readiness, which evidence backs it, and which states remain unsupported.",
    },
  ],
  scopeIn: [
    "Accepted backup-source inventory covering control-plane metadata, deployment state, artifact/provenance records, audit exports, configuration, and support bundles.",
    "Restore-path matrix for SaaS, self-host, and local/dev launch contexts with named owners, restore target, unsupported states, and evidence source.",
    "RPO/RTO drill evidence contract naming fixture inputs, expected outputs, measurement window, pass/fail rule, and rollback or escalation handoff.",
    "Failure-mode and recovery register for missing backup, stale backup, corrupted backup, partial restore, permission denial, and unsupported customer-data restore.",
    "Explicit boundary between Backup & Restore, Provenance & Retention, Upgrade & Migration Engine, Support Workflow, Compliance Evidence Pack, and release cutline ownership.",
    "Follow-up gate that blocks M1-M4 implementation issues until M0 scope and acceptance are recorded.",
  ],
  scopeOut: [
    "No production backup storage, cloud storage backend, snapshot scheduler, cross-region replication, or backup service runtime.",
    "No live customer restore execution, customer data recovery implementation, production restore service, or destructive restore path.",
    "No upgrade rollback runner, migration engine, compatibility matrix calculation, or release-channel automation.",
    "No legal, privacy, compliance, DPA, or customer-assurance approval beyond naming required evidence and owners.",
    "No ticketing system, incident automation, support queue, or SLA workflow implementation.",
    "No M1-M4 design or implementation issue creation before M0 acceptance is recorded.",
  ],
  nonGoals: [
    "Replace provenance retention, upgrade dry-run, launch support, or legal/privacy readiness records.",
    "Build production restore tooling, backup scheduling, object storage integration, or regional failover.",
    "Claim production restore readiness before deterministic drill fixtures prove the launch path.",
    "Use live customer data, destructive recovery operations, or unsupported production dependencies in M0.",
  ],
  boundaries: {
    service:
      "Backup & Restore M0 defines accepted data sets, restore paths, drill evidence, failure modes, and owner boundaries; it does not build backup storage or restore services.",
    ux:
      "UX scope is the future status, limitation, and recovery evidence contract a customer or operator can read, not a restore UI or dashboard implementation.",
    security:
      "Security scope names retention, encryption, access, audit, and customer-assurance evidence without approving compliance posture or touching live customer data.",
    support:
      "Support receives recovery-state routing, failure classification, limitation, owner, and escalation evidence; support queues and remediation execution remain separate.",
  },
  dependencies: [
    {
      source: "docs/design/reliability-observability-cost.md#plan-05",
      reason: "Defines reliability, HA, SLO, and operational-readiness language consumed by backup/restore evidence.",
    },
    {
      source: "docs/design/data-plane.md#plan-11",
      reason: "Defines event-log, replay, and projection behavior that restore evidence must not overclaim.",
    },
    {
      source: "docs/design/provenance-retention.md",
      reason: "Defines artifact retention and audit evidence that must be distinguished from product backups.",
    },
    {
      source: "docs/design/bootstrap-installer.md",
      reason: "Defines SaaS, self-host, and local/dev setup modes whose recovery paths need later drill evidence.",
    },
    {
      source: "docs/design/launch-support-escalation.md",
      reason: "Defines support escalation and communication surfaces that consume failed backup/restore handoffs.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0082",
      reason: "Pins Golden Suites as launch evidence gates; backup/restore drills feed that readiness lane.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Backup & Restore",
      consumes: "Owns accepted backup-source inventory, restore-path matrix, RPO/RTO drill evidence, failure register, and follow-up gate.",
      scopeBoundary: "This issue defines scope and acceptance; it does not build backup storage or run restores.",
    },
    {
      owner: "Provenance & Retention",
      consumes: "Provides retained artifact and audit evidence used to distinguish recoverable artifacts from product backup scope.",
      scopeBoundary: "Retention classes, provenance attestations, and audit exports stay in Provenance & Retention.",
    },
    {
      owner: "Upgrade & Migration Engine",
      consumes: "Consumes restore/rollback evidence for upgrade dry-run and migration compatibility planning.",
      scopeBoundary: "Upgrade rollback, migration planning, and compatibility calculations stay in Upgrade & Migration Engine.",
    },
    {
      owner: "Support Workflow",
      consumes: "Uses failure-mode routing, recovery state, and escalation evidence for support handoff.",
      scopeBoundary: "Ticket queues, SLA commitments, public incident communication, and remediation execution stay in support initiatives.",
    },
    {
      owner: "Compliance Evidence Pack",
      consumes: "Uses backup/restore evidence, limitations, and audit posture for customer assurance readiness.",
      scopeBoundary: "Legal approval, DPA terms, compliance claims, and customer assurance publication stay outside this M0 record.",
    },
    {
      owner: "V1 Release Program & Cutline",
      consumes: "Uses the accepted M0 record to decide when M1-M4 backup/restore proof issues may be created.",
      scopeBoundary: "Release go/no-go, launch claims, and downstream issue creation remain release-program scope.",
    },
  ],
  backupSources: [
    {
      id: "control-plane-metadata",
      owner: "platform engineer",
      restoreTarget: "Yard control-plane state",
      customerVisible: true,
    },
    {
      id: "deployment-state",
      owner: "sre operator",
      restoreTarget: "deployment and resource state projections",
      customerVisible: true,
    },
    {
      id: "artifact-provenance",
      owner: "security/compliance reviewer",
      restoreTarget: "retained artifact lineage and provenance records",
      customerVisible: true,
    },
    {
      id: "audit-export",
      owner: "security/compliance reviewer",
      restoreTarget: "governance and support audit evidence",
      customerVisible: false,
    },
    {
      id: "support-bundle",
      owner: "support engineer",
      restoreTarget: "redacted support/debug context",
      customerVisible: false,
    },
  ],
  restorePaths: [
    {
      id: "saas-control-plane-restore",
      user: "sre operator",
      target: "hosted control-plane metadata and projections",
      unsupported: "Tenant data recovery without accepted backup drill evidence.",
    },
    {
      id: "self-host-yard-restore",
      user: "platform engineer",
      target: "self-host Yard state from operator-owned backup evidence",
      unsupported: "Managed restore into an unknown customer environment.",
    },
    {
      id: "local-dev-fixture-restore",
      user: "app developer",
      target: "fixture-only local/dev state for documentation and tests",
      unsupported: "Production parity claim or destructive local recovery.",
    },
  ],
  m1Evidence: [
    {
      kind: "backup-source-inventory",
      owner: "platform engineer",
      proofMode: "design-record",
      source: "docs/design/backup-restore.md#backup-source-inventory",
      proves: "Each accepted backup source names owner, restore target, customer visibility, and excluded implementation scope.",
    },
    {
      kind: "restore-path-matrix",
      owner: "sre operator",
      proofMode: "recovery-matrix",
      source: "docs/design/backup-restore.md#restore-path-matrix",
      proves: "SaaS, self-host, and local/dev restore paths name target, evidence source, unsupported states, and owner.",
    },
    {
      kind: "rpo-rto-drill-fixture",
      owner: "sre operator",
      proofMode: "drill-fixture",
      source: "docs/design/backup-restore.md#evidence-required-for-m1",
      proves: "M1 drill can measure RPO/RTO with deterministic fixture input, output, and pass/fail rules.",
    },
    {
      kind: "failure-mode-recovery-register",
      owner: "support engineer",
      proofMode: "contract-test",
      source: "docs/design/backup-restore.md#failure-mode-and-recovery-register",
      proves: "Missing, stale, corrupt, partial, denied, and unsupported recovery states route safely.",
    },
    {
      kind: "support-compliance-handoff",
      owner: "security/compliance reviewer",
      proofMode: "support-handoff",
      source: "docs/design/backup-restore.md#owning-initiative-dependencies",
      proves: "Support and compliance can consume backup/restore limitations without approving final claims.",
    },
    {
      kind: "rollback-cleanup-boundary",
      owner: "platform engineer",
      proofMode: "security-review",
      source: "docs/design/backup-restore.md#scope-out-and-non-goals",
      proves: "Rollback, migration, cleanup, scheduler, storage, and live restore work stay in owning follow-up issues.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 design or implementation issues must not be created until this Backup & Restore scope record is accepted.",
  },
};

export function canCreateBackupRestoreFollowUp({ phase, m0Accepted }) {
  return Boolean(m0Accepted) && FOLLOW_UP_PHASES.has(phase);
}

export function classifyBackupRestoreDecision(decision) {
  const text = String(decision ?? "").toLowerCase();

  if (/\b(upgrade|migration|rollback runner|compatibility)\b/.test(text)) {
    return { owner: "Upgrade & Migration Engine", inScope: false };
  }

  if (/\b(provenance|retention|artifact lineage|release artifact)\b/.test(text)) {
    return { owner: "Provenance & Retention", inScope: false };
  }

  if (/\b(support ticket|escalation|incident communication|sla)\b/.test(text)) {
    return { owner: "Support Workflow", inScope: false };
  }

  if (/\b(dpa|legal|privacy|compliance approval|customer assurance)\b/.test(text)) {
    return { owner: "Compliance Evidence Pack", inScope: false };
  }

  return { owner: "Backup & Restore", inScope: true };
}

export function validateBackupRestoreScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-429") {
    errors.push("issue must be HOBO-429");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  for (const term of ["backup and restore", "rpo", "rto"]) {
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
    "docs/design/reliability-observability-cost.md#plan-05",
    "docs/design/data-plane.md#plan-11",
    "docs/design/provenance-retention.md",
    "docs/design/bootstrap-installer.md",
    "docs/design/launch-support-escalation.md",
    "docs/design/adr/02-identity-security.md#adr-0082",
  ];
  const sources = (scope.dependencies ?? []).map((dependency) => dependency.source);
  if (JSON.stringify(sources) !== JSON.stringify(requiredSources)) {
    errors.push("design dependencies must map to reliability, data-plane, provenance, bootstrap, support, and Golden Suites sources");
  }

  if ((scope.initiativeDependencies ?? []).length < 6) {
    errors.push("owning initiative dependencies must map to consuming productization projects");
  }
  for (const dependency of scope.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
    }
  }

  for (const source of ["control-plane-metadata", "deployment-state", "artifact-provenance"]) {
    if (!(scope.backupSources ?? []).some((entry) => entry.id === source)) {
      errors.push(`backup source missing: ${source}`);
    }
  }

  for (const path of ["saas-control-plane-restore", "self-host-yard-restore", "local-dev-fixture-restore"]) {
    if (!(scope.restorePaths ?? []).some((entry) => entry.id === path)) {
      errors.push(`restore path missing: ${path}`);
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
