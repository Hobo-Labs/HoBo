import { isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export const REQUIRED_CONTEXTS = Object.freeze(["saas", "self-host", "local-dev"]);

const REQUIRED_DATA_SETS = Object.freeze([
  "control-plane-metadata",
  "deployment-state-projections",
  "artifact-provenance",
  "audit-export",
  "support-bundle",
]);

const REQUIRED_EVIDENCE_FIELDS = Object.freeze([
  "data-set-id",
  "restore-path-id",
  "fixture-id",
  "started-at",
  "completed-at",
  "measured-rpo-minutes",
  "measured-rto-minutes",
  "pass-fail",
  "failure-mode-id",
  "rollback-or-escalation",
]);

const REQUIRED_FAILURE_MODES = Object.freeze([
  "missing-backup",
  "stale-backup",
  "corrupted-backup",
  "partial-restore",
  "permission-denied",
  "unsupported-customer-data-restore",
]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "production restore",
    pattern: /\b(production restore service|live customer restore execution|production recovery service)\b/i,
  },
  {
    label: "backup storage",
    pattern: /\b(cloud backup storage|snapshot scheduling|cross-region replication|backup storage backend)\b/i,
  },
  {
    label: "live customer data",
    pattern: /\b(live customer data|customer recovery data|destructive customer restore)\b/i,
  },
  {
    label: "compliance approval",
    pattern: /\b(final compliance approval|legal approval|dpa approval|compliance certification)\b/i,
  },
]);

type IdentifiedEntry = {
  readonly id: string;
};

type BackupRestoreDataSet = IdentifiedEntry & {
  readonly owner: string;
  readonly restoreTarget: string;
  readonly sourceEvidence: string;
};

type BackupRestoreEvidenceOutput = {
  readonly format: string;
  readonly fields: readonly string[];
};

type BackupRestorePath = IdentifiedEntry & {
  readonly context: string;
  readonly owner: string;
  readonly restoreTarget: string;
  readonly rpoMinutes: number;
  readonly rtoMinutes: number;
  readonly evidenceSource: string;
  readonly evidenceOutput: BackupRestoreEvidenceOutput;
  readonly rollbackPath: string;
  readonly unsupportedStates: readonly string[];
};

type BackupRestoreFailureMode = IdentifiedEntry & {
  readonly requiredRouting: string;
  readonly rollbackOrEscalation: string;
};

type BackupRestoreLaunchDrillLike = {
  readonly issue?: string;
  readonly phase?: string;
  readonly dataSets?: readonly BackupRestoreDataSet[];
  readonly restorePaths?: readonly BackupRestorePath[];
  readonly failureModes?: readonly BackupRestoreFailureMode[];
  readonly scopeIn?: readonly string[];
};

type ParsedBackupRestoreLaunchDrill = BackupRestoreLaunchDrillLike & {
  readonly issue: "HOBO-498";
  readonly phase: "M1";
  readonly dataSets: readonly BackupRestoreDataSet[];
  readonly restorePaths: readonly BackupRestorePath[];
  readonly failureModes: readonly BackupRestoreFailureMode[];
};

export const BACKUP_RESTORE_LAUNCH_DRILL = Object.freeze({
  issue: "HOBO-498",
  project: "Backup & Restore",
  phase: "M1",
  goal:
    "Define deterministic backup/restore launch-drill evidence for SaaS, self-host, and local/dev paths without claiming production restore readiness.",
  scopeIn: Object.freeze([
    "Define deterministic drill fixtures that name backup data sets, restore path, RPO/RTO targets, evidence output, failure modes, and rollback path.",
    "Distinguish SaaS, self-host, and local/dev launch contexts with separate evidence sources and unsupported states.",
    "Route discovered launch gaps to support, compliance/customer assurance, installation/bootstrap, or release notes owners.",
    "Gate any production restore readiness claim on successful deterministic drill evidence.",
  ]),
  scopeOut: Object.freeze([
    "No production backup storage service, cloud backup backend, snapshot scheduler, cross-region replication, or restore runner.",
    "No live customer restores, destructive recovery operations, customer-data recovery, or production restore service.",
    "No final legal, privacy, DPA, or compliance approval.",
    "No support ticket system, support queue, incident automation, or customer communication workflow implementation.",
  ]),
  dataSets: Object.freeze([
    {
      id: "control-plane-metadata",
      owner: "Platform Engineering",
      restoreTarget: "Hosted or self-host Yard control-plane metadata snapshot.",
      sourceEvidence: "Backup manifest fixture plus metadata checksum.",
    },
    {
      id: "deployment-state-projections",
      owner: "SRE",
      restoreTarget: "Deployment and resource state projections rebuilt from accepted backup input.",
      sourceEvidence: "Projection fixture plus replay cursor.",
    },
    {
      id: "artifact-provenance",
      owner: "Security / Compliance",
      restoreTarget: "Retained artifact lineage, SLSA/provenance, and signed descriptor records.",
      sourceEvidence: "Provenance bundle fixture and signature digest.",
    },
    {
      id: "audit-export",
      owner: "Governance",
      restoreTarget: "Governance and support audit evidence export.",
      sourceEvidence: "Redacted audit export fixture.",
    },
    {
      id: "support-bundle",
      owner: "Launch Support & Escalation",
      restoreTarget: "Customer-safe support/debug context for recovery handoff.",
      sourceEvidence: "Redacted support bundle fixture.",
    },
  ]),
  restorePaths: Object.freeze([
    {
      id: "saas-control-plane-drill",
      context: "saas",
      owner: "SRE",
      restoreTarget: "Hosted control-plane metadata and projection restore into an isolated drill Yard.",
      rpoMinutes: 15,
      rtoMinutes: 60,
      evidenceSource: "Hosted backup manifest fixture, drill transcript, and signed evidence packet.",
      evidenceOutput: Object.freeze({
        format: "backup-restore.drill-evidence/v1",
        fields: REQUIRED_EVIDENCE_FIELDS,
      }),
      rollbackPath: "Abort drill Yard, retain evidence packet, and route failed restore facts to Launch Support.",
      unsupportedStates: Object.freeze(["tenant data recovery", "destructive hosted production restore"]),
    },
    {
      id: "self-host-yard-drill",
      context: "self-host",
      owner: "Platform Engineering",
      restoreTarget: "Operator-owned self-host Yard state from packaged backup evidence.",
      rpoMinutes: 60,
      rtoMinutes: 240,
      evidenceSource: "Operator-provided backup fixture, installer version, and restore transcript.",
      evidenceOutput: Object.freeze({
        format: "backup-restore.drill-evidence/v1",
        fields: REQUIRED_EVIDENCE_FIELDS,
      }),
      rollbackPath: "Stop restore, preserve operator transcript, and route installer gaps to Bootstrap Installer.",
      unsupportedStates: Object.freeze(["managed restore into unknown customer environment", "production parity claim"]),
    },
    {
      id: "local-dev-fixture-drill",
      context: "local-dev",
      owner: "Developer Experience",
      restoreTarget: "Fixture-only local/dev state used by documentation and tests.",
      rpoMinutes: 5,
      rtoMinutes: 15,
      evidenceSource: "Fixture manifest and deterministic local restore transcript.",
      evidenceOutput: Object.freeze({
        format: "backup-restore.drill-evidence/v1",
        fields: REQUIRED_EVIDENCE_FIELDS,
      }),
      rollbackPath: "Delete fixture workspace and route documentation limitations to Release Notes.",
      unsupportedStates: Object.freeze(["production fidelity claim", "live customer recovery"]),
    },
  ]),
  failureModes: Object.freeze([
    {
      id: "missing-backup",
      requiredRouting: "Block restore claim and route to Launch Support plus release limitation.",
      rollbackOrEscalation: "Stop drill and record missing backup evidence gap.",
    },
    {
      id: "stale-backup",
      requiredRouting: "Report RPO breach and require explicit operator or release decision.",
      rollbackOrEscalation: "Abort readiness claim and route to Release Notes if unresolved.",
    },
    {
      id: "corrupted-backup",
      requiredRouting: "Block automated restore and require alternate backup or manual escalation.",
      rollbackOrEscalation: "Preserve corruption evidence for security/compliance review.",
    },
    {
      id: "partial-restore",
      requiredRouting: "Keep parent operation unsafe until rollback, cleanup, or operator handoff is recorded.",
      rollbackOrEscalation: "Run cleanup path or escalate to SRE owner.",
    },
    {
      id: "permission-denied",
      requiredRouting: "Fail closed and preserve audit evidence for security/compliance review.",
      rollbackOrEscalation: "Escalate to Customer Assurance / Legal Privacy boundary.",
    },
    {
      id: "unsupported-customer-data-restore",
      requiredRouting: "Mark unsupported and route to known limitation rather than best-effort recovery.",
      rollbackOrEscalation: "Route public limitation text to Release Notes & Upgrade Guide.",
    },
  ]),
  gapRoutes: Object.freeze([
    { id: "support", owner: "Launch Support & Escalation" },
    { id: "compliance", owner: "Customer Assurance / Legal Privacy" },
    { id: "installation", owner: "Bootstrap Installer" },
    { id: "release-notes", owner: "Release Notes & Upgrade Guide" },
  ]),
  designRefs: Object.freeze([
    "docs/design/backup-restore.md",
    "docs/design/bootstrap-installer.md",
    "docs/design/launch-support-escalation.md",
    "docs/design/customer-assurance-evidence-packet.md",
    "docs/design/release-notes-upgrade-guide.md",
  ]),
});

export function canClaimProductionRestoreReadiness({
  successfulDrillEvidence,
  usesLiveCustomerData,
}: {
  successfulDrillEvidence: boolean;
  usesLiveCustomerData: boolean;
}) {
  if (usesLiveCustomerData) {
    return {
      allowed: false,
      reason: "HOBO-498 drill proof cannot use live customer data or destructive customer restores.",
    };
  }
  if (!successfulDrillEvidence) {
    return {
      allowed: false,
      reason: "Production restore readiness waits for successful deterministic backup/restore drill evidence.",
    };
  }
  return {
    allowed: true,
    reason: "Successful deterministic drill evidence exists and does not rely on live customer data.",
  };
}

export function classifyBackupRestoreGap(gap: string) {
  const text = String(gap ?? "").toLowerCase();

  if (/\b(support|ticket|customer restore|escalation)\b/.test(text)) {
    return { owner: "Launch Support & Escalation", inScope: false };
  }
  if (/\b(compliance|dpa|legal|privacy|customer assurance)\b/.test(text)) {
    return { owner: "Customer Assurance / Legal Privacy", inScope: false };
  }
  if (/\b(installer|installation|bootstrap|self-host installer)\b/.test(text)) {
    return { owner: "Bootstrap Installer", inScope: false };
  }
  if (/\b(release notes|upgrade guide|limitation note|known limitation)\b/.test(text)) {
    return { owner: "Release Notes & Upgrade Guide", inScope: false };
  }

  return { owner: "Backup & Restore", inScope: true };
}

export function parseBackupRestoreLaunchDrill(input: JsonValue):
  | { ok: true; value: ParsedBackupRestoreLaunchDrill }
  | { ok: false; errors: readonly string[] } {
  if (!isRecord(input)) {
    return { ok: false, errors: ["Backup restore launch drill input must be an object."] };
  }

  // SAFETY: `const candidate = input as BackupRestoreLaunchDrillLike;` is required at this I/O or test boundary.
  const candidate = input as BackupRestoreLaunchDrillLike;
  const result = validateBackupRestoreLaunchDrill(candidate);

  if (!result.ok) {
    return result;
  }

  // SAFETY: `return { ok: true, value: candidate as ParsedBackupRestoreLaunchDrill };` is required at this I/O or test boundary.
  return { ok: true, value: candidate as ParsedBackupRestoreLaunchDrill };
}

export function validateBackupRestoreLaunchDrill(drill: BackupRestoreLaunchDrillLike) {
  const errors: string[] = [];

  if (drill.issue !== "HOBO-498") {
    errors.push("Launch drill contract must be tied to HOBO-498.");
  }
  if (drill.phase !== "M1") {
    errors.push("Launch drill contract must remain an M1 design and contract proof.");
  }

  for (const dataSet of REQUIRED_DATA_SETS) {
    const entry = drill.dataSets?.find((candidate) => candidate.id === dataSet);
    if (!entry) {
      errors.push(`Missing backup/restore data set: ${dataSet}.`);
      continue;
    }
    if (!entry.owner || !entry.restoreTarget || !entry.sourceEvidence) {
      errors.push(`Data set ${dataSet} must name owner, restore target, and source evidence.`);
    }
  }

  for (const context of REQUIRED_CONTEXTS) {
    const restorePath = drill.restorePaths?.find((candidate) => candidate.context === context);
    if (!restorePath) {
      errors.push(`Missing restore path for launch context: ${context}.`);
      continue;
    }
    if (!restorePath.restoreTarget) {
      errors.push(`Restore path ${restorePath.id} must name a restore target.`);
    }
    if (!Number.isFinite(restorePath.rpoMinutes) || restorePath.rpoMinutes <= 0) {
      errors.push(`Restore path ${restorePath.id} must set a positive RPO target.`);
    }
    if (!Number.isFinite(restorePath.rtoMinutes) || restorePath.rtoMinutes <= 0) {
      errors.push(`Restore path ${restorePath.id} must set a positive RTO target.`);
    }
    for (const field of REQUIRED_EVIDENCE_FIELDS) {
      if (!restorePath.evidenceOutput.fields.includes(field)) {
        errors.push(`Restore path ${restorePath.id} evidence output missing field: ${field}.`);
      }
    }
    if (!restorePath.rollbackPath) {
      errors.push(`Restore path ${restorePath.id} must name rollback path.`);
    }
  }

  for (const failureMode of REQUIRED_FAILURE_MODES) {
    const entry = drill.failureModes?.find((candidate) => candidate.id === failureMode);
    if (!entry) {
      errors.push(`Missing failure mode: ${failureMode}.`);
      continue;
    }
    if (!entry.requiredRouting || !entry.rollbackOrEscalation) {
      errors.push(`Failure mode ${failureMode} must name routing and rollback/escalation.`);
    }
  }

  for (const item of drill.scopeIn ?? []) {
    for (const { label, pattern } of FORBIDDEN_SCOPE_PATTERNS) {
      if (pattern.test(item)) {
        errors.push(`M1 scope-in includes out-of-scope ${label} work: ${item}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

function isRecord(input: JsonValue): input is JsonObject {
  return isJsonObject(input) && input !== null && !Array.isArray(input);
}
