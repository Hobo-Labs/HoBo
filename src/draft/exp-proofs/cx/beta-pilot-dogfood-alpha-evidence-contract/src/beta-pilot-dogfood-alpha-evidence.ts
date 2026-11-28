import { isJsonObject } from "./json.js";
export const REQUIRED_DOGFOOD_ALPHA_EVIDENCE = [
  "pilot-cohort-snapshot",
  "workflow-evidence-matrix",
  "feedback-intake-ledger",
  "triage-routing-snapshot",
  "blocker-risk-register",
  "cross-project-cutline-map",
  "follow-up-gap-register",
  "initiative-risk-delta"
] as const;

export const REQUIRED_BETA_INTAKE_FIELDS = [
  "persona",
  "environment",
  "workflow",
  "severity",
  "evidence",
  "customerImpact"
] as const;

export type DogfoodAlphaEvidenceId = (typeof REQUIRED_DOGFOOD_ALPHA_EVIDENCE)[number];
export type DogfoodAlphaStatus = "accepted" | "missing" | "blocked";
export type LaunchRiskDelta = "none" | "increased" | "decreased";
export type FollowUpReason = "missing-accepted-evidence" | "owner-blocker" | "scope-change";
export type BetaTriageRoute = "cutline" | "support" | "product-ux" | "docs" | "capability-project";

export type DogfoodAlphaEvidenceItem = {
  readonly id: DogfoodAlphaEvidenceId;
  readonly ownerProject: string;
  readonly status: DogfoodAlphaStatus;
  readonly acceptedEvidence: readonly string[];
};

export type BlockerRisk = {
  readonly id: string;
  readonly route: BetaTriageRoute;
  readonly ownerProject: string;
  readonly status: "accepted-limitation" | "open-blocker" | "resolved";
  readonly launchRisk: "none" | "low" | "high";
};

export type CrossProjectDependency = {
  readonly ownerProject: string;
  readonly reason: string;
};

export type ProposedFollowUp = {
  readonly reason: FollowUpReason | string;
  readonly ownerProject: string;
  readonly summary: string;
};

export type BetaPilotDogfoodAlphaEvidence = {
  readonly schema: string;
  readonly issue: "HOBO-456";
  readonly project: "V1 Beta Pilot & Feedback Loop";
  readonly phase: "M1";
  readonly sourceContract: {
    readonly issue: "HOBO-404";
    readonly path: string;
  };
  readonly requiredIntakeFields: readonly (typeof REQUIRED_BETA_INTAKE_FIELDS)[number][];
  readonly requiredEvidence: readonly DogfoodAlphaEvidenceItem[];
  readonly blockerRiskRegister: readonly BlockerRisk[];
  readonly crossProjectDependencies: readonly CrossProjectDependency[];
  readonly followUpPolicy: {
    readonly blanketFollowUpsAllowed: boolean;
    readonly allowedReasons: readonly FollowUpReason[];
    readonly proposedFollowUps: readonly ProposedFollowUp[];
  };
  readonly launchRiskDelta: LaunchRiskDelta;
  readonly parentInitiativeStatus: {
    readonly required: boolean;
    readonly reason: string;
  };
  readonly scopeOut: readonly string[];
};

export const betaPilotDogfoodAlphaEvidence: BetaPilotDogfoodAlphaEvidence = {
  schema: "hobo.v1.beta_pilot_dogfood_alpha_evidence/2026-06-30",
  issue: "HOBO-456",
  project: "V1 Beta Pilot & Feedback Loop",
  phase: "M1",
  sourceContract: {
    issue: "HOBO-404",
    path: "docs/design/beta-pilot-feedback.md"
  },
  requiredIntakeFields: REQUIRED_BETA_INTAKE_FIELDS,
  requiredEvidence: [
    {
      id: "pilot-cohort-snapshot",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      status: "accepted",
      acceptedEvidence: ["dogfood/alpha cohort maps app developer, platform engineer, and support/operator personas"]
    },
    {
      id: "workflow-evidence-matrix",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      status: "accepted",
      acceptedEvidence: ["workflow rows distinguish hosted dogfood, local/dev, and support handoff environments"]
    },
    {
      id: "feedback-intake-ledger",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      status: "accepted",
      acceptedEvidence: ["ledger shape preserves persona, environment, workflow, severity, evidence, and customer impact"]
    },
    {
      id: "triage-routing-snapshot",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      status: "accepted",
      acceptedEvidence: ["triage snapshot routes feedback to cutline, support, product UX, docs, or capability owners"]
    },
    {
      id: "blocker-risk-register",
      ownerProject: "V1 Release Program & Cutline",
      status: "accepted",
      acceptedEvidence: ["register records no open blocker-severity beta feedback for this gate"]
    },
    {
      id: "cross-project-cutline-map",
      ownerProject: "V1 Release Program & Cutline",
      status: "accepted",
      acceptedEvidence: ["cutline map reflects support, product UX, docs, and capability owner dependencies"]
    },
    {
      id: "follow-up-gap-register",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      status: "accepted",
      acceptedEvidence: ["follow-up creation is limited to missing accepted evidence, owner blockers, or scope changes"]
    },
    {
      id: "initiative-risk-delta",
      ownerProject: "V1 Release Program & Cutline",
      status: "accepted",
      acceptedEvidence: ["no launch-risk delta is recorded by the M1 dogfood/alpha acceptance proof"]
    }
  ],
  blockerRiskRegister: [
    {
      id: "feedback.blocker.none-open",
      route: "cutline",
      ownerProject: "V1 Release Program & Cutline",
      status: "resolved",
      launchRisk: "none"
    },
    {
      id: "feedback.high-risk.accepted-limitations",
      route: "docs",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      status: "accepted-limitation",
      launchRisk: "low"
    },
    {
      id: "feedback.support-handoff.coverage",
      route: "support",
      ownerProject: "V1 Launch Support Desk & Escalation",
      status: "resolved",
      launchRisk: "none"
    }
  ],
  crossProjectDependencies: [
    {
      ownerProject: "V1 Release Program & Cutline",
      reason: "owns blocker deltas, accepted risks, and go/no-go visibility"
    },
    {
      ownerProject: "V1 Launch Support Desk & Escalation",
      reason: "owns support-request routes and first-responder coverage"
    },
    {
      ownerProject: "Workspace & Onboarding UX",
      reason: "owns onboarding, workspace, dashboard, and plan/diff usability findings"
    },
    {
      ownerProject: "V1 Release Notes & Upgrade Guide",
      reason: "owns docs-gap routes, known limitations, and launch-note wording"
    },
    {
      ownerProject: "Owning capability project",
      reason: "owns provider, runtime, identity, billing, marketplace, and other capability gaps"
    }
  ],
  followUpPolicy: {
    blanketFollowUpsAllowed: false,
    allowedReasons: ["missing-accepted-evidence", "owner-blocker", "scope-change"],
    proposedFollowUps: []
  },
  launchRiskDelta: "none",
  parentInitiativeStatus: {
    required: false,
    reason: "No new blocker or high launch-risk delta is introduced by this evidence gate."
  },
  scopeOut: [
    "Do not onboard beta customers in this issue.",
    "Do not implement a general feedback portal.",
    "Do not resolve beta feedback blockers in this issue.",
    "Do not change parent release risk status when the gate records no launch-risk delta."
  ]
};

export function validateDogfoodAlphaEvidence(record: BetaPilotDogfoodAlphaEvidence) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["dogfood/alpha evidence record is required"] };
  }
  if (record.issue !== "HOBO-456") {
    errors.push("issue must be HOBO-456");
  }
  if (record.phase !== "M1") {
    errors.push("phase must be M1");
  }
  if (record.sourceContract?.issue !== "HOBO-404") {
    errors.push("source contract must be HOBO-404");
  }
  if (!arraysEqual(record.requiredIntakeFields, REQUIRED_BETA_INTAKE_FIELDS)) {
    errors.push(`required intake fields must match ${REQUIRED_BETA_INTAKE_FIELDS.join(", ")}`);
  }

  const evidenceById = new Map(record.requiredEvidence?.map((item) => [item.id, item]) ?? []);
  for (const id of REQUIRED_DOGFOOD_ALPHA_EVIDENCE) {
    const item = evidenceById.get(id);
    if (!item) {
      errors.push(`missing required evidence ${id}`);
      continue;
    }
    if (!item.ownerProject) {
      errors.push(`${id} must name ownerProject`);
    }
    if (item.status !== "accepted") {
      errors.push(`${id} must be accepted for the M1 gate`);
    }
    if (!Array.isArray(item.acceptedEvidence) || item.acceptedEvidence.length === 0) {
      errors.push(`${id} must include accepted evidence`);
    }
  }

  for (const item of record.blockerRiskRegister ?? []) {
    if (!item.id || !item.ownerProject || !item.route) {
      errors.push(`blocker/risk ${item.id ?? "<missing>"} must name id, route, and ownerProject`);
    }
    if (item.status === "open-blocker" && item.launchRisk === "none") {
      errors.push(`${item.id}: open blockers must carry launch risk`);
    }
  }

  const dependencyOwners = new Set(record.crossProjectDependencies?.map((item) => item.ownerProject) ?? []);
  for (const owner of [
    "V1 Release Program & Cutline",
    "V1 Launch Support Desk & Escalation",
    "Workspace & Onboarding UX",
    "V1 Release Notes & Upgrade Guide",
    "Owning capability project"
  ]) {
    if (!dependencyOwners.has(owner)) {
      errors.push(`cross-project dependency missing ${owner}`);
    }
  }

  if (record.followUpPolicy?.blanketFollowUpsAllowed) {
    errors.push("blanket follow-up creation is not allowed");
  }
  const allowedReasons = new Set(record.followUpPolicy?.allowedReasons ?? []);
  for (const followUp of record.followUpPolicy?.proposedFollowUps ?? []) {
    // SAFETY: `if (!allowedReasons.has(followUp.reason as FollowUpReason)) {` is required at this I/O or test boundary.
    if (!allowedReasons.has(followUp.reason as FollowUpReason)) {
      errors.push(`unsupported follow-up reason: ${followUp.reason}`);
    }
    if (!followUp.ownerProject || !followUp.summary) {
      errors.push("follow-up issues must name ownerProject and summary");
    }
  }

  if (record.launchRiskDelta !== "none" && !record.parentInitiativeStatus?.required) {
    errors.push("parent initiative status update is required when launch risk changes");
  }

  return { ok: errors.length === 0, errors };
}

export function canAcceptDogfoodAlphaGate(record = betaPilotDogfoodAlphaEvidence) {
  const result = validateDogfoodAlphaEvidence(record);
  const hasOpenBlockers = record.blockerRiskRegister.some((item) => item.status === "open-blocker");
  const allEvidenceAccepted = record.requiredEvidence.every((item) => item.status === "accepted");

  return result.ok && !hasOpenBlockers && allEvidenceAccepted;
}

function arraysEqual(left: readonly string[] | undefined, right: readonly string[]) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}
