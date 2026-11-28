import { isJsonObject, type JsonValue } from "./json.js";
export type EvidenceStatus = "accepted" | "accepted-risk" | "missing";
export type ProofMode = "design-record" | "reference-fixture" | "live-recording" | "manual-review";
export type LaunchRiskEffect = "unchanged" | "increased" | "reduced";

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteDemoEvidenceItem proto message in data-models/.
export interface LaunchSiteDemoEvidenceItem {
  id: string;
  ownerProject: string;
  source: string;
  proofMode: ProofMode;
  status: EvidenceStatus;
  acceptanceBullet: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteDemoBlocker proto message in data-models/.
export interface LaunchSiteDemoBlocker {
  id: string;
  ownerProject: string;
  state: "accepted-risk" | "blocked";
  evidenceSource: string;
  mitigation: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteDemoAcceptedRisk proto message in data-models/.
export interface LaunchSiteDemoAcceptedRisk {
  id: string;
  ownerProject: string;
  mitigation: string;
  launchRiskEffect: LaunchRiskEffect;
}

export interface ReleaseCutlineDependency {
  id: string;
  ownerProject: string;
  readinessDomain: "documentation" | "productization" | "operations-readiness";
  cutlineCategory: `v1-blocker.${string}`;
  source: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteDemoFollowUp proto message in data-models/.
export interface LaunchSiteDemoFollowUp {
  id: string;
  evidenceId: string;
  ownerProject: string;
  reason: string;
}

export interface InitiativeStatusGate {
  parentInitiative: "HoBo v1 Release Readiness";
  launchRiskChange: LaunchRiskEffect;
  statusUpdateRequired: boolean;
  updateSource: string;
}

export interface PublicClaimGuard {
  id: string;
  claim: string;
  evidenceId: string;
  disposition: "hold" | "draft" | "publish";
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteDemoAlphaEvidenceRecord proto message in data-models/.
export interface LaunchSiteDemoAlphaEvidenceRecord {
  schema: string;
  issue: "HOBO-458";
  project: "V1 Launch Site, Messaging & Demo Assets";
  phase: "M1";
  milestone: "M1 Dogfood/alpha proof";
  evidence: LaunchSiteDemoEvidenceItem[];
  blockers: LaunchSiteDemoBlocker[];
  acceptedRisks: LaunchSiteDemoAcceptedRisk[];
  releaseCutlineDependencies: ReleaseCutlineDependency[];
  followUps: LaunchSiteDemoFollowUp[];
  initiativeStatus: InitiativeStatusGate;
  scopeOut: string[];
  publicClaimGuards: PublicClaimGuard[];
}

export const launchSiteDemoAlphaEvidence: LaunchSiteDemoAlphaEvidenceRecord = {
  schema: "hobo.launch-site-demo-alpha-evidence/2026-06-30",
  issue: "HOBO-458",
  project: "V1 Launch Site, Messaging & Demo Assets",
  phase: "M1",
  milestone: "M1 Dogfood/alpha proof",
  blockers: [
    {
      id: "live-recording-is-alpha-slot",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      state: "accepted-risk",
      evidenceSource: "docs/design/launch-demo-golden-path.md#required-assets",
      mitigation: "Alpha proof may reserve the recording-manifest slot, but public launch copy waits for live accepted recording evidence.",
    },
  ],
  acceptedRisks: [
    {
      id: "reference-fixture-demo-path",
      ownerProject: "Example Apps",
      mitigation: "Every reference fixture keeps proof-mode labels and cannot be promoted to live product wording.",
      launchRiskEffect: "unchanged",
    },
    {
      id: "public-copy-not-final",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      mitigation: "This M1 gate records evidence and boundaries only; final launch-page copy remains scope-out.",
      launchRiskEffect: "unchanged",
    },
  ],
  releaseCutlineDependencies: [
    {
      id: "launch-claims-documentation",
      ownerProject: "V1 Release Program & Cutline",
      readinessDomain: "documentation",
      cutlineCategory: "v1-blocker.documentation",
      source: "src/draft/technical-proofs/v1-cutline-contract/README.md",
    },
    {
      id: "demo-proof-mode-productization",
      ownerProject: "Example Apps",
      readinessDomain: "productization",
      cutlineCategory: "v1-blocker.productization",
      source: "docs/design/launch-demo-golden-path.md#required-assets",
    },
    {
      id: "dogfood-alpha-recording-operations",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      readinessDomain: "operations-readiness",
      cutlineCategory: "v1-blocker.operations-readiness",
      source: "docs/design/launch-messaging-claims.md#evidence-required-for-publication",
    },
  ],
  followUps: [],
  initiativeStatus: {
    parentInitiative: "HoBo v1 Release Readiness",
    launchRiskChange: "unchanged",
    statusUpdateRequired: false,
    updateSource: "No parent initiative status update required because HOBO-458 records alpha evidence without increasing launch risk.",
  },
  scopeOut: [
    "No public launch-site implementation, publishing, marketing copy, or final visual assets are created by this proof.",
    "No production-readiness claim may be made from reference fixtures or alpha-only recording slots.",
  ],
  publicClaimGuards: [],
  evidence: [
    {
      id: "claim-register",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      source: "docs/design/launch-messaging-claims.md#initial-claim-register",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "demo-golden-path",
      ownerProject: "Example Apps",
      source: "docs/design/launch-demo-golden-path.md#command-path",
      proofMode: "reference-fixture",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "recording-manifest-slot",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      source: "docs/design/launch-demo-golden-path.md#required-assets",
      proofMode: "live-recording",
      status: "accepted-risk",
      acceptanceBullet: "Blockers and accepted risks are recorded.",
    },
    {
      id: "cutline-documentation-domain",
      ownerProject: "V1 Release Program & Cutline",
      source: "src/draft/technical-proofs/v1-cutline-contract/README.md",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "known-limitations-register",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      source: "docs/design/launch-messaging-claims.md#scope-out-and-follow-up",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Follow-up execution issues are created only where evidence is missing.",
    },
  ],
};

export function validateLaunchSiteDemoAlphaEvidence(record: JsonValue) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["launch-site demo alpha evidence record is required"] };
  }

  // SAFETY: `const value = record as Partial<LaunchSiteDemoAlphaEvidenceRecord>;` is required at this I/O or test boundary.
  const value = record as Partial<LaunchSiteDemoAlphaEvidenceRecord>;

  if (value.issue !== "HOBO-458") {
    errors.push("issue must be HOBO-458");
  }
  if (value.phase !== "M1") {
    errors.push("phase must be M1");
  }
  if (value.milestone !== "M1 Dogfood/alpha proof") {
    errors.push("milestone must be M1 Dogfood/alpha proof");
  }
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
    errors.push("M1 evidence must contain at least five owner-mapped entries");
  }
  if (!Array.isArray(value.blockers) || blockers.length < 1) {
    errors.push("blockers must record at least one alpha gate blocker or accepted risk");
  }
  if (!Array.isArray(value.acceptedRisks) || acceptedRisks.length < 2) {
    errors.push("accepted risks must record at least two launch risk entries");
  }
  if (!Array.isArray(value.releaseCutlineDependencies) || releaseCutlineDependencies.length < 3) {
    errors.push("release cutline dependencies must map at least three readiness domains");
  }

  for (const item of evidence) {
    if (!item.id || !item.ownerProject || !item.source || !item.acceptanceBullet) {
      errors.push(`${item.id ?? "<missing>"} evidence requires id, ownerProject, source, and acceptanceBullet`);
    }
  }
  for (const blocker of blockers) {
    if (!blocker.id || !blocker.ownerProject || !blocker.evidenceSource || !blocker.mitigation) {
      errors.push(`${blocker.id ?? "<missing>"} blocker requires owner, evidenceSource, and mitigation`);
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
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  for (const followUp of followUps) {
    if (!followUp.id || !followUp.evidenceId || !followUp.ownerProject || !followUp.reason) {
      errors.push(`${followUp.id ?? "<missing>"} follow-up requires id, evidenceId, ownerProject, and reason`);
      continue;
    }
    const evidence = evidenceById.get(followUp.evidenceId);
    if (evidence?.status !== "missing") {
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
    if (/^\s*(build|publish|ship|implement)\b.*public launch site/i.test(text)) {
      errors.push("launch site implementation is scope-out");
    }
  }
  const evidenceByIdForClaims = new Map(evidence.map((item) => [item.id, item]));
  for (const claim of publicClaimGuards) {
    if (!claim.id || !claim.claim || !claim.evidenceId || !claim.disposition) {
      errors.push(`${claim.id ?? "<missing>"} public claim guard requires id, claim, evidenceId, and disposition`);
      continue;
    }
    const evidence = evidenceByIdForClaims.get(claim.evidenceId);
    if (claim.disposition === "publish" && !(evidence?.status === "accepted" && evidence.proofMode === "live-recording")) {
      errors.push(`${claim.id}: public claims require accepted live evidence`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertLaunchSiteDemoAlphaEvidence(record = launchSiteDemoAlphaEvidence) {
  const result = validateLaunchSiteDemoAlphaEvidence(record);

  if (!result.ok) {
    throw new Error(`launch-site demo alpha evidence invalid:\n${result.errors.join("\n")}`);
  }

  return record;
}
