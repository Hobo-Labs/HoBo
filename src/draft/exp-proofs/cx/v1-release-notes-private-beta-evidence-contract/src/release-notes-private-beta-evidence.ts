import { isJsonBoolean, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export const REQUIRED_PRIVATE_BETA_EVIDENCE = [
  "release-notes-private-beta-outline",
  "release-cutline-private-beta-delta",
  "upgrade-dry-run-private-beta-status",
  "upgrade-test-suite-private-beta-results",
  "beta-feedback-docs-gap-routing",
  "support-safe-escalation-coverage",
  "docs-copy-owner-and-limitation-register"
] as const;

export type PrivateBetaEvidenceId = (typeof REQUIRED_PRIVATE_BETA_EVIDENCE)[number];
export type EvidenceStatus = "accepted" | "accepted-substitute" | "missing";

export type RequiredEvidence = {
  readonly id: PrivateBetaEvidenceId;
  status: EvidenceStatus;
  readonly owningProject: string;
  readonly proofSource: readonly string[];
  readonly feeds: readonly string[];
};

// domain-view: parse-produced draft-proof record; its wire form is the RecordedBlocker proto message in data-models/.
export type RecordedBlocker = {
  readonly id: string;
  readonly status: "none-open" | "open" | "accepted-risk";
  readonly owner: string;
  readonly summary: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the AcceptedRisk proto message in data-models/.
export type AcceptedRisk = {
  readonly id: string;
  readonly owner: string;
  readonly mitigation: string;
  readonly revisitGate: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the ReleaseCutlineDependency proto message in data-models/.
export type ReleaseCutlineDependency = {
  readonly project: string;
  readonly issueOrRecord: string;
  readonly cutlineRole: string;
};

export type FollowUpIssue = {
  readonly id: string;
  readonly evidenceId: PrivateBetaEvidenceId;
  readonly owningProject: string;
  readonly reason: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the ReleaseNotesPrivateBetaEvidenceRecord proto message in data-models/.
export type ReleaseNotesPrivateBetaEvidenceRecord = {
  readonly issue: "HOBO-466";
  readonly project: "V1 Release Notes & Upgrade Guide";
  readonly phase: "M2";
  readonly milestoneGate: "M2 Private beta proof";
  readonly requiredEvidence: readonly RequiredEvidence[];
  readonly blockers: readonly RecordedBlocker[];
  readonly acceptedRisks: readonly AcceptedRisk[];
  readonly releaseCutline: {
    readonly ownerProject: "V1 Release Program & Cutline";
    readonly dependencies: readonly ReleaseCutlineDependency[];
  };
  readonly followUps: FollowUpIssue[];
  readonly parentInitiativeStatus: {
    readonly initiative: "HoBo v1 Release Readiness";
    readonly gateChangesLaunchRisk: boolean;
    statusUpdateEvidence: string;
  };
};

export const RELEASE_NOTES_PRIVATE_BETA_EVIDENCE: ReleaseNotesPrivateBetaEvidenceRecord = {
  issue: "HOBO-466",
  project: "V1 Release Notes & Upgrade Guide",
  phase: "M2",
  milestoneGate: "M2 Private beta proof",
  requiredEvidence: [
    {
      id: "release-notes-private-beta-outline",
      status: "accepted",
      owningProject: "V1 Release Notes & Upgrade Guide",
      proofSource: ["docs/design/release-notes-upgrade-guide.md", "HOBO-407"],
      feeds: ["release-summary", "known-limitations", "migration-notes"]
    },
    {
      id: "release-cutline-private-beta-delta",
      status: "accepted",
      owningProject: "V1 Release Program & Cutline",
      proofSource: ["HOBO-461"],
      feeds: ["release-summary", "cross-project-dependency-cutline"]
    },
    {
      id: "upgrade-dry-run-private-beta-status",
      status: "accepted-substitute",
      owningProject: "Upgrade & Migration Engine",
      proofSource: ["docs/design/upgrade-migration-engine.md", "HOBO-499"],
      feeds: ["upgrade-paths", "rollback-guidance"]
    },
    {
      id: "upgrade-test-suite-private-beta-results",
      status: "accepted-substitute",
      owningProject: "Upgrade Test Suite",
      proofSource: ["docs/design/upgrade-test-suite.md", "HOBO-433"],
      feeds: ["compatibility-matrix", "migration-notes"]
    },
    {
      id: "beta-feedback-docs-gap-routing",
      status: "accepted",
      owningProject: "V1 Beta Pilot & Feedback Loop",
      proofSource: ["docs/design/beta-pilot-feedback.md", "HOBO-404"],
      feeds: ["known-limitations", "follow-up-routing"]
    },
    {
      id: "support-safe-escalation-coverage",
      status: "accepted",
      owningProject: "Support Workflow",
      proofSource: ["docs/design/support-workflow.md", "docs/design/launch-support-escalation.md"],
      feeds: ["support-contacts", "rollback-guidance"]
    },
    {
      id: "docs-copy-owner-and-limitation-register",
      status: "accepted",
      owningProject: "V1 Docs",
      proofSource: ["docs/design/docs-portal.md", "docs/design/proofs/hobo-407-release-notes-upgrade-guide/index.md"],
      feeds: ["known-limitations", "customer-safe-copy-ownership"]
    }
  ],
  blockers: [
    {
      id: "private-beta-release-notes-blocker-register",
      status: "none-open",
      owner: "V1 Release Notes & Upgrade Guide",
      summary:
        "No release-notes-only private-beta blocker remains open; unsupported paths stay limitations until M3 evidence."
    }
  ],
  acceptedRisks: [
    {
      id: "private-beta-copy-is-not-final-release-copy",
      owner: "V1 Docs",
      mitigation: "Mark private-beta notes as evidence-backed draft guidance, not final launch copy.",
      revisitGate: "M3 Release candidate"
    },
    {
      id: "upgrade-guidance-limited-to-evidenced-paths",
      owner: "Release Engineering",
      mitigation: "Describe only upgrade paths with dry-run or accepted substitute evidence; route others to known limitations.",
      revisitGate: "M3 Release candidate"
    }
  ],
  releaseCutline: {
    ownerProject: "V1 Release Program & Cutline",
    dependencies: [
      {
        project: "V1 Release Notes & Upgrade Guide",
        issueOrRecord: "HOBO-466",
        cutlineRole: "private-beta evidence gate"
      },
      {
        project: "V1 Release Program & Cutline",
        issueOrRecord: "HOBO-461",
        cutlineRole: "parent cutline delta"
      },
      {
        project: "Upgrade & Migration Engine",
        issueOrRecord: "HOBO-499",
        cutlineRole: "upgrade dry-run support"
      },
      {
        project: "Upgrade Test Suite",
        issueOrRecord: "HOBO-433",
        cutlineRole: "upgrade fixture result source"
      },
      {
        project: "V1 Beta Pilot & Feedback Loop",
        issueOrRecord: "HOBO-404",
        cutlineRole: "docs gap and pilot-feedback routing"
      },
      {
        project: "Support Workflow",
        issueOrRecord: "docs/design/support-workflow.md",
        cutlineRole: "support-safe contact and escalation source"
      },
      {
        project: "V1 Docs",
        issueOrRecord: "docs/design/docs-portal.md",
        cutlineRole: "copy ownership and limitation register"
      }
    ]
  },
  followUps: [],
  parentInitiativeStatus: {
    initiative: "HoBo v1 Release Readiness",
    gateChangesLaunchRisk: true,
    statusUpdateEvidence: "HOBO-466 private-beta evidence accepted; launch risk moves with M2 release-note gate."
  }
};

export interface EvidenceValidation {
  ok: boolean;
  errors: string[];
}

export function validateReleaseNotesPrivateBetaEvidence(input: JsonValue): EvidenceValidation {
  // SAFETY: `const record = isRecord(input) ? input as Partial<ReleaseNotesPrivateBetaEvidenc` is required at this I/O or test boundary.
  const record = isRecord(input) ? input as Partial<ReleaseNotesPrivateBetaEvidenceRecord> : {};
  const errors: string[] = [];

  if (!isRecord(input)) {
    errors.push("evidence record must be an object");
  }
  if (record.issue !== "HOBO-466") {
    errors.push("issue must be HOBO-466");
  }
  if (record.phase !== "M2") {
    errors.push("phase must be M2");
  }
  if (record.milestoneGate !== "M2 Private beta proof") {
    errors.push("milestone gate must be M2 Private beta proof");
  }

  // SAFETY: `const requiredEvidence = objectArray(record.requiredEvidence, "requiredEvidence"` is required at this I/O or test boundary.
  const requiredEvidence = objectArray(record.requiredEvidence, "requiredEvidence", errors) as Partial<RequiredEvidence>[];
  const evidenceById = new Map(requiredEvidence.map((evidence) => [evidence.id, evidence]));
  const seenEvidenceIds = new Set<JsonValue>();
  for (const evidence of requiredEvidence) {
    const evidenceLabel = evidence.id ?? "<missing evidence>";
    if (seenEvidenceIds.has(evidence.id)) {
      errors.push(`duplicate required evidence: ${String(evidenceLabel)}`);
    }
    seenEvidenceIds.add(evidence.id);
    if (!isEvidenceStatus(evidence.status)) {
      errors.push(`${String(evidenceLabel)} must use a valid evidence status`);
    }
  }
  for (const evidenceId of REQUIRED_PRIVATE_BETA_EVIDENCE) {
    const evidence = evidenceById.get(evidenceId);
    if (!evidence) {
      errors.push(`missing required evidence: ${evidenceId}`);
      continue;
    }
    if (!evidence.owningProject) {
      errors.push(`${evidenceId} must name owningProject`);
    }
    if (!Array.isArray(evidence.proofSource) || evidence.proofSource.length === 0) {
      errors.push(`${evidenceId} must name proofSource`);
    }
    if (!Array.isArray(evidence.feeds) || evidence.feeds.length === 0) {
      errors.push(`${evidenceId} must name release-note sections or gates it feeds`);
    }
  }

  // SAFETY: `const blockers = objectArray(record.blockers, "blockers", errors) as Partial<Rec` is required at this I/O or test boundary.
  const blockers = objectArray(record.blockers, "blockers", errors) as Partial<RecordedBlocker>[];
  if (blockers.length === 0) {
    errors.push("blockers must be recorded even when none are open");
  }
  for (const blocker of blockers) {
    if (!blocker.owner || !blocker.summary) {
      errors.push(`${blocker.id ?? "<missing blocker>"} must name owner and summary`);
    }
  }

  // SAFETY: `const acceptedRisks = objectArray(record.acceptedRisks, "acceptedRisks", errors)` is required at this I/O or test boundary.
  const acceptedRisks = objectArray(record.acceptedRisks, "acceptedRisks", errors) as Partial<AcceptedRisk>[];
  if (acceptedRisks.length === 0) {
    errors.push("accepted risks must be recorded");
  }
  for (const risk of acceptedRisks) {
    if (!risk.owner || !risk.mitigation || !risk.revisitGate) {
      errors.push(`${risk.id ?? "<missing risk>"} must name owner, mitigation, and revisitGate`);
    }
  }

  const releaseCutline = isRecord(record.releaseCutline) ? record.releaseCutline : undefined;
  if (!releaseCutline) {
    errors.push("release cutline must be recorded");
  }
  const releaseCutlineDependenciesRaw = objectArray(
    releaseCutline?.dependencies,
    "releaseCutline.dependencies",
    errors
  );
  // SAFETY: `const releaseCutlineDependencies = releaseCutlineDependenciesRaw as Partial<ReleaseCutlineDependency>[];` is required at this I/O or test boundary.
  const releaseCutlineDependencies = releaseCutlineDependenciesRaw as Partial<ReleaseCutlineDependency>[];
  const cutlineProjects = new Set(releaseCutlineDependencies.map((dependency) => dependency.project));
  for (const evidence of requiredEvidence) {
    if (evidence.owningProject && !cutlineProjects.has(evidence.owningProject)) {
      errors.push(`release cutline is missing dependency project: ${evidence.owningProject}`);
    }
  }

  // SAFETY: `const followUps = objectArray(record.followUps, "followUps", errors) as Partial<` is required at this I/O or test boundary.
  const followUps = objectArray(record.followUps, "followUps", errors) as Partial<FollowUpIssue>[];
  for (const followUp of followUps) {
    const evidence = evidenceById.get(followUp.evidenceId);
    if (!evidence) {
      errors.push(`follow-up ${followUp.id} references unknown evidence ${followUp.evidenceId}`);
      continue;
    }
    if (isAcceptedEvidence(evidence.status)) {
      errors.push(`follow-up ${followUp.id} for ${followUp.evidenceId} already has accepted evidence`);
    }
    if (!followUp.owningProject || !followUp.reason) {
      errors.push(`follow-up ${followUp.id} must name owningProject and reason`);
    }
  }

  let parentInitiativeStatus: Partial<ReleaseNotesPrivateBetaEvidenceRecord["parentInitiativeStatus"]> | undefined;
  if (isRecord(record.parentInitiativeStatus)) {
    // SAFETY: `parentInitiativeStatus = record.parentInitiativeStatus as Partial<ReleaseNotesPrivateBetaEvidenceRecord["parentInitiativeStatus"]>` is required at this I/O or test boundary.
    parentInitiativeStatus = record.parentInitiativeStatus as Partial<
      ReleaseNotesPrivateBetaEvidenceRecord["parentInitiativeStatus"]
    >;
  }
  if (!parentInitiativeStatus) {
    errors.push("parent initiative status must be recorded");
  }
  if (parentInitiativeStatus?.initiative && parentInitiativeStatus.initiative !== "HoBo v1 Release Readiness") {
    errors.push("parent initiative must be HoBo v1 Release Readiness");
  }
  if (
    parentInitiativeStatus
    && !isJsonBoolean(parentInitiativeStatus.gateChangesLaunchRisk)
  ) {
    errors.push("gateChangesLaunchRisk must be boolean");
  }
  if (
    parentInitiativeStatus?.gateChangesLaunchRisk &&
    !parentInitiativeStatus.statusUpdateEvidence
  ) {
    errors.push("parent initiative status update evidence is required when launch risk changes");
  }

  return { ok: errors.length === 0, errors };
}

export function assertReleaseNotesPrivateBetaEvidence(input: JsonValue): ReleaseNotesPrivateBetaEvidenceRecord {
  const result = validateReleaseNotesPrivateBetaEvidence(input);
  if (!result.ok) {
    throw new Error(result.errors.join("\n"));
  }
  // SAFETY: `return input as ReleaseNotesPrivateBetaEvidenceRecord;` is required at this I/O or test boundary.
  return input as ReleaseNotesPrivateBetaEvidenceRecord;
}

export function canCompletePrivateBetaGate(input: JsonValue): boolean {
  const result = validateReleaseNotesPrivateBetaEvidence(input);
  if (!result.ok) {
    return false;
  }

  // SAFETY: `const record = input as ReleaseNotesPrivateBetaEvidenceRecord;` is required at this I/O or test boundary.
  const record = input as ReleaseNotesPrivateBetaEvidenceRecord;
  return (
    record.requiredEvidence.every((evidence) => isAcceptedEvidence(evidence.status)) &&
    record.blockers.every((blocker) => blocker.status !== "open") &&
    Boolean(record.parentInitiativeStatus.statusUpdateEvidence)
  );
}

function isAcceptedEvidence(status: EvidenceStatus): boolean {
  return status === "accepted" || status === "accepted-substitute";
}

function isEvidenceStatus(status: JsonValue): status is EvidenceStatus {
  return status === "accepted" || status === "accepted-substitute" || status === "missing";
}

function isRecord(value: JsonValue): value is JsonObject {
  return isJsonObject(value) && value !== null;
}

function objectArray(value: JsonValue, field: string, errors: string[]): JsonObject[] {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array`);
    return [];
  }

  const records: JsonObject[] = [];
  for (const [index, entry] of value.entries()) {
    if (isRecord(entry)) {
      records.push(entry);
    } else {
      errors.push(`${field}[${index}] must be an object`);
    }
  }
  return records;
}
