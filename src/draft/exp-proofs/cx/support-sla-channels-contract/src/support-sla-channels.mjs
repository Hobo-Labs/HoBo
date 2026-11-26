const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const REQUIRED_CHANNELS = Object.freeze([
  "support-ticket",
  "status-page",
  "launch-room",
  "customer-email",
  "docs-faq",
]);

const REQUIRED_ESCALATION_OWNERS = Object.freeze([
  "Support Workflow",
  "Incident Communications",
  "Admin Console",
  "V1 Release Program & Cutline",
]);

const FORBIDDEN_SCOPE_PATTERNS = Object.freeze([
  {
    label: "contractual SLA approval",
    pattern: /\b(approve|ratify|commit|guarantee)\b.*\b(contractual\s+sla|customer-facing\s+sla|response\s+sla)\b/i,
  },
  {
    label: "support tooling",
    pattern: /\b(build|implement|wire|automate)\b.*\b(support|ticket|incident)\b.*\b(tool|tooling|automation|queue|portal|console)\b/i,
  },
  {
    label: "business-owner bypass",
    pattern: /\b(contractual\s+sla|ga\s+commitment)\b.*\b(without|no)\b.*\b(business owner|owner signoff|approval)\b/i,
  },
]);

export const REQUIRED_BOUNDARIES = Object.freeze(["service", "ux", "security", "support"]);

export const SUPPORT_SLA_CHANNELS_SCOPE = Object.freeze({
  issue: "HOBO-496",
  project: "Support Workflow",
  phase: "M0",
  goal:
    "Define v1 support SLA, channel, severity-routing, handoff, and unsupported-request coverage before beta or GA support promises are made.",
  personas: Object.freeze([
    {
      id: "support-lead",
      need: "Needs accepted channel coverage, staffing assumptions, severity routing, and unsupported-request policy before beta support starts.",
    },
    {
      id: "support-operator",
      need: "Needs customer-safe response targets, handoff rules, evidence requirements, and escalation owners for each request class.",
    },
    {
      id: "customer-admin",
      need: "Needs clear channel availability, beta limitations, unsupported requests, and escalation expectations without hidden SLA guarantees.",
    },
    {
      id: "incident-commander",
      need: "Needs support-to-incident handoff rules that align ticket intake, customer communications, and incident records.",
    },
    {
      id: "release-owner",
      need: "Needs launch cutline decisions for support coverage gaps and any customer-facing commitment language.",
    },
    {
      id: "security-compliance-reviewer",
      need: "Needs escalation, redaction, audit, and business-owner approval boundaries before contractual support language is published.",
    },
  ]),
  scopeIn: Object.freeze([
    "Define supported channels, support hours, beta coverage assumptions, and unsupported channel states.",
    "Define response target language for internal operations, beta promises, and GA customer-facing commitments.",
    "Map severity routing, handoff rules, evidence requirements, and owner lanes for SEV0 through SEV3 support intake.",
    "Record unsupported request classes and their safe owner routes.",
    "Link support SLA/channel decisions to incident communications, admin console visibility, and release cutline ownership.",
    "List M1 evidence required before support workflow implementation or public SLA publication work can begin.",
  ]),
  scopeOut: Object.freeze([
    "No contractual SLA approval, paid support tier promise, or public response guarantee without business owner signoff.",
    "No support tooling implementation, ticket queue automation, helpdesk integration, admin console UI, or status-page publishing workflow.",
    "No incident command automation, on-call schedule implementation, runbook execution, or notification dispatch.",
    "No legal terms, procurement agreement, enterprise support contract, or commercial pricing approval.",
    "No live customer support operation, customer data access, or production support staff scheduling.",
    "No M1-M4 follow-up implementation issue creation before M0 scope and acceptance evidence is accepted.",
  ]),
  nonGoals: Object.freeze([
    "Replace the launch support escalation matrix from HOBO-408.",
    "Approve a contractual SLA or final GA support terms.",
    "Build support desk, status page, admin console, incident, or release tooling.",
    "Claim beta or GA support readiness without named proof sources and owner signoff.",
  ]),
  boundaries: Object.freeze([
    {
      id: "service",
      owner: "Support Workflow",
      promise:
        "Owns support channel coverage, response language, unsupported-request routing, and M1 proof expectations; support desk services are later work.",
    },
    {
      id: "ux",
      owner: "Support Workflow / Docs Portal",
      promise:
        "May later expose support channels, limitations, and customer-safe target language; this M0 record defines information architecture only.",
    },
    {
      id: "security",
      owner: "Security Verification / Legal",
      promise:
        "Requires redaction, audit, customer-data, and business-owner approval boundaries before customer-facing SLA language is published.",
    },
    {
      id: "support",
      owner: "Support Workflow",
      promise:
        "Consumes severity, channel, handoff, unsupported-request, and owner-route evidence without adding live queues or staffing workflows.",
    },
  ]),
  channels: Object.freeze([
    {
      id: "support-ticket",
      availability: "beta business-hours intake; GA coverage requires owner approval",
      customerVisible: true,
      evidence: "ticket intake fixture with severity and owner fields",
    },
    {
      id: "status-page",
      availability: "customer-impacting incident updates only after redaction and incident evidence",
      customerVisible: true,
      evidence: "incident communication template linked to HOBO-408",
    },
    {
      id: "launch-room",
      availability: "internal launch stakeholder coordination during beta and release cutline review",
      customerVisible: false,
      evidence: "launch-room handoff note with owner and next decision",
    },
    {
      id: "customer-email",
      availability: "approved customer communication for named affected accounts",
      customerVisible: true,
      evidence: "redacted email template with incident or support ticket source",
    },
    {
      id: "docs-faq",
      availability: "approved answer and limitation source for SEV3 questions and unsupported states",
      customerVisible: true,
      evidence: "docs/support FAQ entry or release-note limitation",
    },
  ]),
  responseTargets: Object.freeze([
    {
      severity: "sev0",
      supportHours: "24x7 internal interrupt target during launch windows only",
      internalTarget: "Immediate internal triage and incident commander handoff.",
      betaPromise: "Customer acknowledgement after impact and communication owner are confirmed.",
      handoffRule: "Escalate to Incident Communications and V1 Release Program when impact is customer-visible or unclear.",
    },
    {
      severity: "sev1",
      supportHours: "launch-window coverage plus next business-day owner review",
      internalTarget: "Same launch-window routing to support lead and owning operator lane.",
      betaPromise: "Support ticket update when workaround, owner, or next update condition is known.",
      handoffRule: "Escalate to Incident Communications if customer-visible; otherwise route to Support Workflow owner.",
    },
    {
      severity: "sev2",
      supportHours: "business-hours beta support",
      internalTarget: "Triage to product, admin console, docs, or support owner within the beta support window.",
      betaPromise: "Best-effort ticket update with limitation, workaround, or follow-up owner.",
      handoffRule: "Escalate to Admin Console when missing tenant, entitlement, project, or environment context blocks support.",
    },
    {
      severity: "sev3",
      supportHours: "business-hours documentation and launch-readiness routing",
      internalTarget: "Answer from approved material or file a readiness gap.",
      betaPromise: "No operational response commitment beyond approved beta support material.",
      handoffRule: "Escalate to V1 Release Program & Cutline when the answer changes launch readiness or public claims.",
    },
  ]),
  slaLanguage: Object.freeze([
    {
      mode: "internal-target",
      customerFacing: false,
      contractual: false,
      requiresBusinessOwnerApproval: false,
      rule: "Internal targets guide staffing and triage; they are not quoted externally.",
    },
    {
      mode: "beta-promise",
      customerFacing: true,
      contractual: false,
      requiresBusinessOwnerApproval: false,
      rule: "Beta promises are customer-visible limitations backed by accepted evidence, not contractual SLA guarantees.",
    },
    {
      mode: "ga-customer-commitment",
      customerFacing: true,
      contractual: true,
      requiresBusinessOwnerApproval: true,
      rule: "GA customer-facing commitments require accepted evidence and explicit business-owner signoff before publication.",
    },
  ]),
  unsupportedRequestClasses: Object.freeze([
    {
      id: "contractual-sla-negotiation",
      owner: "Business Owner / Legal",
      customerMessage: "Contractual support terms are not self-approved by support.",
    },
    {
      id: "custom-production-data-access",
      owner: "Security Verification / Legal",
      customerMessage: "Support cannot access customer data without an approved security and legal path.",
    },
    {
      id: "unsupported-install-environment",
      owner: "Bootstrap Installer",
      customerMessage: "Unsupported environments route to installer limitations and troubleshooting evidence.",
    },
    {
      id: "unproven-backup-restore-claim",
      owner: "Backup & Restore",
      customerMessage: "Restore readiness requires accepted drill evidence before support can claim it.",
    },
    {
      id: "release-cutline-exception",
      owner: "V1 Release Program & Cutline",
      customerMessage: "Launch exception requests route to the release owner before support promises change.",
    },
  ]),
  escalationLinks: Object.freeze([
    {
      owner: "Support Workflow",
      source: "docs/design/support-sla-channels.md",
      consumes: "Channel coverage, response language, unsupported-request routing, and follow-up gate.",
      boundary: "Ticket queues, staffing workflows, and helpdesk integrations remain later support implementation work.",
    },
    {
      owner: "Incident Communications",
      source: "docs/design/launch-support-escalation.md",
      consumes: "SEV0/SEV1 customer-visible incident handoff and status-page redaction rules.",
      boundary: "Incident communication templates and publication workflows remain governed by the HOBO-408 escalation record.",
    },
    {
      owner: "Admin Console",
      source: "docs/design/member-rbac-administration.md",
      consumes: "Tenant, project, entitlement, role, and environment visibility gaps that block support triage.",
      boundary: "Admin console UI, RBAC changes, and tenant-data access stay out of this issue.",
    },
    {
      owner: "V1 Release Program & Cutline",
      source: "docs/design/release-notes-upgrade-guide.md",
      consumes: "Public commitment language, beta limitation wording, and launch-readiness exceptions.",
      boundary: "Release go/no-go and customer-facing terms approval stay with release and business owners.",
    },
  ]),
  m1Evidence: Object.freeze([
    {
      id: "support-model-record",
      owner: "support-lead",
      mode: "design-record",
      source: "docs/design/support-sla-channels.md",
      proves: "Channels, hours, severity routes, handoff rules, and unsupported classes are accepted.",
    },
    {
      id: "channel-coverage-table",
      owner: "support-operator",
      mode: "reference-fixture",
      source: "docs/design/support-sla-channels.md#support-channels-and-hours",
      proves: "Each support channel names availability, customer visibility, and evidence source.",
    },
    {
      id: "response-language-register",
      owner: "release-owner",
      mode: "policy-fixture",
      source: "docs/design/support-sla-channels.md#sla-language-boundary",
      proves: "Internal targets, beta promises, and GA commitments are separated before publication.",
    },
    {
      id: "escalation-integration-fixture",
      owner: "incident-commander",
      mode: "support-handoff",
      source: "docs/design/launch-support-escalation.md",
      proves: "Support, incident communication, admin console, and release cutline handoffs have owners.",
    },
    {
      id: "unsupported-request-router",
      owner: "security-compliance-reviewer",
      mode: "contract-test",
      source: "docs/design/support-sla-channels.md#unsupported-request-classes",
      proves: "Unsupported requests route to the correct owner instead of becoming silent promises.",
    },
    {
      id: "owner-signoff-gate",
      owner: "business-owner",
      mode: "approval-record",
      source: "docs/design/support-sla-channels.md#follow-up-gate",
      proves: "Contractual SLA publication remains blocked until evidence and business-owner signoff exist.",
    },
  ]),
  followUpGate: Object.freeze({
    rule:
      "Create M1/M2/M3/M4 support SLA, channel, tooling, or publication work only after this M0 scope record and executable proof are accepted.",
  }),
});

export function canCreateSupportSlaFollowUp({ phase, m0Accepted }) {
  if (!IMPLEMENTATION_PHASES.has(phase)) {
    return {
      allowed: true,
      reason: "M0 scope work is allowed before acceptance.",
    };
  }

  if (!m0Accepted) {
    return {
      allowed: false,
      reason: "HOBO-496 M0 support SLA/channel scope is not accepted.",
    };
  }

  return {
    allowed: true,
    reason: "Support SLA/channel follow-up may reference the accepted HOBO-496 record.",
  };
}

export function canPublishContractualSla({ mode, businessOwnerApproved, evidenceAccepted }) {
  if (mode !== "ga-customer-commitment") {
    return {
      allowed: Boolean(evidenceAccepted),
      reason: "Non-contractual support language still needs accepted evidence before publication.",
    };
  }

  if (!businessOwnerApproved) {
    return {
      allowed: false,
      reason: "GA customer-facing SLA commitments require business-owner approval.",
    };
  }

  if (!evidenceAccepted) {
    return {
      allowed: false,
      reason: "GA customer-facing SLA commitments require accepted support evidence.",
    };
  }

  return {
    allowed: true,
    reason: "Contractual SLA language has business-owner approval and accepted evidence.",
  };
}

export function classifySupportRequest(request) {
  const text = String(request ?? "").toLowerCase();

  if (/\b(contractual|enterprise|legal|agreement|paid support)\b.*\b(sla|terms?|plan)?\b/.test(text)) {
    return { owner: "Business Owner / Legal", inScope: false };
  }

  if (/\b(admin console|tenant visibility|entitlement|project visibility|environment visibility)\b/.test(text)) {
    return { owner: "Admin Console", inScope: false };
  }

  if (/\b(incident communication|status page|public incident|customer update)\b/.test(text)) {
    return { owner: "Incident Communications", inScope: false };
  }

  if (/\b(release cutline|launch exception|public claim|support hours)\b/.test(text)) {
    return { owner: "V1 Release Program & Cutline", inScope: false };
  }

  if (/\b(backup|restore|recovery)\b/.test(text)) {
    return { owner: "Backup & Restore", inScope: false };
  }

  return { owner: "Support Workflow", inScope: true };
}

export function validateSupportSlaChannelsScope(scope) {
  const errors = [];

  if (scope?.issue !== "HOBO-496") {
    errors.push("issue must be HOBO-496");
  }
  if (scope?.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!/support/i.test(scope?.goal ?? "") || !/sla/i.test(scope?.goal ?? "")) {
    errors.push("goal must name support and SLA coverage");
  }
  if ((scope?.personas ?? []).length < 5) {
    errors.push("at least five personas are required");
  }

  const boundaryIds = new Set((scope?.boundaries ?? []).map((boundary) => boundary.id));
  for (const boundary of REQUIRED_BOUNDARIES) {
    if (!boundaryIds.has(boundary)) {
      errors.push(`missing ${boundary} boundary`);
    }
  }

  for (const item of scope?.scopeIn ?? []) {
    for (const forbidden of FORBIDDEN_SCOPE_PATTERNS) {
      if (forbidden.pattern.test(item)) {
        errors.push(`scope creep (${forbidden.label}): ${item}`);
      }
    }
  }

  const channelIds = (scope?.channels ?? []).map((channel) => channel.id);
  if (JSON.stringify(channelIds) !== JSON.stringify(REQUIRED_CHANNELS)) {
    errors.push("support channels must include ticket, status page, launch room, email, and FAQ");
  }
  for (const channel of scope?.channels ?? []) {
    if (!channel.availability || !channel.evidence) {
      errors.push(`channel ${channel.id ?? "<unknown>"} must name availability and evidence`);
    }
  }

  const severities = (scope?.responseTargets ?? []).map((target) => target.severity);
  if (JSON.stringify(severities) !== JSON.stringify(["sev0", "sev1", "sev2", "sev3"])) {
    errors.push("response targets must cover sev0 through sev3");
  }
  for (const target of scope?.responseTargets ?? []) {
    if (!target.supportHours || !target.internalTarget || !target.betaPromise || !target.handoffRule) {
      errors.push(`${target.severity ?? "severity"} must name support hours, target, beta promise, and handoff rule`);
    }
  }

  const languageModes = (scope?.slaLanguage ?? []).map((entry) => entry.mode);
  if (JSON.stringify(languageModes) !== JSON.stringify(["internal-target", "beta-promise", "ga-customer-commitment"])) {
    errors.push("SLA language must separate internal target, beta promise, and GA customer commitment");
  }
  const ga = (scope?.slaLanguage ?? []).find((entry) => entry.mode === "ga-customer-commitment");
  if (!ga?.requiresBusinessOwnerApproval || !ga?.contractual || !ga?.customerFacing) {
    errors.push("GA customer commitment must be contractual, customer-facing, and business-owner approved");
  }

  if ((scope?.unsupportedRequestClasses ?? []).length < 5) {
    errors.push("unsupported request classes must be explicit");
  }
  for (const unsupported of scope?.unsupportedRequestClasses ?? []) {
    if (!unsupported.owner || !unsupported.customerMessage) {
      errors.push(`unsupported request ${unsupported.id ?? "<unknown>"} must name owner and customer message`);
    }
  }

  const escalationOwners = (scope?.escalationLinks ?? []).map((link) => link.owner);
  if (JSON.stringify(escalationOwners) !== JSON.stringify(REQUIRED_ESCALATION_OWNERS)) {
    errors.push("escalation links must cover support, incident communications, admin console, and release cutline");
  }
  for (const link of scope?.escalationLinks ?? []) {
    if (!link.source || !link.consumes || !link.boundary) {
      errors.push(`escalation link ${link.owner ?? "<unknown>"} must name source, consumption, and boundary`);
    }
  }

  for (const evidence of scope?.m1Evidence ?? []) {
    if (!evidence.owner || !evidence.mode || !evidence.source || !evidence.proves) {
      errors.push(`evidence ${evidence.id ?? "<unknown>"} must name owner, mode, source, and proof`);
    }
  }
  if ((scope?.m1Evidence ?? []).length < 6) {
    errors.push("M1 evidence must cover support model, channels, language, escalation, unsupported requests, and signoff");
  }

  if (!scope?.followUpGate?.rule) {
    errors.push("follow-up gate must record a blocking rule");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}
