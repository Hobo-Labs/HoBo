import { isJsonObject, type JsonValue } from "./json.js";
export type EvidenceStatus = "accepted" | "accepted-risk" | "missing";
export type ProofMode = "design-record" | "issue-state" | "manual-review" | "docs-draft" | "cutline-review";
export type LaunchRiskEffect = "unchanged" | "increased" | "reduced";
export type BlockerState = "blocked" | "accepted-risk" | "cleared";
export type ReadinessDomain =
  | "documentation"
  | "release-cutline"
  | "operations-readiness"
  | "support"
  | "compatibility";

// domain-view: parse-produced draft-proof record; its wire form is the ReleaseNotesReleaseCandidateEvidenceItem proto message in data-models/.
export interface ReleaseNotesReleaseCandidateEvidenceItem {
  id: string;
  ownerProject: string;
  source: string;
  proofMode: ProofMode;
  status: EvidenceStatus;
  acceptanceBullet: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the ReleaseNotesReleaseCandidateBlocker proto message in data-models/.
export interface ReleaseNotesReleaseCandidateBlocker {
  id: string;
  ownerProject: string;
  state: BlockerState;
  sourceEvidenceId: string;
  disposition: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the ReleaseNotesReleaseCandidateAcceptedRisk proto message in data-models/.
export interface ReleaseNotesReleaseCandidateAcceptedRisk {
  id: string;
  ownerProject: string;
  mitigation: string;
  launchRiskEffect: LaunchRiskEffect;
}

// domain-view: parse-produced draft-proof record; its wire form is the ReleaseNotesReleaseCutlineDependency proto message in data-models/.
export interface ReleaseNotesReleaseCutlineDependency {
  id: string;
  ownerProject: string;
  readinessDomain: ReadinessDomain;
  cutlineCategory: `v1-blocker.${string}`;
  source: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the ReleaseNotesReleaseCandidateFollowUp proto message in data-models/.
export interface ReleaseNotesReleaseCandidateFollowUp {
  id: string;
  evidenceId: string;
  ownerProject: string;
  reason: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the ReleaseNotesInitiativeStatusGate proto message in data-models/.
export interface ReleaseNotesInitiativeStatusGate {
  parentInitiative: "HoBo v1 Release Readiness";
  launchRiskChange: LaunchRiskEffect;
  statusUpdateRequired: boolean;
  updateSource: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the ReleaseNotesPublicClaimGuard proto message in data-models/.
export interface ReleaseNotesPublicClaimGuard {
  id: string;
  claim: string;
  evidenceId: string;
  disposition: "hold" | "draft" | "publish";
}

// domain-view: parse-produced draft-proof record; its wire form is the ReleaseNotesReleaseCandidateEvidenceRecord proto message in data-models/.
export interface ReleaseNotesReleaseCandidateEvidenceRecord {
  schema: string;
  issue: "HOBO-473";
  project: "V1 Release Notes & Upgrade Guide";
  phase: "M3";
  milestone: "M3 Release candidate";
  evidence: ReleaseNotesReleaseCandidateEvidenceItem[];
  blockers: ReleaseNotesReleaseCandidateBlocker[];
  acceptedRisks: ReleaseNotesReleaseCandidateAcceptedRisk[];
  releaseCutlineDependencies: ReleaseNotesReleaseCutlineDependency[];
  followUps: ReleaseNotesReleaseCandidateFollowUp[];
  initiativeStatus: ReleaseNotesInitiativeStatusGate;
  scopeOut: string[];
  publicClaimGuards: ReleaseNotesPublicClaimGuard[];
}

export const releaseNotesReleaseCandidateEvidence: ReleaseNotesReleaseCandidateEvidenceRecord = {
  schema: "hobo.release-notes-release-candidate-evidence/2026-06-30",
  issue: "HOBO-473",
  project: "V1 Release Notes & Upgrade Guide",
  phase: "M3",
  milestone: "M3 Release candidate",
  evidence: [
    {
      id: "m0-outline-baseline",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      source: "docs/design/release-notes-upgrade-guide.md#proof",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "release-candidate-cutline",
      ownerProject: "V1 Release Program & Cutline",
      source: "src/draft/technical-proofs/v1-cutline-contract/README.md",
      proofMode: "cutline-review",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "release-candidate-notes-draft",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      source: "docs/design/release-notes-upgrade-guide.md#m3-release-candidate-evidence",
      proofMode: "docs-draft",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "install-path-smoke-map",
      ownerProject: "Bootstrap Installer",
      source: "docs/design/bootstrap-installer.md",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "upgrade-rollback-evidence-map",
      ownerProject: "Upgrade & Migration Engine",
      source: "docs/design/upgrade-migration-engine.md",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "compatibility-surface-map",
      ownerProject: "Compatibility Matrix",
      source: "docs/design/compatibility-matrix.md",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Blockers and accepted risks are recorded.",
    },
    {
      id: "support-contact-handoff",
      ownerProject: "V1 Launch Support Desk & Escalation",
      source: "docs/design/launch-support-escalation.md#m3-release-candidate-evidence",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "ga-release-notes-handoff-evidence",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      source: "HOBO-480",
      proofMode: "issue-state",
      status: "missing",
      acceptanceBullet: "Follow-up execution issues are created only where evidence is missing.",
    },
  ],
  blockers: [
    {
      id: "ga-release-notes-handoff-not-proven",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      state: "blocked",
      sourceEvidenceId: "ga-release-notes-handoff-evidence",
      disposition: "GA release-note and upgrade-guide handoff claims stay blocked until HOBO-480 records M4 evidence.",
    },
    {
      id: "final-customer-copy-held",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      state: "accepted-risk",
      sourceEvidenceId: "release-candidate-notes-draft",
      disposition: "M3 may record source-backed draft readiness, but final customer copy and publication wait for GA handoff.",
    },
  ],
  acceptedRisks: [
    {
      id: "release-candidate-copy-not-final",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      mitigation: "Use release-candidate evidence summaries only; keep final customer-facing notes in hold state.",
      launchRiskEffect: "unchanged",
    },
    {
      id: "upgrade-and-compatibility-evidence-window",
      ownerProject: "Upgrade & Migration Engine",
      mitigation: "List supported upgrade and compatibility claims only when their source evidence remains accepted.",
      launchRiskEffect: "unchanged",
    },
  ],
  releaseCutlineDependencies: [
    {
      id: "release-notes-draft-readiness",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      readinessDomain: "documentation",
      cutlineCategory: "v1-blocker.documentation",
      source: "docs/design/release-notes-upgrade-guide.md#m3-release-candidate-evidence",
    },
    {
      id: "release-candidate-owner-signoff",
      ownerProject: "V1 Release Program & Cutline",
      readinessDomain: "release-cutline",
      cutlineCategory: "v1-blocker.release-cutline",
      source: "src/draft/technical-proofs/v1-cutline-contract/README.md",
    },
    {
      id: "install-and-rollback-source-map",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      readinessDomain: "operations-readiness",
      cutlineCategory: "v1-blocker.operations-readiness",
      source: "docs/design/dogfood-yard.md",
    },
    {
      id: "support-contact-source-map",
      ownerProject: "V1 Launch Support Desk & Escalation",
      readinessDomain: "support",
      cutlineCategory: "v1-blocker.support",
      source: "docs/design/launch-support-escalation.md#m3-release-candidate-evidence",
    },
    {
      id: "compatibility-source-map",
      ownerProject: "Compatibility Matrix",
      readinessDomain: "compatibility",
      cutlineCategory: "v1-blocker.productization",
      source: "docs/design/compatibility-matrix.md",
    },
  ],
  followUps: [
    {
      id: "HOBO-480",
      evidenceId: "ga-release-notes-handoff-evidence",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      reason: "GA release-note and upgrade-guide handoff evidence remains explicitly missing after the M3 release-candidate gate.",
    },
  ],
  initiativeStatus: {
    parentInitiative: "HoBo v1 Release Readiness",
    launchRiskChange: "unchanged",
    statusUpdateRequired: true,
    updateSource: "HOBO-473 records release-candidate release-note evidence and keeps GA handoff claims blocked on HOBO-480.",
  },
  scopeOut: [
    "No final release notes, docs-portal publication, customer-facing compatibility guarantee, zero-downtime upgrade promise, support response-time promise, or GA release readiness claim is promoted from M3 evidence.",
    "No docs portal, release automation, customer email, upgrade engine, compatibility harness, support workflow, or runtime launch gate is implemented.",
  ],
  publicClaimGuards: [],
};

export function validateReleaseNotesReleaseCandidateEvidence(record: JsonValue) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["release notes release-candidate evidence record is required"] };
  }

  // SAFETY: `const value = record as Partial<ReleaseNotesReleaseCandidateEvidenceRecord>;` is required at this I/O or test boundary.
  const value = record as Partial<ReleaseNotesReleaseCandidateEvidenceRecord>;
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  const blockers = Array.isArray(value.blockers) ? value.blockers : [];
  const acceptedRisks = Array.isArray(value.acceptedRisks) ? value.acceptedRisks : [];
  const releaseCutlineDependencies = Array.isArray(value.releaseCutlineDependencies)
    ? value.releaseCutlineDependencies
    : [];
  const followUps = Array.isArray(value.followUps) ? value.followUps : [];
  const scopeOut = Array.isArray(value.scopeOut) ? value.scopeOut : [];
  const publicClaimGuards = Array.isArray(value.publicClaimGuards) ? value.publicClaimGuards : [];

  if (value.issue !== "HOBO-473") errors.push("issue must be HOBO-473");
  if (value.phase !== "M3") errors.push("phase must be M3");
  if (value.milestone !== "M3 Release candidate") errors.push("milestone must be M3 Release candidate");
  if (!Array.isArray(value.evidence) || evidence.length < 7) {
    errors.push("M3 release-note evidence must contain at least seven owner-mapped entries");
  }

  for (const item of evidence) {
    if (!item.id || !item.ownerProject || !item.source || !item.acceptanceBullet) {
      errors.push(`${item.id ?? "<missing>"} evidence requires id, ownerProject, source, and acceptanceBullet`);
    }
  }

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));

  if (!Array.isArray(value.blockers) || blockers.length < 1) {
    errors.push("blockers must record at least one release-candidate blocker");
  }
  if (!Array.isArray(value.acceptedRisks) || acceptedRisks.length < 2) {
    errors.push("accepted risks must record at least two launch risk entries");
  }
  for (const blocker of blockers) {
    if (!blocker.id || !blocker.ownerProject || !blocker.sourceEvidenceId || !blocker.disposition) {
      errors.push(`${blocker.id ?? "<missing>"} blocker requires owner, sourceEvidenceId, and disposition`);
    }
    if (blocker.sourceEvidenceId && !evidenceById.has(blocker.sourceEvidenceId)) {
      errors.push(`${blocker.id ?? "<missing>"} blocker cites unknown evidence ${blocker.sourceEvidenceId}`);
    }
  }
  for (const risk of acceptedRisks) {
    if (!risk.id || !risk.ownerProject || !risk.mitigation || !risk.launchRiskEffect) {
      errors.push(`${risk.id ?? "<missing>"} risk requires owner, mitigation, and launchRiskEffect`);
    }
  }
  if (!Array.isArray(value.releaseCutlineDependencies) || releaseCutlineDependencies.length < 5) {
    errors.push("release cutline dependencies must map at least five readiness domains");
  }
  for (const dependency of releaseCutlineDependencies) {
    if (!dependency.id || !dependency.ownerProject || !dependency.source) {
      errors.push(`${dependency.id ?? "<missing>"} dependency requires id, ownerProject, and source`);
    }
    if (!dependency.cutlineCategory?.startsWith("v1-blocker.")) {
      errors.push(`${dependency.id ?? "<missing>"} dependency must cite a v1-blocker cutline category`);
    }
  }
  for (const followUp of followUps) {
    if (!followUp.id || !followUp.evidenceId || !followUp.ownerProject || !followUp.reason) {
      errors.push(`${followUp.id ?? "<missing>"} follow-up requires id, evidenceId, ownerProject, and reason`);
      continue;
    }
    const sourceEvidence = evidenceById.get(followUp.evidenceId);
    if (sourceEvidence?.status !== "missing") {
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
    if (/^\s*(publish|ship|release|approve)\b.*\bfinal release notes\b/i.test(text)) {
      errors.push("final release-note publication is scope-out");
    }
    if (/\b(guarantee|promise|claim|approve)\b.*\b(all browsers|all platforms|compatible|compatibility)\b/i.test(text)) {
      errors.push("unsupported compatibility guarantee is scope-out");
    }
    if (/^\s*(promise|guarantee|claim|approve)\b.*\b(zero[- ]downtime|every install path|all upgrade paths|upgrade)\b/i.test(text)) {
      errors.push("unsupported upgrade guarantee is scope-out");
    }
    if (/^\s*(approve|promise|publish|commit|guarantee)\b.*\b(support contact|response-time|support response|SLA)\b/i.test(text)) {
      errors.push("support contact promise is scope-out");
    }
  }
  for (const claim of publicClaimGuards) {
    if (!claim.id || !claim.claim || !claim.evidenceId || !claim.disposition) {
      errors.push(`${claim.id ?? "<missing>"} public claim guard requires id, claim, evidenceId, and disposition`);
      continue;
    }
    if (claim.disposition === "publish" && /\bGA\b|\bgeneral availability\b/i.test(claim.claim)) {
      errors.push(`${claim.id}: GA release-note claims require GA handoff evidence`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertReleaseNotesReleaseCandidateEvidence(
  record = releaseNotesReleaseCandidateEvidence,
) {
  const result = validateReleaseNotesReleaseCandidateEvidence(record);

  if (!result.ok) {
    throw new Error(`release notes release-candidate evidence invalid:\n${result.errors.join("\n")}`);
  }

  return record;
}
