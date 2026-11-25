import { isJsonObject, type JsonValue } from "./json.js";
export type DogfoodYardGaEvidenceStatus = "accepted" | "accepted-risk" | "in-review" | "missing";
export type DogfoodYardGaProofMode = "design-record" | "issue-state" | "manual-review" | "release-cutline";
export type DogfoodYardGaBlockerState = "blocked" | "accepted-risk" | "cleared";
export type DogfoodYardGaLaunchRiskEffect = "unchanged" | "reduced" | "increased";
export type DogfoodYardGaReadinessDomain =
  | "operations-readiness"
  | "release-cutline"
  | "support"
  | "documentation"
  | "reliability"
  | "bootstrap"
  | "broker";

// domain-view: parse-produced draft-proof record; its wire form is the DogfoodYardGaEvidenceItem proto message in data-models/.
export interface DogfoodYardGaEvidenceItem {
  id: string;
  ownerProject: string;
  source: string;
  proofMode: DogfoodYardGaProofMode;
  status: DogfoodYardGaEvidenceStatus;
  acceptanceBullet: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the DogfoodYardGaBlocker proto message in data-models/.
export interface DogfoodYardGaBlocker {
  id: string;
  ownerProject: string;
  state: DogfoodYardGaBlockerState;
  sourceEvidenceId: string;
  disposition: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the DogfoodYardGaAcceptedRisk proto message in data-models/.
export interface DogfoodYardGaAcceptedRisk {
  id: string;
  ownerProject: string;
  mitigation: string;
  launchRiskEffect: DogfoodYardGaLaunchRiskEffect;
}

// domain-view: parse-produced draft-proof record; its wire form is the DogfoodYardGaReleaseCutlineDependency proto message in data-models/.
export interface DogfoodYardGaReleaseCutlineDependency {
  id: string;
  ownerProject: string;
  readinessDomain: DogfoodYardGaReadinessDomain;
  cutlineCategory: `v1-blocker.${string}`;
  source: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the DogfoodYardGaMissingEvidence proto message in data-models/.
export interface DogfoodYardGaMissingEvidence {
  id: string;
  ownerProject: string;
  reason: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the DogfoodYardGaFollowUp proto message in data-models/.
export interface DogfoodYardGaFollowUp {
  id: string;
  evidenceId: string;
  ownerProject: string;
  reason: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the DogfoodYardGaInitiativeStatusGate proto message in data-models/.
export interface DogfoodYardGaInitiativeStatusGate {
  parentInitiative: "HoBo v1 Release Readiness";
  launchRiskChange: DogfoodYardGaLaunchRiskEffect;
  statusUpdateRequired: boolean;
  updateSource: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the DogfoodYardGaPublicClaimGuard proto message in data-models/.
export interface DogfoodYardGaPublicClaimGuard {
  id: string;
  claim: string;
  evidenceId: string;
  disposition: "hold" | "draft" | "publish";
}

// domain-view: parse-produced draft-proof record; its wire form is the DogfoodYardGaHandoffEvidenceRecord proto message in data-models/.
export interface DogfoodYardGaHandoffEvidenceRecord {
  schema: string;
  issue: "HOBO-476";
  project: "V1 Dogfood Yard & Hosted Operations";
  phase: "M4";
  milestone: "M4 GA handoff";
  scopeIn: string[];
  scopeOut: string[];
  evidence: DogfoodYardGaEvidenceItem[];
  blockers: DogfoodYardGaBlocker[];
  acceptedRisks: DogfoodYardGaAcceptedRisk[];
  releaseCutlineDependencies: DogfoodYardGaReleaseCutlineDependency[];
  missingEvidence: DogfoodYardGaMissingEvidence[];
  followUps: DogfoodYardGaFollowUp[];
  initiativeStatus: DogfoodYardGaInitiativeStatusGate;
  publicClaimGuards: DogfoodYardGaPublicClaimGuard[];
}

export class DogfoodYardGaHandoffEvidenceParseError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(`Invalid Dogfood Yard GA handoff evidence: ${errors.join("; ")}`);
    this.name = "DogfoodYardGaHandoffEvidenceParseError";
    this.errors = [...errors];
  }
}

export type ParsedDogfoodYardGaHandoffEvidence = DogfoodYardGaHandoffEvidenceRecord & {
  readonly parsedDogfoodYardGaHandoffEvidence: true;
};

export const dogfoodYardGaHandoffEvidence: DogfoodYardGaHandoffEvidenceRecord = {
  schema: "hobo.dogfood-yard-ga-handoff-evidence/2026-06-30",
  issue: "HOBO-476",
  project: "V1 Dogfood Yard & Hosted Operations",
  phase: "M4",
  milestone: "M4 GA handoff",
  scopeIn: [
    "Record M4 Dogfood Yard and hosted operations handoff evidence for release-owner review.",
    "Map hosted, self-hosted, upgrade/rollback, incident restore, hosted broker, and support/debug evidence to owning projects.",
    "Reflect open predecessor and release-cutline states without claiming final public GA readiness.",
  ],
  scopeOut: [
    "Do not build Yard runtime, hosted operations runtime, admin UI, bootstrap installer, support tooling, status-page publication, or release automation.",
    "Do not call live provider APIs, provision cloud resources, store credentials, or use live customer data.",
    "Do not publish public GA, production recovery, SLA, or live hosted-operations claims from this handoff proof.",
  ],
  evidence: [
    {
      id: "m0-dogfood-yard-acceptance",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      source: "docs/design/dogfood-yard.md / HOBO-403",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "m1-dogfood-alpha-evidence",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      source: "HOBO-455 / src/draft/dogfood-yard-m1-evidence-contract",
      proofMode: "issue-state",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "m2-private-beta-review",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      source: "HOBO-462 / PR #551",
      proofMode: "issue-state",
      status: "in-review",
      acceptanceBullet: "Blockers and accepted risks are recorded.",
    },
    {
      id: "m3-release-candidate-review",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      source: "HOBO-469 / PR #555",
      proofMode: "issue-state",
      status: "in-review",
      acceptanceBullet: "Blockers and accepted risks are recorded.",
    },
    {
      id: "hosted-broker-deploy-readiness",
      ownerProject: "Meta-cloud Broker",
      source: "HOBO-530 / src/draft/hosted-broker-ga-handoff-evidence-contract",
      proofMode: "issue-state",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "ga-smoke-telemetry-bundle",
      ownerProject: "Reliability, Observability & Cost (FinOps)",
      source: "docs/design/dogfood-yard.md and docs/design/reliability-observability-cost.md#plan-05",
      proofMode: "manual-review",
      status: "accepted-risk",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "rollback-restore-support-handoff",
      ownerProject: "V1 Launch Support Desk & Escalation",
      source: "docs/design/launch-support-escalation.md and docs/design/release-notes-upgrade-guide.md",
      proofMode: "manual-review",
      status: "accepted-risk",
      acceptanceBullet: "Blockers and accepted risks are recorded.",
    },
    {
      id: "release-cutline-ga-handoff",
      ownerProject: "V1 Release Program & Cutline",
      source: "HOBO-475",
      proofMode: "release-cutline",
      status: "missing",
      acceptanceBullet: "Follow-up execution issues are created only where evidence is missing.",
    },
  ],
  blockers: [
    {
      id: "private-beta-predecessor-in-review",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      state: "accepted-risk",
      sourceEvidenceId: "m2-private-beta-review",
      disposition:
        "Dogfood GA handoff may cite the private-beta evidence PR as a predecessor state, but public GA claims wait for merge-owner acceptance.",
    },
    {
      id: "release-candidate-predecessor-in-review",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      state: "accepted-risk",
      sourceEvidenceId: "m3-release-candidate-review",
      disposition:
        "Release-candidate Dogfood evidence remains independently reviewable and cannot be collapsed into this M4 proof.",
    },
    {
      id: "release-program-ga-handoff-open",
      ownerProject: "V1 Release Program & Cutline",
      state: "blocked",
      sourceEvidenceId: "release-cutline-ga-handoff",
      disposition:
        "Final release go/no-go remains owned by HOBO-475; this package records Dogfood handoff evidence only.",
    },
  ],
  acceptedRisks: [
    {
      id: "predecessor-prs-await-merge-owner",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      mitigation:
        "Keep private-beta and release-candidate predecessor state explicit until their PRs merge or their owners update Linear.",
      launchRiskEffect: "unchanged",
    },
    {
      id: "fixture-backed-ga-handoff-language",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      mitigation:
        "Describe deterministic Dogfood handoff evidence as review input, not as live production recovery or public GA proof.",
      launchRiskEffect: "unchanged",
    },
  ],
  releaseCutlineDependencies: [
    {
      id: "dogfood-operations-readiness",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      readinessDomain: "operations-readiness",
      cutlineCategory: "v1-blocker.operations-readiness",
      source: "docs/design/dogfood-yard.md",
    },
    {
      id: "release-program-final-go-no-go",
      ownerProject: "V1 Release Program & Cutline",
      readinessDomain: "release-cutline",
      cutlineCategory: "v1-blocker.release-cutline",
      source: "HOBO-475",
    },
    {
      id: "support-debug-handoff",
      ownerProject: "V1 Launch Support Desk & Escalation",
      readinessDomain: "support",
      cutlineCategory: "v1-blocker.support",
      source: "docs/design/launch-support-escalation.md",
    },
    {
      id: "release-notes-known-limitations",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      readinessDomain: "documentation",
      cutlineCategory: "v1-blocker.documentation",
      source: "docs/design/release-notes-upgrade-guide.md",
    },
    {
      id: "telemetry-restore-evidence",
      ownerProject: "Reliability, Observability & Cost (FinOps)",
      readinessDomain: "reliability",
      cutlineCategory: "v1-blocker.reliability",
      source: "docs/design/reliability-observability-cost.md#plan-05",
    },
    {
      id: "self-host-seed-handover",
      ownerProject: "Bootstrap Installer",
      readinessDomain: "bootstrap",
      cutlineCategory: "v1-blocker.bootstrap",
      source: "docs/design/bootstrap-installer.md",
    },
    {
      id: "hosted-broker-dogfood-link",
      ownerProject: "Meta-cloud Broker",
      readinessDomain: "broker",
      cutlineCategory: "v1-blocker.broker",
      source: "docs/design/meta-cloud-broker.md",
    },
  ],
  missingEvidence: [
    {
      id: "release-program-ga-handoff",
      ownerProject: "V1 Release Program & Cutline",
      reason:
        "Final release-program GA handoff evidence is owned by the existing HOBO-475 issue and cannot be created by Dogfood Yard.",
    },
  ],
  followUps: [
    {
      id: "HOBO-475",
      evidenceId: "release-program-ga-handoff",
      ownerProject: "V1 Release Program & Cutline",
      reason: "Existing M4 release-program issue owns final go/no-go handoff evidence.",
    },
  ],
  initiativeStatus: {
    parentInitiative: "HoBo v1 Release Readiness",
    launchRiskChange: "reduced",
    statusUpdateRequired: true,
    updateSource:
      "HOBO-476 records Dogfood Yard GA handoff evidence, keeps HOBO-475 as the release-program follow-up, and blocks public GA claims on owner acceptance.",
  },
  publicClaimGuards: [
    {
      id: "dogfood-handoff-not-ga-ready",
      claim:
        "Dogfood Yard GA handoff evidence is ready for release-owner review, not a public GA readiness claim.",
      evidenceId: "ga-smoke-telemetry-bundle",
      disposition: "hold",
    },
  ],
};

export function parseDogfoodYardGaHandoffEvidence(
  record: DogfoodYardGaHandoffEvidenceRecord,
): ParsedDogfoodYardGaHandoffEvidence {
  const result = validateDogfoodYardGaHandoffEvidence(record);

  if (!result.ok) {
    throw new DogfoodYardGaHandoffEvidenceParseError(result.errors);
  }

  return Object.freeze({
    ...record,
    parsedDogfoodYardGaHandoffEvidence: true as const,
  });
}

export function validateDogfoodYardGaHandoffEvidence(record: JsonValue) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["Dogfood Yard GA handoff evidence record is required"] };
  }

  // SAFETY: `const value = record as Partial<DogfoodYardGaHandoffEvidenceRecord>;` is required at this I/O or test boundary.
  const value = record as Partial<DogfoodYardGaHandoffEvidenceRecord>;
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  const blockers = Array.isArray(value.blockers) ? value.blockers : [];
  const acceptedRisks = Array.isArray(value.acceptedRisks) ? value.acceptedRisks : [];
  const releaseCutlineDependencies = Array.isArray(value.releaseCutlineDependencies)
    ? value.releaseCutlineDependencies
    : [];
  const missingEvidence = Array.isArray(value.missingEvidence) ? value.missingEvidence : [];
  const followUps = Array.isArray(value.followUps) ? value.followUps : [];
  const scopeIn = Array.isArray(value.scopeIn) ? value.scopeIn : [];
  const scopeOut = Array.isArray(value.scopeOut) ? value.scopeOut : [];
  const publicClaimGuards = Array.isArray(value.publicClaimGuards) ? value.publicClaimGuards : [];

  if (value.issue !== "HOBO-476") errors.push("issue must be HOBO-476");
  if (value.project !== "V1 Dogfood Yard & Hosted Operations") {
    errors.push("project must be V1 Dogfood Yard & Hosted Operations");
  }
  if (value.phase !== "M4") errors.push("phase must be M4");
  if (value.milestone !== "M4 GA handoff") errors.push("milestone must be M4 GA handoff");
  if (!Array.isArray(value.evidence)) errors.push("evidence must be an array");
  if (!Array.isArray(value.blockers)) errors.push("blockers must be an array");
  if (!Array.isArray(value.acceptedRisks)) errors.push("accepted risks must be an array");
  if (!Array.isArray(value.releaseCutlineDependencies)) {
    errors.push("release cutline dependencies must be an array");
  }
  if (!Array.isArray(value.missingEvidence)) errors.push("missing evidence must be an array");
  if (!Array.isArray(value.followUps)) errors.push("follow-ups must be an array");
  if (!Array.isArray(value.scopeIn) || !Array.isArray(value.scopeOut) || !Array.isArray(value.publicClaimGuards)) {
    errors.push("scope guards must be arrays");
  }
  if (evidence.length < 8) errors.push("M4 Dogfood Yard evidence must contain at least eight owner-mapped entries");

  for (const item of evidence) {
    if (!item.id || !item.ownerProject || !item.source || !item.acceptanceBullet) {
      errors.push(`${item.id ?? "<missing>"} evidence requires id, ownerProject, source, and acceptanceBullet`);
    }
  }

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));

  if (blockers.length < 3) {
    errors.push("blockers must record at least three Dogfood Yard GA entries");
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
    errors.push("accepted risks must record at least two Dogfood Yard GA entries");
  }
  for (const risk of acceptedRisks) {
    if (!risk.id || !risk.ownerProject || !risk.mitigation || !risk.launchRiskEffect) {
      errors.push(`${risk.id ?? "<missing>"} risk requires owner, mitigation, and launchRiskEffect`);
    }
  }

  const readinessDomains = new Set(releaseCutlineDependencies.map((dependency) => dependency.readinessDomain));
  if (readinessDomains.size < 7) {
    errors.push("release cutline dependencies must map at least seven readiness domains");
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

  const scopeInText = scopeIn.join("\n");
  if (/\bbuild\b.*\b(hosted Yard runtime|Yard runtime|operations runtime)\b/i.test(scopeInText)) {
    errors.push("Yard runtime implementation is scope-out");
  }
  if (/\b(call|provision|use)\b.*\b(live provider|provider APIs|production provider)\b/i.test(scopeInText)) {
    errors.push("live provider operations are scope-out");
  }
  if (/\b(inspect|use|export)\b.*\b(live customer data|customer payload|customer data)\b/i.test(scopeInText)) {
    errors.push("live customer data is scope-out");
  }

  for (const text of scopeOut) {
    if (!text) errors.push("scope-out guard entries must be non-empty");
  }

  for (const guard of publicClaimGuards) {
    if (!guard.id || !guard.claim || !guard.evidenceId || !guard.disposition) {
      errors.push(`${guard.id ?? "<missing>"} public claim guard requires id, claim, evidenceId, and disposition`);
      continue;
    }
    if (guard.evidenceId && !evidenceById.has(guard.evidenceId)) {
      errors.push(`${guard.id} public claim guard cites unknown evidence ${guard.evidenceId}`);
    }
    if (
      guard.disposition === "publish" &&
      /\b(GA-ready|GA readiness|general availability|public GA|local fixtures|manually edited evidence)\b/i.test(
        guard.claim,
      )
    ) {
      errors.push(`${guard.id}: unsupported Dogfood Yard GA claim`);
    }
    if (guard.disposition === "publish" && /\bproduction recovery guarantees?\b/i.test(guard.claim)) {
      errors.push(`${guard.id}: production recovery claims require accepted drill evidence`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertDogfoodYardGaHandoffEvidence(record = dogfoodYardGaHandoffEvidence) {
  return parseDogfoodYardGaHandoffEvidence(record);
}
