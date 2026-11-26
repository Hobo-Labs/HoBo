const REQUIRED_EVIDENCE_IDS = [
  "operational-owner-checklist",
  "dogfood-yard-readiness-link",
  "compatibility-versioning-window",
  "rollback-restore-limits",
  "release-notes-support-entry",
] as const;

const REQUIRED_COMPATIBILITY_WINDOWS = [
  "receipt-schema-v1",
  "broker-environment-snapshot",
  "catalog-snapshot-version",
] as const;

const FORBIDDEN_GA_CLAIM_PATTERNS = [
  { label: "local fixtures", pattern: /based only on local fixtures|local-fixture-only/i },
  { label: "manually edited receipts", pattern: /manually edited receipts|manual receipt edit/i },
  { label: "proofless live GA", pattern: /live hosted broker is GA-ready|hosted broker is GA-ready/i },
] as const;

export class HostedBrokerGaHandoffEvidenceParseError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Invalid hosted broker GA handoff evidence: ${errors.join("; ")}`);
    this.name = "HostedBrokerGaHandoffEvidenceParseError";
    this.errors = [...errors];
  }
}

export const HOSTED_BROKER_GA_HANDOFF_EVIDENCE = {
  schema: "hobo.hosted-broker-ga-handoff-evidence/v1",
  issue: "HOBO-530",
  project: "Meta-cloud Broker",
  phase: "M4",
  milestoneGate: "M4 GA handoff evidence for hosted broker operations",
  goal:
    "Record hosted broker GA handoff evidence without claiming live hosted broker GA before Dogfood Yard and release cutline evidence exist.",
  scopeIn: [
    "Define GA handoff evidence for hosted broker operations.",
    "Confirm support/debug, compatibility/versioning, known limitations, release docs, and Dogfood Yard dependency evidence.",
    "Map accepted risks and post-GA follow-ups without creating execution work for accepted evidence.",
  ],
  scopeOut: [
    "Do not claim live hosted broker GA before Dogfood Yard and release cutline evidence exist.",
    "Do not build broker runtime, Yard planner, provider adapters, admin UI, Gatekeeper policy, or signing infrastructure.",
    "Do not treat local fixtures, docs, or manually edited receipts as live operational proof.",
  ],
  requiredEvidence: [
    {
      id: "operational-owner-checklist",
      ownerProject: "Meta-cloud Broker",
      proofSource: "docs/design/meta-cloud-broker.md",
      proves:
        "Broker service, support/debug, versioning, rollback, and release-note owners are named before handoff.",
      status: "accepted",
    },
    {
      id: "dogfood-yard-readiness-link",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      proofSource: "docs/design/dogfood-yard.md",
      proves:
        "Dogfood Yard evidence links Resolution Receipt and Resolution Rejection behavior to deploy-readiness questions.",
      status: "accepted",
    },
    {
      id: "compatibility-versioning-window",
      ownerProject: "Meta-cloud Broker",
      proofSource: "src/draft/technical-proofs/meta-cloud-broker-resolution-contract",
      proves:
        "Receipt schema, Broker Environment snapshots, and catalog snapshots are versioned handoff surfaces.",
      status: "accepted",
    },
    {
      id: "rollback-restore-limits",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      proofSource: "docs/design/go-no-go-decision-record.md",
      proves:
        "Rollback/restore language stays limited to deterministic receipt replay and documented recovery boundaries.",
      status: "accepted",
    },
    {
      id: "release-notes-support-entry",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      proofSource: "docs/design/release-notes-upgrade-guide.md",
      proves:
        "Release notes and support docs have broker-specific entries or explicit non-goals before GA language.",
      status: "accepted",
    },
  ],
  dogfoodReadinessLinks: [
    {
      artifact: "Resolution Receipt",
      ownerProject: "Meta-cloud Broker",
      sourceEvidenceId: "dogfood-yard-readiness-link",
      deployReadinessUse:
        "Dogfood Yard can verify deploy readiness by consuming signed receipt evidence and matching manifest/environment/catalog digests.",
      gaBoundary:
        "This is not live hosted broker GA proof; it is the deploy-readiness link that GA handoff consumes.",
    },
    {
      artifact: "Resolution Rejection",
      ownerProject: "Meta-cloud Broker",
      sourceEvidenceId: "dogfood-yard-readiness-link",
      deployReadinessUse:
        "Dogfood Yard can prove stale, incompatible, ambiguous, or unsupported mappings fail closed before Yard planning.",
      gaBoundary:
        "This is not live hosted broker GA proof; it is support/debug evidence for blocked deploy readiness.",
    },
  ],
  compatibilityWindows: [
    {
      id: "receipt-schema-v1",
      ownerProject: "Meta-cloud Broker",
      currentVersion: "hobo.resolution-receipt/v1",
      compatibilityRule:
        "Receipts remain digest-bound to manifest, environment, and catalog snapshot ids; incompatible schema changes need a new receipt version.",
    },
    {
      id: "broker-environment-snapshot",
      ownerProject: "Meta-cloud Broker",
      currentVersion: "hobo.broker-environment/v1",
      compatibilityRule:
        "Environment snapshots are replay inputs, not mutable admin state; superseding approvals issue a new snapshot and receipt/rejection.",
    },
    {
      id: "catalog-snapshot-version",
      ownerProject: "Providers, IaC & Build Adapters",
      currentVersion: "Broker Catalog Snapshot",
      compatibilityRule:
        "Catalog freshness and provider capability compatibility must be visible before GA handoff language promotes broker resolution.",
    },
  ],
  rollbackRestoreLimits: [
    {
      id: "receipt-replay-only",
      ownerProject: "Meta-cloud Broker",
      limit:
        "Rollback can replay prior receipt inputs for audit and planning evidence, but cannot mutate issued receipts in place.",
    },
    {
      id: "yard-restore-boundary",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      limit:
        "Yard restore evidence must consume broker receipts or rejections; it must not silently re-resolve hosted broker authority.",
    },
  ],
  releaseAndSupportDocs: [
    {
      ownerProject: "V1 Release Notes & Upgrade Guide",
      sourceEvidenceId: "release-notes-support-entry",
      brokerEntry:
        "Release notes include broker-specific compatibility windows, known limitations, and explicit non-goals for live GA claims.",
    },
    {
      ownerProject: "V1 Launch Support Desk & Escalation",
      sourceEvidenceId: "release-notes-support-entry",
      brokerEntry:
        "Support docs route broker receipt/rejection debug evidence without support access to customer payloads or provider credentials.",
    },
  ],
  acceptedRisks: [
    {
      id: "ga-handoff-before-live-service-ga",
      ownerRole: "release-owner",
      mitigation:
        "Label this as GA handoff evidence only; live hosted broker GA waits for Dogfood Yard and release-cutline acceptance.",
      followUpOrLaunchNote:
        "Release notes must distinguish fixture-backed broker evidence from live hosted service guarantees.",
      revisitDate: "2026-09-30",
      evidenceId: "release-notes-support-entry",
    },
  ],
  missingEvidence: [
    {
      id: "live-hosted-broker-operational-proof",
      ownerProject: "Meta-cloud Broker",
      reason:
        "Live hosted broker operational proof is outside this handoff package and remains a post-GA or release-owner decision.",
      launchDisposition: "post-ga-follow-up",
    },
  ],
  followUpIssues: [],
  followUpPolicy: {
    createOnlyWhereEvidenceMissing: true,
    acceptedEvidenceDoesNotCreateExecutionWork: true,
    parentReadinessSyncRequiredWhenLaunchRiskChanges: true,
  },
  parentInitiativeSync: {
    initiative: "HoBo v1 Release Readiness",
    launchRiskChanged: true,
    statusUpdated: true,
    statusUpdateReason:
      "Hosted broker GA handoff evidence is accepted with live hosted broker GA proof explicitly outside this branch.",
  },
  gaClaims: [
    {
      id: "handoff-evidence-ready",
      claim:
        "Hosted broker GA handoff evidence is ready for release-owner review when owner checklist, dogfood links, version windows, rollback limits, and release/support entries are attached.",
      sourceEvidenceIds: [
        "operational-owner-checklist",
        "dogfood-yard-readiness-link",
        "compatibility-versioning-window",
        "rollback-restore-limits",
        "release-notes-support-entry",
      ],
      disposition: "review",
    },
  ],
} as const;

export type HostedBrokerGaHandoffEvidenceRecord = typeof HOSTED_BROKER_GA_HANDOFF_EVIDENCE;

export type ParsedHostedBrokerGaHandoffEvidence = HostedBrokerGaHandoffEvidenceRecord & {
  readonly parsedHostedBrokerGaHandoffEvidence: true;
};

export function parseHostedBrokerGaHandoffEvidence(
  record: HostedBrokerGaHandoffEvidenceRecord,
): ParsedHostedBrokerGaHandoffEvidence {
  const errors = collectHostedBrokerGaHandoffEvidenceErrors(record);
  if (errors.length > 0) {
    throw new HostedBrokerGaHandoffEvidenceParseError(errors);
  }

  return Object.freeze({
    ...record,
    parsedHostedBrokerGaHandoffEvidence: true as const,
  });
}

function collectHostedBrokerGaHandoffEvidenceErrors(record: HostedBrokerGaHandoffEvidenceRecord): string[] {
  const errors: string[] = [];

  if (record.issue !== "HOBO-530") {
    errors.push("issue must be HOBO-530");
  }
  if (record.project !== "Meta-cloud Broker") {
    errors.push("project must be Meta-cloud Broker");
  }
  if (record.phase !== "M4") {
    errors.push("phase must be M4");
  }
  if (!/GA handoff/i.test(record.milestoneGate)) {
    errors.push("milestone gate must name GA handoff");
  }

  const evidenceIds = new Set((record.requiredEvidence ?? []).map((evidence) => evidence.id));
  for (const id of REQUIRED_EVIDENCE_IDS) {
    if (!evidenceIds.has(id)) {
      errors.push(`missing required evidence ${id}`);
    }
  }
  for (const evidence of record.requiredEvidence ?? []) {
    if (!evidence.ownerProject || !evidence.proofSource || !evidence.proves) {
      errors.push(`${evidence.id ?? "<missing>"} must name ownerProject, proofSource, and proof statement`);
    }
    if (evidence.status !== "accepted") {
      errors.push(`${evidence.id ?? "<missing>"} must be accepted before GA handoff`);
    }
  }

  const compatibilityIds = new Set((record.compatibilityWindows ?? []).map((window) => window.id));
  for (const id of REQUIRED_COMPATIBILITY_WINDOWS) {
    if (!compatibilityIds.has(id)) {
      errors.push(`missing compatibility window ${id}`);
    }
  }
  for (const window of record.compatibilityWindows ?? []) {
    if (!window.ownerProject || !window.currentVersion || !window.compatibilityRule) {
      errors.push(`${window.id ?? "<missing>"} compatibility window must name owner, version, and rule`);
    }
  }

  for (const link of record.dogfoodReadinessLinks ?? []) {
    if (!link.artifact || !link.sourceEvidenceId || !link.deployReadinessUse || !link.gaBoundary) {
      errors.push(`${link.artifact ?? "<missing>"} dogfood link must name artifact, sourceEvidenceId, deployReadinessUse, and gaBoundary`);
    }
    if (link.sourceEvidenceId && !evidenceIds.has(link.sourceEvidenceId)) {
      errors.push(`${link.artifact ?? "<missing>"} cites unknown evidence ${link.sourceEvidenceId}`);
    }
  }

  if (!record.followUpPolicy?.createOnlyWhereEvidenceMissing) {
    errors.push("follow-up execution issues can be created only where evidence is missing");
  }
  const missingEvidenceIds = new Set((record.missingEvidence ?? []).map((missing) => missing.id));
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

  for (const claim of record.gaClaims ?? []) {
    if (!claim.id || !claim.claim || !Array.isArray(claim.sourceEvidenceIds) || !claim.disposition) {
      errors.push(`${claim.id ?? "<missing>"} GA claim must name id, claim, sourceEvidenceIds, and disposition`);
      continue;
    }
    for (const sourceEvidenceId of claim.sourceEvidenceIds) {
      if (!evidenceIds.has(sourceEvidenceId)) {
        errors.push(`${claim.id} cites unknown evidence ${sourceEvidenceId}`);
      }
    }
    if (claim.disposition === "publish") {
      for (const forbidden of FORBIDDEN_GA_CLAIM_PATTERNS) {
        if (forbidden.pattern.test(claim.claim)) {
          errors.push(`${claim.id} GA claim cannot publish from ${forbidden.label}`);
        }
      }
      if (claim.sourceEvidenceIds.length < REQUIRED_EVIDENCE_IDS.length) {
        errors.push(`${claim.id} GA claim requires the full handoff evidence set before publication`);
      }
    }
  }

  return errors;
}

export interface HostedBrokerGaHandoffDecision {
  owner: string;
  inScope: boolean;
}

export function classifyHostedBrokerGaHandoffDecision(text: string): HostedBrokerGaHandoffDecision {
  if (/\b(release notes|upgrade guide|known limitation)\b/i.test(text)) {
    return { owner: "V1 Release Notes & Upgrade Guide", inScope: true };
  }
  if (/\b(support|debug|escalation)\b/i.test(text)) {
    return { owner: "V1 Launch Support Desk & Escalation", inScope: true };
  }
  if (/\b(dogfood|yard deploy readiness|receipt consumption)\b/i.test(text)) {
    return { owner: "V1 Dogfood Yard & Hosted Operations", inScope: true };
  }
  if (/\b(live broker runtime|provider adapter|admin ui|gatekeeper policy)\b/i.test(text)) {
    return { owner: "Owning implementation project", inScope: false };
  }
  return { owner: "Meta-cloud Broker", inScope: true };
}
