import { isJsonObject } from "./json.js";
export type CustomerOnboardingPhase = "M0" | "M1" | "M2" | "M3" | "M4";

type ClaimAudience = "internal" | "customer-facing" | "release-notes" | "support-handoff";

const IMPLEMENTATION_PHASES = new Set<CustomerOnboardingPhase>(["M1", "M2", "M3", "M4"]);

export const REQUIRED_OPERATING_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

export const REQUIRED_M1_EVIDENCE = Object.freeze([
  "scope-record",
  "pilot-script-fixture",
  "success-criteria-register",
  "persona-profile-fixture",
  "safe-test-handoff",
  "support-feedback-router",
]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "customer-success system",
    pattern:
      /\b(implement|build|ship|launch|wire|run|create)\b.{0,80}\b(crm|customer-success automation|customer success system|salesforce|hubspot|success workflow)\b/i,
  },
  {
    label: "live customer data",
    pattern:
      /\b(live customer data|production tenant records|real customer records|customer pii|raw customer account data|production workspace data)\b/i,
  },
  {
    label: "marketing or sales",
    pattern:
      /\b(launch marketing pages|sales enablement|sales deck|marketing automation|public launch campaign|final launch copy)\b/i,
  },
  {
    label: "live deploy claim",
    pattern:
      /\b(customer-ready live deploy|production launch claim|real provider success claim|guaranteed go-live)\b/i,
  },
]);

const FORBIDDEN_EXTERNAL_CLAIM_PATTERNS = Object.freeze([
  {
    label: "production launch claim",
    pattern: /\b(customer-ready live deploy|production launch claim|guaranteed go-live|ready for production customers)\b/i,
  },
  {
    label: "marketing or sales claim",
    pattern: /\b(final launch copy|public launch campaign|sales enablement|launch marketing pages)\b/i,
  },
]);

export const CUSTOMER_ONBOARDING_SCOPE = {
  schema: "hobo.customer-onboarding-scope/v1",
  issue: "HOBO-449",
  project: "Customer Onboarding",
  phase: "M0" as const,
  goal:
    "Define Customer Onboarding M0 scope so pilot customer entry, first-run success criteria, support handoffs, and follow-up proof requirements are accepted before customer onboarding design or implementation issues fan out.",
  sourceRefs: [
    "Linear HOBO-449 issue body",
    "docs/design/customer-onboarding.md",
    "docs/design/workspace-onboarding-ux.md",
    "docs/design/persona-operating-profile.md",
    "docs/design/pre-launch-outcome-contract.md",
    "docs/design/beta-pilot-feedback.md",
    "docs/design/support-sla-channels.md",
  ],
  personas: [
    {
      id: "pilot-customer-admin",
      need: "Needs a clear onboarding checklist that names prerequisites, accepted limitations, and who can approve first customer use.",
    },
    {
      id: "first-time-app-developer",
      need: "Needs a scripted path from workspace entry to safe-test or first deploy evidence without hidden platform setup.",
    },
    {
      id: "customer-success-lead",
      need: "Needs success criteria, outcome evidence, feedback routing, and handoff owners without implementing a CRM system.",
    },
    {
      id: "support-operator",
      need: "Needs stalled-state, next-action, owner, and evidence fields to route customer onboarding failures safely.",
    },
    {
      id: "security-reviewer",
      need: "Needs customer-data, consent, redaction, and unsupported-state boundaries before pilot evidence is shared.",
    },
  ],
  scopeIn: [
    "Name the user/business goal and primary personas for Customer Onboarding.",
    "Define the accepted customer onboarding stage model from pilot qualification through workspace entry, outcome baseline, safe-test proof, first deploy readiness, support handoff, and feedback intake.",
    "Map service, UX, security, and support boundaries without implementing live onboarding systems.",
    "Map owning initiative dependencies for Workspace & Onboarding UX, Persona Operating Profile, Pre-Launch Outcome Contract, Beta Pilot Feedback, Launch Support Desk, and Release Cutline.",
    "List M1 evidence required before customer onboarding scripts, design records, support fixtures, or contract proof issues can fan out.",
    "Record the follow-up gate that blocks M1/M2/M3/M4 customer-onboarding work until this M0 scope is accepted.",
  ],
  scopeOut: [
    "No CRM, customer-success automation, sales workflow, marketing page, launch-site copy, or sales enablement implementation.",
    "No live customer data import, production tenant mutation, customer PII collection, or customer account storage.",
    "No dashboard, workspace onboarding UI, auth, billing, support-ticketing, telemetry pipeline, or notification implementation.",
    "No live provider deployment, production launch claim, or customer-ready go-live claim without accepted safe-test and provider evidence.",
    "No M1-M4 follow-up issues before this M0 scope record is accepted.",
  ],
  nonGoals: [
    "Approve a first customer for production launch.",
    "Replace Workspace & Onboarding UX, Beta Pilot Feedback, support SLA, or release cutline ownership.",
    "Implement customer-success operations, CRM integration, support tooling, telemetry, billing, auth, or onboarding UI.",
    "Create child M1-M4 implementation work before M0 acceptance is recorded.",
  ],
  operatingBoundaries: [
    {
      id: "service",
      owner: "Customer Onboarding",
      promise:
        "Owns the accepted onboarding stage model, success criteria, proof requirements, and follow-up gate.",
    },
    {
      id: "ux",
      owner: "Workspace & Onboarding UX",
      promise:
        "Owns first-run product rail and future UI behavior; this M0 record only defines customer onboarding inputs and handoffs.",
    },
    {
      id: "security",
      owner: "Security Verification / Legal, Privacy & Terms Readiness",
      promise:
        "Owns consent, redaction, customer-data exclusion, and unsupported regulated-workflow routing.",
    },
    {
      id: "support",
      owner: "V1 Launch Support Desk & Escalation",
      promise:
        "Owns support handoff language, stalled-state routing, severity mapping, and unsupported-request escalation.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Customer Onboarding",
      boundary: "Owns this M0 scope record, onboarding stage vocabulary, success criteria, and follow-up gate.",
    },
    {
      owner: "Workspace & Onboarding UX",
      boundary: "Owns the first-run product rail that customer onboarding consumes but does not implement.",
    },
    {
      owner: "Persona Operating Profile",
      boundary: "Owns the minimal profile fields that tune onboarding defaults without creating broad customer profiling.",
    },
    {
      owner: "Pre-Launch Outcome Contract",
      boundary: "Owns outcome baseline fields that customer onboarding uses to define success evidence.",
    },
    {
      owner: "V1 Beta Pilot & Feedback Loop",
      boundary: "Owns pilot eligibility, feedback intake, and blocker triage after customer onboarding evidence exists.",
    },
    {
      owner: "V1 Launch Support Desk & Escalation",
      boundary: "Owns support route, channel, and severity language for stalled onboarding states.",
    },
    {
      owner: "V1 Release Program & Cutline",
      boundary: "Consumes customer onboarding gaps as beta, RC, and GA readiness blockers or accepted limitations.",
    },
  ],
  m1Evidence: [
    {
      id: "scope-record",
      owner: "Customer Onboarding",
      minimumProof: "Accepted design record, traceability row, and executable scope package for HOBO-449.",
    },
    {
      id: "pilot-script-fixture",
      owner: "Customer Onboarding",
      minimumProof: "Fixture lists onboarding stages, entry criteria, exit criteria, owner, and evidence per stage.",
    },
    {
      id: "success-criteria-register",
      owner: "Pre-Launch Outcome Contract",
      minimumProof: "Outcome, success signal, cost cap, approval rule, failure rule, and review date are recorded.",
    },
    {
      id: "persona-profile-fixture",
      owner: "Persona Operating Profile",
      minimumProof: "Profile fields tune onboarding defaults without storing broad CRM or behavioral tracking data.",
    },
    {
      id: "safe-test-handoff",
      owner: "Workspace & Onboarding UX / E2E Test Matrix",
      minimumProof: "Safe-test or simulated-provider evidence is linked before any live-provider claim is made.",
    },
    {
      id: "support-feedback-router",
      owner: "V1 Beta Pilot & Feedback Loop / V1 Launch Support Desk & Escalation",
      minimumProof: "Blocked onboarding states route to support, beta feedback, release cutline, docs, or capability owner.",
    },
  ],
  onboardingStages: [
    {
      id: "qualify",
      owner: "Customer Onboarding",
      evidence: "pilot-fit record with persona, environment, consent, support window, and exclusion checks",
    },
    {
      id: "profile",
      owner: "Persona Operating Profile",
      evidence: "minimal profile fixture with risk posture, cost cap, approved systems, and do-not-do boundaries",
    },
    {
      id: "workspace-entry",
      owner: "Workspace & Onboarding UX",
      evidence: "workspace, project, and provider-readiness state with missing prerequisites marked non-green",
    },
    {
      id: "outcome-baseline",
      owner: "Pre-Launch Outcome Contract",
      evidence: "customer-visible outcome baseline with success signal, owner, failure rule, and rollback expectation",
    },
    {
      id: "safe-proof",
      owner: "E2E Test Matrix / Example Apps",
      evidence: "safe-test result pack or simulated-provider proof with mocked/live boundary labels",
    },
    {
      id: "support-handoff",
      owner: "V1 Launch Support Desk & Escalation",
      evidence: "stalled-state owner, next action, severity, customer-safe message, and evidence source",
    },
  ],
  followUpGate: {
    owner: "Customer Onboarding",
    rule: "M1-M4 follow-up issues may start only after HOBO-449 M0 scope acceptance is recorded.",
  },
} as const;

export function validateCustomerOnboardingScope(record: typeof CUSTOMER_ONBOARDING_SCOPE) {
  const errors: string[] = [];

  if (!record || !isJsonObject(record)) {
    return { ok: false, errors: ["customer onboarding scope record is required"] };
  }
  if (record.issue !== "HOBO-449") errors.push("issue must be HOBO-449");
  if (record.phase !== "M0") errors.push("phase must be M0");
  if (!record.goal || !/Customer Onboarding/i.test(record.goal)) {
    errors.push("goal must name Customer Onboarding");
  }

  for (const section of [
    "personas",
    "scopeIn",
    "scopeOut",
    "nonGoals",
    "initiativeDependencies",
    "m1Evidence",
    "onboardingStages",
  ] as const) {
    if (!Array.isArray(record[section]) || record[section].length === 0) {
      errors.push(`${section} must be a non-empty list`);
    }
  }

  const boundaryIds = new Set(record.operatingBoundaries?.map((boundary) => boundary.id) ?? []);
  for (const boundary of REQUIRED_OPERATING_BOUNDARIES) {
    if (!boundaryIds.has(boundary)) errors.push(`missing ${boundary} operating boundary`);
  }

  const evidenceIds = new Set(record.m1Evidence?.map((evidence) => evidence.id) ?? []);
  for (const evidence of REQUIRED_M1_EVIDENCE) {
    if (!evidenceIds.has(evidence)) errors.push(`missing ${evidence} M1 evidence`);
  }

  const scopedText = [...(record.scopeIn ?? [])].join("\n");
  for (const forbidden of FORBIDDEN_SCOPE_PATTERNS) {
    if (forbidden.pattern.test(scopedText)) {
      errors.push(`scope creep: ${forbidden.label}`);
    }
  }

  if (!record.followUpGate?.rule || !/M1-M4/.test(record.followUpGate.rule)) {
    errors.push("follow-up gate must block M1-M4 work until M0 acceptance");
  }

  return { ok: errors.length === 0, errors };
}

export function canStartCustomerOnboardingFollowUp({
  phase,
  m0Accepted,
}: {
  phase: CustomerOnboardingPhase;
  m0Accepted: boolean;
}) {
  if (!IMPLEMENTATION_PHASES.has(phase)) return { allowed: true };
  if (m0Accepted) return { allowed: true };
  return {
    allowed: false,
    reason: "Customer Onboarding M1-M4 follow-up work is blocked until HOBO-449 M0 scope is accepted.",
  };
}

export function classifyCustomerOnboardingClaim({
  audience,
  claim,
  proofMode,
  source,
}: {
  audience: ClaimAudience;
  claim: string;
  proofMode?: string;
  source?: string;
}) {
  if (!claim.trim()) {
    return {
      allowed: false,
      reason: "Customer onboarding claims must state the claimed onboarding readiness boundary.",
    };
  }

  const externallyVisible = audience !== "internal";
  if (externallyVisible && (!proofMode || !source)) {
    return {
      allowed: false,
      reason: "Customer-facing onboarding claims require proof mode and source evidence.",
    };
  }

  if (externallyVisible) {
    for (const forbidden of FORBIDDEN_EXTERNAL_CLAIM_PATTERNS) {
      if (forbidden.pattern.test(claim)) {
        return {
          allowed: false,
          reason: `M0 scope proof cannot support ${forbidden.label}.`,
        };
      }
    }
  }

  return { allowed: true };
}
