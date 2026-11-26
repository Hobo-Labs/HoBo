import { isJsonObject } from "./json.js";
export const REQUIRED_ACTIVATION_EVENTS = [
  "account-created",
  "workspace-created",
  "project-created",
  "first-plan-created",
  "first-deploy-attempted",
  "first-failure-recovered",
  "first-successful-handoff",
];

export const REQUIRED_PRIVACY_RULES = [
  "purpose-limited-events",
  "pii-and-secret-exclusion",
  "workspace-retention-window",
  "customer-opt-out-and-export",
];

const FORBIDDEN_SCOPE_PATTERNS = [
  /live analytics vendor/i,
  /broad behavioral tracking/i,
  /cross-tenant recommendation memory/i,
];

const FORBIDDEN_CAPTURED_FIELD_PATTERNS = [
  /rawemail/i,
  /^email$/i,
  /secret/i,
  /credential/i,
  /token/i,
  /payment/i,
];

export const WORKSPACE_ACTIVATION_TELEMETRY_CONTRACT = {
  issue: "HOBO-486",
  project: "Workspace & Onboarding UX",
  phase: "M0",
  goal:
    "Define privacy-safe first-run activation telemetry so workspace onboarding can be evaluated without selecting a live analytics vendor or collecting raw customer data.",
  events: [
    {
      id: "account-created",
      ownerProject: "Organization & Workspace Model",
      evidenceMode: "contract-event",
      productQuestion: "Can a user create the account needed to start a workspace?",
      supportOrRecoveryUse: "Support can distinguish identity/account setup failures from later workspace failures.",
      capturedFields: ["eventId", "tenantRef", "actorRole", "occurredAt", "sourceSurface", "consentMode"],
    },
    {
      id: "workspace-created",
      ownerProject: "Workspace & Onboarding UX",
      evidenceMode: "contract-event",
      productQuestion: "Does onboarding get the user into a usable workspace?",
      supportOrRecoveryUse: "Recovery can resume setup from the workspace boundary without replaying account creation.",
      capturedFields: ["eventId", "workspaceRef", "actorRole", "occurredAt", "templateRef", "consentMode"],
    },
    {
      id: "project-created",
      ownerProject: "Settings & Project Lifecycle",
      evidenceMode: "contract-event",
      productQuestion: "Does the first workspace produce a project that can own deploy evidence?",
      supportOrRecoveryUse: "Support can route empty-workspace reports to project setup rather than deployment.",
      capturedFields: ["eventId", "workspaceRef", "projectRef", "actorRole", "occurredAt", "sourceSurface"],
    },
    {
      id: "first-plan-created",
      ownerProject: "Plan/Diff Viewer",
      evidenceMode: "design-record",
      productQuestion: "Can the user produce a first plan/diff before attempting launch?",
      supportOrRecoveryUse: "Recovery can inspect the plan record when deploy fails before infrastructure changes.",
      capturedFields: ["eventId", "workspaceRef", "projectRef", "planRef", "occurredAt", "planOutcome"],
    },
    {
      id: "first-deploy-attempted",
      ownerProject: "Deployment Dashboard & Topology Explorer",
      evidenceMode: "contract-event",
      productQuestion: "Does the first plan reach a deploy attempt with visible status?",
      supportOrRecoveryUse: "Support can separate planning friction from launch/runtime friction.",
      capturedFields: ["eventId", "workspaceRef", "projectRef", "deployRef", "occurredAt", "attemptOutcome"],
    },
    {
      id: "first-failure-recovered",
      ownerProject: "Support & Debug Tools",
      evidenceMode: "support-handoff",
      productQuestion: "Can the user recover from the first blocking failure without abandoning onboarding?",
      supportOrRecoveryUse: "Recovery evidence names the failing step, remediation route, and successful retry boundary.",
      capturedFields: ["eventId", "workspaceRef", "projectRef", "failureClass", "recoveryRoute", "occurredAt"],
    },
    {
      id: "first-successful-handoff",
      ownerProject: "V1 Beta Pilot & Feedback Loop",
      evidenceMode: "handoff-record",
      productQuestion: "Did onboarding hand the user to a stable next action after first value evidence?",
      supportOrRecoveryUse: "Support can identify whether the user reached docs, beta feedback, support, or launch review.",
      capturedFields: ["eventId", "workspaceRef", "projectRef", "handoffTarget", "occurredAt", "reviewWindow"],
    },
  ],
  privacyRules: [
    {
      id: "purpose-limited-events",
      constraint: "Events exist only to answer first-run activation and recovery questions.",
      retention: "Keep event summaries with workspace onboarding evidence through the beta review window.",
      customerChoice: "Customers can see the event classes and product questions in launch documentation.",
      exclusion: "No heatmaps, session replay, raw clickstream, or behavioral profiling.",
    },
    {
      id: "pii-and-secret-exclusion",
      constraint: "Captured fields use tenant, workspace, project, plan, deploy, and event references.",
      retention: "Persist references and classified outcomes, not raw customer text or provider payloads.",
      customerChoice: "Customer-authored names can be redacted or replaced by stable refs in exports.",
      exclusion: "No raw email addresses, secrets, credentials, tokens, payment data, or provider credentials.",
    },
    {
      id: "workspace-retention-window",
      constraint: "Retention follows workspace support, beta feedback, release readiness, and audit handoff windows.",
      retention: "Delete or aggregate activation telemetry after the support/review window unless audit policy retains refs.",
      customerChoice: "Workspace admins can request export or deletion under the privacy/legal readiness policy.",
      exclusion: "No new analytics warehouse or customer-success profile is created.",
    },
    {
      id: "customer-opt-out-and-export",
      constraint: "Opt-out disables non-essential product analytics while preserving mandatory audit/support facts.",
      retention: "Opt-out state is retained with the workspace settings record.",
      customerChoice: "Admins can inspect opt-out state and export activation evidence used for support.",
      exclusion: "Opt-out cannot be bypassed by routing events to an unapproved vendor.",
    },
  ],
  relatedIssues: ["HOBO-409", "HOBO-507", "HOBO-508", "HOBO-509"],
  scopeIn: [
    "Define the M0 workspace activation event catalog.",
    "Map each event to a product question and support or recovery use.",
    "Define privacy constraints, retention, opt-out behavior, and PII exclusions.",
    "Name owner projects and proof modes for later M1 contract work.",
  ],
  scopeOut: [
    "No live analytics vendor selection.",
    "No behavioral tracking platform.",
    "No broad profile, CRM, customer-success lifecycle, or cross-tenant recommendation memory.",
    "No product UI, telemetry pipeline, storage backend, or event ingestion implementation.",
  ],
};

export function validateActivationContract(contract) {
  const errors = [];

  if (!contract || !isJsonObject(contract)) {
    return { ok: false, errors: ["contract is required"] };
  }

  if (contract.issue !== "HOBO-486") {
    errors.push("issue must be HOBO-486");
  }
  if (contract.phase !== "M0") {
    errors.push("phase must be M0");
  }

  const eventIds = (contract.events ?? []).map((event) => event.id);
  if (JSON.stringify(eventIds) !== JSON.stringify(REQUIRED_ACTIVATION_EVENTS)) {
    errors.push("required activation events are incomplete or out of order");
  }

  for (const event of contract.events ?? []) {
    for (const field of ["ownerProject", "evidenceMode", "productQuestion", "supportOrRecoveryUse"]) {
      if (!hasValue(event[field])) {
        errors.push(`${event.id ?? "<missing>"} missing ${field}`);
      }
    }
    for (const capturedField of event.capturedFields ?? []) {
      if (FORBIDDEN_CAPTURED_FIELD_PATTERNS.some((pattern) => pattern.test(capturedField))) {
        errors.push(`${capturedField} is forbidden in activation telemetry`);
      }
    }
  }

  const privacyIds = (contract.privacyRules ?? []).map((rule) => rule.id);
  if (JSON.stringify(privacyIds) !== JSON.stringify(REQUIRED_PRIVACY_RULES)) {
    errors.push("required privacy rules are incomplete or out of order");
  }

  for (const rule of contract.privacyRules ?? []) {
    for (const field of ["constraint", "retention", "customerChoice", "exclusion"]) {
      if (!hasValue(rule[field])) {
        errors.push(`${rule.id ?? "<missing>"} missing ${field}`);
      }
    }
  }

  for (const scopeEntry of contract.scopeIn ?? []) {
    for (const pattern of FORBIDDEN_SCOPE_PATTERNS) {
      if (pattern.test(scopeEntry)) {
        errors.push(`scope-in cannot include ${pattern.source}`);
      }
    }
  }

  for (const requiredScopeOut of ["No live analytics vendor selection.", "No behavioral tracking platform."]) {
    if (!(contract.scopeOut ?? []).includes(requiredScopeOut)) {
      errors.push(`${requiredScopeOut} is required in scopeOut`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateTelemetryClaim(claim, { launchClaim = false } = {}) {
  const errors = [];

  if (!claim || !isJsonObject(claim)) {
    return { ok: false, errors: ["telemetry claim is required"] };
  }

  if (launchClaim) {
    for (const eventId of REQUIRED_ACTIVATION_EVENTS) {
      if (!(claim.events ?? []).includes(eventId)) {
        errors.push(`${eventId} is required for launch activation claims`);
      }
      if (!hasValue(claim.ownerMappings?.[eventId])) {
        errors.push(`${eventId} owner mapping is required`);
      }
    }
    for (const privacyRuleId of REQUIRED_PRIVACY_RULES) {
      if (!(claim.privacyRules ?? []).includes(privacyRuleId)) {
        errors.push(`${privacyRuleId} privacy rule is required`);
      }
    }
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
