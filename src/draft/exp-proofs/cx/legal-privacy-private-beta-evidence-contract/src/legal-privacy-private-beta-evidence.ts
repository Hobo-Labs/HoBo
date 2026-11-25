import { isJsonObject, type JsonValue } from "./json.js";
export const REQUIRED_PRIVATE_BETA_EVIDENCE_IDS = [
  "m0-checklist-baseline",
  "privacy-notice-beta-review",
  "terms-beta-limitation",
  "subprocessor-provider-beta-register",
  "data-retention-telemetry-boundary",
  "customer-assurance-support-handoff",
  "legal-risk-register"
] as const;

type RequiredEvidenceId = (typeof REQUIRED_PRIVATE_BETA_EVIDENCE_IDS)[number];
type EvidenceStatus = "accepted" | "pending" | "missing";
type Phase = "M1" | "M2" | "M3" | "M4";

type RequiredEvidence = {
  id: RequiredEvidenceId;
  ownerProject: string;
  evidenceSource: string;
  proves: string;
  status: EvidenceStatus;
};

type Blocker = {
  id: string;
  category: "beta-limitation" | "release-candidate-blocker" | "ga-blocker";
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

// domain-view: parse-produced draft-proof record; its wire form is the LegalPrivacyPrivateBetaEvidence proto message in data-models/.
type LegalPrivacyPrivateBetaEvidence = {
  schema: string;
  issue: "HOBO-464";
  parentIssue: "HOBO-405";
  project: "V1 Legal, Privacy & Terms Readiness";
  phase: Phase;
  milestoneGate: "M2 Private beta proof";
  decisionStatus: string;
  requiredEvidence: RequiredEvidence[];
  blockers: Blocker[];
  acceptedRisks: AcceptedRisk[];
  crossProjectDependencies: CrossProjectDependency[];
  missingEvidence: MissingEvidence[];
  followUpIssues: FollowUpIssue[];
  customerClaimPolicy: {
    betaAllowedClaims: string[];
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
  /\bSOC2 certified\b/i,
  /\bGDPR compliant\b/i,
  /\bHIPAA compliant\b/i,
  /\bproduction legal approval\b/i,
  /\bfinal terms approved\b/i,
  /\ball regions\b/i
];

export const legalPrivacyPrivateBetaEvidence: LegalPrivacyPrivateBetaEvidence = {
  schema: "hobo.v1.legal-privacy.private-beta-evidence/2026-06-30",
  issue: "HOBO-464",
  parentIssue: "HOBO-405",
  project: "V1 Legal, Privacy & Terms Readiness",
  phase: "M2",
  milestoneGate: "M2 Private beta proof",
  decisionStatus: "private-beta-evidence-accepted-with-public-launch-limitations",
  requiredEvidence: [
    {
      id: "m0-checklist-baseline",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      evidenceSource: "src/draft/exp-proofs/cx/legal-privacy-terms-readiness-contract",
      proves: "The accepted M0 checklist still anchors terms, privacy, data, telemetry, subprocessors, security claims, support, and communications.",
      status: "accepted"
    },
    {
      id: "privacy-notice-beta-review",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      evidenceSource: "docs/design/legal-privacy-terms-readiness.md#m2-private-beta-evidence-gate",
      proves: "Private beta can proceed only with reviewed privacy-notice limitations, telemetry purpose, retention posture, and customer messaging.",
      status: "accepted"
    },
    {
      id: "terms-beta-limitation",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      evidenceSource: "docs/design/legal-privacy-terms-readiness.md#m2-private-beta-evidence-gate",
      proves: "Private beta terms remain limited beta language and do not assert public launch or paid GA legal approval.",
      status: "accepted"
    },
    {
      id: "subprocessor-provider-beta-register",
      ownerProject: "Customer Assurance Evidence Packet",
      evidenceSource: "docs/design/customer-assurance-evidence-packet.md",
      proves: "Subprocessor and provider statements distinguish beta-required, optional, mocked, unsupported, and still-unconfirmed services.",
      status: "accepted"
    },
    {
      id: "data-retention-telemetry-boundary",
      ownerProject: "Compliance Evidence Pack",
      evidenceSource: "docs/design/tenant-data-lifecycle.md",
      proves: "Private beta data classes, retention posture, telemetry purpose, deletion/export limitations, and residency sensitivity are visible before pilot use.",
      status: "accepted"
    },
    {
      id: "customer-assurance-support-handoff",
      ownerProject: "V1 Launch Support Desk & Escalation",
      evidenceSource: "docs/design/support-sla-channels.md",
      proves: "Support and customer assurance questions route to named owners with customer-safe evidence and no unsupported SLA or compliance promise.",
      status: "accepted"
    },
    {
      id: "legal-risk-register",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "docs/design/go-no-go-decision-record.md",
      proves: "Legal/privacy risks, launch blockers, accepted beta limitations, mitigations, and revisit dates are recorded before beta signoff.",
      status: "accepted"
    }
  ],
  blockers: [
    {
      id: "public-paid-legal-approval",
      category: "ga-blocker",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      sourceEvidenceId: "terms-beta-limitation",
      disposition: "Private beta may proceed with limited legal language; public paid launch remains blocked until final terms and privacy notice are approved.",
      launchRisk: "high"
    },
    {
      id: "enterprise-assurance-subprocessor-finalization",
      category: "release-candidate-blocker",
      ownerProject: "Customer Assurance Evidence Packet",
      sourceEvidenceId: "subprocessor-provider-beta-register",
      disposition: "Enterprise pilot commitments require a confirmed subprocessor/provider list and customer assurance packet before expansion.",
      launchRisk: "medium"
    },
    {
      id: "public-security-privacy-claim-evidence",
      category: "beta-limitation",
      ownerProject: "Security Verification",
      sourceEvidenceId: "legal-risk-register",
      disposition: "Private beta claims must name limitations and cannot promote public security, privacy, or compliance statements without evidence review.",
      launchRisk: "medium"
    }
  ],
  acceptedRisks: [
    {
      id: "private-beta-limited-terms",
      ownerRole: "legal-owner",
      mitigation: "Use private-beta-only terms posture and route public or paid launch language to final legal review.",
      followUpOrLaunchNote: "Release notes and customer communications must call this a beta limitation.",
      revisitDate: "2026-07-31",
      evidenceId: "terms-beta-limitation"
    },
    {
      id: "beta-subprocessor-register-incomplete",
      ownerRole: "vendor-owner",
      mitigation: "Allow only pilots whose required providers and processors are covered by the beta register.",
      followUpOrLaunchNote: "Enterprise assurance packet remains release-candidate follow-up evidence.",
      revisitDate: "2026-07-31",
      evidenceId: "subprocessor-provider-beta-register"
    }
  ],
  crossProjectDependencies: [
    {
      ownerProject: "V1 Release Program & Cutline",
      consumesEvidenceId: "legal-risk-register",
      cutlineImpact: "The cutline carries private-beta limitations, blockers, and accepted legal/privacy risks as visible launch evidence."
    },
    {
      ownerProject: "V1 Release Notes & Upgrade Guide",
      consumesEvidenceId: "terms-beta-limitation",
      cutlineImpact: "Release notes can state private-beta legal/privacy limitations without promoting final legal terms."
    },
    {
      ownerProject: "Customer Assurance Evidence Packet",
      consumesEvidenceId: "subprocessor-provider-beta-register",
      cutlineImpact: "Customer assurance can answer beta processor/provider questions only from accepted evidence."
    },
    {
      ownerProject: "Compliance Evidence Pack",
      consumesEvidenceId: "data-retention-telemetry-boundary",
      cutlineImpact: "Data lifecycle and telemetry boundaries decide which beta workflows can handle customer data."
    },
    {
      ownerProject: "V1 Launch Support Desk & Escalation",
      consumesEvidenceId: "customer-assurance-support-handoff",
      cutlineImpact: "Support routes legal/privacy and assurance questions without inventing unowned commitments."
    },
    {
      ownerProject: "Security Verification",
      consumesEvidenceId: "legal-risk-register",
      cutlineImpact: "Public security/privacy claims stay blocked until evidence-backed verification is accepted."
    }
  ],
  missingEvidence: [
    {
      id: "release-candidate-legal-approval",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      reason: "M2 private beta evidence does not prove release-candidate or public launch legal readiness.",
      launchDisposition: "follow-up"
    },
    {
      id: "ga-public-legal-privacy-signoff",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      reason: "Private beta limitations cannot substitute for final public/paid GA terms, privacy notice, DPA, or regional notices.",
      launchDisposition: "follow-up"
    }
  ],
  followUpIssues: [
    {
      id: "HOBO-471",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      missingEvidenceId: "release-candidate-legal-approval",
      allowedReason: "Existing M3 release-candidate evidence issue owns legal/privacy release-candidate signoff gaps."
    },
    {
      id: "HOBO-478",
      ownerProject: "V1 Legal, Privacy & Terms Readiness",
      missingEvidenceId: "ga-public-legal-privacy-signoff",
      allowedReason: "Existing M4 GA handoff issue owns public/paid launch legal/privacy signoff gaps."
    }
  ],
  customerClaimPolicy: {
    betaAllowedClaims: [
      "Private beta legal/privacy posture is evidence-tracked with explicit launch limitations.",
      "Beta telemetry, retention, and support routing are limited to accepted owner-reviewed boundaries.",
      "Unsupported security, privacy, compliance, provider, and paid-launch claims remain blocked."
    ],
    unsupportedPublicClaims: [],
    scopeOut: [
      "final customer terms drafting",
      "final privacy policy or DPA approval",
      "legal workflow implementation",
      "billing or paid launch enablement",
      "public compliance certification claims",
      "support desk product implementation"
    ]
  },
  releaseCutlineReflection: {
    cutlineProject: "V1 Release Program & Cutline",
    reflectedEvidenceIds: [
      "privacy-notice-beta-review",
      "terms-beta-limitation",
      "subprocessor-provider-beta-register",
      "data-retention-telemetry-boundary",
      "customer-assurance-support-handoff",
      "legal-risk-register"
    ],
    limitationsAreVisible: true
  },
  parentInitiativeSync: {
    initiative: "HoBo v1 Release Readiness",
    launchRiskChanged: true,
    statusUpdated: true,
    statusUpdateReason:
      "M2 private beta legal/privacy evidence is accepted, while release-candidate and GA public launch legal signoffs remain explicit blockers."
  }
};

export function validateLegalPrivacyPrivateBetaEvidence(record: JsonValue): ValidationResult {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["legal/privacy private beta evidence record is required"] };
  }

  // SAFETY: `const candidate = record as Partial<LegalPrivacyPrivateBetaEvidence>;` is required at this I/O or test boundary.
  const candidate = record as Partial<LegalPrivacyPrivateBetaEvidence>;

  if (candidate.issue !== "HOBO-464") {
    errors.push("issue must be HOBO-464");
  }
  if (candidate.parentIssue !== "HOBO-405") {
    errors.push("parent issue must be HOBO-405");
  }
  if (candidate.phase !== "M2") {
    errors.push("phase must be M2");
  }
  if (candidate.milestoneGate !== "M2 Private beta proof") {
    errors.push("milestone gate must be M2 Private beta proof");
  }

  const evidenceIds = new Set((candidate.requiredEvidence ?? []).map((item) => item.id));
  for (const evidenceId of REQUIRED_PRIVATE_BETA_EVIDENCE_IDS) {
    if (!evidenceIds.has(evidenceId)) {
      errors.push(`missing required M2 evidence: ${evidenceId}`);
    }
  }

  for (const evidence of candidate.requiredEvidence ?? []) {
    if (!evidence.ownerProject || !evidence.evidenceSource || !evidence.proves) {
      errors.push(`${evidence.id ?? "<missing>"} must map to ownerProject, evidenceSource, and proof statement`);
    }
    if (evidence.status !== "accepted") {
      errors.push(`${evidence.id ?? "<missing>"} must be accepted before the M2 private beta gate can pass`);
    }
  }

  for (const blocker of candidate.blockers ?? []) {
    if (!blocker.id || !blocker.category || !blocker.ownerProject || !blocker.sourceEvidenceId || !blocker.disposition) {
      errors.push(`${blocker.id ?? "<missing>"} blocker must name category, ownerProject, sourceEvidenceId, and disposition`);
    }
    if (blocker.sourceEvidenceId && !evidenceIds.has(blocker.sourceEvidenceId)) {
      errors.push(`${blocker.id ?? "<missing>"} blocker cites unknown evidence ${blocker.sourceEvidenceId}`);
    }
  }
  if (!candidate.blockers?.length) {
    errors.push("blockers must be recorded");
  }

  for (const risk of candidate.acceptedRisks ?? []) {
    if (!risk.id || !risk.ownerRole || !risk.mitigation || !risk.followUpOrLaunchNote || !risk.revisitDate) {
      errors.push(`${risk.id ?? "<missing>"} accepted risk must name ownerRole, mitigation, followUpOrLaunchNote, and revisitDate`);
    }
    if (risk.evidenceId && !evidenceIds.has(risk.evidenceId)) {
      errors.push(`${risk.id ?? "<missing>"} accepted risk cites unknown evidence ${risk.evidenceId}`);
    }
  }
  if (!candidate.acceptedRisks?.length) {
    errors.push("accepted risks must be recorded");
  }

  for (const dependency of candidate.crossProjectDependencies ?? []) {
    if (!dependency.ownerProject || !dependency.consumesEvidenceId || !dependency.cutlineImpact) {
      errors.push(`${dependency.ownerProject ?? "<missing>"} dependency must name ownerProject, consumesEvidenceId, and cutlineImpact`);
    }
    if (dependency.consumesEvidenceId && !evidenceIds.has(dependency.consumesEvidenceId)) {
      errors.push(`${dependency.ownerProject ?? "<missing>"} dependency cites unknown evidence ${dependency.consumesEvidenceId}`);
    }
  }
  if (!candidate.crossProjectDependencies?.length) {
    errors.push("cross-project dependencies must be reflected in the release cutline");
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

  const reflected = new Set(candidate.releaseCutlineReflection?.reflectedEvidenceIds ?? []);
  for (const dependency of candidate.crossProjectDependencies ?? []) {
    if (!reflected.has(dependency.consumesEvidenceId)) {
      errors.push(`${dependency.consumesEvidenceId} must be reflected in the release cutline`);
    }
  }
  if (!candidate.releaseCutlineReflection?.limitationsAreVisible) {
    errors.push("private beta limitations must be visible in the release cutline");
  }

  if (candidate.parentInitiativeSync?.launchRiskChanged && !candidate.parentInitiativeSync.statusUpdated) {
    errors.push("parent initiative status must be updated when launch risk changes");
  }

  return { ok: errors.length === 0, errors };
}

export function assertLegalPrivacyPrivateBetaEvidence(
  record: JsonValue = legalPrivacyPrivateBetaEvidence
): LegalPrivacyPrivateBetaEvidence {
  const result = validateLegalPrivacyPrivateBetaEvidence(record);

  if (!result.ok) {
    throw new Error(`legal/privacy private beta evidence invalid:\n${result.errors.join("\n")}`);
  }

  // SAFETY: `return record as LegalPrivacyPrivateBetaEvidence;` is required at this I/O or test boundary.
  return record as LegalPrivacyPrivateBetaEvidence;
}
