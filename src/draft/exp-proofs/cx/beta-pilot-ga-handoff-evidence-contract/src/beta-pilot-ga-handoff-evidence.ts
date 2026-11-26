import { isJsonObject, type JsonValue } from "./json.js";
export type EvidenceStatus = "accepted" | "accepted-risk" | "missing";
export type ProofMode = "design-record" | "issue-state" | "manual-review" | "release-cutline";
export type LaunchRiskEffect = "unchanged" | "increased" | "reduced";
export type BlockerState = "blocked" | "accepted-risk" | "cleared";
export type ReadinessDomain =
  | "documentation"
  | "productization"
  | "operations-readiness"
  | "support"
  | "release-cutline";

// domain-view: parse-produced draft-proof record; its wire form is the BetaPilotGaEvidenceItem proto message in data-models/.
export interface BetaPilotGaEvidenceItem {
  id: string;
  ownerProject: string;
  source: string;
  proofMode: ProofMode;
  status: EvidenceStatus;
  acceptanceBullet: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the BetaPilotGaBlocker proto message in data-models/.
export interface BetaPilotGaBlocker {
  id: string;
  ownerProject: string;
  state: BlockerState;
  sourceEvidenceId: string;
  disposition: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the BetaPilotGaAcceptedRisk proto message in data-models/.
export interface BetaPilotGaAcceptedRisk {
  id: string;
  ownerProject: string;
  mitigation: string;
  launchRiskEffect: LaunchRiskEffect;
}

// domain-view: parse-produced draft-proof record; its wire form is the BetaPilotGaCutlineDependency proto message in data-models/.
export interface BetaPilotGaCutlineDependency {
  id: string;
  ownerProject: string;
  readinessDomain: ReadinessDomain;
  cutlineCategory: `v1-blocker.${string}`;
  source: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the BetaPilotGaFollowUp proto message in data-models/.
export interface BetaPilotGaFollowUp {
  id: string;
  evidenceId: string;
  ownerProject: string;
  reason: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the BetaPilotGaInitiativeStatusGate proto message in data-models/.
export interface BetaPilotGaInitiativeStatusGate {
  parentInitiative: "HoBo v1 Release Readiness";
  launchRiskChange: LaunchRiskEffect;
  statusUpdateRequired: boolean;
  updateSource: string;
}

// domain-view: parse-produced draft-proof record; its wire form is the BetaPilotGaPublicClaimGuard proto message in data-models/.
export interface BetaPilotGaPublicClaimGuard {
  id: string;
  claim: string;
  evidenceId: string;
  disposition: "hold" | "draft" | "publish";
}

// domain-view: parse-produced draft-proof record; its wire form is the BetaPilotGaHandoffEvidenceRecord proto message in data-models/.
export interface BetaPilotGaHandoffEvidenceRecord {
  schema: string;
  issue: "HOBO-477";
  project: "V1 Beta Pilot & Feedback Loop";
  phase: "M4";
  milestone: "M4 GA handoff";
  evidence: BetaPilotGaEvidenceItem[];
  blockers: BetaPilotGaBlocker[];
  acceptedRisks: BetaPilotGaAcceptedRisk[];
  releaseCutlineDependencies: BetaPilotGaCutlineDependency[];
  followUps: BetaPilotGaFollowUp[];
  initiativeStatus: BetaPilotGaInitiativeStatusGate;
  scopeOut: string[];
  publicClaimGuards: BetaPilotGaPublicClaimGuard[];
}

export const betaPilotGaHandoffEvidence: BetaPilotGaHandoffEvidenceRecord = {
  schema: "hobo.beta-pilot-ga-handoff-evidence/2026-06-30",
  issue: "HOBO-477",
  project: "V1 Beta Pilot & Feedback Loop",
  phase: "M4",
  milestone: "M4 GA handoff",
  evidence: [
    {
      id: "feedback-intake-contract",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      source: "docs/design/beta-pilot-feedback.md#feedback-intake",
      proofMode: "design-record",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "private-beta-evidence",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      source: "src/draft/exp-proofs/cx/v1-beta-pilot-private-beta-evidence/README.md",
      proofMode: "issue-state",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
    {
      id: "release-candidate-evidence",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      source: "src/draft/beta-pilot-release-candidate-evidence-contract/README.md",
      proofMode: "issue-state",
      status: "accepted",
      acceptanceBullet: "Blockers and accepted risks are recorded.",
    },
    {
      id: "support-route-handoff",
      ownerProject: "V1 Launch Support Desk & Escalation",
      source: "docs/design/launch-support-escalation.md",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "release-cutline-handoff",
      ownerProject: "V1 Release Program & Cutline",
      source: "src/draft/technical-proofs/v1-cutline-contract/README.md",
      proofMode: "release-cutline",
      status: "accepted",
      acceptanceBullet: "Cross-project dependencies are reflected in the release cutline.",
    },
    {
      id: "ga-feedback-summary",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      source: "src/draft/exp-proofs/cx/beta-pilot-ga-handoff-evidence-contract",
      proofMode: "manual-review",
      status: "accepted",
      acceptanceBullet: "Required evidence for this phase is listed and mapped to owning projects.",
    },
  ],
  blockers: [
    {
      id: "private-beta-source-accepted",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      state: "cleared",
      sourceEvidenceId: "private-beta-evidence",
      disposition: "Private-beta evidence is available as the M2 source and remains linked instead of being recopied into the GA proof.",
    },
    {
      id: "release-candidate-source-accepted",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      state: "cleared",
      sourceEvidenceId: "release-candidate-evidence",
      disposition: "The M3 release-candidate evidence no longer blocks GA handoff; final GA claims still require this M4 record.",
    },
    {
      id: "post-ga-feedback-cadence",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      state: "accepted-risk",
      sourceEvidenceId: "ga-feedback-summary",
      disposition: "Post-GA feedback cadence can remain an accepted risk because it does not block the scoped M4 handoff evidence.",
    },
  ],
  acceptedRisks: [
    {
      id: "post-ga-feedback-cadence-owned",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      mitigation: "Keep post-GA feedback cadence as an owner-reviewed release note and revisit it after GA handoff acceptance.",
      launchRiskEffect: "unchanged",
    },
    {
      id: "manual-pilot-summary-source",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      mitigation: "Treat GA summary evidence as a manual review record until a later feedback reporting surface exists.",
      launchRiskEffect: "unchanged",
    },
  ],
  releaseCutlineDependencies: [
    {
      id: "beta-feedback-productization",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      readinessDomain: "productization",
      cutlineCategory: "v1-blocker.productization",
      source: "docs/design/beta-pilot-feedback.md#release-candidate-exit",
    },
    {
      id: "release-note-known-limitations",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      readinessDomain: "documentation",
      cutlineCategory: "v1-blocker.documentation",
      source: "docs/design/release-notes-upgrade-guide.md",
    },
    {
      id: "support-feedback-route",
      ownerProject: "V1 Launch Support Desk & Escalation",
      readinessDomain: "support",
      cutlineCategory: "v1-blocker.support",
      source: "docs/design/launch-support-escalation.md",
    },
    {
      id: "dogfood-hosted-operations-input",
      ownerProject: "V1 Dogfood Yard & Hosted Operations",
      readinessDomain: "operations-readiness",
      cutlineCategory: "v1-blocker.operations-readiness",
      source: "docs/design/dogfood-yard.md",
    },
    {
      id: "release-owner-ga-signoff",
      ownerProject: "V1 Release Program & Cutline",
      readinessDomain: "release-cutline",
      cutlineCategory: "v1-blocker.release-cutline",
      source: "src/draft/technical-proofs/v1-cutline-contract/README.md",
    },
  ],
  followUps: [],
  initiativeStatus: {
    parentInitiative: "HoBo v1 Release Readiness",
    launchRiskChange: "reduced",
    statusUpdateRequired: true,
    updateSource:
      "HOBO-477 records V1 Beta Pilot & Feedback Loop M4 GA handoff evidence and clears the M3 GA-handoff gap.",
  },
  scopeOut: [
    "No beta customer onboarding, customer cohort expansion, feedback portal, support ticketing workflow, product UX, or hosted operations implementation is created by this proof.",
    "No launch blocker is resolved inside this GA handoff proof; blocker fixes remain owned by their project issues.",
    "No GA readiness, public launch, support SLA, or live hosted-operations claim may be promoted from beta evidence without the accepted M4 handoff record.",
  ],
  publicClaimGuards: [
    {
      id: "ga-beta-claim-requires-m4",
      claim: "Beta pilot feedback can support GA readiness only after accepted M4 handoff evidence and cleared blocking records.",
      evidenceId: "ga-feedback-summary",
      disposition: "hold",
    },
  ],
};

export function validateBetaPilotGaHandoffEvidence(record: JsonValue) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["beta pilot GA handoff evidence record is required"] };
  }

  // SAFETY: `const value = record as Partial<BetaPilotGaHandoffEvidenceRecord>;` is required at this I/O or test boundary.
  const value = record as Partial<BetaPilotGaHandoffEvidenceRecord>;
  const evidence = Array.isArray(value.evidence) ? value.evidence : [];
  const blockers = Array.isArray(value.blockers) ? value.blockers : [];
  const acceptedRisks = Array.isArray(value.acceptedRisks) ? value.acceptedRisks : [];
  const releaseCutlineDependencies = Array.isArray(value.releaseCutlineDependencies)
    ? value.releaseCutlineDependencies
    : [];
  const followUps = Array.isArray(value.followUps) ? value.followUps : [];
  const scopeOut = Array.isArray(value.scopeOut) ? value.scopeOut : [];
  const publicClaimGuards = Array.isArray(value.publicClaimGuards) ? value.publicClaimGuards : [];

  if (value.issue !== "HOBO-477") errors.push("issue must be HOBO-477");
  if (value.phase !== "M4") errors.push("phase must be M4");
  if (value.milestone !== "M4 GA handoff") errors.push("milestone must be M4 GA handoff");
  if (!Array.isArray(value.evidence)) errors.push("evidence must be an array");
  if (!Array.isArray(value.blockers)) errors.push("blockers must be an array");
  if (!Array.isArray(value.acceptedRisks)) errors.push("accepted risks must be an array");
  if (!Array.isArray(value.releaseCutlineDependencies)) errors.push("release cutline dependencies must be an array");
  if (!Array.isArray(value.followUps)) errors.push("follow-ups must be an array");
  if (!Array.isArray(value.scopeOut)) errors.push("scope-out guards must be an array");
  if (!Array.isArray(value.publicClaimGuards)) errors.push("public claim guards must be an array");
  if (!Array.isArray(value.evidence) || evidence.length < 6) {
    errors.push("M4 beta pilot GA handoff evidence must contain at least six owner-mapped entries");
  }

  for (const item of evidence) {
    if (!item.id || !item.ownerProject || !item.source || !item.acceptanceBullet) {
      errors.push(`${item.id ?? "<missing>"} evidence requires id, ownerProject, source, and acceptanceBullet`);
    }
  }

  const evidenceById = new Map(evidence.map((item) => [item.id, item]));

  if (blockers.length < 2) {
    errors.push("blockers must record at least two GA handoff entries");
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
    errors.push("accepted risks must record at least two GA handoff entries");
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
    if (/^\s*(onboard|expand|invite)\b.*\b(beta|customer|cohort)/i.test(text)) {
      errors.push("beta customer onboarding is scope-out");
    }
    if (/^\s*(implement|build|create|ship)\b.*\b(feedback portal|support ticketing|support tooling)\b/i.test(text)) {
      errors.push("feedback portal or support tooling implementation is scope-out");
    }
    if (/^\s*(resolve|fix|clear)\b.*\b(launch blockers?|blockers?)\b/i.test(text)) {
      errors.push("launch blocker resolution is scope-out");
    }
  }

  for (const guard of publicClaimGuards) {
    if (!guard.id || !guard.claim || !guard.evidenceId || !guard.disposition) {
      errors.push(`${guard.id ?? "<missing>"} public claim guard requires id, claim, evidenceId, and disposition`);
      continue;
    }

    const evidence = evidenceById.get(guard.evidenceId);
    const acceptedGaEvidence = evidence?.status === "accepted" && evidence.id === "ga-feedback-summary";
    const unresolvedBlockers = blockers.some((blocker) => blocker.state === "blocked");

    if (
      guard.disposition === "publish" &&
      /\bGA\b|\bgeneral availability\b|\bGA readiness\b|\bproduction readiness\b/i.test(guard.claim) &&
      (!acceptedGaEvidence || unresolvedBlockers)
    ) {
      errors.push(`${guard.id}: GA beta pilot claims require accepted GA handoff evidence and no unresolved blockers`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function assertBetaPilotGaHandoffEvidence(record = betaPilotGaHandoffEvidence) {
  const result = validateBetaPilotGaHandoffEvidence(record);

  if (!result.ok) {
    throw new Error(`beta pilot GA handoff evidence invalid:\n${result.errors.join("\n")}`);
  }

  return record;
}
