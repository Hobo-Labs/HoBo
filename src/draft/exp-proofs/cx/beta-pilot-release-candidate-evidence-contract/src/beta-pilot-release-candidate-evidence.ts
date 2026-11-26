import { isJsonObject, type JsonValue } from "./json.js";
export type EvidenceStatus = "accepted" | "accepted-risk" | "missing";
export type ProofMode = "design-record" | "issue-state" | "manual-review" | "support-triage";
export type LaunchRiskEffect = "unchanged" | "increased" | "reduced";
export type BlockerState = "blocked" | "accepted-risk" | "cleared";

// domain-view: parse-produced draft-proof record; its wire form is the BetaPilotReleaseCandidateEvidenceItem proto message in data-models/.
export interface BetaPilotReleaseCandidateEvidenceItem {
  id: string;
  ownerProject: string;
  source: string;
  proofMode: ProofMode;
  status: EvidenceStatus;
  acceptanceBullet: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the BetaPilotReleaseCandidateBlocker proto message in data-models/.
export interface BetaPilotReleaseCandidateBlocker {
  id: string;
  ownerProject: string;
  state: BlockerState;
  sourceEvidenceId: string;
  disposition: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the BetaPilotReleaseCandidateAcceptedRisk proto message in data-models/.
export interface BetaPilotReleaseCandidateAcceptedRisk {
  id: string;
  ownerProject: string;
  mitigation: string;
  launchRiskEffect: LaunchRiskEffect;
}

// domain-view: parse-produced draft-proof record; its wire form is the BetaPilotReleaseCutlineDependency proto message in data-models/.
export interface BetaPilotReleaseCutlineDependency {
  id: string;
  ownerProject: string;
  readinessDomain: "documentation" | "productization" | "support" | "operations-readiness";
  cutlineCategory: `v1-blocker.${string}`;
  source: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the BetaPilotReleaseCandidateFollowUp proto message in data-models/.
export interface BetaPilotReleaseCandidateFollowUp {
  id: string;
  evidenceId: string;
  ownerProject: string;
  reason: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the BetaPilotInitiativeStatusGate proto message in data-models/.
export interface BetaPilotInitiativeStatusGate {
  parentInitiative: "HoBo v1 Release Readiness";
  launchRiskChange: LaunchRiskEffect;
  statusUpdateRequired: boolean;
  updateSource: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the BetaPilotPublicClaimGuard proto message in data-models/.
export interface BetaPilotPublicClaimGuard {
  id: string;
  claim: string;
  evidenceId: string;
  disposition: "hold" | "draft" | "publish";
}

// domain-view: parse-produced draft-proof record; its wire form is the BetaPilotReleaseCandidateEvidenceRecord proto message in data-models/.
export interface BetaPilotReleaseCandidateEvidenceRecord {
  schema: string;
  issue: "HOBO-470";
  project: "V1 Beta Pilot & Feedback Loop";
  phase: "M3";
  milestone: "M3 Release candidate";
  evidence: BetaPilotReleaseCandidateEvidenceItem[];
  blockers: BetaPilotReleaseCandidateBlocker[];
  acceptedRisks: BetaPilotReleaseCandidateAcceptedRisk[];
  releaseCutlineDependencies: BetaPilotReleaseCutlineDependency[];
  followUps: BetaPilotReleaseCandidateFollowUp[];
  initiativeStatus: BetaPilotInitiativeStatusGate;
  scopeOut: string[];
  publicClaimGuards: BetaPilotPublicClaimGuard[];
}

export const betaPilotReleaseCandidateEvidence: BetaPilotReleaseCandidateEvidenceRecord = {
  schema: "hobo.beta-pilot-release-candidate-evidence/2026-06-30",
  issue: "HOBO-470",
  project: "V1 Beta Pilot & Feedback Loop",
  phase: "M3",
  milestone: "M3 Release candidate",
  evidence: [
    {
      id: "feedback-intake-triage",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      source: "docs/design/beta-pilot-feedback.md#feedback-intake",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "beta-exit-criteria",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      source: "docs/design/beta-pilot-feedback.md#release-candidate-exit",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "private-beta-evidence-pr",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      source: "HOBO-463 / https://github.com/Tyler-R-Kendrick/HoBo/pull/541",
      proofMode: "issue-state",
      status: "accepted-risk",
      acceptanceBullet: "Blockers and accepted risks are recorded.",
    },
    {
      id: "release-cutline-handoff",
      ownerProject: "V1 Release Program & Cutline",
      source: "src/draft/technical-proofs/v1-cutline-contract/README.md",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "support-route-handoff",
      ownerProject: "V1 Launch Support Desk & Escalation",
      source: "docs/design/launch-support-escalation.md",
      proofMode: "support-triage",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "ga-handoff-evidence",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      source: "HOBO-477",
      proofMode: "issue-state",
      status: "missing",
      acceptanceBullet: "Follow-up execution issues are created only where evidence is missing.",
    },
  ],
  blockers: [
    {
      id: "private-beta-proof-awaits-merge-owner",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      state: "accepted-risk",
      sourceEvidenceId: "private-beta-evidence-pr",
      disposition: "M3 evidence may record release-candidate routing, but final release-candidate promotion waits for merge-owner acceptance of HOBO-463.",
    },
    {
      id: "ga-handoff-not-yet-proven",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      state: "blocked",
      sourceEvidenceId: "ga-handoff-evidence",
      disposition: "GA claims stay blocked until HOBO-477 records GA handoff evidence.",
    },
  ],
  acceptedRisks: [
    {
      id: "in-review-private-beta-source",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      mitigation: "Treat private-beta evidence as an in-review source and keep release-candidate language conditional until merge-owner acceptance.",
      launchRiskEffect: "increased",
    },
    {
      id: "support-routing-before-ga",
      ownerProject: "V1 Launch Support Desk & Escalation",
      mitigation: "Route beta findings to support owners without promising GA response targets or customer-facing support SLAs.",
      launchRiskEffect: "unchanged",
    },
  ],
  releaseCutlineDependencies: [
    {
      id: "beta-feedback-productization",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      readinessDomain: "productization",
      cutlineCategory: "v1-blocker.productization",
      source: "docs/design/beta-pilot-feedback.md#release-candidate-exit",
    },
    {
      id: "release-note-known-limitations",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      readinessDomain: "documentation",
      cutlineCategory: "v1-blocker.documentation",
      source: "docs/design/release-notes-upgrade-guide.md",
    },
    {
      id: "support-escalation-path",
      ownerProject: "V1 Launch Support Desk & Escalation",
      readinessDomain: "support",
      cutlineCategory: "v1-blocker.support",
      source: "docs/design/launch-support-escalation.md",
    },
    {
      id: "dogfood-hosted-operations-input",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      readinessDomain: "operations-readiness",
      cutlineCategory: "v1-blocker.operations-readiness",
      source: "docs/design/dogfood-yard.md",
    },
  ],
  followUps: [
    {
      id: "HOBO-477",
      evidenceId: "ga-handoff-evidence",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      reason: "GA handoff evidence is explicitly missing after the M3 release-candidate gate.",
    },
  ],
  initiativeStatus: {
    parentInitiative: "HoBo v1 Release Readiness",
    launchRiskChange: "increased",
    statusUpdateRequired: true,
    updateSource: "HOBO-470 records private-beta evidence still in review and blocks GA claims on HOBO-477.",
  },
  scopeOut: [
    "No beta customer onboarding, feedback portal, support tooling, or product UX implementation is created by this proof.",
    "No GA readiness, public launch, customer support SLA, or live hosted operations claim may be promoted from beta release-candidate evidence.",
  ],
  publicClaimGuards: [],
};

export function validateBetaPilotReleaseCandidateEvidence(record: JsonValue) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["beta pilot release-candidate evidence record is required"] };
  }

  // SAFETY: `const value = record as Partial<BetaPilotReleaseCandidateEvidenceRecord>;` is required at this I/O or test boundary.
  const value = record as Partial<BetaPilotReleaseCandidateEvidenceRecord>;

  if (value.issue !== "HOBO-470") errors.push("issue must be HOBO-470");
  if (value.phase !== "M3") errors.push("phase must be M3");
  if (value.milestone !== "M3 Release candidate") errors.push("milestone must be M3 Release candidate");

  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  const blockers = Array.isArray(value.blockers) ? value.blockers : [];
  const acceptedRisks = Array.isArray(value.acceptedRisks) ? value.acceptedRisks : [];
  const releaseCutlineDependencies = Array.isArray(value.releaseCutlineDependencies)
    ? value.releaseCutlineDependencies
    : [];
  const followUps = Array.isArray(value.followUps) ? value.followUps : [];
  const scopeOut = Array.isArray(value.scopeOut) ? value.scopeOut : [];
  const publicClaimGuards = Array.isArray(value.publicClaimGuards) ? value.publicClaimGuards : [];

  if (!Array.isArray(value.evidence) || evidence.length < 5) {
    errors.push("M3 evidence must contain at least five owner-mapped entries");
  }
  if (!Array.isArray(value.blockers) || blockers.length < 1) {
    errors.push("blockers must record at least one release-candidate blocker");
  }
  if (!Array.isArray(value.acceptedRisks) || acceptedRisks.length < 2) {
    errors.push("accepted risks must record at least two launch risk entries");
  }
  if (!Array.isArray(value.releaseCutlineDependencies) || releaseCutlineDependencies.length < 4) {
    errors.push("release cutline dependencies must map at least four readiness domains");
  }

  for (const item of evidence) {
    if (!item.id || !item.ownerProject || !item.source || !item.acceptanceBullet) {
      errors.push(`${item.id ?? "<missing>"} evidence requires id, ownerProject, source, and acceptanceBullet`);
    }
  }

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));

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
      errors.push("initiative status update source is required when launch risk changes");
    }
  }
  for (const text of scopeOut) {
    if (/^\s*onboard\b.*\b(beta|customer|cohort)/i.test(text)) {
      errors.push("customer onboarding is scope-out");
    }
  }
  for (const claim of publicClaimGuards) {
    if (!claim.id || !claim.claim || !claim.evidenceId || !claim.disposition) {
      errors.push(`${claim.id ?? "<missing>"} public claim guard requires id, claim, evidenceId, and disposition`);
      continue;
    }
    if (claim.disposition === "publish" && /\bGA\b|\bgeneral availability\b/i.test(claim.claim)) {
      errors.push(`${claim.id}: GA claims require GA handoff evidence`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertBetaPilotReleaseCandidateEvidence(record = betaPilotReleaseCandidateEvidence) {
  const result = validateBetaPilotReleaseCandidateEvidence(record);

  if (!result.ok) {
    throw new Error(`beta pilot release-candidate evidence invalid:\n${result.errors.join("\n")}`);
  }

  return record;
}
