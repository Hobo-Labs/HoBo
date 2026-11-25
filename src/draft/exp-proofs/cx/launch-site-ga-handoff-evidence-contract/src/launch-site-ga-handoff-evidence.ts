import { isJsonObject, type JsonValue } from "./json.js";
export type EvidenceStatus = "accepted" | "accepted-risk" | "missing";
export type ProofMode = "design-record" | "issue-state" | "manual-review" | "live-recording";
export type LaunchRiskEffect = "unchanged" | "increased" | "reduced";
export type BlockerState = "blocked" | "accepted-risk" | "cleared";

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteGaEvidenceItem proto message in data-models/.
export interface LaunchSiteGaEvidenceItem {
  id: string;
  ownerProject: string;
  source: string;
  proofMode: ProofMode;
  status: EvidenceStatus;
  acceptanceBullet: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteGaBlocker proto message in data-models/.
export interface LaunchSiteGaBlocker {
  id: string;
  ownerProject: string;
  state: BlockerState;
  sourceEvidenceId: string;
  disposition: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteGaAcceptedRisk proto message in data-models/.
export interface LaunchSiteGaAcceptedRisk {
  id: string;
  ownerProject: string;
  mitigation: string;
  launchRiskEffect: LaunchRiskEffect;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteGaCutlineDependency proto message in data-models/.
export interface LaunchSiteGaCutlineDependency {
  id: string;
  ownerProject: string;
  readinessDomain:
    | "documentation"
    | "productization"
    | "operations-readiness"
    | "support"
    | "legal-privacy"
    | "release-cutline";
  cutlineCategory: `v1-blocker.${string}`;
  source: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteGaFollowUp proto message in data-models/.
export interface LaunchSiteGaFollowUp {
  id: string;
  evidenceId: string;
  ownerProject: string;
  reason: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteGaInitiativeStatusGate proto message in data-models/.
export interface LaunchSiteGaInitiativeStatusGate {
  parentInitiative: "HoBo v1 Release Readiness";
  launchRiskChange: LaunchRiskEffect;
  statusUpdateRequired: boolean;
  updateSource: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteGaPublicClaimGuard proto message in data-models/.
export interface LaunchSiteGaPublicClaimGuard {
  id: string;
  claim: string;
  evidenceId: string;
  disposition: "hold" | "draft" | "publish";
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSiteGaHandoffEvidenceRecord proto message in data-models/.
export interface LaunchSiteGaHandoffEvidenceRecord {
  schema: string;
  issue: "HOBO-479";
  project: "V1 Launch Site, Messaging & Demo Assets";
  phase: "M4";
  milestone: "M4 GA handoff";
  evidence: LaunchSiteGaEvidenceItem[];
  blockers: LaunchSiteGaBlocker[];
  acceptedRisks: LaunchSiteGaAcceptedRisk[];
  releaseCutlineDependencies: LaunchSiteGaCutlineDependency[];
  followUps: LaunchSiteGaFollowUp[];
  initiativeStatus: LaunchSiteGaInitiativeStatusGate;
  scopeOut: string[];
  publicClaimGuards: LaunchSiteGaPublicClaimGuard[];
}

export const launchSiteGaHandoffEvidence: LaunchSiteGaHandoffEvidenceRecord = {
  schema: "hobo.launch-site-ga-handoff-evidence/2026-06-30",
  issue: "HOBO-479",
  project: "V1 Launch Site, Messaging & Demo Assets",
  phase: "M4",
  milestone: "M4 GA handoff",
  evidence: [
    {
      id: "launch-claim-register",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      source: "docs/design/launch-messaging-claims.md#initial-claim-register",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "golden-path-demo-record",
      ownerProject: "Example Apps",
      source: "docs/design/launch-demo-golden-path.md",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "private-beta-launch-site-evidence",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      source: "src/draft/launch-site-private-beta-evidence-contract/README.md",
      proofMode: "issue-state",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "release-candidate-launch-site-evidence",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      source: "HOBO-472",
      proofMode: "issue-state",
      status: "accepted-risk",
      acceptanceBullet: "Blockers and accepted risks are recorded.",
    },
    {
      id: "final-public-copy-approval",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      source: "HOBO-479",
      proofMode: "manual-review",
      status: "missing",
      acceptanceBullet: "Follow-up execution issues are created only where evidence is missing.",
    },
    {
      id: "ga-launch-asset-manifest",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      source: "src/draft/launch-site-ga-handoff-evidence-contract",
      proofMode: "live-recording",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "release-cutline-handoff",
      ownerProject: "V1 Release Program & Cutline",
      source: "src/draft/technical-proofs/v1-cutline-contract/README.md",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
  ],
  blockers: [
    {
      id: "release-candidate-source-in-progress",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      state: "accepted-risk",
      sourceEvidenceId: "release-candidate-launch-site-evidence",
      disposition: "HOBO-472 is tracked as the release-candidate source; GA handoff can record this risk but cannot bypass owner acceptance.",
    },
    {
      id: "public-claim-publication-needs-owner-review",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      state: "blocked",
      sourceEvidenceId: "ga-launch-asset-manifest",
      disposition: "GA handoff evidence records owner readiness, but final public launch copy and site publication still require owner review.",
    },
  ],
  acceptedRisks: [
    {
      id: "conditional-release-candidate-source",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      mitigation: "Keep GA handoff language conditional on accepted release-candidate evidence and link the in-progress owner source.",
      launchRiskEffect: "increased",
    },
    {
      id: "live-recording-refresh-window",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      mitigation: "Treat launch recordings and screenshots as refresh-gated assets with owner and trigger metadata.",
      launchRiskEffect: "unchanged",
    },
  ],
  releaseCutlineDependencies: [
    {
      id: "launch-message-documentation",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      readinessDomain: "documentation",
      cutlineCategory: "v1-blocker.documentation",
      source: "docs/design/release-notes-upgrade-guide.md",
    },
    {
      id: "launch-demo-productization",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      readinessDomain: "productization",
      cutlineCategory: "v1-blocker.productization",
      source: "docs/design/launch-demo-golden-path.md",
    },
    {
      id: "hosted-demo-operations-readiness",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      readinessDomain: "operations-readiness",
      cutlineCategory: "v1-blocker.operations-readiness",
      source: "docs/design/dogfood-yard.md",
    },
    {
      id: "launch-support-handoff",
      ownerProject: "V1 Launch Support Desk & Escalation",
      readinessDomain: "support",
      cutlineCategory: "v1-blocker.support",
      source: "docs/design/launch-support-escalation.md",
    },
    {
      id: "legal-privacy-copy-boundary",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      readinessDomain: "legal-privacy",
      cutlineCategory: "v1-blocker.legal-privacy",
      source: "docs/design/legal-privacy-terms-readiness.md",
    },
    {
      id: "release-owner-ga-signoff",
      ownerProject: "V1 Release Program & Cutline",
      readinessDomain: "release-cutline",
      cutlineCategory: "v1-blocker.release-cutline",
      source: "src/draft/technical-proofs/v1-cutline-contract/README.md",
    },
  ],
  followUps: [
    {
      id: "final-public-copy-owner-review",
      evidenceId: "final-public-copy-approval",
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      reason: "Final public launch copy and site publication remain owner-reviewed handoff evidence, not implementation in this proof.",
    },
  ],
  initiativeStatus: {
    parentInitiative: "HoBo v1 Release Readiness",
    launchRiskChange: "increased",
    statusUpdateRequired: true,
    updateSource: "HOBO-479 records GA launch-site handoff evidence with public-claim publication still owner-gated.",
  },
  scopeOut: [
    "No launch marketing site, public page, final launch copy, visual polish, screenshots, final demo video, real cloud resources, provider credentials, production hosting, or public production-readiness claim is implemented.",
    "No private beta or release-candidate evidence is promoted to unconditional GA wording without accepted owner review.",
  ],
  publicClaimGuards: [
    {
      id: "ga-owner-review-required",
      claim: "GA launch site claims can be drafted only after owner-reviewed GA handoff evidence is linked.",
      evidenceId: "ga-launch-asset-manifest",
      disposition: "hold",
    },
  ],
};

export function validateLaunchSiteGaHandoffEvidence(record: JsonValue) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["launch-site GA handoff evidence record is required"] };
  }

  // SAFETY: `const value = record as Partial<LaunchSiteGaHandoffEvidenceRecord>;` is required at this I/O or test boundary.
  const value = record as Partial<LaunchSiteGaHandoffEvidenceRecord>;
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  const blockers = Array.isArray(value.blockers) ? value.blockers : [];
  const acceptedRisks = Array.isArray(value.acceptedRisks) ? value.acceptedRisks : [];
  const releaseCutlineDependencies = Array.isArray(value.releaseCutlineDependencies)
    ? value.releaseCutlineDependencies
    : [];
  const followUps = Array.isArray(value.followUps) ? value.followUps : [];
  const scopeOut = Array.isArray(value.scopeOut) ? value.scopeOut : [];
  const publicClaimGuards = Array.isArray(value.publicClaimGuards) ? value.publicClaimGuards : [];

  if (value.issue !== "HOBO-479") errors.push("issue must be HOBO-479");
  if (value.phase !== "M4") errors.push("phase must be M4");
  if (value.milestone !== "M4 GA handoff") errors.push("milestone must be M4 GA handoff");
  if (!Array.isArray(value.evidence) || evidence.length < 6) {
    errors.push("M4 GA handoff evidence must contain at least six owner-mapped entries");
  }

  for (const item of evidence) {
    if (!item.id || !item.ownerProject || !item.source || !item.acceptanceBullet) {
      errors.push(`${item.id ?? "<missing>"} evidence requires id, ownerProject, source, and acceptanceBullet`);
    }
  }

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));

  if (!Array.isArray(value.blockers) || blockers.length < 2) {
    errors.push("blockers must record at least two GA handoff blockers");
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

  if (!Array.isArray(value.releaseCutlineDependencies) || releaseCutlineDependencies.length < 6) {
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
    if (/^\s*(build|publish|ship|implement)\b.*\b(public\s+)?launch[- ]site\b/i.test(text)) {
      errors.push("launch-site implementation is scope-out");
    }
    if (/^\s*(create|write|publish|ship|finalize)\b.*(final launch copy|visual polish|screenshots|final demo video)/i.test(text)) {
      errors.push("final launch copy and assets are scope-out");
    }
    if (/^\s*(provision|create|deploy)\b.*(real cloud resources|provider credentials|production hosting)/i.test(text)) {
      errors.push("real cloud resource provisioning is scope-out");
    }
  }
  for (const claim of publicClaimGuards) {
    if (!claim.id || !claim.claim || !claim.evidenceId || !claim.disposition) {
      errors.push(`${claim.id ?? "<missing>"} public claim guard requires id, claim, evidenceId, and disposition`);
      continue;
    }
    const evidence = evidenceById.get(claim.evidenceId);
    const acceptedGaEvidence = evidence?.status === "accepted" && evidence.id === "ga-launch-asset-manifest";
    if (claim.disposition === "publish" && /\bGA\b|\bgeneral availability\b|\bproduction readiness\b/i.test(claim.claim)) {
      if (!acceptedGaEvidence) {
        errors.push(`${claim.id}: GA launch claims require accepted GA handoff evidence and owner review`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertLaunchSiteGaHandoffEvidence(record = launchSiteGaHandoffEvidence) {
  const result = validateLaunchSiteGaHandoffEvidence(record);

  if (!result.ok) {
    throw new Error(`launch-site GA handoff evidence invalid:\n${result.errors.join("\n")}`);
  }

  return record;
}
