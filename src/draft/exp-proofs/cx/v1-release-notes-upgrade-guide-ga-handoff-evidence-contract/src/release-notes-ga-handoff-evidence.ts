import { isJsonObject, type JsonValue } from "./json.js";
export type EvidenceStatus = "accepted" | "accepted-risk" | "missing";
export type ProofMode = "design-record" | "issue-state" | "manual-review" | "release-cutline";
export type BlockerState = "cleared" | "accepted-risk";
export type LaunchRiskEffect = "unchanged" | "reduced";
export type ReadinessDomain =
  | "documentation"
  | "release-cutline"
  | "operations-readiness"
  | "support"
  | "compatibility"
  | "migration";

export interface ReleaseNotesGaEvidenceItem {
  id: string;
  ownerProject: string;
  source: string;
  proofMode: ProofMode;
  status: EvidenceStatus;
  acceptanceBullet: string;
}

export interface ReleaseNotesGaBlocker {
  id: string;
  ownerProject: string;
  state: BlockerState;
  sourceEvidenceId: string;
  disposition: string;
}

export interface ReleaseNotesGaAcceptedRisk {
  id: string;
  ownerProject: string;
  mitigation: string;
  launchRiskEffect: LaunchRiskEffect;
}

export interface ReleaseNotesGaReleaseCutlineDependency {
  id: string;
  ownerProject: string;
  readinessDomain: ReadinessDomain;
  cutlineCategory: `v1-blocker.${string}`;
  source: string;
}

export interface ReleaseNotesGaMissingEvidence {
  id: string;
  ownerProject: string;
  reason: string;
}

export interface ReleaseNotesGaFollowUp {
  id: string;
  evidenceId: string;
  ownerProject: string;
  reason: string;
}

export interface ReleaseNotesGaInitiativeStatusGate {
  parentInitiative: "HoBo v1 Release Readiness";
  launchRiskChange: LaunchRiskEffect;
  statusUpdateRequired: boolean;
  updateSource: string;
}

export interface ReleaseNotesGaPublicClaimGuard {
  id: string;
  claim: string;
  evidenceId: string;
  disposition: "hold" | "draft" | "publish";
}

export interface ReleaseNotesGaHandoffEvidenceRecord {
  schema: string;
  issue: "HOBO-480";
  project: "V1 Release Notes & Upgrade Guide";
  phase: "M4";
  milestone: "M4 GA handoff";
  evidence: ReleaseNotesGaEvidenceItem[];
  blockers: ReleaseNotesGaBlocker[];
  acceptedRisks: ReleaseNotesGaAcceptedRisk[];
  releaseCutlineDependencies: ReleaseNotesGaReleaseCutlineDependency[];
  missingEvidence: ReleaseNotesGaMissingEvidence[];
  followUps: ReleaseNotesGaFollowUp[];
  initiativeStatus: ReleaseNotesGaInitiativeStatusGate;
  scopeOut: string[];
  publicClaimGuards: ReleaseNotesGaPublicClaimGuard[];
}

export type ParsedReleaseNotesGaHandoffEvidence = ReleaseNotesGaHandoffEvidenceRecord & {
  readonly parsedReleaseNotesGaHandoffEvidence: true;
};

export const releaseNotesGaHandoffEvidence: ReleaseNotesGaHandoffEvidenceRecord = {
  schema: "hobo.release-notes-ga-handoff-evidence/2026-06-30",
  issue: "HOBO-480",
  project: "V1 Release Notes & Upgrade Guide",
  phase: "M4",
  milestone: "M4 GA handoff",
  evidence: [
    {
      id: "m0-release-notes-outline-baseline",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      source: "docs/design/release-notes-upgrade-guide.md#proof",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "m3-release-candidate-handoff",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      source: "HOBO-473 / src/draft/v1-release-notes-upgrade-guide-release-candidate-evidence-contract",
      proofMode: "issue-state",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "final-release-notes-signoff",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      source: "HOBO-480",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Blockers and accepted risks are recorded.",
    },
    {
      id: "final-upgrade-guide-signoff",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      source: "docs/design/release-notes-upgrade-guide.md#m4-ga-handoff-evidence",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "release-cutline-ga-signoff",
      ownerProject: "V1 Release Program & Cutline",
      source: "docs/design/go-no-go-decision-record.md",
      proofMode: "release-cutline",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "install-path-ga-smoke-evidence",
      ownerProject: "Bootstrap Installer",
      source: "docs/design/bootstrap-installer.md",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "compatibility-known-limitation-register",
      ownerProject: "Compatibility Matrix",
      source: "docs/design/compatibility-matrix.md",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Blockers and accepted risks are recorded.",
    },
    {
      id: "upgrade-rollback-ga-evidence",
      ownerProject: "Upgrade & Migration Engine",
      source: "docs/design/upgrade-migration-engine.md",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "support-contact-ga-handoff",
      ownerProject: "V1 Launch Support Desk & Escalation",
      source: "docs/design/launch-support-escalation.md#m3-release-candidate-evidence",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "docs-portal-publication-handoff",
      ownerProject: "Docs Portal",
      source: "docs/design/docs-portal.md",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "The parent HoBo v1 Release Readiness initiative status is updated if this gate changes launch risk.",
    },
  ],
  blockers: [
    {
      id: "ga-release-notes-handoff-gap",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      state: "cleared",
      sourceEvidenceId: "final-release-notes-signoff",
      disposition:
        "The HOBO-473 missing GA handoff gap is cleared for release-owner review by this M4 evidence record.",
    },
    {
      id: "final-publication-owned-outside-proof",
      ownerProject: "Docs Portal",
      state: "accepted-risk",
      sourceEvidenceId: "docs-portal-publication-handoff",
      disposition:
        "Publication mechanics and customer communication remain owner-run launch operations; this proof records the handoff evidence, not the delivery system.",
    },
  ],
  acceptedRisks: [
    {
      id: "source-evidence-refresh-window",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      mitigation:
        "Any post-signoff change to compatibility, install, support, or rollback evidence must update the release-note record before launch copy changes.",
      launchRiskEffect: "unchanged",
    },
    {
      id: "known-limitation-wording-window",
      ownerProject: "Compatibility Matrix",
      mitigation:
        "Known limitations can ship only with owner-approved customer wording and source evidence links; unsupported claims stay held.",
      launchRiskEffect: "unchanged",
    },
  ],
  releaseCutlineDependencies: [
    {
      id: "final-release-note-readiness",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      readinessDomain: "documentation",
      cutlineCategory: "v1-blocker.documentation",
      source: "docs/design/release-notes-upgrade-guide.md#m4-ga-handoff-evidence",
    },
    {
      id: "release-owner-ga-signoff",
      ownerProject: "V1 Release Program & Cutline",
      readinessDomain: "release-cutline",
      cutlineCategory: "v1-blocker.release-cutline",
      source: "docs/design/go-no-go-decision-record.md",
    },
    {
      id: "install-path-ga-readiness",
      ownerProject: "Bootstrap Installer",
      readinessDomain: "operations-readiness",
      cutlineCategory: "v1-blocker.operations-readiness",
      source: "docs/design/bootstrap-installer.md",
    },
    {
      id: "support-contact-ga-readiness",
      ownerProject: "V1 Launch Support Desk & Escalation",
      readinessDomain: "support",
      cutlineCategory: "v1-blocker.support",
      source: "docs/design/launch-support-escalation.md#m3-release-candidate-evidence",
    },
    {
      id: "compatibility-ga-readiness",
      ownerProject: "Compatibility Matrix",
      readinessDomain: "compatibility",
      cutlineCategory: "v1-blocker.productization",
      source: "docs/design/compatibility-matrix.md",
    },
    {
      id: "upgrade-rollback-ga-readiness",
      ownerProject: "Upgrade & Migration Engine",
      readinessDomain: "migration",
      cutlineCategory: "v1-blocker.productization",
      source: "docs/design/upgrade-migration-engine.md",
    },
  ],
  missingEvidence: [],
  followUps: [],
  initiativeStatus: {
    parentInitiative: "HoBo v1 Release Readiness",
    launchRiskChange: "reduced",
    statusUpdateRequired: true,
    updateSource:
      "HOBO-480 records M4 release-note and upgrade-guide GA handoff evidence, clears the HOBO-473 missing GA handoff gap, and keeps publication mechanics outside this proof.",
  },
  scopeOut: [
    "No final release notes, docs portal publication, customer email, customer-facing compatibility guarantee, zero-downtime upgrade promise, support response-time promise, or GA release decision is implemented in this proof package.",
    "No docs portal, release automation, customer communication workflow, upgrade engine, compatibility harness, support workflow, runtime launch gate, or customer-notification service is implemented.",
    "No unsupported compatibility, upgrade, all-platform, all-install-path, support SLA, or release-readiness claim is promoted without source evidence.",
  ],
  publicClaimGuards: [],
};

export function validateReleaseNotesGaHandoffEvidence(record: JsonValue) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["release notes GA handoff evidence record is required"] };
  }

  // SAFETY: `const value = record as Partial<ReleaseNotesGaHandoffEvidenceRecord>;` is required at this I/O or test boundary.
  const value = record as Partial<ReleaseNotesGaHandoffEvidenceRecord>;
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  const blockers = Array.isArray(value.blockers) ? value.blockers : [];
  const acceptedRisks = Array.isArray(value.acceptedRisks) ? value.acceptedRisks : [];
  const releaseCutlineDependencies = Array.isArray(value.releaseCutlineDependencies)
    ? value.releaseCutlineDependencies
    : [];
  const missingEvidence = Array.isArray(value.missingEvidence) ? value.missingEvidence : [];
  const followUps = Array.isArray(value.followUps) ? value.followUps : [];
  const scopeOut = Array.isArray(value.scopeOut) ? value.scopeOut : [];
  const publicClaimGuards = Array.isArray(value.publicClaimGuards) ? value.publicClaimGuards : [];

  if (value.issue !== "HOBO-480") errors.push("issue must be HOBO-480");
  if (value.phase !== "M4") errors.push("phase must be M4");
  if (value.milestone !== "M4 GA handoff") errors.push("milestone must be M4 GA handoff");
  if (!Array.isArray(value.evidence)) errors.push("evidence must be an array");
  if (!Array.isArray(value.blockers)) errors.push("blockers must be an array");
  if (!Array.isArray(value.acceptedRisks)) errors.push("accepted risks must be an array");
  if (!Array.isArray(value.releaseCutlineDependencies)) errors.push("release cutline dependencies must be an array");
  if (!Array.isArray(value.missingEvidence)) errors.push("missing evidence must be an array");
  if (!Array.isArray(value.followUps)) errors.push("follow-ups must be an array");
  if (!Array.isArray(value.scopeOut)) errors.push("scope-out guards must be an array");
  if (!Array.isArray(value.publicClaimGuards)) errors.push("public claim guards must be an array");
  if (evidence.length < 8) errors.push("M4 release-note evidence must contain at least eight owner-mapped entries");

  for (const item of evidence) {
    if (!item.id || !item.ownerProject || !item.source || !item.acceptanceBullet) {
      errors.push(`${item.id ?? "<missing>"} evidence requires id, ownerProject, source, and acceptanceBullet`);
    }
  }

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));

  if (blockers.length < 2) {
    errors.push("blockers must record at least two GA release-note entries");
  }
  for (const blocker of blockers) {
    if (!blocker.id || !blocker.ownerProject || !blocker.sourceEvidenceId || !blocker.disposition) {
      errors.push(`${blocker.id ?? "<missing>"} blocker requires owner, sourceEvidenceId, and disposition`);
    }
    if (blocker.sourceEvidenceId && !evidenceById.has(blocker.sourceEvidenceId)) {
      errors.push(`${blocker.id ?? "<missing>"} blocker cites unknown evidence ${blocker.sourceEvidenceId}`);
    }
  }

  if (acceptedRisks.length < 2) {
    errors.push("accepted risks must record at least two GA release-note entries");
  }
  for (const risk of acceptedRisks) {
    if (!risk.id || !risk.ownerProject || !risk.mitigation || !risk.launchRiskEffect) {
      errors.push(`${risk.id ?? "<missing>"} risk requires owner, mitigation, and launchRiskEffect`);
    }
  }

  if (releaseCutlineDependencies.length < 6) {
    errors.push("release cutline dependencies must map at least six readiness domains");
  }
  for (const dependency of releaseCutlineDependencies) {
    if (!dependency.id || !dependency.ownerProject || !dependency.source) {
      errors.push(`${dependency.id ?? "<missing>"} dependency requires id, ownerProject, and source`);
    }
    if (!dependency.cutlineCategory?.startsWith("v1-blocker.")) {
      errors.push(`${dependency.id ?? "<missing>"} dependency must cite a v1-blocker cutline category`);
    }
  }

  const missingEvidenceById = new Map(missingEvidence.map((item) => [item.id, item]));
  for (const followUp of followUps) {
    if (!followUp.id || !followUp.evidenceId || !followUp.ownerProject || !followUp.reason) {
      errors.push(`${followUp.id ?? "<missing>"} follow-up requires id, evidenceId, ownerProject, and reason`);
      continue;
    }
    if (!missingEvidenceById.has(followUp.evidenceId)) {
      errors.push(`${followUp.id}: follow-up execution issues require missing evidence`);
    }
  }

  if (!value.initiativeStatus) {
    errors.push("initiative status gate is required");
  } else {
    const statusRequiresUpdate =
      value.initiativeStatus.statusUpdateRequired || value.initiativeStatus.launchRiskChange !== "unchanged";
    if (statusRequiresUpdate && !value.initiativeStatus.updateSource) {
      errors.push("initiative status update source is required");
    }
  }

  for (const text of scopeOut) {
    if (/^\s*(publish|ship|release|approve)\b.*\bfinal release notes?\b/i.test(text)) {
      errors.push("final release-note publication is scope-out");
    }
    if (
      /^\s*(implement|build|create|ship|enable|publish)\b.*\b(docs portal|customer email|customer communication|customer notification)\b/i.test(
        text,
      )
    ) {
      errors.push("docs portal or customer communication implementation is scope-out");
    }
    if (/\b(guarantee|promise|claim|approve)\b.*\b(all browsers|all platforms|compatible|compatibility)\b/i.test(text)) {
      errors.push("unsupported compatibility guarantee is scope-out");
    }
    if (/^\s*(promise|guarantee|claim|approve)\b.*\b(zero[- ]downtime|every install path|all upgrade paths|upgrade)\b/i.test(text)) {
      errors.push("unsupported upgrade guarantee is scope-out");
    }
    if (/^\s*(approve|promise|publish|commit|guarantee)\b.*\b(SLA|support response|response-time|support promise)\b/i.test(text)) {
      errors.push("support promise is scope-out");
    }
  }

  for (const guard of publicClaimGuards) {
    if (!guard.id || !guard.claim || !guard.evidenceId || !guard.disposition) {
      errors.push(`${guard.id ?? "<missing>"} public claim guard requires id, claim, evidenceId, and disposition`);
      continue;
    }
    if (
      guard.disposition === "publish" &&
      /\b(GA-ready|general availability|all platforms|all browsers|zero[- ]downtime|all upgrade paths|SLA|support response|compatible)\b/i.test(
        guard.claim,
      )
    ) {
      errors.push(`${guard.id}: unsupported public release-note claim`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function parseReleaseNotesGaHandoffEvidence(
  record = releaseNotesGaHandoffEvidence,
): ParsedReleaseNotesGaHandoffEvidence {
  const parsed = assertReleaseNotesGaHandoffEvidence(record);

  return Object.freeze({
    ...parsed,
    parsedReleaseNotesGaHandoffEvidence: true as const,
  });
}

export function assertReleaseNotesGaHandoffEvidence(record = releaseNotesGaHandoffEvidence) {
  const result = validateReleaseNotesGaHandoffEvidence(record);

  if (!result.ok) {
    throw new Error(`release notes GA handoff evidence invalid:\n${result.errors.join("\n")}`);
  }

  return record;
}
