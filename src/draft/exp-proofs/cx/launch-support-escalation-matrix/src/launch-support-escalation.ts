export const requiredLaunchSupportRoutes = [
  "support",
  "admin-console",
  "operators-sre",
  "reliability-observability-cost",
];

export const launchSupportEscalationMatrix = {
  issue: "HOBO-408",
  phase: "M0",
  project: "V1 Launch Support Desk & Escalation",
  goal:
    "Define the launch support escalation matrix, coverage assumptions, and incident communication templates before beta and GA readiness work proceeds.",
  designRefs: [
    "docs/design/operators-sre.md#plan-40",
    "docs/design/developer-experience.md#plan-49",
    "docs/design/reliability-observability-cost.md#plan-05",
    "docs/design/adr/03-data-plane.md#adr-0058",
  ],
  personas: [
    {
      role: "support-lead",
      responsibility: "Owns intake quality, customer context, and support queue handoff.",
    },
    {
      role: "incident-commander",
      responsibility: "Coordinates severity, owner routing, and incident record hygiene.",
    },
    {
      role: "first-responder",
      responsibility: "Starts triage, gathers evidence, and confirms the first escalation path.",
    },
    {
      role: "customer-communications-owner",
      responsibility: "Publishes approved customer updates after redaction and evidence checks.",
    },
    {
      role: "release-owner",
      responsibility: "Approves launch readiness gaps and response commitment language.",
    },
  ],
  scopeIn: [
    "Launch severity definitions",
    "First-week coverage expectations",
    "Escalation owner routing",
    "Customer communication template drafts",
    "Support/debug tooling prerequisites",
  ],
  scopeOut: [
    "Support tooling implementation",
    "Customer-facing response SLA commitments without owner approval",
  ],
  severityLevels: [
    {
      id: "sev0",
      label: "Customer-impacting outage or data safety risk",
      firstResponder: "on-call first responder",
      escalationOwner: "incident commander plus operators/SRE owner",
      expectedResponse:
        "Begin live triage, open an incident record, and escalate to the incident commander immediately.",
      customerCommunication: {
        channel: "status page plus named customer channel when affected accounts are known",
        requiredFields: ["incident_id", "impact_summary", "current_status", "next_update_condition"],
        redactionGate: true,
      },
      handoffCriteria: [
        "Impact scope is confirmed or still unknown after initial triage.",
        "Any data safety, auth, networking, or deploy rollback decision is needed.",
        "Customer update needs approval before publication.",
      ],
    },
    {
      id: "sev1",
      label: "Major degraded production path",
      firstResponder: "support lead or on-call first responder",
      escalationOwner: "operators/SRE owner",
      expectedResponse:
        "Open an incident record, attach evidence, and route to the owning operational lane.",
      customerCommunication: {
        channel: "status page when customer-visible, otherwise support ticket update",
        requiredFields: ["incident_id", "affected_capability", "known_workaround", "next_update_condition"],
        redactionGate: true,
      },
      handoffCriteria: [
        "Workaround is unavailable or unverified.",
        "A rollback, provider escalation, or runbook action is required.",
      ],
    },
    {
      id: "sev2",
      label: "Limited feature regression or support-facing defect",
      firstResponder: "support lead",
      escalationOwner: "admin console or product release owner",
      expectedResponse:
        "Collect reproduction evidence, classify the affected product lane, and file a follow-up issue.",
      customerCommunication: {
        channel: "support ticket update",
        requiredFields: ["ticket_id", "affected_feature", "workaround_or_status", "followup_owner"],
        redactionGate: true,
      },
      handoffCriteria: [
        "A support operator cannot resolve the issue from documented evidence.",
        "The defect requires admin tooling, product decision, or customer-specific mitigation.",
      ],
    },
    {
      id: "sev3",
      label: "Question, documentation gap, or launch readiness follow-up",
      firstResponder: "support queue owner",
      escalationOwner: "support lead",
      expectedResponse:
        "Answer from approved launch material or route the gap to the owning readiness project.",
      customerCommunication: {
        channel: "support ticket or launch FAQ update",
        requiredFields: ["ticket_id", "question", "approved_answer_or_gap", "owner_lane"],
        redactionGate: true,
      },
      handoffCriteria: [
        "No approved answer exists.",
        "The question exposes a missing beta or GA readiness criterion.",
      ],
    },
  ],
  toolingPrerequisites: [
    {
      area: "observability-access",
      ownerLane: "reliability-observability-cost",
      prerequisite: "Support can read scoped metrics, logs, traces, and SLO burn context for affected projects.",
    },
    {
      area: "incident-timeline",
      ownerLane: "operators-sre",
      prerequisite: "Incident records preserve opened, classified, escalated, mitigated, and resolved events.",
    },
    {
      area: "tenant-context",
      ownerLane: "admin-console",
      prerequisite:
        "Support can identify affected account, project, environment, plan, and entitlement context without secret exposure.",
    },
    {
      area: "status-page-redaction",
      ownerLane: "support",
      prerequisite:
        "Customer updates pass redaction review before internal incident details become public status text.",
    },
    {
      area: "runbook-notification",
      ownerLane: "operators-sre",
      prerequisite:
        "Runbook and hobo:notify handoffs expose owner, acknowledgement, escalation, and deadline state.",
    },
    {
      area: "release-feature-context",
      ownerLane: "support",
      prerequisite:
        "Support can map a ticket to launch phase, feature flag, release, and known limitation evidence.",
    },
  ],
  communicationTemplates: [
    {
      kind: "initial-ack",
      audience: "affected customers",
      channel: "support ticket or status page",
      redactionGate: true,
      evidenceSource: "incident record impact summary",
      body:
        "We are investigating {{incident_id}} affecting {{impact_summary}}. Current status: {{current_status}}. Next update when {{next_update_condition}}.",
    },
    {
      kind: "investigation-update",
      audience: "affected customers and launch stakeholders",
      channel: "support ticket, status page, or launch-room update",
      redactionGate: true,
      evidenceSource: "incident timeline and responder notes",
      body:
        "{{incident_id}} remains under investigation. Confirmed impact: {{impact_summary}}. Known workaround: {{known_workaround}}. Next update when {{next_update_condition}}.",
    },
    {
      kind: "mitigation-update",
      audience: "affected customers and launch stakeholders",
      channel: "support ticket or status page",
      redactionGate: true,
      evidenceSource: "mitigation event and runbook output",
      body:
        "Mitigation is in progress for {{incident_id}}. Action taken: {{mitigation_summary}}. Customer action needed: {{customer_action}}. Next update when {{next_update_condition}}.",
    },
    {
      kind: "resolution-followup",
      audience: "affected customers and internal launch review",
      channel: "support ticket, status page resolution, or postmortem note",
      redactionGate: true,
      evidenceSource: "resolved incident record and follow-up issue links",
      body:
        "{{incident_id}} is resolved. Resolution summary: {{resolution_summary}}. Follow-up owner: {{followup_owner}}. Preventive action: {{preventive_action}}.",
    },
  ],
  gapRoutes: [
    {
      gap: "Missing support queue procedure, FAQ, or customer response owner",
      ownerLane: "support",
      followUpProject: "V1 Launch Support Desk & Escalation",
    },
    {
      gap: "Missing customer, tenant, project, entitlement, or launch phase visibility",
      ownerLane: "admin-console",
      followUpProject: "V1 Admin Console & Operator UX",
    },
    {
      gap: "Missing incident command, runbook, on-call, hobo:notify, or escalation evidence",
      ownerLane: "operators-sre",
      followUpProject: "Operator Agents, SRE & Incident Response",
    },
    {
      gap: "Missing metrics, logs, traces, SLO burn, alert routing, or cost context",
      ownerLane: "reliability-observability-cost",
      followUpProject: "Reliability, Observability & Cost Controls",
    },
  ],
};

const SCOPE_CREEP_PATTERN = /\b(build|implement|ship|wire|automate)\b.*\b(support|incident)\b.*\b(tooling|tool|automation|console)\b/i;
const SLA_PROMISE_PATTERN = /\b(\d+\s*(minute|minutes|min|hour|hours|hr|hrs)|sla|guarantee|guaranteed)\b/i;

export function canOpenSupportExecutionIssue({ acceptedAt } = {}) {
  if (!acceptedAt) {
    return {
      allowed: false,
      reason: "HOBO-408 M0 support escalation record is not accepted.",
    };
  }

  return {
    allowed: true,
    reason: "Support execution issue may reference the accepted HOBO-408 record.",
  };
}

export function validateLaunchSupportEscalationMatrix(record) {
  const errors = [];

  if (record?.issue !== "HOBO-408") {
    errors.push("record.issue must be HOBO-408.");
  }

  if (record?.phase !== "M0") {
    errors.push("record.phase must be M0.");
  }

  if (!record?.goal || !/launch support/i.test(record.goal)) {
    errors.push("record.goal must describe launch support.");
  }

  if (!Array.isArray(record?.personas) || record.personas.length < 5) {
    errors.push("personas must name the launch support roles.");
  }

  if (!Array.isArray(record?.scopeOut) || !record.scopeOut.includes("Support tooling implementation")) {
    errors.push("scopeOut must exclude support tooling implementation.");
  }

  for (const scopeItem of record?.scopeIn ?? []) {
    if (SCOPE_CREEP_PATTERN.test(scopeItem)) {
      errors.push(`scopeIn item crosses support tooling implementation scope out: ${scopeItem}`);
    }
  }

  validateSeverityLevels(record?.severityLevels, errors);
  validateToolingPrerequisites(record?.toolingPrerequisites, errors);
  validateTemplates(record?.communicationTemplates, errors);
  validateGapRoutes(record?.gapRoutes, errors);

  return {
    valid: errors.length === 0,
    errors,
  };
}

function validateSeverityLevels(severityLevels, errors) {
  if (!Array.isArray(severityLevels) || severityLevels.length === 0) {
    errors.push("severityLevels must not be empty.");
    return;
  }

  for (const severity of severityLevels) {
    for (const field of [
      "id",
      "label",
      "firstResponder",
      "escalationOwner",
      "expectedResponse",
      "customerCommunication",
      "handoffCriteria",
    ]) {
      if (!severity[field] || (Array.isArray(severity[field]) && severity[field].length === 0)) {
        errors.push(`${severity.id ?? "severity"} is missing ${field}.`);
      }
    }

    if (SLA_PROMISE_PATTERN.test(severity.expectedResponse ?? "")) {
      errors.push(`${severity.id} expectedResponse promises customer-facing SLA terms without owner approval.`);
    }

    if (!severity.customerCommunication?.channel) {
      errors.push(`${severity.id} customerCommunication.channel is required.`);
    }

    if (!severity.customerCommunication?.redactionGate) {
      errors.push(`${severity.id} customer communication requires a redaction gate.`);
    }

    if (!Array.isArray(severity.customerCommunication?.requiredFields) || severity.customerCommunication.requiredFields.length === 0) {
      errors.push(`${severity.id} customer communication requiredFields are required.`);
    }
  }
}

function validateToolingPrerequisites(toolingPrerequisites, errors) {
  const requiredAreas = [
    "observability-access",
    "incident-timeline",
    "tenant-context",
    "status-page-redaction",
    "runbook-notification",
  ];
  const areas = new Set((toolingPrerequisites ?? []).map((item) => item.area));

  for (const area of requiredAreas) {
    if (!areas.has(area)) {
      errors.push(`tooling prerequisite ${area} is required.`);
    }
  }
}

function validateTemplates(communicationTemplates, errors) {
  if (!Array.isArray(communicationTemplates) || communicationTemplates.length === 0) {
    errors.push("communicationTemplates must not be empty.");
    return;
  }

  for (const template of communicationTemplates) {
    if (!template.redactionGate) {
      errors.push(`${template.kind ?? "template"} requires redaction before customer communication.`);
    }

    if (!template.evidenceSource) {
      errors.push(`${template.kind ?? "template"} requires an evidence source.`);
    }

    if (!template.body?.includes("{{incident_id}}")) {
      errors.push(`${template.kind ?? "template"} must carry incident_id placeholder.`);
    }

    if (SLA_PROMISE_PATTERN.test(template.body ?? "")) {
      errors.push(`${template.kind ?? "template"} promises customer-facing SLA terms without owner approval.`);
    }
  }
}

function validateGapRoutes(gapRoutes, errors) {
  const routeSet = new Set((gapRoutes ?? []).map((route) => route.ownerLane));

  for (const requiredRoute of requiredLaunchSupportRoutes) {
    if (!routeSet.has(requiredRoute)) {
      errors.push(`gap route ${requiredRoute} is required.`);
    }
  }
}
