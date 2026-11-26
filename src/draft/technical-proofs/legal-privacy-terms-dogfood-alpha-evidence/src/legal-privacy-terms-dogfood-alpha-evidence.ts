export type EvidenceDomain =
  | "terms"
  | "privacy-notice"
  | "data-retention"
  | "telemetry"
  | "subprocessors-provider-claims"
  | "security-claims"
  | "support-obligations"
  | "customer-communications";

export type EvidenceStatus = "accepted" | "missing" | "blocked" | "risk-accepted";

// domain-view: parse-produced draft-proof record; its wire form is the DogfoodAlphaEvidenceItem proto message in data-models/.
export interface DogfoodAlphaEvidenceItem {
  domain: EvidenceDomain;
  status: EvidenceStatus;
  owningProject: string;
  requiredEvidence: string;
  source: string;
  releaseCutlineRef: string;
  followUpIssue?: string;
  acceptedRisk?: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchBlocker proto message in data-models/.
export interface LaunchBlocker {
  id: string;
  owner: string;
  status: "resolved" | "open";
  reason: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the AcceptedRisk proto message in data-models/.
export interface AcceptedRisk {
  id: string;
  owner: string;
  approver: string;
  rationale: string;
  expiresBefore: "private-beta" | "release-candidate" | "ga";
}

// domain-view: parse-produced draft-proof record; its wire form is the ParentInitiativeUpdate proto message in data-models/.
export interface ParentInitiativeUpdate {
  initiative: "HoBo v1 Release Readiness";
  riskChanged: boolean;
  status: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LegalPrivacyTermsDogfoodAlphaRecord proto message in data-models/.
export interface LegalPrivacyTermsDogfoodAlphaRecord {
  issue: "HOBO-457";
  phase: "M1 Dogfood/alpha proof";
  project: "V1 Legal, Privacy & Terms Readiness";
  scope: {
    excludesFinalLegalText: boolean;
    excludesPaidOrPublicLaunch: boolean;
  };
  milestoneEvidenceAccepted: boolean;
  evidence: DogfoodAlphaEvidenceItem[];
  blockers: LaunchBlocker[];
  acceptedRisks: AcceptedRisk[];
  crossProjectDependencies: string[];
  releaseCutline: {
    id: string;
    dependencies: string[];
  };
  parentInitiativeUpdate?: ParentInitiativeUpdate;
  finalLegalTextDrafted?: boolean;
  publicLaunchClaim?: string;
}

export interface LegalPrivacyTermsDogfoodAlphaGate {
  canCompleteMilestone: boolean;
  blockers: string[];
  missingEvidence: EvidenceDomain[];
  invalidFollowUps: EvidenceDomain[];
  unreflectedDependencies: string[];
}

const requiredEvidenceDomains: EvidenceDomain[] = [
  "terms",
  "privacy-notice",
  "data-retention",
  "telemetry",
  "subprocessors-provider-claims",
  "security-claims",
  "support-obligations",
  "customer-communications",
];

const dependencies = [
  "V1 Release Program & Cutline",
  "Tenant Data Lifecycle",
  "Customer Assurance Evidence Packet",
  "Security Verification",
  "Support & Debug Tools",
  "V1 Launch Site, Messaging & Demo Assets",
];

const acceptedEvidence: DogfoodAlphaEvidenceItem[] = [
  {
    domain: "terms",
    status: "accepted",
    owningProject: "V1 Legal, Privacy & Terms Readiness",
    requiredEvidence: "Dogfood/alpha terms approval path and owner routing are recorded.",
    source: "legal-owner-review",
    releaseCutlineRef: "cutline.legal.terms",
  },
  {
    domain: "privacy-notice",
    status: "accepted",
    owningProject: "V1 Legal, Privacy & Terms Readiness",
    requiredEvidence: "Dogfood/alpha privacy notice review maps telemetry, retention, support access, and subprocessors.",
    source: "privacy-owner-review",
    releaseCutlineRef: "cutline.legal.privacy",
  },
  {
    domain: "data-retention",
    status: "accepted",
    owningProject: "Tenant Data Lifecycle",
    requiredEvidence: "Retention classes and deletion/export expectations are linked before dogfood data enters alpha.",
    source: "tenant-data-lifecycle-evidence",
    releaseCutlineRef: "cutline.governance.retention",
  },
  {
    domain: "telemetry",
    status: "accepted",
    owningProject: "Workspace & Onboarding UX",
    requiredEvidence: "Telemetry purpose, PII exclusion, support/debug use, and opt-out handling are recorded.",
    source: "workspace-activation-telemetry-contract",
    releaseCutlineRef: "cutline.telemetry.activation",
  },
  {
    domain: "subprocessors-provider-claims",
    status: "accepted",
    owningProject: "Customer Assurance Evidence Packet",
    requiredEvidence: "Provider and subprocessor claims distinguish required, optional, mocked, and unsupported services.",
    source: "customer-assurance-evidence-packet",
    releaseCutlineRef: "cutline.vendor.subprocessors",
  },
  {
    domain: "security-claims",
    status: "accepted",
    owningProject: "Security Verification",
    requiredEvidence: "Dogfood/alpha security claims are evidence-backed or downgraded before public copy.",
    source: "security-verification-claim-register",
    releaseCutlineRef: "cutline.security.claims",
  },
  {
    domain: "support-obligations",
    status: "accepted",
    owningProject: "Support & Debug Tools",
    requiredEvidence: "Support intake, escalation, evidence requirements, and known limitations are linked.",
    source: "support-workflow-and-escalation-evidence",
    releaseCutlineRef: "cutline.support.obligations",
  },
  {
    domain: "customer-communications",
    status: "accepted",
    owningProject: "V1 Launch Site, Messaging & Demo Assets",
    requiredEvidence: "Dogfood/alpha communications align with evidence, known limitations, and release notes.",
    source: "launch-messaging-claim-register",
    releaseCutlineRef: "cutline.launch.messages",
  },
];

export function buildLegalPrivacyTermsDogfoodAlphaRecord(
  overrides: Partial<LegalPrivacyTermsDogfoodAlphaRecord> = {},
): LegalPrivacyTermsDogfoodAlphaRecord {
  return {
    issue: "HOBO-457",
    phase: "M1 Dogfood/alpha proof",
    project: "V1 Legal, Privacy & Terms Readiness",
    scope: {
      excludesFinalLegalText: true,
      excludesPaidOrPublicLaunch: true,
    },
    milestoneEvidenceAccepted: true,
    evidence: acceptedEvidence,
    blockers: [],
    acceptedRisks: [],
    crossProjectDependencies: dependencies,
    releaseCutline: {
      id: "release-cutline.v1.dogfood-alpha.legal-privacy-terms",
      dependencies,
    },
    parentInitiativeUpdate: {
      initiative: "HoBo v1 Release Readiness",
      riskChanged: false,
      status: "dogfood-alpha-legal-ready",
    },
    ...overrides,
  };
}

export function validateLegalPrivacyTermsDogfoodAlphaRecord(
  record: LegalPrivacyTermsDogfoodAlphaRecord,
): LegalPrivacyTermsDogfoodAlphaRecord {
  if (record.finalLegalTextDrafted) {
    throw new Error("scope.final_legal_text");
  }
  if (record.publicLaunchClaim) {
    throw new Error("scope.unsupported_public_launch_claim");
  }
  if (!record.scope.excludesFinalLegalText || !record.scope.excludesPaidOrPublicLaunch) {
    throw new Error("scope.boundary_missing");
  }

  const seenDomains = new Set<EvidenceDomain>();
  for (const item of record.evidence) {
    if (seenDomains.has(item.domain)) {
      throw new Error(`evidence.${item.domain}.duplicate`);
    }
    seenDomains.add(item.domain);

    if (!item.owningProject || !item.requiredEvidence || !item.source || !item.releaseCutlineRef) {
      throw new Error(`evidence.${item.domain}.incomplete`);
    }
    if ((item.status === "missing" || item.status === "blocked") && !item.followUpIssue) {
      throw new Error(`evidence.${item.domain}.missing_follow_up`);
    }
    if ((item.status === "accepted" || item.status === "risk-accepted") && item.followUpIssue) {
      throw new Error(`evidence.${item.domain}.unexpected_follow_up`);
    }
    if (item.status === "risk-accepted" && !item.acceptedRisk) {
      throw new Error(`evidence.${item.domain}.missing_risk_acceptance`);
    }
  }

  for (const domain of requiredEvidenceDomains) {
    if (!seenDomains.has(domain)) {
      throw new Error(`evidence.${domain}.missing`);
    }
  }

  for (const dependency of record.crossProjectDependencies) {
    if (!record.releaseCutline.dependencies.includes(dependency)) {
      throw new Error(`release_cutline.missing_dependency.${dependency}`);
    }
  }

  if (
    record.parentInitiativeUpdate?.riskChanged === true &&
    record.parentInitiativeUpdate.status.length === 0
  ) {
    throw new Error("parent_initiative.missing_status_update");
  }

  return record;
}

export function evaluateLegalPrivacyTermsDogfoodAlphaGate(
  record: LegalPrivacyTermsDogfoodAlphaRecord,
): LegalPrivacyTermsDogfoodAlphaGate {
  const validated = validateLegalPrivacyTermsDogfoodAlphaRecord(record);
  const blockers = validated.blockers
    .filter((blocker) => blocker.status === "open")
    .map((blocker) => blocker.id);
  const missingEvidence = validated.evidence
    .filter((item) => item.status === "missing" || item.status === "blocked")
    .map((item) => item.domain);
  const invalidFollowUps = validated.evidence
    .filter((item) => (item.status === "accepted" || item.status === "risk-accepted") && item.followUpIssue)
    .map((item) => item.domain);
  const unreflectedDependencies = validated.crossProjectDependencies.filter(
    (dependency) => !validated.releaseCutline.dependencies.includes(dependency),
  );

  return {
    blockers,
    missingEvidence,
    invalidFollowUps,
    unreflectedDependencies,
    canCompleteMilestone:
      validated.milestoneEvidenceAccepted &&
      blockers.length === 0 &&
      missingEvidence.length === 0 &&
      invalidFollowUps.length === 0 &&
      unreflectedDependencies.length === 0,
  };
}
