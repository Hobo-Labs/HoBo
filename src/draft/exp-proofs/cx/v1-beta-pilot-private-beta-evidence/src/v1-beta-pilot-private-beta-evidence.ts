export type EvidenceStatus = "complete" | "missing" | "accepted-limitation";
export type RiskLevel = "low" | "medium" | "high";

// domain-view: parse-produced draft-proof record; its wire form is the RequiredEvidence proto message in data-models/.
export type RequiredEvidence = {
  readonly id: string;
  readonly ownerProject: string;
  readonly evidenceKinds: readonly string[];
  readonly status: EvidenceStatus;
};

// domain-view: parse-produced draft-proof record; its wire form is the BlockerState proto message in data-models/.
export type BlockerState = {
  readonly id: string;
  readonly status: "open" | "resolved" | "accepted-limitation";
  readonly ownerProject: string;
  readonly disposition: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the AcceptedRisk proto message in data-models/.
export type AcceptedRisk = {
  readonly id: string;
  readonly owner: string;
  readonly mitigation: string;
  readonly launchNoteOrFollowUp: string;
};

// domain-view: parse-produced draft-proof record; its wire form is the ReleaseCutline proto message in data-models/.
export type ReleaseCutline = {
  readonly consumesProjects: readonly string[];
  readonly blocksReleaseCandidateWithoutDependencyDisposition: boolean;
};

// domain-view: parse-produced draft-proof record; its wire form is the PrivateBetaEvidenceGate proto message in data-models/.
export type PrivateBetaEvidenceGate = {
  readonly issue: "HOBO-463";
  readonly project: "V1 Beta Pilot & Feedback Loop";
  readonly phase: "M2";
  readonly milestone: "M2 Private beta proof";
  readonly requiredEvidence: readonly RequiredEvidence[];
  readonly blockerStates: readonly BlockerState[];
  readonly acceptedRisks: readonly AcceptedRisk[];
  readonly releaseCutline: ReleaseCutline;
  readonly scopeIn: string[];
  readonly scopeOut: readonly string[];
};

export type EvidenceGapInput = {
  readonly required: boolean;
  readonly status: EvidenceStatus;
};

export type FollowUpIssueSpec = {
  readonly parentIssue: "HOBO-463";
  readonly title: string;
  readonly evidenceId: string;
  readonly ownerProject: string;
  readonly labels: readonly string[];
};

const REQUIRED_EVIDENCE_IDS = [
  "pilot-cohort-snapshot",
  "workflow-feedback-ledger",
  "blocker-and-risk-register",
  "release-cutline-dependency-map",
  "parent-readiness-signal"
] as const;

const REQUIRED_CUTLINE_PROJECTS = [
  "V1 Release Program & Cutline",
  "V1 Launch Support Desk & Escalation",
  "V1 Release Notes & Upgrade Guide",
  "Workspace & Onboarding UX",
  "Capability project owners"
] as const;

const SCOPE_CREEP_PATTERNS = [
  { label: "customer onboarding", pattern: /onboard(?:ing)?\b.*\bbeta customers?/i },
  { label: "blocker resolution", pattern: /resolve\b.*\blaunch blockers?/i },
  { label: "support tooling", pattern: /build\b.*\bsupport (?:ticketing|tooling|automation)/i }
] as const;

export const V1_BETA_PILOT_PRIVATE_BETA_EVIDENCE: PrivateBetaEvidenceGate = {
  issue: "HOBO-463",
  project: "V1 Beta Pilot & Feedback Loop",
  phase: "M2",
  milestone: "M2 Private beta proof",
  requiredEvidence: [
    {
      id: "pilot-cohort-snapshot",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      evidenceKinds: ["target persona fit", "feedback consent", "support window"],
      status: "complete"
    },
    {
      id: "workflow-feedback-ledger",
      ownerProject: "Workspace & Onboarding UX",
      evidenceKinds: ["workflow result", "structured feedback item", "customer impact"],
      status: "missing"
    },
    {
      id: "blocker-and-risk-register",
      ownerProject: "V1 Release Program & Cutline",
      evidenceKinds: ["blocker delta", "accepted risk", "mitigation owner"],
      status: "complete"
    },
    {
      id: "release-cutline-dependency-map",
      ownerProject: "V1 Release Program & Cutline",
      evidenceKinds: ["dependency disposition", "launch-note route", "release candidate input"],
      status: "complete"
    },
    {
      id: "parent-readiness-signal",
      ownerProject: "HoBo v1 Release Readiness",
      evidenceKinds: ["risk delta", "parent status signal"],
      status: "complete"
    }
  ],
  blockerStates: [
    {
      id: "beta-blocker-feedback",
      status: "open",
      ownerProject: "V1 Release Program & Cutline",
      disposition: "Release-candidate promotion waits for owner disposition."
    },
    {
      id: "support-route-capacity",
      status: "resolved",
      ownerProject: "V1 Launch Support Desk & Escalation",
      disposition: "Support route and escalation window are attached."
    },
    {
      id: "platform-engineer-workflow-gap",
      status: "accepted-limitation",
      ownerProject: "Workspace & Onboarding UX",
      disposition: "Accepted as private-beta limitation with follow-up before release candidate."
    }
  ],
  acceptedRisks: [
    {
      id: "workflow-coverage-gap",
      owner: "beta program owner",
      mitigation: "Keep the gap private-beta only and block release-candidate promotion until evidence lands.",
      launchNoteOrFollowUp: "RCR or child issue for missing workflow-feedback-ledger evidence."
    }
  ],
  releaseCutline: {
    consumesProjects: REQUIRED_CUTLINE_PROJECTS,
    blocksReleaseCandidateWithoutDependencyDisposition: true
  },
  scopeIn: [
    "List required M2 private-beta evidence and map each item to an owning project.",
    "Record blockers and accepted risks as release-readiness evidence.",
    "Reflect cross-project dependencies in the release cutline.",
    "Create follow-up issue specs only for missing evidence.",
    "Summarize parent release-readiness status changes when risk changes."
  ],
  scopeOut: [
    "Do not onboard beta customers in this proof.",
    "Do not build support tooling or ticketing automation.",
    "Do not resolve blockers surfaced by beta feedback."
  ]
};

export function validatePrivateBetaEvidenceGate(record: PrivateBetaEvidenceGate) {
  const errors: string[] = [];

  if (record.issue !== "HOBO-463") {
    errors.push("issue must be HOBO-463");
  }
  if (record.phase !== "M2") {
    errors.push("phase must be M2");
  }

  const evidenceIds = record.requiredEvidence.map((item) => item.id);
  for (const evidenceId of REQUIRED_EVIDENCE_IDS) {
    if (!evidenceIds.includes(evidenceId)) {
      errors.push(`missing required evidence: ${evidenceId}`);
    }
  }
  for (const item of record.requiredEvidence) {
    if (!item.ownerProject || item.evidenceKinds.length === 0) {
      errors.push(`${item.id} must map to an owning project and evidence kinds`);
    }
  }

  for (const status of ["open", "resolved", "accepted-limitation"] as const) {
    if (!record.blockerStates.some((blocker) => blocker.status === status)) {
      errors.push(`blocker states must include ${status}`);
    }
  }
  for (const risk of record.acceptedRisks) {
    if (!risk.owner || !risk.mitigation || !risk.launchNoteOrFollowUp) {
      errors.push(`${risk.id} must record owner, mitigation, and launch note or follow-up`);
    }
  }

  for (const project of REQUIRED_CUTLINE_PROJECTS) {
    if (!record.releaseCutline.consumesProjects.includes(project)) {
      errors.push(`release cutline must consume ${project}`);
    }
  }
  if (!record.releaseCutline.blocksReleaseCandidateWithoutDependencyDisposition) {
    errors.push("release cutline must block RC without dependency disposition");
  }

  for (const item of record.scopeIn) {
    for (const guard of SCOPE_CREEP_PATTERNS) {
      if (guard.pattern.test(item)) {
        errors.push(`scope creep: ${guard.label}: ${item}`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

export function classifyEvidenceGap(input: EvidenceGapInput) {
  if (input.required && input.status === "missing") {
    return "follow-up-issue-required" as const;
  }

  return "no-follow-up" as const;
}

export function createFollowUpIssues(record: PrivateBetaEvidenceGate): FollowUpIssueSpec[] {
  return record.requiredEvidence
    .filter((item) => classifyEvidenceGap({ required: true, status: item.status }) === "follow-up-issue-required")
    .map((item) => ({
      parentIssue: "HOBO-463",
      title: `M2 evidence follow-up: ${item.id}`,
      evidenceId: item.id,
      ownerProject: item.ownerProject,
      labels: ["slice", "hardening"]
    }));
}

export function summarizeParentReadinessSignal(input: {
  readonly previousRisk: RiskLevel;
  readonly currentRisk: RiskLevel;
  readonly missingRequiredEvidence: number;
  readonly openBlockers: number;
}) {
  if (
    riskRank(input.currentRisk) > riskRank(input.previousRisk) ||
    input.missingRequiredEvidence > 0 ||
    input.openBlockers > 0
  ) {
    return "risk-increased" as const;
  }

  return "no-parent-status-change" as const;
}

function riskRank(risk: RiskLevel) {
  return { low: 0, medium: 1, high: 2 }[risk];
}
