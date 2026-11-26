import { isJsonObject } from "./json.js";
const REQUIRED_INTAKE_FIELDS = ["persona", "environment", "workflow", "severity", "evidence", "customerImpact"];
const REQUIRED_TRIAGE_DESTINATIONS = ["cutline", "support", "product-ux", "docs", "capability-project"];
const REQUIRED_RC_PERSONAS = ["app developer", "platform engineer", "support/operator"];
const SCOPE_CREEP_PATTERNS = [
  /onboard(?:ing)?\b.*\bbeta customers?\b/i,
  /general feedback (?:portal|infrastructure|platform)/i,
  /customer onboarding/i
];

export const BETA_PILOT_FEEDBACK_CONTRACT = {
  issue: "HOBO-404",
  project: "V1 Beta Pilot & Feedback Loop",
  phase: "M0",
  goal:
    "Define private beta cohort selection, feedback intake, triage, and release-candidate exit criteria without enrolling customers or building feedback infrastructure in this slice.",
  cohortCriteria: [
    {
      id: "target-persona-fit",
      owner: "beta program owner",
      evidence: "Pilot maps to one of the v1 launch personas and names the primary workflow under test."
    },
    {
      id: "workflow-readiness",
      owner: "workflow owner",
      evidence: "The workflow has fixture, environment, and expected evidence prerequisites before pilot exposure."
    },
    {
      id: "support-capacity",
      owner: "support lead",
      evidence: "First responder, escalation owner, and support window are available before pilot admission."
    },
    {
      id: "feedback-consent",
      owner: "beta program owner",
      evidence: "Pilot contact consents to structured feedback capture and customer-impact classification."
    },
    {
      id: "exclusion-rules",
      owner: "release owner",
      evidence: "Excluded pilots include unsupported regions, regulated data without approval, and workflows lacking rollback or support evidence."
    }
  ],
  intake: {
    requiredFields: REQUIRED_INTAKE_FIELDS,
    severityValues: ["blocker", "high-risk-non-blocker", "support-request", "usability", "docs-gap", "capability-gap", "launch-note"],
    evidenceTypes: ["screen recording", "command transcript", "trace id", "log excerpt", "support note", "customer quote"]
  },
  triageRoutes: [
    {
      destination: "cutline",
      when: "go/no-go risk, open blocker, exception request, or launch readiness decision",
      ownerProject: "V1 Release Program & Cutline"
    },
    {
      destination: "support",
      when: "support path, escalation, severity communication, or first-week coverage gap",
      ownerProject: "V1 Launch Support Desk & Escalation"
    },
    {
      destination: "product-ux",
      when: "onboarding, dashboard, plan/diff, or activation usability problem",
      ownerProject: "Workspace & Onboarding UX"
    },
    {
      destination: "docs",
      when: "release note, upgrade guide, known limitation, or troubleshooting gap",
      ownerProject: "V1 Release Notes & Upgrade Guide"
    },
    {
      destination: "capability-project",
      when: "provider, runtime, identity, billing, marketplace, or other capability gap",
      ownerProject: "Owning capability project"
    }
  ],
  exitCriteria: [
    {
      id: "no-open-blockers",
      requirement: "No unresolved blocker-severity beta feedback remains open."
    },
    {
      id: "representative-persona-coverage",
      requirement: "App developer, platform engineer, and support/operator workflows have evidence or accepted limitations."
    },
    {
      id: "evidence-completeness",
      requirement: "Required feedback evidence is attached or the gap is explicitly accepted as a limitation."
    },
    {
      id: "high-risk-acceptance",
      requirement: "Every unresolved high-risk non-blocker has an owner-approved launch note or exception."
    }
  ],
  scopeIn: [
    "Define beta cohort criteria, exclusion rules, and readiness prerequisites.",
    "Define a feedback intake shape with persona, environment, workflow, severity, evidence, and customer impact.",
    "Define route rules for cutline, support, product UX, docs, and capability-project owners.",
    "Define release-candidate exit criteria from beta evidence."
  ],
  scopeOut: [
    "Do not onboard beta customers in this issue.",
    "Do not create general product feedback infrastructure beyond the v1 intake contract.",
    "Do not promise support response SLAs or launch dates.",
    "Do not resolve blockers surfaced by beta feedback."
  ],
  dependencies: [
    {
      source: "docs/design/beta-pilot-feedback.md",
      reason: "Durable beta program scope and intake record."
    },
    {
      source: "docs/design/developer-experience.md#plan-07",
      reason: "Owns user-facing workspace, dashboard, plan, release-note, and support-facing DX surfaces."
    },
    {
      source: "docs/design/walkthrough.md",
      reason: "Defines role workflows that beta feedback must identify and classify."
    },
    {
      source: "docs/design/reliability-observability-cost.md#plan-05",
      reason: "Defines telemetry and operational evidence used by beta triage."
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0082",
      reason: "Keeps launch evidence tied to reproducible verification instead of unsupported claims."
    }
  ]
};

export function validateBetaPilotFeedbackContract(contract) {
  const errors = [];

  if (!contract || !isJsonObject(contract)) {
    return { ok: false, errors: ["contract is required"] };
  }
  if (contract.issue !== "HOBO-404") {
    errors.push("issue must be HOBO-404");
  }
  if (contract.phase !== "M0") {
    errors.push("phase must be M0");
  }

  for (const collection of ["cohortCriteria", "triageRoutes", "exitCriteria", "scopeIn", "scopeOut"]) {
    if (!Array.isArray(contract[collection]) || contract[collection].length === 0) {
      errors.push(`${collection} must be a non-empty list`);
    }
  }

  if (!arraysEqual(contract.intake?.requiredFields, REQUIRED_INTAKE_FIELDS)) {
    errors.push(`intake must require ${REQUIRED_INTAKE_FIELDS.join(", ")}`);
  }

  for (const criterion of contract.cohortCriteria ?? []) {
    if (!criterion.id || !criterion.owner || !criterion.evidence) {
      errors.push(`cohort criterion ${criterion.id ?? "<missing>"} must name id, owner, and evidence`);
    }
  }

  const destinations = (contract.triageRoutes ?? []).map((route) => route.destination);
  if (!arraysEqual(destinations, REQUIRED_TRIAGE_DESTINATIONS)) {
    errors.push(`triage routes must be ${REQUIRED_TRIAGE_DESTINATIONS.join(", ")}`);
  }
  for (const route of contract.triageRoutes ?? []) {
    if (!route.when || !route.ownerProject) {
      errors.push(`triage route ${route.destination ?? "<missing>"} must name condition and ownerProject`);
    }
  }

  for (const criterion of contract.exitCriteria ?? []) {
    if (!criterion.id || !criterion.requirement) {
      errors.push(`exit criterion ${criterion.id ?? "<missing>"} must name id and requirement`);
    }
  }

  for (const item of contract.scopeIn ?? []) {
    if (SCOPE_CREEP_PATTERNS.some((pattern) => pattern.test(item))) {
      errors.push(`scope creep: ${item}`);
    }
  }

  if ((contract.dependencies ?? []).length < 5) {
    errors.push("dependencies must include beta record, DX, walkthrough, reliability evidence, and verification ADR");
  }

  return { ok: errors.length === 0, errors };
}

export function validateFeedbackIntake(feedback, contract = BETA_PILOT_FEEDBACK_CONTRACT) {
  const errors = [];
  const requiredFields = contract.intake?.requiredFields ?? REQUIRED_INTAKE_FIELDS;

  for (const field of requiredFields) {
    if (feedback?.[field] === undefined || feedback?.[field] === null || feedback?.[field] === "") {
      errors.push(`${field} is required`);
    }
  }
  if (feedback?.evidence !== undefined && (!Array.isArray(feedback.evidence) || feedback.evidence.length === 0)) {
    errors.push("evidence must be a non-empty list");
  }
  if (
    feedback?.severity &&
    Array.isArray(contract.intake?.severityValues) &&
    !contract.intake.severityValues.includes(feedback.severity)
  ) {
    errors.push(`unknown severity: ${feedback.severity}`);
  }

  return { ok: errors.length === 0, errors };
}

export function classifyFeedback(feedback) {
  const severity = feedback?.severity ?? "";
  const workflow = feedback?.workflow ?? "";

  if (severity === "blocker" || /go\/no-go|release|exception/i.test(workflow)) {
    return "cutline";
  }
  if (severity === "support-request" || /install|support|escalation/i.test(workflow)) {
    return "support";
  }
  if (severity === "usability" || /onboarding|workspace|dashboard|plan/i.test(workflow)) {
    return "product-ux";
  }
  if (severity === "docs-gap" || /upgrade|release note|known limitation|troubleshoot/i.test(workflow)) {
    return "docs";
  }
  if (severity === "capability-gap" || /provider|runtime|identity|billing|marketplace/i.test(workflow)) {
    return "capability-project";
  }

  return "cutline";
}

export function canGraduateToReleaseCandidate(candidate) {
  const covered = new Set(candidate?.targetPersonasCovered ?? []);

  return (
    candidate?.openBlockers === 0 &&
    REQUIRED_RC_PERSONAS.every((persona) => covered.has(persona)) &&
    candidate?.requiredEvidenceComplete === true &&
    candidate?.unresolvedHighRiskAccepted === true
  );
}

function arraysEqual(left, right) {
  return Array.isArray(left) && left.length === right.length && left.every((value, index) => value === right[index]);
}
