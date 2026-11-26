import { isJsonObject } from "./json.js";
export const REQUIRED_PRIVATE_BETA_SUPPORT_EVIDENCE_IDS = [
  "support-escalation-baseline",
  "support-workflow-intake",
  "support-sla-channel-language",
  "incident-communication-redaction",
  "security-escalation-route",
  "release-cutline-handoff"
];

export const launchSupportPrivateBetaEvidence = {
  schema: "hobo.v1.launch-support.private-beta-evidence/2026-06-30",
  issue: "HOBO-467",
  parentIssue: "HOBO-401",
  phase: "M2",
  milestoneGate: "M2 Private beta proof",
  decisionStatus: "private-beta-evidence-accepted",
  requiredEvidence: [
    {
      id: "support-escalation-baseline",
      ownerProject: "V1 Launch Support Desk & Escalation",
      evidenceSource: "docs/design/launch-support-escalation.md",
      proves: "SEV0-SEV3 severity, first responder, escalation owner, customer communication, and handoff rules are accepted for private beta.",
      status: "accepted"
    },
    {
      id: "support-workflow-intake",
      ownerProject: "V1 Launch Support Desk & Escalation",
      evidenceSource: "docs/design/support-workflow.md",
      proves: "Support intake, triage, redacted evidence, owner route, and customer-safe update states are accepted before support execution.",
      status: "accepted"
    },
    {
      id: "support-sla-channel-language",
      ownerProject: "V1 Launch Support Desk & Escalation",
      evidenceSource: "docs/design/support-sla-channels.md",
      proves: "Private beta support promises are separated from internal targets and GA contractual commitments.",
      status: "accepted"
    },
    {
      id: "incident-communication-redaction",
      ownerProject: "Incident Communications",
      evidenceSource: "docs/design/incident-communications.md",
      proves: "Customer-visible incident updates require source evidence, redaction approval, and no customer-private data.",
      status: "accepted"
    },
    {
      id: "security-escalation-route",
      ownerProject: "Security Verification",
      evidenceSource: "docs/design/security-verification.md",
      proves: "Security-sensitive support issues route to the launch-blocker process and do not become support-owned promises.",
      status: "accepted"
    },
    {
      id: "release-cutline-handoff",
      ownerProject: "V1 Release Program & Cutline",
      evidenceSource: "src/draft/technical-proofs/v1-cutline-contract",
      proves: "Support readiness gaps, limitations, and launch-risk changes feed the release cutline instead of bypassing it.",
      status: "accepted"
    }
  ],
  blockers: [
    {
      id: "no-public-sla-commitment",
      category: "launch-limitation",
      ownerProject: "V1 Launch Support Desk & Escalation",
      sourceEvidenceId: "support-sla-channel-language",
      disposition: "Private beta may publish customer-safe limitation language but must not publish contractual SLA guarantees.",
      launchRisk: "medium"
    },
    {
      id: "redaction-before-customer-update",
      category: "security-gate",
      ownerProject: "Incident Communications",
      sourceEvidenceId: "incident-communication-redaction",
      disposition: "Customer-facing updates remain blocked until redaction approval and source incident evidence are present.",
      launchRisk: "high"
    }
  ],
  acceptedRisks: [
    {
      id: "manual-private-beta-support",
      ownerRole: "support-lead",
      mitigation: "Use accepted support workflow and channel language with manual owner routing during private beta.",
      followUpOrLaunchNote: "Release notes must call out private beta support coverage and unsupported request classes.",
      revisitDate: "2026-08-15",
      evidenceId: "support-workflow-intake"
    },
    {
      id: "no-ga-response-commitment",
      ownerRole: "release-owner",
      mitigation: "Keep response language non-contractual until GA handoff evidence and business-owner signoff exist.",
      followUpOrLaunchNote: "GA support commitment remains a launch limitation until HOBO-481 evidence is accepted.",
      revisitDate: "2026-09-01",
      evidenceId: "support-sla-channel-language"
    }
  ],
  crossProjectDependencies: [
    {
      ownerProject: "V1 Release Program & Cutline",
      consumesEvidenceId: "release-cutline-handoff",
      cutlineImpact: "Private beta support gaps are recorded as blockers, accepted risks, or limitations before launch-risk status changes."
    },
    {
      ownerProject: "V1 Release Notes & Upgrade Guide",
      consumesEvidenceId: "support-sla-channel-language",
      cutlineImpact: "Release notes consume beta-only support language and must not promote GA response commitments."
    },
    {
      ownerProject: "Incident Communications",
      consumesEvidenceId: "incident-communication-redaction",
      cutlineImpact: "Customer-visible incident language depends on accepted redaction and evidence gates."
    },
    {
      ownerProject: "Security Verification",
      consumesEvidenceId: "security-escalation-route",
      cutlineImpact: "Security-sensitive support issues remain launch blockers until the security owner accepts or downgrades them."
    }
  ],
  missingEvidence: [
    {
      id: "release-candidate-support-drill",
      ownerProject: "V1 Launch Support Desk & Escalation",
      reason: "Private beta evidence does not prove release-candidate support drills, staffing, or customer update rehearsals.",
      launchDisposition: "follow-up"
    },
    {
      id: "ga-support-handoff",
      ownerProject: "V1 Launch Support Desk & Escalation",
      reason: "Private beta evidence does not prove GA support commitments, compatibility windows, or final handoff acceptance.",
      launchDisposition: "follow-up"
    }
  ],
  followUpIssues: [
    {
      id: "HOBO-474",
      ownerProject: "V1 Launch Support Desk & Escalation",
      missingEvidenceId: "release-candidate-support-drill",
      allowedReason: "Existing M3 release-candidate evidence issue owns support drill and release-candidate acceptance proof."
    },
    {
      id: "HOBO-481",
      ownerProject: "V1 Launch Support Desk & Escalation",
      missingEvidenceId: "ga-support-handoff",
      allowedReason: "Existing M4 GA handoff issue owns final support commitment and launch handoff evidence."
    }
  ],
  parentInitiativeSync: {
    initiative: "HoBo v1 Release Readiness",
    launchRiskChanged: true,
    statusUpdated: true,
    statusUpdateReason: "M2 private beta support evidence is accepted while release-candidate and GA support proof remain explicit follow-ups."
  },
  customerCommitments: {
    publicSlaPromised: false,
    businessOwnerSignoff: false,
    privateBetaOnly: true,
    customerVisibleLanguage: "Private beta support uses customer-safe limitation language and approved support channels; no contractual response guarantee is published."
  },
  scopeBoundary: {
    implementsSupportRuntime: false,
    implementsTicketQueue: false,
    publishesStatusPage: false,
    usesCustomerData: false,
    approvesCommercialTerms: false
  }
};

export function validateLaunchSupportPrivateBetaEvidence(record) {
  const errors = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["private beta support evidence record is required"] };
  }

  if (record.issue !== "HOBO-467") {
    errors.push("issue must be HOBO-467");
  }
  if (record.phase !== "M2") {
    errors.push("phase must be M2");
  }
  if (record.milestoneGate !== "M2 Private beta proof") {
    errors.push("milestone gate must be M2 Private beta proof");
  }

  const evidenceIds = new Set((record.requiredEvidence ?? []).map((item) => item.id));
  for (const evidenceId of REQUIRED_PRIVATE_BETA_SUPPORT_EVIDENCE_IDS) {
    if (!evidenceIds.has(evidenceId)) {
      errors.push(`missing required M2 private beta support evidence: ${evidenceId}`);
    }
  }
  for (const evidence of record.requiredEvidence ?? []) {
    if (!evidence.ownerProject || !evidence.evidenceSource || !evidence.proves) {
      errors.push(`${evidence.id ?? "<missing>"} must map evidence to ownerProject, evidenceSource, and proof statement`);
    }
    if (evidence.status !== "accepted") {
      errors.push(`${evidence.id ?? "<missing>"} must be accepted before the M2 private beta gate can pass`);
    }
  }

  if (!Array.isArray(record.blockers) || record.blockers.length === 0) {
    errors.push("blockers must be recorded, even when they are launch limitations");
  }
  for (const blocker of record.blockers ?? []) {
    if (!blocker.id || !blocker.category || !blocker.ownerProject || !blocker.sourceEvidenceId || !blocker.disposition) {
      errors.push(`${blocker.id ?? "<missing>"} blocker must name category, ownerProject, sourceEvidenceId, and disposition`);
    }
    if (blocker.sourceEvidenceId && !evidenceIds.has(blocker.sourceEvidenceId)) {
      errors.push(`${blocker.id ?? "<missing>"} blocker cites unknown evidence ${blocker.sourceEvidenceId}`);
    }
  }

  if (!Array.isArray(record.acceptedRisks) || record.acceptedRisks.length === 0) {
    errors.push("accepted risks must be recorded");
  }
  for (const risk of record.acceptedRisks ?? []) {
    if (!risk.id || !risk.ownerRole || !risk.mitigation || !risk.followUpOrLaunchNote || !risk.revisitDate) {
      errors.push(`${risk.id ?? "<missing>"} accepted risk must name ownerRole, mitigation, followUpOrLaunchNote, and revisitDate`);
    }
    if (risk.evidenceId && !evidenceIds.has(risk.evidenceId)) {
      errors.push(`${risk.id ?? "<missing>"} accepted risk cites unknown evidence ${risk.evidenceId}`);
    }
  }

  if (!Array.isArray(record.crossProjectDependencies) || record.crossProjectDependencies.length === 0) {
    errors.push("cross-project dependencies must be reflected in the release cutline");
  }
  for (const dependency of record.crossProjectDependencies ?? []) {
    if (!dependency.ownerProject || !dependency.consumesEvidenceId || !dependency.cutlineImpact) {
      errors.push(`${dependency.ownerProject ?? "<missing>"} dependency must name ownerProject, consumesEvidenceId, and cutlineImpact`);
    }
    if (dependency.consumesEvidenceId && !evidenceIds.has(dependency.consumesEvidenceId)) {
      errors.push(`${dependency.ownerProject ?? "<missing>"} dependency cites unknown evidence ${dependency.consumesEvidenceId}`);
    }
  }

  const missingEvidenceIds = new Set((record.missingEvidence ?? []).map((item) => item.id));
  for (const followUp of record.followUpIssues ?? []) {
    if (!followUp.id || !followUp.ownerProject || !followUp.missingEvidenceId || !followUp.allowedReason) {
      errors.push(`${followUp.id ?? "<missing>"} follow-up must name ownerProject, missingEvidenceId, and allowedReason`);
    }
    if (followUp.missingEvidenceId && !missingEvidenceIds.has(followUp.missingEvidenceId)) {
      errors.push(`${followUp.id ?? "<missing>"} follow-up is allowed only for missing evidence`);
    }
  }

  if (record.parentInitiativeSync?.launchRiskChanged && !record.parentInitiativeSync.statusUpdated) {
    errors.push("parent initiative status must be updated when launch risk changes");
  }

  if (record.customerCommitments?.publicSlaPromised && !record.customerCommitments?.businessOwnerSignoff) {
    errors.push("public SLA promises require GA evidence and business-owner signoff");
  }

  if (record.scopeBoundary?.implementsSupportRuntime) {
    errors.push("support runtime implementation is out of scope");
  }
  if (record.scopeBoundary?.implementsTicketQueue) {
    errors.push("support ticket queue implementation is out of scope");
  }
  if (record.scopeBoundary?.publishesStatusPage) {
    errors.push("status-page publication is out of scope");
  }
  if (record.scopeBoundary?.usesCustomerData) {
    errors.push("customer data access is out of scope");
  }
  if (record.scopeBoundary?.approvesCommercialTerms) {
    errors.push("commercial terms approval is out of scope");
  }

  return { ok: errors.length === 0, errors };
}

export function assertLaunchSupportPrivateBetaEvidence(record = launchSupportPrivateBetaEvidence) {
  const result = validateLaunchSupportPrivateBetaEvidence(record);

  if (!result.ok) {
    throw new Error(`launch support private beta evidence invalid:\n${result.errors.join("\n")}`);
  }

  return record;
}
