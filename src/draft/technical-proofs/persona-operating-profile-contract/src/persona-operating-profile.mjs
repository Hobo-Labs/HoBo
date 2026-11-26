import { isJsonObject } from "./json.js";
export const REQUIRED_PROFILE_FIELDS = [
  "industry",
  "team-type",
  "approved-systems",
  "blocked-systems",
  "risk-posture",
  "approval-owner",
  "cost-cap",
  "safe-test-depth",
  "existing-workflows",
  "primary-outcomes",
  "do-not-do-boundaries",
];

export const REQUIRED_RECOMMENDATION_USES = [
  "recommendation-ranking",
  "safe-test-defaults",
  "permission-explanations",
  "cost-control-defaults",
  "client-report-context",
];

export const REQUIRED_RIGHTS = [
  "purpose-and-minimization",
  "retention-window",
  "edit-delete",
  "export-redaction",
  "tenant-boundary",
];

const FORBIDDEN_SCOPE_PATTERNS = [
  /ML personalization platform/i,
  /broad behavioral tracking/i,
  /cross-tenant recommendation memory/i,
  /CRM/i,
];

const FORBIDDEN_MEMORY_SCOPES = [/cross-tenant/i, /global/i, /behavioral/i];

export const PERSONA_OPERATING_PROFILE_CONTRACT = {
  issue: "HOBO-507",
  project: "Workspace & Onboarding UX",
  phase: "M0",
  sourceIssue: "QUI-91",
  goal:
    "Define a compact v1 operating profile that improves recommendations and first-run defaults without creating a broad profile system or cross-tenant memory.",
  personas: ["Marcus", "Sarah", "Priya", "Elena", "Morgan"],
  fields: [
    field("industry", ["Marcus", "Priya"], "Select launch-safe examples for the user's domain.", "Choose comparable safe-test packs.", "Require review for regulated industries.", "Applies industry-sensitive cost caps.", "workspace.profile.industry", "activation.profile.industry"),
    field("team-type", ["Marcus", "Sarah"], "Tune onboarding to solo, startup, agency, or enterprise context.", "Pick team-size appropriate fixtures.", "Routes approvals to admin or platform owner.", "Sets default budget tolerance band.", "workspace.profile.teamType", "activation.profile.teamType"),
    field("approved-systems", ["Sarah", "Morgan"], "Preselect known allowed integrations.", "Prefer safe tests that use approved systems.", "Defaults disallowed integrations to needs-approval.", "Avoids cost estimates for unapproved systems.", "workspace.profile.approvedSystems", "activation.profile.approvedSystems"),
    field("blocked-systems", ["Morgan", "Elena"], "Suppress blocked integrations from recommendations.", "Reject unsafe fixture defaults.", "Marks blocked systems as deny-by-default.", "Prevents spend suggestions tied to blocked systems.", "workspace.profile.blockedSystems", "activation.profile.blockedSystems"),
    field("risk-posture", ["Morgan", "Sarah"], "Choose conservative, standard, or exploratory defaults.", "Sets safe-test depth before launch claims.", "Sets approval strictness.", "Sets cost and rollback guard sensitivity.", "workspace.profile.riskPosture", "activation.profile.riskPosture"),
    field("approval-owner", ["Sarah", "Morgan"], "Names who must approve risky recommendations.", "Includes approval actor in test evidence.", "Defines default approver route.", "Routes budget exception review.", "workspace.profile.approvalOwnerRef", "activation.profile.approvalOwner"),
    field("cost-cap", ["Marcus", "Sarah", "Priya"], "Ranks options that fit budget tolerance first.", "Limits fixture cost envelope.", "Requires approval above cap.", "Defines default launch cost guard.", "workspace.profile.costCap", "activation.profile.costCap"),
    field("safe-test-depth", ["Marcus", "Elena"], "Chooses smoke, simulated, or provider-backed proof defaults.", "Directly selects safe-test pack depth.", "Requires approval when requested depth exceeds posture.", "Keeps tests inside approved spend.", "workspace.profile.safeTestDepth", "activation.profile.safeTestDepth"),
    field("existing-workflows", ["Priya", "Elena"], "Explains recommendations against current manual or automated work.", "Selects fixtures that mirror the workflow.", "Flags workflow changes needing review.", "Separates migration cost from net-new cost.", "workspace.profile.existingWorkflows", "activation.profile.existingWorkflows"),
    field("primary-outcomes", ["Marcus", "Priya"], "Ranks by desired business outcome.", "Chooses outcome-specific safe tests.", "Adds outcome owner when needed.", "Aligns cost caps to outcome value.", "workspace.profile.primaryOutcomes", "activation.profile.primaryOutcomes"),
    field("do-not-do-boundaries", ["Morgan", "Sarah", "Priya"], "Filters recommendations that violate explicit boundaries.", "Rejects test packs that cross stated boundaries.", "Turns boundary conflicts into approval blockers.", "Blocks spend on forbidden paths.", "workspace.profile.doNotDoBoundaries", "activation.profile.doNotDoBoundaries"),
  ],
  recommendationUses: [
    {
      id: "recommendation-ranking",
      definition: "Rank supported options by profile fit and explain which profile fields affected ordering.",
    },
    {
      id: "safe-test-defaults",
      definition: "Select safe-test pack depth and fixture family before public or deployment claims.",
    },
    {
      id: "permission-explanations",
      definition: "Explain requested permissions with approved systems, blocked systems, and risk posture.",
    },
    {
      id: "cost-control-defaults",
      definition: "Set launch cost guard defaults and budget exception routes from profile fields.",
    },
    {
      id: "client-report-context",
      definition: "Give Priya-style client workspaces cloneable context without sharing memory across tenants.",
    },
  ],
  recommendationMemory: {
    scope: "tenant-workspace",
    v1Definition:
      "Recommendation memory is explicit workspace/client profile data plus recommendation decisions derived from it, retained only inside the tenant workspace.",
    postV1Excluded:
      "Adaptive ranking models, behavioral personalization, and cross-tenant recommendation memory remain post-v1.",
  },
  privacyRights: [
    {
      id: "purpose-and-minimization",
      policy: "Collect only fields that influence recommendations, safe-test defaults, approvals, cost caps, settings, or first-run telemetry.",
      owner: "Workspace & Onboarding UX / V1 Legal, Privacy & Terms Readiness",
      customerVisible: "Profile purpose is visible during workspace setup.",
    },
    {
      id: "retention-window",
      policy: "Retain profile records with workspace settings and beta support evidence, then aggregate or delete according to privacy policy.",
      owner: "Workspace & Onboarding UX / Provenance & Retention",
      customerVisible: "Retention posture is documented in launch limitations.",
    },
    {
      id: "edit-delete",
      policy: "Workspace admins can edit or delete profile fields without deleting required audit/support facts.",
      owner: "Settings & Project Lifecycle / Support Workflow",
      customerVisible: "Edit and delete controls are part of the profile contract.",
    },
    {
      id: "export-redaction",
      policy: "Exports redact sensitive approved/blocked systems unless an authorized admin explicitly includes them.",
      owner: "V1 Legal, Privacy & Terms Readiness / Support Workflow",
      customerVisible: "Export scope and redaction behavior are explicit.",
    },
    {
      id: "tenant-boundary",
      policy: "Profile memory never crosses tenant or client-workspace boundaries by default.",
      owner: "Tenant Isolation & Quotas / Organization & Workspace Model",
      customerVisible: "Tenant boundary is a launch-safe guarantee, not a personalization option.",
    },
  ],
  postV1Boundaries: [
    "ML personalization platform.",
    "Broad behavioral tracking or session replay.",
    "Cross-tenant recommendation memory.",
    "Full CRM or customer-success lifecycle profile.",
  ],
  relatedIssues: ["QUI-91", "HOBO-409", "HOBO-486", "HOBO-415"],
  scopeIn: [
    "Define minimal v1 operating profile fields.",
    "Map profile fields to personas, onboarding defaults, safe-test packs, approval defaults, cost caps, workspace settings, and first-run telemetry.",
    "Define privacy, retention, edit/delete, export, and tenant-boundary implications.",
    "Define v1 recommendation memory and post-v1 boundaries.",
    "Preserve QUI-91 as source evidence without copying its full implementation backlog.",
  ],
  scopeOut: [
    "No ML personalization platform.",
    "No broad behavioral tracking.",
    "No cross-tenant recommendation memory.",
    "No broad CRM or customer-success profile system.",
    "No product UI implementation.",
  ],
};

export function validateOperatingProfileContract(contract) {
  const errors = [];

  if (!contract || !isJsonObject(contract)) {
    return { ok: false, errors: ["contract is required"] };
  }

  if (contract.issue !== "HOBO-507") {
    errors.push("issue must be HOBO-507");
  }
  if (contract.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (contract.sourceIssue !== "QUI-91") {
    errors.push("QUI-91 evidence source is required");
  }

  assertOrderedIds(errors, contract.fields, REQUIRED_PROFILE_FIELDS, "required profile fields");
  assertOrderedIds(errors, contract.recommendationUses, REQUIRED_RECOMMENDATION_USES, "required recommendation uses");
  assertOrderedIds(errors, contract.privacyRights, REQUIRED_RIGHTS, "required privacy rights");

  for (const fieldDef of contract.fields ?? []) {
    for (const key of [
      "personas",
      "onboardingDefault",
      "safeTestUse",
      "approvalDefault",
      "costCapUse",
      "workspaceSetting",
      "telemetryUse",
    ]) {
      if (!hasValue(fieldDef[key])) {
        errors.push(`${fieldDef.id ?? "<missing>"} missing ${key}`);
      }
    }
  }

  for (const right of contract.privacyRights ?? []) {
    for (const key of ["policy", "owner", "customerVisible"]) {
      if (!hasValue(right[key])) {
        errors.push(`${right.id ?? "<missing>"} missing ${key}`);
      }
    }
  }

  for (const pattern of FORBIDDEN_MEMORY_SCOPES) {
    if (pattern.test(contract.recommendationMemory?.scope ?? "")) {
      errors.push("cross-tenant recommendation memory is forbidden");
    }
  }

  for (const entry of contract.scopeIn ?? []) {
    for (const pattern of FORBIDDEN_SCOPE_PATTERNS) {
      if (pattern.test(entry)) {
        errors.push(`scope-in cannot include ${pattern.source}`);
      }
    }
  }

  for (const requiredScopeOut of [
    "No ML personalization platform.",
    "No broad behavioral tracking.",
    "No cross-tenant recommendation memory.",
  ]) {
    if (!(contract.scopeOut ?? []).includes(requiredScopeOut)) {
      errors.push(`${requiredScopeOut} is required in scopeOut`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateRecommendationMemoryClaim(claim) {
  const errors = [];

  if (!claim || !isJsonObject(claim)) {
    return { ok: false, errors: ["recommendation memory claim is required"] };
  }

  if (claim.sourceIssue !== "QUI-91") {
    errors.push("QUI-91 evidence source is required");
  }
  for (const requiredUse of REQUIRED_RECOMMENDATION_USES) {
    if (!(claim.uses ?? []).includes(requiredUse)) {
      errors.push(`${requiredUse} is required`);
    }
  }
  if (claim.memoryScope !== "tenant-workspace") {
    errors.push("tenant-workspace memory scope is required");
  }
  if (claim.evidenceMode !== "contract-record") {
    errors.push("contract-record evidence mode is required");
  }

  return { ok: errors.length === 0, errors };
}

function field(
  id,
  personas,
  onboardingDefault,
  safeTestUse,
  approvalDefault,
  costCapUse,
  workspaceSetting,
  telemetryUse,
) {
  return {
    id,
    personas,
    onboardingDefault,
    safeTestUse,
    approvalDefault,
    costCapUse,
    workspaceSetting,
    telemetryUse,
  };
}

function assertOrderedIds(errors, entries, requiredIds, label) {
  const ids = (entries ?? []).map((entry) => entry.id);
  if (JSON.stringify(ids) !== JSON.stringify(requiredIds)) {
    errors.push(`${label} are incomplete or out of order`);
  }
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
