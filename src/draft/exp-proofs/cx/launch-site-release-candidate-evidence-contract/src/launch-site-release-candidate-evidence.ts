import { isJsonObject, type JsonValue } from "./json.js";
export type EvidenceStatus = "accepted" | "accepted-risk" | "missing";
export type ProofMode = "design-record" | "issue-state" | "manual-review" | "reference-fixture" | "live-recording";
export type LaunchRiskEffect = "unchanged" | "increased" | "reduced";
export type BlockerState = "blocked" | "accepted-risk" | "cleared";

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteReleaseCandidateEvidenceItem proto message in data-models/.
export interface LaunchSiteReleaseCandidateEvidenceItem {
  id: string;
  ownerProject: string;
  source: string;
  proofMode: ProofMode;
  status: EvidenceStatus;
  acceptanceBullet: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteReleaseCandidateBlocker proto message in data-models/.
export interface LaunchSiteReleaseCandidateBlocker {
  id: string;
  ownerProject: string;
  state: BlockerState;
  sourceEvidenceId: string;
  disposition: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteReleaseCandidateAcceptedRisk proto message in data-models/.
export interface LaunchSiteReleaseCandidateAcceptedRisk {
  id: string;
  ownerProject: string;
  mitigation: string;
  launchRiskEffect: LaunchRiskEffect;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteReleaseCutlineDependency proto message in data-models/.
export interface LaunchSiteReleaseCutlineDependency {
  id: string;
  ownerProject: string;
  readinessDomain: "documentation" | "productization" | "operations-readiness" | "support" | "legal" | "release-cutline";
  cutlineCategory: `v1-blocker.${string}`;
  source: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteReleaseCandidateFollowUp proto message in data-models/.
export interface LaunchSiteReleaseCandidateFollowUp {
  id: string;
  evidenceId: string;
  ownerProject: string;
  reason: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteInitiativeStatusGate proto message in data-models/.
export interface LaunchSiteInitiativeStatusGate {
  parentInitiative: "HoBo v1 Release Readiness";
  launchRiskChange: LaunchRiskEffect;
  statusUpdateRequired: boolean;
  updateSource: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSitePublicClaimGuard proto message in data-models/.
export interface LaunchSitePublicClaimGuard {
  id: string;
  claim: string;
  evidenceId: string;
  disposition: "hold" | "draft" | "publish";
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteReleaseCandidateEvidenceRecord proto message in data-models/.
export interface LaunchSiteReleaseCandidateEvidenceRecord {
  schema: string;
  issue: "HOBO-472";
  project: "V1 Launch Site, Messaging & Demo Assets";
  phase: "M3";
  milestone: "M3 Release candidate";
  evidence: LaunchSiteReleaseCandidateEvidenceItem[];
  blockers: LaunchSiteReleaseCandidateBlocker[];
  acceptedRisks: LaunchSiteReleaseCandidateAcceptedRisk[];
  releaseCutlineDependencies: LaunchSiteReleaseCutlineDependency[];
  followUps: LaunchSiteReleaseCandidateFollowUp[];
  initiativeStatus: LaunchSiteInitiativeStatusGate;
  scopeOut: string[];
  publicClaimGuards: LaunchSitePublicClaimGuard[];
}

export const launchSiteReleaseCandidateEvidence: LaunchSiteReleaseCandidateEvidenceRecord = {
  schema: "hobo.launch-site-release-candidate-evidence/2026-06-30",
  issue: "HOBO-472",
  project: "V1 Launch Site, Messaging & Demo Assets",
  phase: "M3",
  milestone: "M3 Release candidate",
  evidence: [
    {
      id: "claim-register-publication-rules",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      source: "docs/design/launch-messaging-claims.md#evidence-required-for-publication",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "private-beta-launch-site-evidence",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      source: "HOBO-465 / docs/design/launch-messaging-claims.md#private-beta-evidence-gate",
      proofMode: "issue-state",
      status: "accepted",
      acceptanceBullet: "Blockers and accepted risks are recorded.",
    },
    {
      id: "golden-path-demo-assets",
      ownerProject: "Example Apps",
      source: "docs/design/launch-demo-golden-path.md#required-assets",
      proofMode: "reference-fixture",
      status: "accepted-risk",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "release-candidate-cutline",
      ownerProject: "V1 Release Program & Cutline",
      source: "docs/design/go-no-go-decision-record.md#m3-release-candidate-evidence-gate",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "release-notes-known-limitations",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      source: "docs/design/release-notes-upgrade-guide.md#outline",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "support-legal-handoff",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      source: "docs/design/legal-privacy-terms-readiness.md",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "The parent HoBo v1 Release Readiness initiative status is updated if this gate changes launch risk.",
    },
    {
      id: "ga-launch-site-handoff-evidence",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      source: "HOBO-479",
      proofMode: "issue-state",
      status: "missing",
      acceptanceBullet: "Follow-up execution issues are created only where evidence is missing.",
    },
  ],
  blockers: [
    {
      id: "ga-launch-site-handoff-not-proven",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      state: "blocked",
      sourceEvidenceId: "ga-launch-site-handoff-evidence",
      disposition: "GA/public launch claims remain blocked until HOBO-479 records GA handoff evidence.",
    },
    {
      id: "live-demo-assets-conditional",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      state: "accepted-risk",
      sourceEvidenceId: "golden-path-demo-assets",
      disposition: "M3 may draft release-candidate demo language, but reference fixtures stay labeled and cannot become production-readiness claims.",
    },
  ],
  acceptedRisks: [
    {
      id: "reference-fixture-demo-language",
      ownerProject: "Example Apps",
      mitigation: "Every reference fixture, transcript, screenshot slot, and recording slot keeps proof-mode labels.",
      launchRiskEffect: "unchanged",
    },
    {
      id: "public-copy-still-conditional",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      mitigation: "Release-candidate copy remains draft/hold until live evidence, legal/privacy review, and GA handoff evidence exist.",
      launchRiskEffect: "increased",
    },
  ],
  releaseCutlineDependencies: [
    {
      id: "launch-claim-documentation",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      readinessDomain: "documentation",
      cutlineCategory: "v1-blocker.documentation",
      source: "docs/design/launch-messaging-claims.md#evidence-required-for-publication",
    },
    {
      id: "demo-asset-productization",
      ownerProject: "Example Apps",
      readinessDomain: "productization",
      cutlineCategory: "v1-blocker.productization",
      source: "docs/design/launch-demo-golden-path.md#required-assets",
    },
    {
      id: "dogfood-operations-evidence",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      readinessDomain: "operations-readiness",
      cutlineCategory: "v1-blocker.operations-readiness",
      source: "docs/design/dogfood-yard.md",
    },
    {
      id: "release-owner-cutline",
      ownerProject: "V1 Release Program & Cutline",
      readinessDomain: "release-cutline",
      cutlineCategory: "v1-blocker.release-cutline",
      source: "src/draft/technical-proofs/v1-cutline-contract/README.md",
    },
    {
      id: "legal-public-copy-handoff",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      readinessDomain: "legal",
      cutlineCategory: "v1-blocker.legal",
      source: "docs/design/legal-privacy-terms-readiness.md",
    },
    {
      id: "support-route-for-unsupported-claims",
      ownerProject: "V1 Launch Support Desk & Escalation",
      readinessDomain: "support",
      cutlineCategory: "v1-blocker.support",
      source: "docs/design/launch-support-escalation.md",
    },
  ],
  followUps: [
    {
      id: "HOBO-479",
      evidenceId: "ga-launch-site-handoff-evidence",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      reason: "GA handoff evidence remains explicitly missing after the M3 release-candidate gate.",
    },
  ],
  initiativeStatus: {
    parentInitiative: "HoBo v1 Release Readiness",
    launchRiskChange: "increased",
    statusUpdateRequired: true,
    updateSource: "HOBO-472 records release-candidate launch-site evidence and keeps GA/public launch claims blocked on HOBO-479.",
  },
  scopeOut: [
    "No launch-site implementation, public marketing page, final visual assets, or final public copy is built or published by this proof.",
    "No GA readiness, production hosting, live customer traffic, or public launch claim is promoted from M3 release-candidate evidence.",
    "No follow-up issue is created for accepted evidence; only missing GA handoff evidence points to HOBO-479.",
  ],
  publicClaimGuards: [
    {
      id: "reference-fixture-production-readiness",
      claim: "Reference fixture demo evidence proves production readiness.",
      evidenceId: "golden-path-demo-assets",
      disposition: "hold",
    },
    {
      id: "release-candidate-public-copy",
      claim: "Release-candidate copy can be drafted when proof-mode labels and known limitations remain visible.",
      evidenceId: "claim-register-publication-rules",
      disposition: "draft",
    },
  ],
};

export function validateLaunchSiteReleaseCandidateEvidence(record: JsonValue) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["launch-site release-candidate evidence record is required"] };
  }

  // SAFETY: `const value = record as Partial<LaunchSiteReleaseCandidateEvidenceRecord>;` is required at this I/O or test boundary.
  const value = record as Partial<LaunchSiteReleaseCandidateEvidenceRecord>;
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  const blockers = Array.isArray(value.blockers) ? value.blockers : [];
  const acceptedRisks = Array.isArray(value.acceptedRisks) ? value.acceptedRisks : [];
  const releaseCutlineDependencies = Array.isArray(value.releaseCutlineDependencies)
    ? value.releaseCutlineDependencies
    : [];
  const followUps = Array.isArray(value.followUps) ? value.followUps : [];
  const scopeOut = Array.isArray(value.scopeOut) ? value.scopeOut : [];
  const publicClaimGuards = Array.isArray(value.publicClaimGuards) ? value.publicClaimGuards : [];

  if (value.issue !== "HOBO-472") errors.push("issue must be HOBO-472");
  if (value.project !== "V1 Launch Site, Messaging & Demo Assets") {
    errors.push("project must be V1 Launch Site, Messaging & Demo Assets");
  }
  if (value.phase !== "M3") errors.push("phase must be M3");
  if (value.milestone !== "M3 Release candidate") errors.push("milestone must be M3 Release candidate");

  if (!Array.isArray(value.evidence) || evidence.length < 6) {
    errors.push("M3 launch-site evidence must contain at least six owner-mapped entries");
  }
  for (const item of evidence) {
    if (!item.id || !item.ownerProject || !item.source || !item.acceptanceBullet) {
      errors.push(`${item.id ?? "<missing>"} evidence requires id, ownerProject, source, and acceptanceBullet`);
    }
  }

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));

  if (!Array.isArray(value.blockers) || blockers.length < 2) {
    errors.push("blockers must record at least two release-candidate blockers");
  }
  for (const blocker of blockers) {
    if (!blocker.id || !blocker.ownerProject || !blocker.sourceEvidenceId || !blocker.disposition) {
      errors.push(`${blocker.id ?? "<missing>"} blocker requires owner, sourceEvidenceId, and disposition`);
    }
    if (blocker.sourceEvidenceId && !evidenceById.has(blocker.sourceEvidenceId)) {
      errors.push(`${blocker.id ?? "<missing>"} blocker cites unknown evidence ${blocker.sourceEvidenceId}`);
    }
  }

  if (!Array.isArray(value.acceptedRisks) || acceptedRisks.length < 2) {
    errors.push("accepted risks must record at least two launch risk entries");
  }
  for (const risk of acceptedRisks) {
    if (!risk.id || !risk.ownerProject || !risk.mitigation || !risk.launchRiskEffect) {
      errors.push(`${risk.id ?? "<missing>"} risk requires owner, mitigation, and launchRiskEffect`);
    }
  }

  if (!Array.isArray(value.releaseCutlineDependencies) || releaseCutlineDependencies.length < 4) {
    errors.push("release cutline dependencies must map at least four readiness domains");
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
    if (/^\s*(build|implement|create|ship)\b.*\b(public\s+)?launch[- ]site\b/i.test(text)) {
      errors.push("launch-site implementation is scope-out");
    }
    if (/^\s*(publish|write|approve|ship|build|create|implement)\b.*\bfinal\s+(public\s+)?(launch\s+)?copy\b/i.test(text)) {
      errors.push("final public copy is scope-out");
    }
  }

  for (const claim of publicClaimGuards) {
    if (!claim.id || !claim.claim || !claim.evidenceId || !claim.disposition) {
      errors.push(`${claim.id ?? "<missing>"} public claim guard requires id, claim, evidenceId, and disposition`);
      continue;
    }
    const sourceEvidence = evidenceById.get(claim.evidenceId);
    if (claim.disposition === "publish" && /\bGA\b|\bgeneral availability\b/i.test(claim.claim)) {
      errors.push(`${claim.id}: GA launch claims require GA handoff evidence`);
    }
    if (claim.disposition === "publish" && sourceEvidence?.proofMode !== "live-recording") {
      errors.push(`${claim.id}: public launch claims require accepted live evidence`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertLaunchSiteReleaseCandidateEvidence(
  record: JsonValue = launchSiteReleaseCandidateEvidence,
) {
  const result = validateLaunchSiteReleaseCandidateEvidence(record);

  if (!result.ok) {
    throw new Error(`launch-site release-candidate evidence invalid:\n${result.errors.join("\n")}`);
  }

  // SAFETY: `return record as LaunchSiteReleaseCandidateEvidenceRecord;` is required at this I/O or test boundary.
  return record as LaunchSiteReleaseCandidateEvidenceRecord;
}
