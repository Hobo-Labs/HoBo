import { type JsonValue } from "./json.js";
const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const REQUIRED_M1_EVIDENCE = Object.freeze([
  "support-intake-schema",
  "triage-state-machine",
  "customer-safe-evidence-pack",
  "owner-route-matrix",
  "redaction-and-access-guard",
  "scope-boundary-register",
]);

const REQUIRED_EVIDENCE = Object.freeze([
  "requester",
  "customer-safe-summary",
  "severity",
  "affected-surface",
  "owner-route",
  "evidence-links",
  "redaction-state",
  "next-update-condition",
]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "helpdesk automation",
    pattern:
      /\b(build|implement|wire|automate|ship|create)\b.*\b(helpdesk|ticket|support)\b.*\b(automation|queue|tooling|portal|integration)\b/i,
  },
  {
    label: "customer data access",
    pattern: /\b(production\s+)?customer data access\b|\bgrant\b.*\bcustomer data\b/i,
  },
  {
    label: "SLA promise",
    pattern:
      /\b(guarantee|guaranteed|promise|commit|approve)\b.*\b(sla|response time|response-time)\b|\b\d+\s*(minute|minutes|min|hour|hours|hr|hrs)\b/i,
  },
  {
    label: "incident command",
    pattern: /\b(run|own|implement|replace)\b.*\bincident command\b/i,
  },
]);

export const REQUIRED_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

export const SUPPORT_WORKFLOW_SCOPE = Object.freeze({
  issue: "HOBO-448",
  project: "Support Workflow",
  phase: "M0",
  goal:
    "Define Support Workflow scope and acceptance so HoBo has accepted support intake, triage, evidence, owner routing, and customer-safe handoff boundaries before support tooling or live operations begin.",
  personas: Object.freeze([
    {
      id: "support-lead",
      name: "Support lead",
      need: "Needs accepted workflow ownership, severity triage, and follow-up gates before support execution issues fan out.",
    },
    {
      id: "support-operator",
      name: "Support operator",
      need: "Needs a customer-safe intake record, required evidence fields, and owner-route rules for each request.",
    },
    {
      id: "customer-admin",
      name: "Customer admin",
      need: "Needs clear support handoff language, next-update conditions, and limitation wording without hidden SLA guarantees.",
    },
    {
      id: "incident-commander",
      name: "Incident commander",
      need: "Needs a support-to-incident handoff that preserves redacted context and does not replace incident command ownership.",
    },
    {
      id: "release-owner",
      name: "Release owner",
      need: "Needs launch-readiness gaps and customer-facing support language routed into the release cutline.",
    },
    {
      id: "security-compliance-reviewer",
      name: "Security/compliance reviewer",
      need: "Needs customer-data, redaction, audit, and access boundaries before support work can expose operational evidence.",
    },
  ]),
  scopeIn: Object.freeze([
    "Define support intake, triage, owner routing, customer-safe status, and closure vocabulary.",
    "Record required support evidence fields for requester, summary, severity, affected surface, owner route, linked evidence, redaction state, and next update condition.",
    "Map service, UX, security, and support boundaries across Admin Console, Incident Communications, Support SLA Channels, Release Program, Security Verification, and Docs.",
    "Define M1 evidence required before support tooling, ticket queue integration, or customer-support operations work can begin.",
    "Define customer-safe handoff language for unsupported, blocked, and owner-routed requests.",
  ]),
  scopeOut: Object.freeze([
    "No helpdesk implementation, ticket queue automation, support portal, status-page publishing workflow, or live support operation.",
    "No production customer data access, secret access, tenant data browsing, or support impersonation path.",
    "No contractual SLA approval, public response-time guarantee, paid support tier promise, or GA support terms.",
    "No incident command replacement, on-call schedule implementation, runbook execution, or notification dispatch.",
    "No broad M1-M4 follow-up issue creation before this M0 scope record and proof are accepted.",
  ]),
  nonGoals: Object.freeze([
    "Replace HOBO-408 launch support escalation or HOBO-496 support SLA/channel records.",
    "Build support desk software or choose a helpdesk vendor.",
    "Approve contractual support terms or customer-facing response guarantees.",
    "Grant support access to raw customer data or production secrets.",
  ]),
  boundaries: Object.freeze([
    {
      id: "service",
      owner: "Support Workflow",
      promise:
        "Owns support intake, triage states, owner routing, customer-safe evidence shape, and M1 proof expectations; runtime support services are later work.",
    },
    {
      id: "ux",
      owner: "Support Workflow / Admin Console",
      promise:
        "May later expose support status, owner route, limitations, and next update conditions; this M0 record defines information architecture only.",
    },
    {
      id: "security",
      owner: "Security Verification / Legal",
      promise:
        "Owns redaction, customer-data access, audit, and approval boundaries before support can expose operational evidence.",
    },
    {
      id: "support",
      owner: "Support Workflow",
      promise:
        "Consumes launch support, SLA/channel, admin-console, release, and security evidence without adding live queues or staffing workflows.",
    },
  ]),
  intakeStates: Object.freeze([
    {
      id: "received",
      meaning: "A request arrives with requester and channel context, but severity and owner are not yet accepted.",
    },
    {
      id: "classified",
      meaning: "Severity, affected surface, and unsupported-request posture are assigned from accepted records.",
    },
    {
      id: "evidence-linked",
      meaning: "Redacted evidence links, incident/support references, and source records are attached.",
    },
    {
      id: "owner-routed",
      meaning: "The owning initiative accepts the next action or handoff boundary.",
    },
    {
      id: "customer-updated",
      meaning: "Customer-safe wording, limitation, and next update condition are recorded.",
    },
    {
      id: "closed",
      meaning: "The request has a routed answer, follow-up issue, or accepted unsupported-state explanation.",
    },
  ]),
  requiredEvidence: Object.freeze([
    {
      id: "requester",
      owner: "Support Workflow",
      proof: "Identifies customer, admin, internal operator, or release stakeholder requesting support.",
    },
    {
      id: "customer-safe-summary",
      owner: "Support Workflow",
      proof: "Summarizes the request without raw secrets, internal-only incident notes, or customer data leakage.",
    },
    {
      id: "severity",
      owner: "Support SLA Channels",
      proof: "Maps the request to accepted SEV0-SEV3 handling language.",
    },
    {
      id: "affected-surface",
      owner: "Admin Console / Product Owner",
      proof: "Names product, tenant, project, environment, release, or docs surface involved.",
    },
    {
      id: "owner-route",
      owner: "Support Workflow",
      proof: "Names the next responsible initiative and support boundary.",
    },
    {
      id: "evidence-links",
      owner: "Owning Initiative",
      proof: "Links redacted logs, incident record, admin context, release note, proof package, or docs source.",
    },
    {
      id: "redaction-state",
      owner: "Security Verification",
      proof: "States whether evidence is customer-safe, internal-only, or requires security/legal approval.",
    },
    {
      id: "next-update-condition",
      owner: "Support Workflow",
      proof: "Records when support updates the customer or internal stakeholder again.",
    },
  ]),
  designRefs: Object.freeze([
    "docs/design/support-sla-channels.md",
    "docs/design/launch-support-escalation.md",
    "docs/design/admin-console.md",
    "docs/design/security-verification.md",
    "docs/design/release-notes-upgrade-guide.md",
    "docs/design/public-status-page-incident-communication.md",
  ]),
  adrRefs: Object.freeze([
    "docs/design/adr/03-data-plane.md#adr-0058",
    "docs/design/adr/03-data-plane.md#adr-0059",
    "docs/design/adr/02-identity-security.md#adr-0046",
    "docs/design/adr/02-identity-security.md#adr-0077",
    "docs/design/adr/02-identity-security.md#adr-0094",
  ]),
  initiativeDependencies: Object.freeze([
    {
      owner: "Support SLA Channels",
      boundary:
        "Supplies channel, severity, target-language, unsupported-request, and owner-signoff vocabulary; Support Workflow consumes it for triage.",
    },
    {
      owner: "Incident Communications",
      boundary:
        "Owns public incident updates, status-page templates, and incident-command handoff; Support Workflow only routes and links customer-safe state.",
    },
    {
      owner: "Admin Console",
      boundary:
        "Supplies tenant, entitlement, project, environment, and release visibility; Support Workflow does not build admin UI or authorize data access.",
    },
    {
      owner: "Security Verification",
      boundary:
        "Owns redaction, access approval, and customer-data exposure boundaries before support evidence becomes customer-visible.",
    },
    {
      owner: "V1 Release Program & Cutline",
      boundary:
        "Owns public commitment language, beta limitation wording, and go/no-go exceptions surfaced by support gaps.",
    },
    {
      owner: "Docs / Troubleshooting Guides",
      boundary:
        "Owns approved answers and troubleshooting content that support may cite for SEV3 and unsupported states.",
    },
  ]),
  m1Evidence: Object.freeze([
    {
      id: "support-intake-schema",
      mode: "design-record",
      proves: "Support request, channel, requester, severity, affected surface, and owner route fields are stable.",
    },
    {
      id: "triage-state-machine",
      mode: "contract-test",
      proves: "Received, classified, evidence-linked, owner-routed, customer-updated, and closed states transition deterministically.",
    },
    {
      id: "customer-safe-evidence-pack",
      mode: "support-handoff",
      proves: "Support can attach redacted logs, incidents, admin context, docs, and proof links without leaking secrets.",
    },
    {
      id: "owner-route-matrix",
      mode: "reference-fixture",
      proves: "Support, incident communications, admin console, security, release, docs, billing, bootstrap, and backup cases route to owners.",
    },
    {
      id: "redaction-and-access-guard",
      mode: "policy-fixture",
      proves: "Raw customer data, secret access, impersonation, and internal incident notes fail closed without approval.",
    },
    {
      id: "scope-boundary-register",
      mode: "audit-fixture",
      proves: "Helpdesk automation, SLA promises, incident command, support staffing, and live operations remain out of M0 scope.",
    },
  ]),
  followUpGate: Object.freeze({
    rule:
      "Create M1/M2/M3/M4 Support Workflow design or implementation issues only after this M0 scope record and executable proof are accepted.",
  }),
});

export function canCreateSupportWorkflowFollowUp({
  phase,
  m0Accepted,
}: {
  phase: string;
  m0Accepted: boolean;
}) {
  if (!IMPLEMENTATION_PHASES.has(phase)) {
    return {
      allowed: true,
      reason: "Phase does not depend on the M0 Support Workflow gate.",
    };
  }

  if (m0Accepted) {
    return {
      allowed: true,
      reason: "M0 Support Workflow scope and acceptance evidence has been accepted.",
    };
  }

  return {
    allowed: false,
    reason: "M1/M2/M3/M4 follow-up issues wait for accepted M0 Support Workflow scope.",
  };
}

export function classifySupportWorkflowDecision(decision: JsonValue) {
  const text = String(decision ?? "").toLowerCase();

  if (/\b(helpdesk|ticket automation|support portal|queue automation|zendesk|intercom)\b/.test(text)) {
    return { owner: "Support Tooling", inScope: false };
  }

  if (/\b(status page|public incident|incident communication|customer update)\b/.test(text)) {
    return { owner: "Incident Communications", inScope: false };
  }

  if (/\b(admin console|tenant|entitlement|project|environment)\b/.test(text)) {
    return { owner: "Admin Console", inScope: false };
  }

  if (/\b(contractual|legal|paid support|enterprise)\b.*\b(sla|terms?|support language)?\b/.test(text)) {
    return { owner: "Business Owner / Legal", inScope: false };
  }

  if (/\b(secret|raw customer data|impersonation|customer data access)\b/.test(text)) {
    return { owner: "Security Verification", inScope: false };
  }

  return { owner: "Support Workflow", inScope: true };
}

export function validateSupportWorkflowScope(scope: {
  issue?: string;
  phase?: string;
  goal?: string;
  personas?: ReadonlyArray<{ id: string }>;
  boundaries?: ReadonlyArray<{ id: string }>;
  intakeStates?: ReadonlyArray<{ id: string }>;
  requiredEvidence?: ReadonlyArray<{ id: string }>;
  m1Evidence?: ReadonlyArray<{ id: string }>;
  scopeIn?: ReadonlyArray<string>;
  followUpGate?: { rule?: string };
}) {
  const errors = [];

  if (scope.issue !== "HOBO-448") {
    errors.push("Scope record must be tied to HOBO-448.");
  }

  if (scope.phase !== "M0") {
    errors.push("Scope record must remain an M0 acceptance record.");
  }

  if (!/support workflow/i.test(scope.goal ?? "")) {
    errors.push("Goal must name Support Workflow.");
  }

  if ((scope.personas ?? []).length < 5) {
    errors.push("At least five support workflow personas are required.");
  }

  for (const boundary of REQUIRED_BOUNDARIES) {
    if (!scope.boundaries?.some((entry) => entry.id === boundary)) {
      errors.push(`Missing ${boundary} boundary.`);
    }
  }

  for (const field of REQUIRED_EVIDENCE) {
    if (!scope.requiredEvidence?.some((entry) => entry.id === field)) {
      errors.push(`Missing support evidence: ${field}.`);
    }
  }

  for (const evidence of REQUIRED_M1_EVIDENCE) {
    if (!scope.m1Evidence?.some((entry) => entry.id === evidence)) {
      errors.push(`Missing M1 evidence: ${evidence}.`);
    }
  }

  if ((scope.intakeStates ?? []).length < 6) {
    errors.push("Support intake states must cover receipt through closure.");
  }

  for (const item of scope.scopeIn ?? []) {
    for (const { label, pattern } of FORBIDDEN_SCOPE_PATTERNS) {
      if (pattern.test(item)) {
        errors.push(`M0 scope-in includes out-of-scope ${label} work: ${item}`);
      }
    }
  }

  if (!scope.followUpGate?.rule) {
    errors.push("Follow-up gate must record a blocking rule.");
  }

  return { ok: errors.length === 0, errors };
}
