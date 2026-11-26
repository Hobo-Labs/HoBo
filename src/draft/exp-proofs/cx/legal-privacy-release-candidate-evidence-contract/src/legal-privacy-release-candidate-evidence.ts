import { isJsonObject, type JsonValue } from "./json.js";
export const REQUIRED_RELEASE_CANDIDATE_EVIDENCE_IDS = [
  "m0-checklist-baseline",
  "private-beta-legal-privacy-source",
  "privacy-release-candidate-review",
  "terms-release-candidate-limitation",
  "subprocessor-provider-release-candidate-register",
  "data-retention-telemetry-release-candidate-boundary",
  "customer-assurance-legal-support-handoff",
  "release-candidate-risk-register"
] as const;

type RequiredEvidenceId = (typeof REQUIRED_RELEASE_CANDIDATE_EVIDENCE_IDS)[number];
type EvidenceStatus = "accepted" | "pending" | "missing";
type Phase = "M1" | "M2" | "M3" | "M4";
type BlockerCategory = "release-candidate-limitation" | "ga-blocker" | "launch-note";

type RequiredEvidence = {
  id: RequiredEvidenceId;
  ownerProject: string;
  evidenceSource: string;
  proves: string;
  status: EvidenceStatus;
};

type Blocker = {
  id: string;
  category: BlockerCategory;
  ownerProject: string;
  sourceEvidenceId: RequiredEvidenceId;
  disposition: string;
  launchRisk: "low" | "medium" | "high";
};

type AcceptedRisk = {
  id: string;
  ownerRole: string;
  mitigation: string;
  followUpOrLaunchNote: string;
  revisitDate: string;
  evidenceId: RequiredEvidenceId;
};

type CrossProjectDependency = {
  ownerProject: string;
  consumesEvidenceId: RequiredEvidenceId;
  cutlineImpact: string;
};

type MissingEvidence = {
  id: string;
  ownerProject: string;
  reason: string;
  launchDisposition: "follow-up" | "blocked";
};

type FollowUpIssue = {
  id: string;
  ownerProject: string;
  missingEvidenceId: string;
  allowedReason: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the LegalPrivacyReleaseCandidateEvidence proto message in data-models/.
type LegalPrivacyReleaseCandidateEvidence = {
  schema: string;
  issue: "HOBO-471";
  parentIssue: "HOBO-405";
  project: "V1 Legal, Privacy & Terms Readiness";
  phase: Phase;
  milestoneGate: "M3 Release candidate";
  decisionStatus: string;
  requiredEvidence: RequiredEvidence[];
  blockers: Blocker[];
  acceptedRisks: AcceptedRisk[];
  crossProjectDependencies: CrossProjectDependency[];
  missingEvidence: MissingEvidence[];
  followUpIssues: FollowUpIssue[];
  customerClaimPolicy: {
    releaseCandidateAllowedClaims: string[];
    unsupportedPublicClaims: string[];
    scopeOut: string[];
  };
  releaseCutlineReflection: {
    cutlineProject: "V1 Release Program & Cutline";
    reflectedEvidenceIds: RequiredEvidenceId[];
    limitationsAreVisible: boolean;
  };
  parentInitiativeSync: {
    initiative: "HoBo v1 Release Readiness";
    launchRiskChanged: boolean;
    statusUpdated: boolean;
    statusUpdateReason: string;
  };
};

type ValidationResult = {
  ok: boolean;
  errors: string[];
};

const FORBIDDEN_PUBLIC_CLAIM_PATTERNS = [
  /\bfinal terms approved\b/i,
  /\bpaid GA\b/i,
  /\ball regions\b/i,
  /\bSOC2 certified\b/i,
  /\bGDPR compliant\b/i,
  /\bHIPAA compliant\b/i,
  /\bDPA approved\b/i,
  /\bproduction legal approval\b/i
];

export const legalPrivacyReleaseCandidateEvidence: LegalPrivacyReleaseCandidateEvidence = {
  schema: "hobo.v1.legal-privacy.release-candidate-evidence/2026-06-30",
  issue: "HOBO-471",
  parentIssue: "HOBO-405",
  project: "V1 Legal, Privacy & Terms Readiness",
  phase: "M3",
  milestoneGate: "M3 Release candidate",
  decisionStatus: "release-candidate-evidence-accepted-with-ga-legal-limitations",
  requiredEvidence: [
    {
      id: "m0-checklist-baseline",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      evidenceSource: "src/draft/exp-proofs/cx/legal-privacy-terms-readiness-contract",
      proves: "The accepted M0 checklist still anchors terms, privacy notice, retention, telemetry, subprocessors, support, security claims, and customer communications.",
      status: "accepted"
    },
    {
      id: "private-beta-legal-privacy-source",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      evidenceSource: "src/draft/exp-proofs/cx/legal-privacy-private-beta-evidence-contract",
      proves: "M2 private beta evidence is accepted and its release-candidate and GA gaps are explicit rather than hidden.",
      status: "accepted"
    },
    {
      id: "privacy-release-candidate-review",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      evidenceSource: "docs/design/legal-privacy-terms-readiness.md#m3-release-candidate-evidence-gate",
      proves: "Release-candidate privacy posture names telemetry purpose, retention posture, customer messaging, data class boundaries, and beta-to-RC limitations.",
      status: "accepted"
    },
    {
      id: "terms-release-candidate-limitation",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      evidenceSource: "docs/design/legal-privacy-terms-readiness.md#m3-release-candidate-evidence-gate",
      proves: "Release-candidate terms posture is a reviewable limitation and does not claim paid GA, final DPA, final privacy-policy, or regional legal approval.",
      status: "accepted"
    },
    {
      id: "subprocessor-provider-release-candidate-register",
      ownerProject: "Customer Assurance Evidence Packet",
      evidenceSource: "docs/design/customer-assurance-evidence-packet.md",
      proves: "Subprocessor, provider, unsupported, optional, mocked, and still-unconfirmed services are visible before release-candidate customer assurance claims.",
      status: "accepted"
    },
    {
      id: "data-retention-telemetry-release-candidate-boundary",
      ownerProject: "Compliance Evidence Pack",
      evidenceSource: "docs/design/tenant-data-lifecycle.md",
      proves: "Data retention, export/deletion, telemetry, and support-access boundaries are reflected before release-candidate workflows touch customer data.",
      status: "accepted"
    },
    {
      id: "customer-assurance-legal-support-handoff",
      ownerProject: "V1 Launch Support Desk & Escalation",
      evidenceSource: "docs/design/support-sla-channels.md",
      proves: "Legal/privacy customer-assurance and support questions route to owners without inventing unsupported SLA, compliance, or DPA promises.",
      status: "accepted"
    },
    {
      id: "release-candidate-risk-register",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "docs/design/go-no-go-decision-record.md",
      proves: "Legal/privacy blockers, accepted risks, mitigations, launch notes, and revisit dates are reflected in the release-candidate cutline.",
      status: "accepted"
    }
  ],
  blockers: [
    {
      id: "paid-ga-legal-approval",
      category: "ga-blocker",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      sourceEvidenceId: "terms-release-candidate-limitation",
      disposition: "Release-candidate evidence may be accepted, but paid GA remains blocked until final terms, privacy notice, DPA, and regional notices are approved.",
      launchRisk: "high"
    },
    {
      id: "enterprise-assurance-final-list",
      category: "release-candidate-limitation",
      ownerProject: "Customer Assurance Evidence Packet",
      sourceEvidenceId: "subprocessor-provider-release-candidate-register",
      disposition: "Enterprise assurance packets can describe confirmed release-candidate services, but unconfirmed subprocessors and providers stay explicit limitations.",
      launchRisk: "medium"
    },
    {
      id: "public-compliance-claim-limit",
      category: "launch-note",
      ownerProject: "Security Verification",
      sourceEvidenceId: "release-candidate-risk-register",
      disposition: "Public security, privacy, provider, and compliance claims remain source-gated and cannot be upgraded by legal/privacy release-candidate evidence alone.",
      launchRisk: "medium"
    }
  ],
  acceptedRisks: [
    {
      id: "rc-limited-legal-language",
      ownerRole: "legal-owner",
      mitigation: "Use release-candidate limitation language and route paid/public launch copy to final legal review.",
      followUpOrLaunchNote: "Release notes and launch messaging must state this as release-candidate evidence, not final public launch approval.",
      revisitDate: "2026-08-15",
      evidenceId: "terms-release-candidate-limitation"
    },
    {
      id: "rc-subprocessor-register-limit",
      ownerRole: "vendor-owner",
      mitigation: "Allow only release-candidate cohorts whose required providers and processors are covered by accepted evidence.",
      followUpOrLaunchNote: "Customer assurance packet lists unconfirmed subprocessors as limitations until GA handoff evidence lands.",
      revisitDate: "2026-08-15",
      evidenceId: "subprocessor-provider-release-candidate-register"
    }
  ],
  crossProjectDependencies: [
    {
      ownerProject: "V1 Release Program & Cutline",
      consumesEvidenceId: "release-candidate-risk-register",
      cutlineImpact: "The release cutline carries legal/privacy M3 blockers, accepted risks, and launch notes as visible readiness evidence."
    },
    {
      ownerProject: "V1 Release Notes & Upgrade Guide",
      consumesEvidenceId: "terms-release-candidate-limitation",
      cutlineImpact: "Release notes can state release-candidate legal/privacy limitations without promoting final GA terms or DPA approval."
    },
    {
      ownerProject: "Customer Assurance Evidence Packet",
      consumesEvidenceId: "subprocessor-provider-release-candidate-register",
      cutlineImpact: "Customer assurance can answer RC provider/subprocessor questions only from accepted evidence."
    },
    {
      ownerProject: "Compliance Evidence Pack",
      consumesEvidenceId: "data-retention-telemetry-release-candidate-boundary",
      cutlineImpact: "Retention, telemetry, export/deletion, and support-access boundaries decide whether RC workflows may touch customer data."
    },
    {
      ownerProject: "V1 Launch Support Desk & Escalation",
      consumesEvidenceId: "customer-assurance-legal-support-handoff",
      cutlineImpact: "Support routes legal/privacy and assurance questions without inventing unowned commitments."
    },
    {
      ownerProject: "V1 Launch Site, Messaging & Demo Assets",
      consumesEvidenceId: "release-candidate-risk-register",
      cutlineImpact: "Launch messaging can use only claims with source evidence, owner, risk, and disposition."
    }
  ],
  missingEvidence: [
    {
      id: "ga-public-legal-privacy-signoff",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      reason: "Release-candidate evidence does not prove final public/paid GA terms, privacy notice, DPA, regional notices, or compliance claims.",
      launchDisposition: "follow-up"
    }
  ],
  followUpIssues: [
    {
      id: "HOBO-478",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      missingEvidenceId: "ga-public-legal-privacy-signoff",
      allowedReason: "Existing M4 GA handoff issue owns public/paid launch legal/privacy signoff gaps."
    }
  ],
  customerClaimPolicy: {
    releaseCandidateAllowedClaims: [
      "Legal/privacy release-candidate evidence is accepted with explicit GA limitations.",
      "Release-candidate telemetry, retention, subprocessor, provider, and support handoffs are owner-mapped.",
      "Unsupported public, paid-GA, final-DPA, regional, and compliance claims remain blocked."
    ],
    unsupportedPublicClaims: [],
    scopeOut: [
      "final customer terms drafting",
      "final privacy policy or DPA approval",
      "legal workflow implementation",
      "billing or paid GA enablement",
      "public compliance certification claims",
      "support desk product implementation"
    ]
  },
  releaseCutlineReflection: {
    cutlineProject: "V1 Release Program & Cutline",
    reflectedEvidenceIds: [
      "privacy-release-candidate-review",
      "terms-release-candidate-limitation",
      "subprocessor-provider-release-candidate-register",
      "data-retention-telemetry-release-candidate-boundary",
      "customer-assurance-legal-support-handoff",
      "release-candidate-risk-register"
    ],
    limitationsAreVisible: true
  },
  parentInitiativeSync: {
    initiative: "HoBo v1 Release Readiness",
    launchRiskChanged: true,
    statusUpdated: true,
    statusUpdateReason:
      "M3 legal/privacy release-candidate evidence is accepted, while GA legal/privacy signoff remains an explicit HOBO-478 follow-up."
  }
};

export function validateLegalPrivacyReleaseCandidateEvidence(record: JsonValue): ValidationResult {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["legal/privacy release-candidate evidence record is required"] };
  }

  // SAFETY: `const candidate = record as Partial<LegalPrivacyReleaseCandidateEvidence>;` is required at this I/O or test boundary.
  const candidate = record as Partial<LegalPrivacyReleaseCandidateEvidence>;

  if (candidate.issue !== "HOBO-471") {
    errors.push("issue must be HOBO-471");
  }
  if (candidate.parentIssue !== "HOBO-405") {
    errors.push("parent issue must be HOBO-405");
  }
  if (candidate.phase !== "M3") {
    errors.push("phase must be M3");
  }
  if (candidate.milestoneGate !== "M3 Release candidate") {
    errors.push("milestone gate must be M3 Release candidate");
  }

  const evidenceIds = new Set((candidate.requiredEvidence ?? []).map((item) => item.id));
  for (const evidenceId of REQUIRED_RELEASE_CANDIDATE_EVIDENCE_IDS) {
    if (!evidenceIds.has(evidenceId)) {
      errors.push(`missing required M3 evidence: ${evidenceId}`);
    }
  }

  for (const evidence of candidate.requiredEvidence ?? []) {
    if (!evidence.ownerProject || !evidence.evidenceSource || !evidence.proves) {
      errors.push(`${evidence.id ?? "<missing>"} must map to ownerProject, evidenceSource, and proof statement`);
    }
    if (evidence.status !== "accepted") {
      errors.push(`${evidence.id ?? "<missing>"} must be accepted before the M3 release-candidate gate can pass`);
    }
  }

  if (!candidate.blockers?.length) {
    errors.push("blockers must be recorded");
  }
  for (const blocker of candidate.blockers ?? []) {
    if (!blocker.id || !blocker.category || !blocker.ownerProject || !blocker.sourceEvidenceId || !blocker.disposition) {
      errors.push(`${blocker.id ?? "<missing>"} blocker must name category, ownerProject, sourceEvidenceId, and disposition`);
    }
    if (blocker.sourceEvidenceId && !evidenceIds.has(blocker.sourceEvidenceId)) {
      errors.push(`${blocker.id ?? "<missing>"} blocker cites unknown evidence ${blocker.sourceEvidenceId}`);
    }
  }

  if (!candidate.acceptedRisks?.length) {
    errors.push("accepted risks must be recorded");
  }
  for (const risk of candidate.acceptedRisks ?? []) {
    if (!risk.id || !risk.ownerRole || !risk.mitigation || !risk.followUpOrLaunchNote || !risk.revisitDate) {
      errors.push(`${risk.id ?? "<missing>"} accepted risk must name ownerRole, mitigation, followUpOrLaunchNote, and revisitDate`);
    }
    if (risk.evidenceId && !evidenceIds.has(risk.evidenceId)) {
      errors.push(`${risk.id ?? "<missing>"} accepted risk cites unknown evidence ${risk.evidenceId}`);
    }
  }

  if (!candidate.crossProjectDependencies?.length) {
    errors.push("cross-project dependencies must be reflected in the release cutline");
  }
  for (const dependency of candidate.crossProjectDependencies ?? []) {
    if (!dependency.ownerProject || !dependency.consumesEvidenceId || !dependency.cutlineImpact) {
      errors.push(`${dependency.ownerProject ?? "<missing>"} dependency must name ownerProject, consumesEvidenceId, and cutlineImpact`);
    }
    if (dependency.consumesEvidenceId && !evidenceIds.has(dependency.consumesEvidenceId)) {
      errors.push(`${dependency.ownerProject ?? "<missing>"} dependency cites unknown evidence ${dependency.consumesEvidenceId}`);
    }
  }

  const missingEvidenceIds = new Set((candidate.missingEvidence ?? []).map((item) => item.id));
  for (const followUp of candidate.followUpIssues ?? []) {
    if (!followUp.id || !followUp.ownerProject || !followUp.missingEvidenceId || !followUp.allowedReason) {
      errors.push(`${followUp.id ?? "<missing>"} follow-up must name ownerProject, missingEvidenceId, and allowedReason`);
    }
    if (followUp.missingEvidenceId && !missingEvidenceIds.has(followUp.missingEvidenceId)) {
      errors.push(`${followUp.id ?? "<missing>"} follow-up is allowed only for missing evidence`);
    }
  }

  for (const claim of candidate.customerClaimPolicy?.unsupportedPublicClaims ?? []) {
    if (FORBIDDEN_PUBLIC_CLAIM_PATTERNS.some((pattern) => pattern.test(claim))) {
      errors.push(`unsupported public claim: ${claim}`);
    }
  }
  for (const scopeOut of candidate.customerClaimPolicy?.scopeOut ?? []) {
    if (/\bdraft\b.*\b(final|customer)\b.*\b(terms|DPA|privacy policy)\b/i.test(scopeOut)) {
      errors.push("final legal text is scope-out");
    }
    if (/\bapprove\b.*\bpaid GA\b/i.test(scopeOut)) {
      errors.push("paid GA approval is scope-out");
    }
  }

  const reflected = new Set(candidate.releaseCutlineReflection?.reflectedEvidenceIds ?? []);
  for (const dependency of candidate.crossProjectDependencies ?? []) {
    if (!reflected.has(dependency.consumesEvidenceId)) {
      errors.push(`${dependency.consumesEvidenceId} must be reflected in the release cutline`);
    }
  }
  if (!candidate.releaseCutlineReflection?.limitationsAreVisible) {
    errors.push("release-candidate legal/privacy limitations must be visible in the release cutline");
  }

  if (candidate.parentInitiativeSync?.launchRiskChanged && !candidate.parentInitiativeSync.statusUpdated) {
    errors.push("parent initiative status must be updated when launch risk changes");
  }

  return { ok: errors.length === 0, errors };
}

export function assertLegalPrivacyReleaseCandidateEvidence(
  record: JsonValue = legalPrivacyReleaseCandidateEvidence
): LegalPrivacyReleaseCandidateEvidence {
  const result = validateLegalPrivacyReleaseCandidateEvidence(record);

  if (!result.ok) {
    throw new Error(`legal/privacy release-candidate evidence invalid:\n${result.errors.join("\n")}`);
  }

  // SAFETY: `return record as LegalPrivacyReleaseCandidateEvidence;` is required at this I/O or test boundary.
  return record as LegalPrivacyReleaseCandidateEvidence;
}
