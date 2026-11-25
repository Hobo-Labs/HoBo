import { isJsonObject, type JsonValue } from "./json.js";
export type EvidenceStatus = "accepted" | "accepted-risk" | "missing";
export type ProofMode = "design-record" | "issue-state" | "manual-review" | "release-cutline";
export type BlockerState = "cleared" | "accepted-risk";
export type LaunchRiskEffect = "unchanged" | "reduced";
export type ReadinessDomain = "legal" | "privacy" | "customer-assurance" | "security" | "release-cutline";

// domain-view: parse-produced draft-proof record; its wire form is the LegalPrivacyGaEvidenceItem proto message in data-models/.
export interface LegalPrivacyGaEvidenceItem {
  id: string;
  ownerProject: string;
  source: string;
  proofMode: ProofMode;
  status: EvidenceStatus;
  acceptanceBullet: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LegalPrivacyGaBlocker proto message in data-models/.
export interface LegalPrivacyGaBlocker {
  id: string;
  ownerProject: string;
  state: BlockerState;
  sourceEvidenceId: string;
  disposition: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LegalPrivacyGaAcceptedRisk proto message in data-models/.
export interface LegalPrivacyGaAcceptedRisk {
  id: string;
  ownerProject: string;
  mitigation: string;
  launchRiskEffect: LaunchRiskEffect;
}

// domain-view: parse-produced draft-proof record; its wire form is the LegalPrivacyGaReleaseCutlineDependency proto message in data-models/.
export interface LegalPrivacyGaReleaseCutlineDependency {
  id: string;
  ownerProject: string;
  readinessDomain: ReadinessDomain;
  cutlineCategory: `v1-blocker.${string}`;
  source: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LegalPrivacyGaMissingEvidence proto message in data-models/.
export interface LegalPrivacyGaMissingEvidence {
  id: string;
  ownerProject: string;
  reason: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LegalPrivacyGaFollowUp proto message in data-models/.
export interface LegalPrivacyGaFollowUp {
  id: string;
  evidenceId: string;
  ownerProject: string;
  reason: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LegalPrivacyGaInitiativeStatusGate proto message in data-models/.
export interface LegalPrivacyGaInitiativeStatusGate {
  parentInitiative: "HoBo v1 Release Readiness";
  launchRiskChange: LaunchRiskEffect;
  statusUpdateRequired: boolean;
  updateSource: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LegalPrivacyGaPublicClaimGuard proto message in data-models/.
export interface LegalPrivacyGaPublicClaimGuard {
  id: string;
  claim: string;
  evidenceId: string;
  disposition: "hold" | "draft" | "publish";
}

// domain-view: parse-produced draft-proof record; its wire form is the LegalPrivacyGaHandoffEvidenceRecord proto message in data-models/.
export interface LegalPrivacyGaHandoffEvidenceRecord {
  schema: string;
  issue: "HOBO-478";
  project: "V1 Legal, Privacy & Terms Readiness";
  phase: "M4";
  milestone: "M4 GA handoff";
  evidence: LegalPrivacyGaEvidenceItem[];
  blockers: LegalPrivacyGaBlocker[];
  acceptedRisks: LegalPrivacyGaAcceptedRisk[];
  releaseCutlineDependencies: LegalPrivacyGaReleaseCutlineDependency[];
  missingEvidence: LegalPrivacyGaMissingEvidence[];
  followUps: LegalPrivacyGaFollowUp[];
  initiativeStatus: LegalPrivacyGaInitiativeStatusGate;
  scopeOut: string[];
  publicClaimGuards: LegalPrivacyGaPublicClaimGuard[];
}

export const legalPrivacyGaHandoffEvidence: LegalPrivacyGaHandoffEvidenceRecord = {
  schema: "hobo.legal-privacy-ga-handoff-evidence/2026-06-30",
  issue: "HOBO-478",
  project: "V1 Legal, Privacy & Terms Readiness",
  phase: "M4",
  milestone: "M4 GA handoff",
  evidence: [
    {
      id: "m0-legal-privacy-checklist",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      source: "docs/design/legal-privacy-terms-readiness.md",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "private-beta-legal-privacy-baseline",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      source: "HOBO-464 / src/draft/exp-proofs/cx/legal-privacy-private-beta-evidence-contract",
      proofMode: "issue-state",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "ga-final-terms-signoff",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      source: "HOBO-478",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Blockers and accepted risks are recorded.",
    },
    {
      id: "ga-privacy-notice-dpa-signoff",
      ownerProject: "Customer Assurance Evidence Packet",
      source: "docs/design/customer-assurance-evidence-packet.md",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "subprocessor-provider-ga-register",
      ownerProject: "Compliance Evidence Pack",
      source: "docs/design/customer-assurance-evidence-packet.md",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "security-privacy-claim-review",
      ownerProject: "Security Verification",
      source: "docs/design/security-verification.md",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "release-cutline-ga-legal-signoff",
      ownerProject: "V1 Release Program & Cutline",
      source: "docs/design/go-no-go-decision-record.md",
      proofMode: "release-cutline",
      status: "accepted",
      acceptanceBullet: "The parent HoBo v1 Release Readiness initiative status is updated if this gate changes launch risk.",
    },
  ],
  blockers: [
    {
      id: "final-public-terms-privacy-signoff",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      state: "cleared",
      sourceEvidenceId: "ga-final-terms-signoff",
      disposition: "GA launch may cite legal/privacy readiness only as an evidence-backed signoff record; this package does not draft the text.",
    },
    {
      id: "regional-localization-notices",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      state: "accepted-risk",
      sourceEvidenceId: "ga-privacy-notice-dpa-signoff",
      disposition: "Localized notices and jurisdiction-specific expansion remain post-GA accepted risk, not a blocker for the scoped v1 GA handoff.",
    },
  ],
  acceptedRisks: [
    {
      id: "regional-notice-expansion-after-ga",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      mitigation: "Keep GA claim copy scoped to reviewed jurisdictions and route expansion requests to legal owner review.",
      launchRiskEffect: "unchanged",
    },
    {
      id: "subprocessor-list-change-window",
      ownerProject: "Compliance Evidence Pack",
      mitigation: "Treat provider/subprocessor changes after signoff as cutline-affecting evidence updates before launch copy changes.",
      launchRiskEffect: "unchanged",
    },
  ],
  releaseCutlineDependencies: [
    {
      id: "final-terms-signoff",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      readinessDomain: "legal",
      cutlineCategory: "v1-blocker.legal",
      source: "docs/design/legal-privacy-terms-readiness.md",
    },
    {
      id: "privacy-notice-dpa-signoff",
      ownerProject: "Customer Assurance Evidence Packet",
      readinessDomain: "privacy",
      cutlineCategory: "v1-blocker.privacy",
      source: "docs/design/customer-assurance-evidence-packet.md",
    },
    {
      id: "subprocessor-provider-register",
      ownerProject: "Compliance Evidence Pack",
      readinessDomain: "customer-assurance",
      cutlineCategory: "v1-blocker.customer-assurance",
      source: "docs/design/customer-assurance-evidence-packet.md",
    },
    {
      id: "security-privacy-claim-review",
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
      source: "docs/design/go-no-go-decision-record.md",
    },
  ],
  missingEvidence: [],
  followUps: [],
  initiativeStatus: {
    parentInitiative: "HoBo v1 Release Readiness",
    launchRiskChange: "reduced",
    statusUpdateRequired: true,
    updateSource:
      "HOBO-478 records GA legal/privacy handoff evidence, closes the GA public legal/privacy signoff gap, and preserves post-GA localization risk.",
  },
  scopeOut: [
    "No final customer terms, privacy policy, DPA, regional legal notice, or legal advice text is drafted in this proof package.",
    "No legal workflow, contract lifecycle system, billing system, paid launch mechanics, or commercial terms are implemented.",
    "No unsupported compliance, security, privacy, provider, all-region, or certification claim is promoted without evidence.",
  ],
  publicClaimGuards: [],
};

export function validateLegalPrivacyGaHandoffEvidence(record: JsonValue) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["legal/privacy GA handoff evidence record is required"] };
  }

  // SAFETY: `const value = record as Partial<LegalPrivacyGaHandoffEvidenceRecord>;` is required at this I/O or test boundary.
  const value = record as Partial<LegalPrivacyGaHandoffEvidenceRecord>;
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

  if (value.issue !== "HOBO-478") errors.push("issue must be HOBO-478");
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
  if (evidence.length < 7) errors.push("M4 legal/privacy evidence must contain at least seven owner-mapped entries");

  for (const item of evidence) {
    if (!item.id || !item.ownerProject || !item.source || !item.acceptanceBullet) {
      errors.push(`${item.id ?? "<missing>"} evidence requires id, ownerProject, source, and acceptanceBullet`);
    }
  }

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));

  if (blockers.length < 2) {
    errors.push("blockers must record at least two GA legal/privacy entries");
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
    errors.push("accepted risks must record at least two GA legal/privacy entries");
  }
  for (const risk of acceptedRisks) {
    if (!risk.id || !risk.ownerProject || !risk.mitigation || !risk.launchRiskEffect) {
      errors.push(`${risk.id ?? "<missing>"} risk requires owner, mitigation, and launchRiskEffect`);
    }
  }

  if (releaseCutlineDependencies.length < 5) {
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
    if (/^\s*(draft|write|author|create|produce)\b.*\b(final customer terms|privacy policy|DPA|legal text|terms and DPA)\b/i.test(text)) {
      errors.push("final legal drafting is scope-out");
    }
    if (/^\s*(implement|build|create|ship|enable)\b.*\b(legal contract lifecycle|legal workflow|contract lifecycle)\b/i.test(text)) {
      errors.push("legal workflow implementation is scope-out");
    }
    if (/^\s*(enable|implement|build|ship|approve)\b.*\b(billing|paid launch|commercial terms)\b/i.test(text)) {
      errors.push("billing or paid launch enablement is scope-out");
    }
  }
  for (const guard of publicClaimGuards) {
    if (!guard.id || !guard.claim || !guard.evidenceId || !guard.disposition) {
      errors.push(`${guard.id ?? "<missing>"} public claim guard requires id, claim, evidenceId, and disposition`);
      continue;
    }
    if (
      guard.disposition === "publish" &&
      /\b(SOC2 certified|GDPR compliant|HIPAA compliant|all regions|all jurisdictions|compliance certified)\b/i.test(guard.claim)
    ) {
      errors.push(`${guard.id}: unsupported public legal/privacy claim`);
    }
  }

  return { ok: errors.length === 0, errors };
}
