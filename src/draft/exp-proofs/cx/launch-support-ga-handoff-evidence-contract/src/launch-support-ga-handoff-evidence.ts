import { isJsonObject, type JsonValue } from "./json.js";
export type EvidenceStatus = "accepted" | "accepted-risk" | "missing";
export type ProofMode = "design-record" | "issue-state" | "manual-review" | "release-cutline" | "support-handoff";
export type BlockerState = "cleared" | "accepted-risk";
export type LaunchRiskEffect = "unchanged" | "reduced";
export type ReadinessDomain =
  | "support"
  | "operations-readiness"
  | "incident-communications"
  | "security"
  | "release-cutline";

export const launchSupportGaHandoffEvidenceSchema = "hobo.launch-support-ga-handoff-evidence/2026-06-30";

const parsedLaunchSupportGaHandoffEvidence = Symbol("parsedLaunchSupportGaHandoffEvidence");

export type ParsedLaunchSupportGaHandoffEvidenceRecord = LaunchSupportGaHandoffEvidenceRecord & {
  readonly [parsedLaunchSupportGaHandoffEvidence]: true;
};

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSupportGaEvidenceItem proto message in data-models/.
export interface LaunchSupportGaEvidenceItem {
  id: string;
  ownerProject: string;
  source: string;
  proofMode: ProofMode;
  status: EvidenceStatus;
  acceptanceBullet: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSupportGaBlocker proto message in data-models/.
export interface LaunchSupportGaBlocker {
  id: string;
  ownerProject: string;
  state: BlockerState;
  sourceEvidenceId: string;
  disposition: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSupportGaAcceptedRisk proto message in data-models/.
export interface LaunchSupportGaAcceptedRisk {
  id: string;
  ownerProject: string;
  mitigation: string;
  launchRiskEffect: LaunchRiskEffect;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSupportGaReleaseCutlineDependency proto message in data-models/.
export interface LaunchSupportGaReleaseCutlineDependency {
  id: string;
  ownerProject: string;
  readinessDomain: ReadinessDomain;
  cutlineCategory: `v1-blocker.${string}`;
  source: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSupportGaMissingEvidence proto message in data-models/.
export interface LaunchSupportGaMissingEvidence {
  id: string;
  ownerProject: string;
  reason: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSupportGaFollowUp proto message in data-models/.
export interface LaunchSupportGaFollowUp {
  id: string;
  evidenceId: string;
  ownerProject: string;
  reason: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSupportGaInitiativeStatusGate proto message in data-models/.
export interface LaunchSupportGaInitiativeStatusGate {
  parentInitiative: "HoBo v1 Release Readiness";
  launchRiskChange: LaunchRiskEffect;
  statusUpdateRequired: boolean;
  updateSource: string;
  statusUpdateUrl: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSupportGaPublicClaimGuard proto message in data-models/.
export interface LaunchSupportGaPublicClaimGuard {
  id: string;
  claim: string;
  evidenceId: string;
  disposition: "hold" | "draft" | "publish";
}

// domain-view: parse-produced draft-proof record; its wire form is the LaunchSupportGaHandoffEvidenceRecord proto message in data-models/.
export interface LaunchSupportGaHandoffEvidenceRecord {
  schema: string;
  issue: "HOBO-481";
  project: "V1 Launch Support Desk & Escalation";
  phase: "M4";
  milestone: "M4 GA handoff";
  evidence: LaunchSupportGaEvidenceItem[];
  blockers: LaunchSupportGaBlocker[];
  acceptedRisks: LaunchSupportGaAcceptedRisk[];
  releaseCutlineDependencies: LaunchSupportGaReleaseCutlineDependency[];
  missingEvidence: LaunchSupportGaMissingEvidence[];
  followUps: LaunchSupportGaFollowUp[];
  initiativeStatus: LaunchSupportGaInitiativeStatusGate;
  scopeOut: string[];
  publicClaimGuards: LaunchSupportGaPublicClaimGuard[];
}

export const launchSupportGaHandoffEvidence: LaunchSupportGaHandoffEvidenceRecord = {
  schema: launchSupportGaHandoffEvidenceSchema,
  issue: "HOBO-481",
  project: "V1 Launch Support Desk & Escalation",
  phase: "M4",
  milestone: "M4 GA handoff",
  evidence: [
    {
      id: "m0-launch-support-escalation-baseline",
      ownerProject: "V1 Launch Support Desk & Escalation",
      source: "docs/design/launch-support-escalation.md#m0-acceptance-record",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
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
      source: "HOBO-474 / src/draft/launch-support-release-candidate-evidence-contract",
      proofMode: "issue-state",
      status: "accepted",
      acceptanceBullet: "Blockers and accepted risks are recorded.",
    },
    {
      id: "ga-support-owner-signoff",
      ownerProject: "V1 Launch Support Desk & Escalation",
      source: "HOBO-481",
      proofMode: "support-handoff",
      status: "accepted",
      acceptanceBullet: "Blockers and accepted risks are recorded.",
    },
    {
      id: "ga-support-sla-channel-boundary",
      ownerProject: "Support SLA Channels",
      source: "docs/design/support-sla-channels.md",
      proofMode: "design-record",
      status: "accepted-risk",
      acceptanceBullet: "Blockers and accepted risks are recorded.",
    },
    {
      id: "incident-communication-redaction-handoff",
      ownerProject: "Public Status Page & Incident Communication",
      source: "docs/design/public-status-page-incident-communication.md",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "security-sensitive-support-data-route",
      ownerProject: "Security Verification",
      source: "docs/design/security-verification.md",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "release-cutline-ga-support-signoff",
      ownerProject: "V1 Release Program & Cutline",
      source: "docs/design/go-no-go-decision-record.md",
      proofMode: "release-cutline",
      status: "accepted",
      acceptanceBullet: "The parent HoBo v1 Release Readiness initiative status is updated if this gate changes launch risk.",
    },
  ],
  blockers: [
    {
      id: "m3-ga-support-handoff-gap",
      ownerProject: "V1 Launch Support Desk & Escalation",
      state: "cleared",
      sourceEvidenceId: "ga-support-owner-signoff",
      disposition: "HOBO-481 clears the HOBO-474 missing GA support handoff by recording owner, evidence, and cutline sync.",
    },
    {
      id: "contractual-ga-support-sla-language",
      ownerProject: "Support SLA Channels",
      state: "accepted-risk",
      sourceEvidenceId: "ga-support-sla-channel-boundary",
      disposition: "GA handoff can cite support readiness, but contractual support SLAs require separate business-owner evidence before publication.",
    },
  ],
  acceptedRisks: [
    {
      id: "manual-ga-support-owner-signoff",
      ownerProject: "V1 Launch Support Desk & Escalation",
      mitigation: "Keep GA support handoff evidence owner-mapped and source-backed without creating live ticket automation in this proof.",
      launchRiskEffect: "reduced",
    },
    {
      id: "customer-data-access-remains-guarded",
      ownerProject: "Security Verification",
      mitigation: "Route support questions needing customer data through redaction and security approval instead of granting support direct access.",
      launchRiskEffect: "unchanged",
    },
    {
      id: "public-status-page-publication-remains-separate",
      ownerProject: "Public Status Page & Incident Communication",
      mitigation: "Use incident communication records and redaction gates as handoff evidence; leave publication workflow to the status-page owner.",
      launchRiskEffect: "unchanged",
    },
  ],
  releaseCutlineDependencies: [
    {
      id: "ga-support-handoff",
      ownerProject: "V1 Launch Support Desk & Escalation",
      readinessDomain: "support",
      cutlineCategory: "v1-blocker.support",
      source: "docs/design/launch-support-escalation.md#m4-ga-handoff-evidence",
    },
    {
      id: "incident-command-and-runbook-route",
      ownerProject: "Operators/SRE",
      readinessDomain: "operations-readiness",
      cutlineCategory: "v1-blocker.operations-readiness",
      source: "docs/design/operators-sre.md#plan-40",
    },
    {
      id: "customer-update-redaction-route",
      ownerProject: "Public Status Page & Incident Communication",
      readinessDomain: "incident-communications",
      cutlineCategory: "v1-blocker.incident-communications",
      source: "docs/design/public-status-page-incident-communication.md",
    },
    {
      id: "support-data-access-review",
      ownerProject: "Security Verification",
      readinessDomain: "security",
      cutlineCategory: "v1-blocker.security",
      source: "docs/design/security-verification.md",
    },
    {
      id: "release-owner-ga-support-signoff",
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
      "HOBO-481 records GA launch support handoff evidence, clears the HOBO-474 GA support gap, and preserves support tooling/SLA/customer-data scope boundaries.",
    statusUpdateUrl:
      "https://linear.app/quickdeploy-ai/initiative/hobo-v1-release-readiness-ee7ae99011b6/activity#initiative-update-bb231636",
  },
  scopeOut: [
    "No support runtime, helpdesk software, ticket queue automation, on-call scheduler, status-page publisher, or live customer-data access is implemented.",
    "No contractual GA support SLA, paid support tier, response-time guarantee, commercial support term, or business-owner support policy is approved.",
    "No customer-data debugging, support impersonation, provider credential access, or tenant data browsing is granted to support from this proof.",
  ],
  publicClaimGuards: [],
};

export function validateLaunchSupportGaHandoffEvidence(record: JsonValue) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["launch support GA handoff evidence record is required"] };
  }

  // SAFETY: `const value = record as Partial<LaunchSupportGaHandoffEvidenceRecord>;` is required at this I/O or test boundary.
  const value = record as Partial<LaunchSupportGaHandoffEvidenceRecord>;
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

  if (value.issue !== "HOBO-481") errors.push("issue must be HOBO-481");
  if (value.schema !== launchSupportGaHandoffEvidenceSchema) {
    errors.push(`schema must be ${launchSupportGaHandoffEvidenceSchema}`);
  }
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
  if (evidence.length < 8) errors.push("M4 support evidence must contain at least eight owner-mapped entries");

  for (const item of evidence) {
    if (!item.id || !item.ownerProject || !item.source || !item.acceptanceBullet) {
      errors.push(`${item.id ?? "<missing>"} evidence requires id, ownerProject, source, and acceptanceBullet`);
    }
  }

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));

  if (blockers.length < 2) {
    errors.push("blockers must record at least two GA support entries");
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
    errors.push("accepted risks must record at least two GA support entries");
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
    if (statusRequiresUpdate && !value.initiativeStatus.statusUpdateUrl) {
      errors.push("initiative status update evidence URL is required");
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
  for (const guard of publicClaimGuards) {
    if (!guard.id || !guard.claim || !guard.evidenceId || !guard.disposition) {
      errors.push(`${guard.id ?? "<missing>"} public claim guard requires id, claim, evidenceId, and disposition`);
      continue;
    }
    if (
      guard.disposition === "publish" &&
      /\b(24x7 contractual|contractual GA support|unlimited customer-data|customer-data troubleshooting|response-time guarantee|paid support tier)\b/i.test(
        guard.claim,
      )
    ) {
      errors.push(`${guard.id}: unsupported public support claim`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function parseLaunchSupportGaHandoffEvidence(record: JsonValue): ParsedLaunchSupportGaHandoffEvidenceRecord {
  const result = validateLaunchSupportGaHandoffEvidence(record);

  if (!result.ok) {
    throw new Error(`launch support GA handoff evidence invalid:\n${result.errors.join("\n")}`);
  }

  // SAFETY: `const parsed = structuredClone(record as LaunchSupportGaHandoffEvidenceRecord) a` is required at this I/O or test boundary.
  const parsed = structuredClone(record as LaunchSupportGaHandoffEvidenceRecord) as ParsedLaunchSupportGaHandoffEvidenceRecord;
  Object.defineProperty(parsed, parsedLaunchSupportGaHandoffEvidence, {
    enumerable: false,
    value: true,
  });

  return Object.freeze(parsed);
}

export function isParsedLaunchSupportGaHandoffEvidence(
  record: JsonValue,
): record is ParsedLaunchSupportGaHandoffEvidenceRecord {
  return Boolean(
    record &&
      isJsonObject(record) &&
      // SAFETY: `(record as Partial<ParsedLaunchSupportGaHandoffEvidenceRecord>)[parsedLaunchSupp` is required at this I/O or test boundary.
      (record as Partial<ParsedLaunchSupportGaHandoffEvidenceRecord>)[parsedLaunchSupportGaHandoffEvidence],
  );
}

export function assertLaunchSupportGaHandoffEvidence(record = launchSupportGaHandoffEvidence) {
  return parseLaunchSupportGaHandoffEvidence(record);
}
