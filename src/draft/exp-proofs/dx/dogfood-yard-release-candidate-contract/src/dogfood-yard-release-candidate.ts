import { isJsonObject, type JsonValue } from "./json.js";
export type EvidenceStatus = "accepted" | "accepted-risk" | "missing";
export type ProofMode = "design-record" | "reference-fixture" | "mocked-drill" | "manual-review" | "live-recording";
export type LaunchRiskEffect = "unchanged" | "increased" | "reduced";
export type FollowUpDisposition = "existing-issue" | "new-issue-required";

export interface DogfoodReleaseCandidateEvidenceItem {
  id: string;
  ownerProject: string;
  source: string;
  proofMode: ProofMode;
  status: EvidenceStatus;
  acceptanceBullet: string;
}

export interface DogfoodReleaseCandidateBlocker {
  id: string;
  ownerProject: string;
  state: "accepted-risk" | "blocked" | "release-note";
  evidenceSource: string;
  mitigation: string;
}

export interface DogfoodReleaseCandidateAcceptedRisk {
  id: string;
  ownerProject: string;
  mitigation: string;
  launchRiskEffect: LaunchRiskEffect;
}

export interface DogfoodReleaseCandidateDependency {
  id: string;
  ownerProject: string;
  readinessDomain: "operations-readiness" | "documentation" | "support" | "reliability";
  cutlineCategory: `v1-blocker.${string}`;
  source: string;
}

export interface DogfoodReleaseCandidateFollowUp {
  id: string;
  evidenceId: string;
  ownerProject: string;
  disposition: FollowUpDisposition;
  reason: string;
}

export interface DogfoodReleaseCandidateInitiativeStatus {
  parentInitiative: "HoBo v1 Release Readiness";
  launchRiskChange: LaunchRiskEffect;
  statusUpdateRequired: boolean;
  updateSource: string;
}

export interface DogfoodOperationalClaimGuard {
  id: string;
  claim: string;
  evidenceId: string;
  disposition: "hold" | "release-candidate" | "publish";
}

export interface DogfoodYardReleaseCandidateEvidenceRecord {
  schema: string;
  issue: "HOBO-469";
  project: "V1 Dogfood Yard & Hosted Operations";
  phase: "M3";
  milestone: "M3 Release candidate";
  evidence: DogfoodReleaseCandidateEvidenceItem[];
  blockers: DogfoodReleaseCandidateBlocker[];
  acceptedRisks: DogfoodReleaseCandidateAcceptedRisk[];
  releaseCutlineDependencies: DogfoodReleaseCandidateDependency[];
  followUps: DogfoodReleaseCandidateFollowUp[];
  initiativeStatus: DogfoodReleaseCandidateInitiativeStatus;
  scopeOut: string[];
  operationalClaimGuards: DogfoodOperationalClaimGuard[];
}

export const dogfoodYardReleaseCandidateEvidence: DogfoodYardReleaseCandidateEvidenceRecord = {
  schema: "hobo.dogfood-yard.release-candidate/2026-06-30",
  issue: "HOBO-469",
  project: "V1 Dogfood Yard & Hosted Operations",
  phase: "M3",
  milestone: "M3 Release candidate",
  evidence: [
    {
      id: "m0-dogfood-acceptance-record",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      source: "docs/design/dogfood-yard.md#m0-acceptance-record",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "m1-dogfood-alpha-cutline",
      ownerProject: "V1 Release Program & Cutline",
      source: "docs/design/proofs/hobo-454-v1-cutline-dogfood-alpha/index.md",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "release-candidate-scenario-ledger",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      source: "docs/design/dogfood-yard.md#release-candidate-evidence-gate",
      proofMode: "mocked-drill",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "support-debug-readiness",
      ownerProject: "V1 Launch Support Desk & Escalation",
      source: "docs/design/launch-support-escalation.md",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Blockers and accepted risks are recorded.",
    },
    {
      id: "rollback-restore-drill-fixture",
      ownerProject: "Reliability, Observability & Cost (FinOps)",
      source: "docs/design/reliability-observability-cost.md#plan-05",
      proofMode: "reference-fixture",
      status: "accepted-risk",
      acceptanceBullet: "Blockers and accepted risks are recorded.",
    },
    {
      id: "ga-operations-handoff",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      source: "HOBO-476",
      proofMode: "live-recording",
      status: "missing",
      acceptanceBullet: "Follow-up execution issues are created only where evidence is missing.",
    },
  ],
  blockers: [
    {
      id: "ga-live-handoff-not-yet-accepted",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      state: "blocked",
      evidenceSource: "ga-operations-handoff",
      mitigation: "Keep release-candidate evidence separate from GA handoff evidence and route GA proof to HOBO-476.",
    },
    {
      id: "support-debug-fixture-only",
      ownerProject: "V1 Launch Support Desk & Escalation",
      state: "accepted-risk",
      evidenceSource: "support-debug-readiness",
      mitigation: "Support language may cite release-candidate fixtures only when labelled as support-safe, tenantless evidence.",
    },
  ],
  acceptedRisks: [
    {
      id: "mocked-drill-before-live-ops",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      mitigation: "Release-candidate drill evidence can gate RC readiness, but live hosted operations evidence remains a GA prerequisite.",
      launchRiskEffect: "unchanged",
    },
    {
      id: "restore-drill-reference-fixture",
      ownerProject: "Reliability, Observability & Cost (FinOps)",
      mitigation: "Restore evidence stays fixture-backed until live operational recovery proof is attached by the GA handoff.",
      launchRiskEffect: "unchanged",
    },
  ],
  releaseCutlineDependencies: [
    {
      id: "dogfood-operations-cutline",
      ownerProject: "V1 Release Program & Cutline",
      readinessDomain: "operations-readiness",
      cutlineCategory: "v1-blocker.operations-readiness",
      source: "src/draft/technical-proofs/v1-cutline-contract/README.md",
    },
    {
      id: "release-notes-known-limitations",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      readinessDomain: "documentation",
      cutlineCategory: "v1-blocker.documentation",
      source: "docs/design/release-notes-upgrade-guide.md",
    },
    {
      id: "support-escalation-rc-language",
      ownerProject: "V1 Launch Support Desk & Escalation",
      readinessDomain: "support",
      cutlineCategory: "v1-blocker.support",
      source: "docs/design/launch-support-escalation.md",
    },
    {
      id: "rollback-restore-reliability-signal",
      ownerProject: "Reliability, Observability & Cost (FinOps)",
      readinessDomain: "reliability",
      cutlineCategory: "v1-blocker.operations-readiness",
      source: "docs/design/reliability-observability-cost.md#plan-05",
    },
  ],
  followUps: [
    {
      id: "HOBO-476",
      evidenceId: "ga-operations-handoff",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      disposition: "existing-issue",
      reason: "GA hosted operations handoff evidence is explicitly missing from the M3 release-candidate gate.",
    },
  ],
  initiativeStatus: {
    parentInitiative: "HoBo v1 Release Readiness",
    launchRiskChange: "unchanged",
    statusUpdateRequired: false,
    updateSource: "No parent initiative status update required because HOBO-469 records M3 RC evidence without increasing launch risk.",
  },
  scopeOut: [
    "Do not build hosted Yard runtime, provision live cloud resources, or call production provider APIs.",
    "Do not use live customer data, provider credentials, or tenant payloads in release-candidate fixtures.",
    "Do not claim beta, GA, public launch, or production operational readiness from M3 release-candidate evidence.",
  ],
  operationalClaimGuards: [
    {
      id: "hosted-yard-rc-only",
      claim: "Hosted Yard release-candidate operations have owner-mapped fixture evidence.",
      evidenceId: "release-candidate-scenario-ledger",
      disposition: "release-candidate",
    },
    {
      id: "ga-handoff-held",
      claim: "Hosted Yard GA handoff is complete.",
      evidenceId: "ga-operations-handoff",
      disposition: "hold",
    },
  ],
};

const FORBIDDEN_SCOPE_PATTERNS = [
  /build .*yard runtime/i,
  /provision live cloud/i,
  /production provider/i,
  /provider credential/i,
  /live customer data/i,
  /tenant payload/i,
  /mark ga readiness/i,
  /claim .*ga/i,
];

export function validateDogfoodYardReleaseCandidateEvidence(record: JsonValue) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["dogfood release-candidate evidence record is required"] };
  }

  // SAFETY: `const value = record as Partial<DogfoodYardReleaseCandidateEvidenceRecord>;` is required at this I/O or test boundary.
  const value = record as Partial<DogfoodYardReleaseCandidateEvidenceRecord>;
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  const blockers = Array.isArray(value.blockers) ? value.blockers : [];
  const acceptedRisks = Array.isArray(value.acceptedRisks) ? value.acceptedRisks : [];
  const releaseCutlineDependencies = Array.isArray(value.releaseCutlineDependencies)
    ? value.releaseCutlineDependencies
    : [];
  const followUps = Array.isArray(value.followUps) ? value.followUps : [];
  const scopeOut = Array.isArray(value.scopeOut) ? value.scopeOut : [];
  const operationalClaimGuards = Array.isArray(value.operationalClaimGuards) ? value.operationalClaimGuards : [];

  if (value.issue !== "HOBO-469") {
    errors.push("issue must be HOBO-469");
  }
  if (value.phase !== "M3") {
    errors.push("phase must be M3");
  }
  if (value.milestone !== "M3 Release candidate") {
    errors.push("milestone must be M3 Release candidate");
  }
  if (evidence.length < 6) {
    errors.push("M3 evidence must contain at least six owner-mapped entries");
  }
  if (blockers.length < 2) {
    errors.push("blockers must record at least two release-candidate blockers or accepted risks");
  }
  if (acceptedRisks.length < 2) {
    errors.push("accepted risks must record at least two launch risk entries");
  }
  if (releaseCutlineDependencies.length < 4) {
    errors.push("release cutline dependencies must map at least four readiness domains");
  }

  for (const item of evidence) {
    if (!item.id || !item.ownerProject || !item.source || !item.acceptanceBullet) {
      errors.push(`${item.id ?? "<missing>"} evidence requires id, ownerProject, source, and acceptanceBullet`);
    }
  }

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  for (const blocker of blockers) {
    if (!blocker.id || !blocker.ownerProject || !blocker.evidenceSource || !blocker.mitigation) {
      errors.push(`${blocker.id ?? "<missing>"} blocker requires owner, evidenceSource, and mitigation`);
    }
    if (blocker.evidenceSource && !evidenceById.has(blocker.evidenceSource)) {
      errors.push(`${blocker.id ?? "<missing>"} blocker cites unknown evidence ${blocker.evidenceSource}`);
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
    const followUpEvidence = evidenceById.get(followUp.evidenceId);
    if (followUpEvidence?.status !== "missing") {
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
    if (/^\s*(do not|no)\b/i.test(text)) {
      continue;
    }
    if (FORBIDDEN_SCOPE_PATTERNS.some((pattern) => pattern.test(text))) {
      errors.push("live provider or runtime work is scope-out");
      break;
    }
  }

  for (const claim of operationalClaimGuards) {
    if (!claim.id || !claim.claim || !claim.evidenceId || !claim.disposition) {
      errors.push(`${claim.id ?? "<missing>"} operational claim guard requires id, claim, evidenceId, and disposition`);
      continue;
    }
    const claimEvidence = evidenceById.get(claim.evidenceId);
    if (
      claim.disposition === "publish" &&
      !(claimEvidence?.status === "accepted" && claimEvidence.proofMode === "live-recording" && value.phase !== "M3")
    ) {
      errors.push(`${claim.id}: published operational claims require accepted GA live evidence`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function parseDogfoodYardReleaseCandidateEvidence(record: JsonValue): DogfoodYardReleaseCandidateEvidenceRecord {
  const result = validateDogfoodYardReleaseCandidateEvidence(record);

  if (!result.ok) {
    throw new Error(`dogfood release-candidate evidence invalid:\n${result.errors.join("\n")}`);
  }

  // SAFETY: `return record as DogfoodYardReleaseCandidateEvidenceRecord;` is required at this I/O or test boundary.
  return record as DogfoodYardReleaseCandidateEvidenceRecord;
}

export function assertDogfoodYardReleaseCandidateEvidence(
  record = dogfoodYardReleaseCandidateEvidence,
): DogfoodYardReleaseCandidateEvidenceRecord {
  return parseDogfoodYardReleaseCandidateEvidence(record);
}
