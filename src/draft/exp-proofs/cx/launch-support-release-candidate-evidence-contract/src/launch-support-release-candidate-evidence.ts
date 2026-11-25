import { isJsonObject, type JsonValue } from "./json.js";
export type EvidenceStatus = "accepted" | "accepted-risk" | "missing";
export type ProofMode = "design-record" | "issue-state" | "manual-review" | "support-drill";
export type LaunchRiskEffect = "unchanged" | "increased" | "reduced";
export type BlockerState = "blocked" | "accepted-risk" | "cleared";

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSupportReleaseCandidateEvidenceItem proto message in data-models/.
export interface LaunchSupportReleaseCandidateEvidenceItem {
  id: string;
  ownerProject: string;
  source: string;
  proofMode: ProofMode;
  status: EvidenceStatus;
  acceptanceBullet: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSupportReleaseCandidateBlocker proto message in data-models/.
export interface LaunchSupportReleaseCandidateBlocker {
  id: string;
  ownerProject: string;
  state: BlockerState;
  sourceEvidenceId: string;
  disposition: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSupportReleaseCandidateAcceptedRisk proto message in data-models/.
export interface LaunchSupportReleaseCandidateAcceptedRisk {
  id: string;
  ownerProject: string;
  mitigation: string;
  launchRiskEffect: LaunchRiskEffect;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSupportReleaseCutlineDependency proto message in data-models/.
export interface LaunchSupportReleaseCutlineDependency {
  id: string;
  ownerProject: string;
  readinessDomain: "support" | "operations-readiness" | "documentation" | "security" | "release-cutline";
  cutlineCategory: `v1-blocker.${string}`;
  source: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSupportReleaseCandidateFollowUp proto message in data-models/.
export interface LaunchSupportReleaseCandidateFollowUp {
  id: string;
  evidenceId: string;
  ownerProject: string;
  reason: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSupportInitiativeStatusGate proto message in data-models/.
export interface LaunchSupportInitiativeStatusGate {
  parentInitiative: "HoBo v1 Release Readiness";
  launchRiskChange: LaunchRiskEffect;
  statusUpdateRequired: boolean;
  updateSource: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSupportPublicClaimGuard proto message in data-models/.
export interface LaunchSupportPublicClaimGuard {
  id: string;
  claim: string;
  evidenceId: string;
  disposition: "hold" | "draft" | "publish";
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSupportReleaseCandidateEvidenceRecord proto message in data-models/.
export interface LaunchSupportReleaseCandidateEvidenceRecord {
  schema: string;
  issue: "HOBO-474";
  project: "V1 Launch Support Desk & Escalation";
  phase: "M3";
  milestone: "M3 Release candidate";
  evidence: LaunchSupportReleaseCandidateEvidenceItem[];
  blockers: LaunchSupportReleaseCandidateBlocker[];
  acceptedRisks: LaunchSupportReleaseCandidateAcceptedRisk[];
  releaseCutlineDependencies: LaunchSupportReleaseCutlineDependency[];
  followUps: LaunchSupportReleaseCandidateFollowUp[];
  initiativeStatus: LaunchSupportInitiativeStatusGate;
  scopeOut: string[];
  publicClaimGuards: LaunchSupportPublicClaimGuard[];
}

export const launchSupportReleaseCandidateEvidence: LaunchSupportReleaseCandidateEvidenceRecord = {
  schema: "hobo.launch-support-release-candidate-evidence/2026-06-30",
  issue: "HOBO-474",
  project: "V1 Launch Support Desk & Escalation",
  phase: "M3",
  milestone: "M3 Release candidate",
  evidence: [
    {
      id: "private-beta-support-baseline",
      ownerProject: "V1 Launch Support Desk & Escalation",
      source: "HOBO-467 / docs/design/launch-support-escalation.md#m2-private-beta-evidence",
      proofMode: "issue-state",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "release-candidate-support-drill",
      ownerProject: "V1 Launch Support Desk & Escalation",
      source: "docs/design/launch-support-escalation.md#m3-release-candidate-evidence",
      proofMode: "support-drill",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "incident-command-handoff-rehearsal",
      ownerProject: "Operators/SRE",
      source: "docs/design/operators-sre.md#plan-40",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "customer-update-redaction-rehearsal",
      ownerProject: "Public Status Page & Incident Communication",
      source: "docs/design/public-status-page-incident-communication.md",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "security-sensitive-support-route",
      ownerProject: "Security Verification",
      source: "docs/design/security-verification.md",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Blockers and accepted risks are recorded.",
    },
    {
      id: "release-cutline-support-signoff",
      ownerProject: "V1 Release Program & Cutline",
      source: "src/draft/technical-proofs/v1-cutline-contract/README.md",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "ga-support-handoff-evidence",
      ownerProject: "V1 Launch Support Desk & Escalation",
      source: "HOBO-481",
      proofMode: "issue-state",
      status: "missing",
      acceptanceBullet: "Follow-up execution issues are created only where evidence is missing.",
    },
  ],
  blockers: [
    {
      id: "ga-support-handoff-not-proven",
      ownerProject: "V1 Launch Support Desk & Escalation",
      state: "blocked",
      sourceEvidenceId: "ga-support-handoff-evidence",
      disposition: "GA support commitments stay blocked until HOBO-481 records GA handoff evidence.",
    },
  ],
  acceptedRisks: [
    {
      id: "manual-release-candidate-support-drill",
      ownerProject: "V1 Launch Support Desk & Escalation",
      mitigation: "Use release-candidate support drills and owner routes without introducing live ticket automation.",
      launchRiskEffect: "unchanged",
    },
    {
      id: "customer-update-redaction-before-ga",
      ownerProject: "Public Status Page & Incident Communication",
      mitigation: "Keep customer-facing updates in draft/hold state until source evidence and redaction review pass.",
      launchRiskEffect: "unchanged",
    },
  ],
  releaseCutlineDependencies: [
    {
      id: "support-release-candidate",
      ownerProject: "V1 Launch Support Desk & Escalation",
      readinessDomain: "support",
      cutlineCategory: "v1-blocker.support",
      source: "docs/design/launch-support-escalation.md#m3-release-candidate-evidence",
    },
    {
      id: "incident-command-rehearsal",
      ownerProject: "Operators/SRE",
      readinessDomain: "operations-readiness",
      cutlineCategory: "v1-blocker.operations-readiness",
      source: "docs/design/operators-sre.md#plan-40",
    },
    {
      id: "customer-update-language",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      readinessDomain: "documentation",
      cutlineCategory: "v1-blocker.documentation",
      source: "docs/design/release-notes-upgrade-guide.md",
    },
    {
      id: "security-route-review",
      ownerProject: "Security Verification",
      readinessDomain: "security",
      cutlineCategory: "v1-blocker.security",
      source: "docs/design/security-verification.md",
    },
    {
      id: "release-owner-signoff",
      ownerProject: "V1 Release Program & Cutline",
      readinessDomain: "release-cutline",
      cutlineCategory: "v1-blocker.release-cutline",
      source: "src/draft/technical-proofs/v1-cutline-contract/README.md",
    },
  ],
  followUps: [
    {
      id: "HOBO-481",
      evidenceId: "ga-support-handoff-evidence",
      ownerProject: "V1 Launch Support Desk & Escalation",
      reason: "GA support handoff evidence remains explicitly missing after the M3 release-candidate gate.",
    },
  ],
  initiativeStatus: {
    parentInitiative: "HoBo v1 Release Readiness",
    launchRiskChange: "unchanged",
    statusUpdateRequired: true,
    updateSource: "HOBO-474 records release-candidate support evidence and keeps GA support claims blocked on HOBO-481.",
  },
  scopeOut: [
    "No support runtime, helpdesk/ticket queue, on-call scheduler, status-page publisher, live customer-data access, or commercial support terms are implemented.",
    "No GA support SLA, final compatibility window, public response-time guarantee, or customer support launch claim is promoted from M3 evidence.",
  ],
  publicClaimGuards: [],
};

export function validateLaunchSupportReleaseCandidateEvidence(record: JsonValue) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["launch support release-candidate evidence record is required"] };
  }

  // SAFETY: `const value = record as Partial<LaunchSupportReleaseCandidateEvidenceRecord>;` is required at this I/O or test boundary.
  const value = record as Partial<LaunchSupportReleaseCandidateEvidenceRecord>;
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  const blockers = Array.isArray(value.blockers) ? value.blockers : [];
  const acceptedRisks = Array.isArray(value.acceptedRisks) ? value.acceptedRisks : [];
  const releaseCutlineDependencies = Array.isArray(value.releaseCutlineDependencies)
    ? value.releaseCutlineDependencies
    : [];
  const followUps = Array.isArray(value.followUps) ? value.followUps : [];
  const scopeOut = Array.isArray(value.scopeOut) ? value.scopeOut : [];
  const publicClaimGuards = Array.isArray(value.publicClaimGuards) ? value.publicClaimGuards : [];

  if (value.issue !== "HOBO-474") errors.push("issue must be HOBO-474");
  if (value.phase !== "M3") errors.push("phase must be M3");
  if (value.milestone !== "M3 Release candidate") errors.push("milestone must be M3 Release candidate");
  if (!Array.isArray(value.evidence) || evidence.length < 6) {
    errors.push("M3 support evidence must contain at least six owner-mapped entries");
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
    if (/^\s*(implement|build|create|ship|add)\b.*(\bsupport\b.*\bticket\b|\bticket\b.*\bqueue\b|\bhelpdesk\b)/i.test(text)) {
      errors.push("support ticket queue implementation is scope-out");
    }
    if (/^\s*(publish|auto-publish|automate|implement|build|create)\b.*\bstatus[- ]page\b|\bstatus[- ]page\b.*\bautomatically\b/i.test(text)) {
      errors.push("status-page publication is scope-out");
    }
    if (/^\s*(read|access|use|export|inspect)\b.*(\bcustomer[- ]data\b|\blive customer data\b)/i.test(text)) {
      errors.push("customer-data access is scope-out");
    }
    if (/^\s*(approve|promise|publish|commit)\b.*(\bSLA\b|\bresponse-time guarantee\b)/i.test(text)) {
      errors.push("customer-facing SLA approval is scope-out");
    }
  }
  for (const claim of publicClaimGuards) {
    if (!claim.id || !claim.claim || !claim.evidenceId || !claim.disposition) {
      errors.push(`${claim.id ?? "<missing>"} public claim guard requires id, claim, evidenceId, and disposition`);
      continue;
    }
    if (claim.disposition === "publish" && /\bGA\b|\bgeneral availability\b/i.test(claim.claim)) {
      errors.push(`${claim.id}: GA support claims require GA handoff evidence`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertLaunchSupportReleaseCandidateEvidence(
  record = launchSupportReleaseCandidateEvidence,
) {
  const result = validateLaunchSupportReleaseCandidateEvidence(record);

  if (!result.ok) {
    throw new Error(`launch support release-candidate evidence invalid:\n${result.errors.join("\n")}`);
  }

  return record;
}
