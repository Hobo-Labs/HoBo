export const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"] as const;

export const REQUIRED_DEPENDENCY_TARGETS = [
  "docs/design/launch-support-escalation.md",
  "docs/design/public-status-page-incident-communication.md",
  "docs/design/support-sla-channels.md",
  "docs/design/product-notifications-lifecycle.md",
  "docs/design/launch-messaging-claims.md",
  "docs/design/adr/02-identity-security.md#adr-0045",
  "docs/design/adr/03-data-plane.md#adr-0058",
] as const;

type Phase = "M0" | "M1" | "M2" | "M3" | "M4";
type BoundaryId = (typeof REQUIRED_BOUNDARIES)[number];

const FOLLOW_UP_PHASES = new Set<Phase>(["M1", "M2", "M3", "M4"]);
const CUSTOMER_VISIBLE_AUDIENCES = new Set(["customer-visible", "public-status-page", "named-customer"]);

const FORBIDDEN_SCOPE_PATTERNS = [
  { label: "live notification dispatch", pattern: /live notification dispatch|notification delivery|send notifications/i },
  { label: "ticket automation", pattern: /ticket automation|auto(?:matic)? ticket|create ticket/i },
  { label: "runbook execution", pattern: /runbook execution|execute .*runbook|remediation/i },
  { label: "SLA promises", pattern: /sla|response target|15 minute|fifteen minute|contractual response/i },
  { label: "customer data", pattern: /customer[_ -]?email|private tenant data|customer data|tenant data|pii/i },
  { label: "live public status page implementation", pattern: /live status page|status page publishing workflow/i },
];

export const INCIDENT_COMMUNICATIONS_SCOPE = {
  issue: "HOBO-450",
  project: "Incident Communications",
  phase: "M0",
  goal:
    "Define accepted Incident Communications productization scope before M1 design or contract proof can create customer-visible incident update, status page, support handoff, or launch communication follow-up work.",
  personas: [
    {
      id: "incident-commander",
      name: "Incident commander",
      need: "Coordinate factual incident state, next update cadence, and internal approval without owning live publication tooling.",
    },
    {
      id: "support-lead",
      name: "Support lead",
      need: "Receive customer-safe update language and escalation handoffs without turning this scope into ticket automation or SLA enforcement.",
    },
    {
      id: "customer-admin",
      name: "Customer administrator",
      need: "Understand service impact, current state, mitigation guidance, and expected follow-up without seeing private tenant data.",
    },
    {
      id: "sre-operator",
      name: "SRE operator",
      need: "Provide verified incident facts and runbook status while keeping remediation execution in SRE-owned lanes.",
    },
    {
      id: "release-owner",
      name: "Release owner",
      need: "Gate launch communication claims on accepted incident-communication evidence and limitation wording.",
    },
    {
      id: "security-compliance-reviewer",
      name: "Security and compliance reviewer",
      need: "Verify redaction, customer-data exclusion, incident evidence, and auditability before customer-visible publication.",
    },
  ],
  scopeIn: [
    "Customer-safe incident communication vocabulary for candidate, investigating, identified, monitoring, resolved, and follow-up states.",
    "Template taxonomy for initial notices, progress updates, maintenance notices, resolution summaries, and limitation notes.",
    "Service, UX, security, and support boundaries for status-page, named-customer, support-ticket, launch-room, and release-note communication handoffs.",
    "Evidence checklist for source incident facts, redaction approval, owner review, status/state mapping, and support handoff before customer-visible updates.",
    "Follow-up gate that blocks M1-M4 design or implementation issues until this M0 scope record is accepted.",
  ],
  scopeOut: [
    "No live notification dispatch, email/SMS/webhook delivery, subscription management, or preference center implementation.",
    "No public status page renderer, component uptime computation, status page publishing workflow, or external incident feed implementation.",
    "No support ticket automation, queue routing engine, CRM integration, or contractual support SLA enforcement.",
    "No runbook execution, remediation automation, rollback operation, or SRE control-plane mutation.",
    "No customer-private data, tenant data, customer_email fields, or raw diagnostic payloads in customer-visible communication templates.",
    "No M1-M4 follow-up issue creation before M0 acceptance is recorded.",
  ],
  nonGoals: [
    "Replace Public Status Page ownership for published component state and update cadence.",
    "Replace Support SLA & Channels ownership for contractual response targets, support channel routing, or ticket workflow.",
    "Replace SRE ownership for incident diagnosis, remediation, rollback, or runbook execution.",
    "Create live notification, CRM, support, status-page, or launch-site runtime behavior.",
  ],
  boundaries: [
    {
      id: "service",
      rule:
        "Incident Communications defines records, templates, state vocabulary, and handoff evidence; it does not build dispatch services, status-page renderers, support queues, or runbook executors.",
    },
    {
      id: "ux",
      rule:
        "UX scope is customer-safe copy structure, state labels, update cadence language, and limitation wording for later surfaces; no screen, feed, email, or notification UI is implemented here.",
    },
    {
      id: "security",
      rule:
        "Security scope requires redaction approval, customer-data exclusion, source evidence, and auditability before customer-visible publication.",
    },
    {
      id: "support",
      rule:
        "Support receives escalation context, customer-safe wording, and owner handoff records; ticket automation, SLA guarantees, queue routing, and CRM mutation remain out of scope.",
    },
  ],
  communicationSurfaces: [
    {
      id: "public-status-page",
      owner: "Public Status Page",
      boundary: "Consumes approved incident update records; publication workflow and component uptime logic stay outside HOBO-450.",
    },
    {
      id: "named-customer-update",
      owner: "Support Workflow",
      boundary: "Consumes customer-safe copy and incident facts; delivery, account selection, and ticket activity stay outside HOBO-450.",
    },
    {
      id: "support-ticket-handoff",
      owner: "Support SLA & Channels",
      boundary: "Receives escalation context and state labels; ticket creation, routing, and SLA enforcement stay outside HOBO-450.",
    },
    {
      id: "internal-launch-room",
      owner: "Release Program",
      boundary: "Uses limitation and launch-claim status; release go/no-go remains release-program scope.",
    },
    {
      id: "release-notes-limitation",
      owner: "Launch Messaging Claims",
      boundary: "Uses resolved/follow-up summaries and limitations; public launch copy approval remains launch-messaging scope.",
    },
  ],
  incidentStates: [
    { id: "candidate", meaning: "Potential customer-impacting event is being assessed and is not customer-visible by default." },
    { id: "investigating", meaning: "Impact is plausible or confirmed and facts are still being gathered." },
    { id: "identified", meaning: "Cause or affected boundary is known enough to state a mitigation or owner." },
    { id: "monitoring", meaning: "Mitigation is applied and stability evidence is being watched." },
    { id: "resolved", meaning: "Customer-impacting incident is no longer active and summary evidence can be prepared." },
    { id: "follow-up", meaning: "Post-incident customer-safe action item, limitation, or postmortem reference remains open." },
  ],
  templateKinds: [
    {
      id: "initial-notice",
      requiredFields: ["communication_id", "incident_state", "customer_impact", "next_update_expectation"],
      redactionGate: true,
    },
    {
      id: "progress-update",
      requiredFields: ["communication_id", "incident_state", "current_status", "next_update_expectation"],
      redactionGate: true,
    },
    {
      id: "maintenance-notice",
      requiredFields: ["communication_id", "maintenance_window", "expected_customer_impact", "rollback_statement"],
      redactionGate: true,
    },
    {
      id: "resolution-summary",
      requiredFields: ["communication_id", "incident_state", "resolution_time", "customer_safe_summary"],
      redactionGate: true,
    },
    {
      id: "limitation-note",
      requiredFields: ["communication_id", "known_limitation", "owner_route", "follow_up_expectation"],
      redactionGate: true,
    },
  ],
  dependencies: [
    {
      target: "docs/design/launch-support-escalation.md",
      reason: "Defines incident communication templates, escalation handoffs, and launch support gap routing consumed by this scope.",
    },
    {
      target: "docs/design/public-status-page-incident-communication.md",
      reason: "Defines public status-page component taxonomy, incident states, maintenance notices, update cadence, and publication boundaries.",
    },
    {
      target: "docs/design/support-sla-channels.md",
      reason: "Defines support channel coverage, response-target language, unsupported request routing, and owner signoff boundaries.",
    },
    {
      target: "docs/design/product-notifications-lifecycle.md",
      reason: "Defines product lifecycle notification classes, preference/delivery evidence, and notification ownership boundaries.",
    },
    {
      target: "docs/design/launch-messaging-claims.md",
      reason: "Defines launch claims, limitation copy, evidence owners, and publication review requirements.",
    },
    {
      target: "docs/design/adr/02-identity-security.md#adr-0045",
      reason: "Pins SLO-as-code, alerting, and rollback calibration as reliability-owned sources for incident facts.",
    },
    {
      target: "docs/design/adr/03-data-plane.md#adr-0058",
      reason: "Pins SRE incident management, runbooks, diagnosis, and gated remediation as operator-owned inputs.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Incident Communications",
      consumes:
        "Owns accepted communication vocabulary, templates, redaction gates, evidence checklist, and follow-up issue gate.",
      scopeBoundary: "Defines M0 scope and acceptance; does not implement dispatch, publication, support, or remediation runtime.",
    },
    {
      owner: "Public Status Page",
      consumes: "Consumes incident states, update records, maintenance notices, and limitation summaries.",
      scopeBoundary: "Status page publication, component uptime, and public feed behavior remain Public Status Page scope.",
    },
    {
      owner: "Support SLA & Channels",
      consumes: "Consumes support-safe incident wording, escalation context, and unsupported-request routes.",
      scopeBoundary: "Response targets, ticket queues, CRM mutation, and SLA policy remain Support SLA & Channels scope.",
    },
    {
      owner: "Operators/SRE",
      consumes: "Provides source incident facts, remediation state, rollback status, and runbook references.",
      scopeBoundary: "Diagnosis, remediation, rollback, and runbook execution remain Operators/SRE scope.",
    },
    {
      owner: "Security Verification / Legal",
      consumes: "Approves redaction, customer-data exclusion, compliance-sensitive language, and disclosure constraints.",
      scopeBoundary: "Legal approval workflow, vulnerability disclosure, and tenant data policy remain separate owner lanes.",
    },
    {
      owner: "Launch Messaging Claims",
      consumes: "Consumes resolved incident summaries and limitation notes before public launch or release-note claims.",
      scopeBoundary: "Launch-site copy, public claim approval, and demo asset publication remain launch-messaging scope.",
    },
  ],
  m1Evidence: [
    {
      kind: "incident-state-fixture",
      boundary: "service",
      owner: "incident-commander",
      source: "docs/design/incident-communications.md#incident-state-vocabulary",
      proves: "Later services can distinguish candidate, investigating, identified, monitoring, resolved, and follow-up states.",
    },
    {
      kind: "template-schema-fixture",
      boundary: "service",
      owner: "incident-commander",
      source: "docs/design/incident-communications.md#template-kinds",
      proves: "Every communication template has communication_id and redaction-gated required fields.",
    },
    {
      kind: "customer-copy-review",
      boundary: "ux",
      owner: "release-owner",
      source: "docs/design/incident-communications.md#communication-surfaces",
      proves: "Customer-visible status, named-customer, support, launch-room, and release-note surfaces have distinct copy boundaries.",
    },
    {
      kind: "redaction-approval-fixture",
      boundary: "security",
      owner: "security-compliance-reviewer",
      source: "docs/design/incident-communications.md#publication-gate",
      proves: "Customer-visible communication requires evidence, redaction approval, and no customer data leakage.",
    },
    {
      kind: "support-handoff-register",
      boundary: "support",
      owner: "support-lead",
      source: "docs/design/incident-communications.md#owning-initiative-dependencies",
      proves: "Support receives handoff context without ticket automation, SLA enforcement, or queue mutation.",
    },
    {
      kind: "scope-boundary-register",
      boundary: "support",
      owner: "release-owner",
      source: "docs/design/incident-communications.md#scope-out-and-non-goals",
      proves: "Live notification dispatch, status-page implementation, ticket automation, runbook execution, SLA promises, and customer data remain out.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 incident communication design or implementation issues must not be created until this M0 scope record is accepted.",
  },
} as const;

export function canCreateIncidentCommunicationFollowUp({
  phase,
  m0Accepted,
}: {
  phase: Phase;
  m0Accepted: boolean;
}) {
  if (phase === "M0") {
    return { allowed: true, reason: "M0 scope definition may proceed before acceptance." };
  }

  return {
    allowed: Boolean(m0Accepted) && FOLLOW_UP_PHASES.has(phase),
    reason: m0Accepted ? "M0 scope accepted." : "M1-M4 follow-up work is blocked until M0 acceptance.",
  };
}

export function canPublishIncidentCommunication({
  audience,
  evidenceAccepted,
  redactionApproved,
  customerDataIncluded,
  contractualSlaIncluded,
}: {
  audience: string;
  evidenceAccepted: boolean;
  redactionApproved: boolean;
  customerDataIncluded: boolean;
  contractualSlaIncluded: boolean;
}) {
  if (!CUSTOMER_VISIBLE_AUDIENCES.has(audience)) {
    return { allowed: true, reason: "Internal audience does not use the customer-visible publication gate." };
  }

  if (!evidenceAccepted) {
    return { allowed: false, reason: "Customer-visible communication requires accepted incident evidence." };
  }
  if (!redactionApproved) {
    return { allowed: false, reason: "Customer-visible communication requires redaction approval." };
  }
  if (customerDataIncluded) {
    return { allowed: false, reason: "Customer-visible communication must not include customer data." };
  }
  if (contractualSlaIncluded) {
    return { allowed: false, reason: "Customer-visible communication must not promise contractual SLA terms." };
  }

  return { allowed: true, reason: "Publication gate passed." };
}

export function classifyIncidentCommunicationRequest(request: string) {
  const normalized = request.toLowerCase();

  if (/private tenant data|customer data|customer_email|pii/.test(normalized)) {
    return { owner: "Security Verification / Legal", inScope: false };
  }
  if (/runbook|remediation|rollback|execute/.test(normalized)) {
    return { owner: "Operators/SRE", inScope: false };
  }
  if (/ticket automation|support ticket automation|crm|queue/.test(normalized)) {
    return { owner: "Support Workflow", inScope: false };
  }
  if (/contractual|response sla|sla/.test(normalized)) {
    return { owner: "Business Owner / Legal", inScope: false };
  }
  if (/status page|publishing workflow|uptime component/.test(normalized)) {
    return { owner: "Public Status Page", inScope: false };
  }

  return { owner: "Incident Communications", inScope: true };
}

export function validateIncidentCommunicationsScope(scope: typeof INCIDENT_COMMUNICATIONS_SCOPE) {
  const errors: string[] = [];

  if (scope.issue !== "HOBO-450") {
    errors.push("issue must be HOBO-450");
  }
  if (scope.project !== "Incident Communications") {
    errors.push("project must be Incident Communications");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!scope.goal?.toLowerCase().includes("incident communications")) {
    errors.push("goal must name Incident Communications");
  }
  if ((scope.personas ?? []).length < 6) {
    errors.push("at least six primary personas are required");
  }
  if ((scope.scopeIn ?? []).length < 5) {
    errors.push("scope in must have at least five entries");
  }
  if ((scope.scopeOut ?? []).length < 5) {
    errors.push("scope out must have at least five entries");
  }

  const boundaryIds = new Set((scope.boundaries ?? []).map((boundary) => boundary.id));
  for (const boundary of REQUIRED_BOUNDARIES) {
    if (!boundaryIds.has(boundary)) {
      errors.push(`missing ${boundary} boundary`);
    }
  }

  const dependencyTargets = (scope.dependencies ?? []).map((dependency) => dependency.target);
  if (JSON.stringify(dependencyTargets) !== JSON.stringify(REQUIRED_DEPENDENCY_TARGETS)) {
    errors.push("dependency targets must map to support escalation, status page, support SLA, notifications, launch claims, ADR-0045, and ADR-0058");
  }

  const evidenceBoundaries = new Set((scope.m1Evidence ?? []).map((evidence) => evidence.boundary));
  for (const boundary of REQUIRED_BOUNDARIES) {
    if (!evidenceBoundaries.has(boundary)) {
      errors.push(`m1 evidence missing ${boundary} proof`);
    }
  }

  for (const template of scope.templateKinds ?? []) {
    if (!template.requiredFields?.includes("communication_id") || !template.redactionGate) {
      errors.push(`template ${template.id ?? "<unknown>"} must require communication_id and redaction gate`);
    }
  }

  for (const entry of scope.scopeIn ?? []) {
    for (const { label, pattern } of FORBIDDEN_SCOPE_PATTERNS) {
      if (pattern.test(entry)) {
        errors.push(`scope creep: ${label} in "${entry}"`);
      }
    }
  }

  if (!scope.followUpGate?.allowedAfter || !scope.followUpGate?.blockedBefore) {
    errors.push("follow-up gate must record allowed-after and blocked-before states");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export type IncidentCommunicationBoundaryId = BoundaryId;
