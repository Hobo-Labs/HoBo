export const REQUIRED_DECISION_FIELDS = [
  "gate",
  "decision",
  "approverRole",
  "evidenceLinks",
  "blockerDeltas",
  "acceptedRisks",
  "expiryOrRevisitDate"
] as const;

export const REQUIRED_GATES = ["beta", "release-candidate", "ga"] as const;

export const REQUIRED_EXCEPTION_FIELDS = [
  "owner",
  "mitigation",
  "launchNoteOrFollowUp",
  "expiryOrRevisitDate"
] as const;

export type ReleaseGate = "beta" | "release-candidate" | "ga";
export type ReleaseDecision = "go" | "conditional-go" | "no-go";
export type TaxonomyClass = "launch-blocker" | "high-risk-non-blocker" | "launch-note" | "post-ga-follow-up";

export type GoNoGoDecisionWorkflow = {
  readonly schema: string;
  readonly issue: "HOBO-483";
  readonly template: {
    readonly requiredFields: readonly (typeof REQUIRED_DECISION_FIELDS)[number][];
  };
  readonly gates: readonly (typeof REQUIRED_GATES)[number][];
  readonly gateWorkflow: readonly {
    readonly gate: ReleaseGate;
    readonly requiredEvidence: readonly string[];
    readonly allowedDecisions: readonly ReleaseDecision[];
  }[];
  readonly exceptionPolicy: {
    requiredFields: readonly (typeof REQUIRED_EXCEPTION_FIELDS)[number][];
    forbiddenClasses: readonly TaxonomyClass[];
    cannotOverrideRequiredGates: boolean;
  };
  readonly scopeGuard: {
    approvesCurrentRisk: boolean;
    forbiddenActions: readonly string[];
  };
};

export const goNoGoDecisionWorkflow: GoNoGoDecisionWorkflow = {
  schema: "hobo.v1.go_no_go_decision_record/2026-06-30",
  issue: "HOBO-483",
  template: {
    requiredFields: REQUIRED_DECISION_FIELDS
  },
  gates: REQUIRED_GATES,
  gateWorkflow: [
    {
      gate: "beta",
      requiredEvidence: ["pilot cohort", "known limitations", "support route", "blocker delta"],
      allowedDecisions: ["go", "conditional-go", "no-go"]
    },
    {
      gate: "release-candidate",
      requiredEvidence: ["release notes", "upgrade guidance", "compatibility evidence", "blocker delta"],
      allowedDecisions: ["go", "conditional-go", "no-go"]
    },
    {
      gate: "ga",
      requiredEvidence: ["signed launch checklist", "support handoff", "legal/privacy posture", "blocker delta"],
      allowedDecisions: ["go", "conditional-go", "no-go"]
    }
  ],
  exceptionPolicy: {
    requiredFields: REQUIRED_EXCEPTION_FIELDS,
    forbiddenClasses: ["launch-blocker"],
    cannotOverrideRequiredGates: true
  },
  scopeGuard: {
    approvesCurrentRisk: false,
    forbiddenActions: [
      "approve-current-risk",
      "resolve-launch-blocker",
      "override-ci-review-security-or-contract-gate"
    ]
  }
};

export function validateGoNoGoDecisionWorkflow(record: GoNoGoDecisionWorkflow) {
  const errors: string[] = [];

  for (const field of REQUIRED_DECISION_FIELDS) {
    if (!record.template.requiredFields.includes(field)) {
      errors.push(`decision template is missing ${field}`);
    }
  }

  for (const gate of REQUIRED_GATES) {
    if (!record.gates.includes(gate)) {
      errors.push(`workflow is missing ${gate} gate`);
    }
    const step = record.gateWorkflow.find((item) => item.gate === gate);
    if (!step) {
      errors.push(`workflow is missing ${gate} decision step`);
    } else if (step.requiredEvidence.length === 0) {
      errors.push(`${gate} decision step must require evidence`);
    }
  }

  for (const field of REQUIRED_EXCEPTION_FIELDS) {
    if (!record.exceptionPolicy.requiredFields.includes(field)) {
      errors.push(`exception policy is missing ${field}`);
    }
  }

  if (record.scopeGuard.approvesCurrentRisk) {
    errors.push("HOBO-483 defines the process only and does not approve current risks");
  }
  if (!record.exceptionPolicy.forbiddenClasses.includes("launch-blocker")) {
    errors.push("launch blockers cannot be waived by exception");
  }
  if (!record.exceptionPolicy.cannotOverrideRequiredGates) {
    errors.push("exceptions cannot override required gates");
  }

  return { ok: errors.length === 0, errors };
}

export function assertGoNoGoDecisionWorkflow(record = goNoGoDecisionWorkflow) {
  const result = validateGoNoGoDecisionWorkflow(record);

  if (!result.ok) {
    throw new Error(`go/no-go decision workflow invalid:\n${result.errors.join("\n")}`);
  }

  return record;
}
