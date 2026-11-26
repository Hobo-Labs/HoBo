import { isJsonObject } from "./json.js";
export const MINIMAL_OUTCOME_FIELDS = [
  "intendedBusinessOutcome",
  "successSignal",
  "owner",
  "costCap",
  "approvalRule",
  "failureRule",
  "rollbackExpectation",
  "reviewDate",
];

export const REQUIRED_SURFACES = [
  "plan-diff",
  "launch-go-no-go",
  "telemetry",
  "beta-feedback",
  "support-handoff",
  "release-notes-known-limitations",
];

const FORBIDDEN_SCOPE_PATTERNS = [
  /analytics warehouse/i,
  /automated roi/i,
  /customer success lifecycle/i,
];

export const PRE_LAUNCH_OUTCOME_CONTRACT = {
  issue: "HOBO-509",
  project: "Plan/Diff Viewer",
  phase: "M0",
  goal:
    "Capture a pre-launch business outcome baseline before v1 deploys so safe tests, plan review, launch decisions, monitoring, support, and value follow-up compare against the user's stated success basis.",
  fields: [
    {
      id: "intendedBusinessOutcome",
      label: "Intended business outcome",
      owner: "launch requester",
      requiredForGovernedLaunch: true,
      customerVisible: true,
    },
    {
      id: "successSignal",
      label: "Success signal or metric",
      owner: "launch requester",
      requiredForGovernedLaunch: true,
      customerVisible: true,
    },
    {
      id: "owner",
      label: "Approval and review owner",
      owner: "workspace admin",
      requiredForGovernedLaunch: true,
      customerVisible: true,
    },
    {
      id: "costCap",
      label: "Cost cap",
      owner: "workspace admin",
      requiredForGovernedLaunch: true,
      customerVisible: true,
    },
    {
      id: "approvalRule",
      label: "Approval rule",
      owner: "workspace admin",
      requiredForGovernedLaunch: true,
      customerVisible: true,
    },
    {
      id: "failureRule",
      label: "Failure, pause, or escalation rule",
      owner: "support owner",
      requiredForGovernedLaunch: true,
      customerVisible: true,
    },
    {
      id: "rollbackExpectation",
      label: "Rollback expectation",
      owner: "support owner",
      requiredForGovernedLaunch: true,
      customerVisible: true,
    },
    {
      id: "reviewDate",
      label: "Review date",
      owner: "launch requester",
      requiredForGovernedLaunch: true,
      customerVisible: true,
    },
  ],
  surfaces: [
    {
      id: "plan-diff",
      ownerProject: "Plan/Diff Viewer",
      fieldsUsed: MINIMAL_OUTCOME_FIELDS,
      evidenceUse: "Shows the baseline next to resource, cost, policy, and rollback diff before approval.",
    },
    {
      id: "launch-go-no-go",
      ownerProject: "V1 Release Program & Cutline",
      fieldsUsed: MINIMAL_OUTCOME_FIELDS,
      evidenceUse: "Blocks launch when governed owner, cost, access, or control evidence is missing.",
    },
    {
      id: "telemetry",
      ownerProject: "Workspace & Onboarding UX",
      fieldsUsed: MINIMAL_OUTCOME_FIELDS,
      evidenceUse: "Names the privacy-safe signals that can be compared against the baseline after launch.",
    },
    {
      id: "beta-feedback",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      fieldsUsed: MINIMAL_OUTCOME_FIELDS,
      evidenceUse: "Routes beta feedback against the stated outcome, owner, failure rule, and review date.",
    },
    {
      id: "support-handoff",
      ownerProject: "V1 Launch Support Desk & Escalation",
      fieldsUsed: MINIMAL_OUTCOME_FIELDS,
      evidenceUse: "Gives support the customer-visible success, cost, pause, failure, and rollback basis.",
    },
    {
      id: "release-notes-known-limitations",
      ownerProject: "V1 Release Notes & Upgrade Guide",
      fieldsUsed: MINIMAL_OUTCOME_FIELDS,
      evidenceUse: "Turns unsupported outcome, evidence, cost, or rollback claims into known limitations.",
    },
  ],
  evidenceRequirements: [
    {
      id: "safe-test-sample-cases",
      ownerProject: "E2E Test Matrix",
      proofMode: "reference-fixture",
      comparesAgainstBaseline: "successSignal",
      requiredBeforeLaunchClaim: true,
    },
    {
      id: "safe-test-result-pack",
      ownerProject: "E2E Test Matrix",
      proofMode: "contract-test",
      comparesAgainstBaseline: "intendedBusinessOutcome",
      requiredBeforeLaunchClaim: true,
    },
    {
      id: "plan-diff-baseline",
      ownerProject: "Plan/Diff Viewer",
      proofMode: "design-record",
      comparesAgainstBaseline: "costCap",
      requiredBeforeLaunchClaim: true,
    },
    {
      id: "post-launch-comparison-window",
      ownerProject: "Workspace & Onboarding UX",
      proofMode: "telemetry-contract",
      comparesAgainstBaseline: "reviewDate",
      requiredBeforeLaunchClaim: false,
    },
    {
      id: "support-review-export",
      ownerProject: "V1 Launch Support Desk & Escalation",
      proofMode: "support-handoff",
      comparesAgainstBaseline: "failureRule",
      requiredBeforeLaunchClaim: false,
    },
  ],
  privacyRetentionRules: [
    {
      id: "customer-visible-baseline",
      customerVisibility: "Outcome, success signal, owner, cost cap, approval rule, failure rule, rollback expectation, and review date are visible to the deploying customer.",
      retention: "Stored with the deployment record through the review window and release-support retention period.",
      exclusion: "Does not expose internal policy notes or support-only redactions.",
    },
    {
      id: "pii-and-secret-exclusion",
      customerVisibility: "Baseline text may be customer-authored but must not require PII, secrets, credentials, or raw provider data.",
      retention: "Only redacted references or fixture ids persist in telemetry and support exports.",
      exclusion: "PII, secret values, provider credentials, and raw customer records are excluded.",
    },
    {
      id: "retention-by-deployment",
      customerVisibility: "The customer can inspect the active deployment baseline and review date.",
      retention: "Retention follows deployment, audit, release-note, and support handoff policies rather than a new analytics store.",
      exclusion: "No separate warehouse or broad customer-success profile is created in this issue.",
    },
    {
      id: "support-redaction-boundary",
      customerVisibility: "Support sees the customer-readable baseline plus redacted evidence links.",
      retention: "Support exports keep enough evidence to explain launch, pause, and rollback decisions.",
      exclusion: "Support notes cannot promote simulated or safe-test evidence into live-provider success claims.",
    },
  ],
  sourceEvidence: [
    {
      id: "QUI-92",
      sourceType: "Linear issue",
      citation: "https://linear.app/quickdeploy-ai/issue/QUI-92/competitive-extension-pre-launch-outcome-contract-and-value-baseline",
      preservedAs: "source evidence for the HoBo v1 launch contract",
    },
    {
      id: "competitive-persona-gap-synthesis-2026-06-11",
      sourceType: "Linear document",
      citation: "https://linear.app/quickdeploy-ai/document/competitive-persona-gap-synthesis-2026-06-11-cad78262d922",
      preservedAs: "competitive gap that value proof starts too late",
    },
    {
      id: "quickdeployai-customer-personas",
      sourceType: "Google Doc",
      citation: "https://docs.google.com/document/d/1bHtC_Nwkb5VslTocFTbDmqVOmV4W6YBd6PyVU3KfS9k",
      preservedAs: "persona rule for outcome, testing, monitoring, and control questions",
    },
  ],
  scopeIn: [
    "Define the M0 outcome contract fields and where each field is consumed.",
    "Define safe-test fixture and post-launch comparison evidence requirements.",
    "Define privacy, retention, and customer-visible boundaries.",
    "Preserve QUI-92 and the competitive synthesis as source evidence.",
  ],
  scopeOut: [
    "No analytics warehouse.",
    "No automated ROI model.",
    "No full customer success lifecycle.",
    "No live provider-success claim without provider-backed evidence.",
  ],
  followUpBoundary: {
    implementsThirtyDayValueLoop: false,
    implementsAutomatedRoiModel: false,
    implementsAnalyticsWarehouse: false,
    preservesQui92AsSourceEvidence: true,
  },
};

export function validateOutcomeContractDefinition(contract) {
  const errors = [];

  if (!contract || !isJsonObject(contract)) {
    return { ok: false, errors: ["contract is required"] };
  }

  if (contract.issue !== "HOBO-509") {
    errors.push("issue must be HOBO-509");
  }
  if (contract.phase !== "M0") {
    errors.push("phase must be M0");
  }

  const fieldIds = (contract.fields ?? []).map((field) => field.id);
  if (JSON.stringify(fieldIds) !== JSON.stringify(MINIMAL_OUTCOME_FIELDS)) {
    errors.push("minimal outcome fields are incomplete or out of order");
  }
  for (const field of contract.fields ?? []) {
    if (!field.owner || !field.label) {
      errors.push(`${field.id ?? "<missing>"} must name owner and label`);
    }
  }

  const surfaceIds = (contract.surfaces ?? []).map((surface) => surface.id);
  if (JSON.stringify(surfaceIds) !== JSON.stringify(REQUIRED_SURFACES)) {
    errors.push("required launch surfaces are incomplete or out of order");
  }
  for (const surface of contract.surfaces ?? []) {
    if (!surface.ownerProject || !surface.evidenceUse) {
      errors.push(`${surface.id ?? "<missing>"} must name ownerProject and evidenceUse`);
    }
    if (JSON.stringify(surface.fieldsUsed ?? []) !== JSON.stringify(MINIMAL_OUTCOME_FIELDS)) {
      errors.push(`${surface.id ?? "<missing>"} must map every minimal outcome field`);
    }
  }

  if ((contract.evidenceRequirements ?? []).length < 5) {
    errors.push("safe-test and post-launch comparison evidence requirements are incomplete");
  }
  for (const evidence of contract.evidenceRequirements ?? []) {
    if (!evidence.proofMode || !evidence.comparesAgainstBaseline) {
      errors.push(`${evidence.id ?? "<missing>"} must name proof mode and baseline comparison`);
    }
  }

  for (const rule of contract.privacyRetentionRules ?? []) {
    if (!rule.customerVisibility || !rule.retention || !rule.exclusion) {
      errors.push(`${rule.id ?? "<missing>"} must define customer visibility, retention, and exclusion`);
    }
  }
  if ((contract.privacyRetentionRules ?? []).length < 4) {
    errors.push("privacy and retention rules are incomplete");
  }

  const sourceIds = (contract.sourceEvidence ?? []).map((source) => source.id);
  for (const requiredSource of ["QUI-92", "competitive-persona-gap-synthesis-2026-06-11", "quickdeployai-customer-personas"]) {
    if (!sourceIds.includes(requiredSource)) {
      errors.push(`${requiredSource} source evidence must be preserved`);
    }
  }

  for (const entry of [...(contract.scopeIn ?? []), ...(contract.scopeOut ?? [])]) {
    if (FORBIDDEN_SCOPE_PATTERNS.some((pattern) => pattern.test(entry)) && (contract.scopeIn ?? []).includes(entry)) {
      errors.push(`scope creep: ${entry}`);
    }
  }

  if (contract.followUpBoundary?.implementsThirtyDayValueLoop) {
    errors.push("30-day value loop implementation is out of scope for HOBO-509");
  }
  if (contract.followUpBoundary?.implementsAutomatedRoiModel) {
    errors.push("automated ROI model is out of scope for HOBO-509");
  }
  if (contract.followUpBoundary?.implementsAnalyticsWarehouse) {
    errors.push("analytics warehouse is out of scope for HOBO-509");
  }

  return { ok: errors.length === 0, errors };
}

export function validateLaunchReadiness(contract, { governedCapability = false } = {}) {
  const errors = [];

  for (const field of MINIMAL_OUTCOME_FIELDS) {
    if (!hasValue(contract?.[field])) {
      errors.push(`${field} is required`);
    }
  }

  if (governedCapability) {
    if (!hasAccessConfirmation(contract?.accessConfirmation)) {
      errors.push("accessConfirmation is required for governed launches");
    }
    if (!hasControlConfirmation(contract?.controlConfirmation)) {
      errors.push("controlConfirmation is required for governed launches");
    }
  }

  if (contract?.launchEvidence?.claimedLiveProviderSuccess && !contract.launchEvidence.providerBacked) {
    errors.push("live provider success requires provider-backed evidence");
  }

  return { ok: errors.length === 0, errors };
}

function hasValue(value) {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value && isJsonObject(value)) {
    return Object.keys(value).length > 0;
  }
  return value !== undefined && value !== null && value !== "";
}

function hasAccessConfirmation(value) {
  return (
    hasValue(value?.confirmedBy) &&
    Array.isArray(value?.systems) &&
    value.systems.length > 0 &&
    Array.isArray(value?.dataClasses) &&
    value.dataClasses.length > 0
  );
}

function hasControlConfirmation(value) {
  return Boolean(value?.pause && value?.disable && value?.rollback && hasValue(value.confirmedBy));
}
