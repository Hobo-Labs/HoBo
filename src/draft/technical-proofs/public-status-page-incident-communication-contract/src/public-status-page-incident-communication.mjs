export const REQUIRED_DEPENDENCY_TARGETS = [
  "HOBO-496 support SLA and channel readiness",
  "docs/design/reliability-observability-cost.md#plan-05",
  "docs/design/launch-support-escalation.md",
  "docs/design/adr/02-identity-security.md#adr-0045",
  "docs/design/adr/03-data-plane.md#adr-0058",
];

const FOLLOW_UP_PHASES = new Set(["M1", "M2", "M3", "M4"]);

const FORBIDDEN_SCOPE_PATTERNS = [
  /live status-page publishing/i,
  /status-page publish(?:ing)? flow/i,
  /implement .*status/i,
  /ticket automation/i,
  /runbook execution/i,
  /notification dispatch/i,
  /customer-specific/i,
  /customer data/i,
  /customer_email/i,
  /guarantee/i,
  /guaranteed/i,
  /\b\d+\s*(minute|minutes|min|hour|hours|hr|hrs)\b/i,
  /\bSLA\b/i,
];

export const PUBLIC_STATUS_PAGE_CONTRACT = {
  issue: "HOBO-497",
  phase: "M0",
  project: "Incident Communications",
  goal:
    "Define the public status page and incident communication contract for v1 launch without building the live publish flow, support tooling, or customer-facing SLA promises.",
  statusPageScope: [
    {
      area: "public-components",
      includes:
        "Customer-readable component groups, current status, degraded capability labels, and linked owning readiness domain.",
      excludes: "Raw provider topology, private tenant identifiers, internal host names, and debug-only runbook state.",
    },
    {
      area: "active-incidents",
      includes:
        "Public incident summary, affected components, state, last update, next update condition, and customer-safe impact language.",
      excludes: "Unredacted incident timeline, responder notes, private support tickets, and speculative root cause.",
    },
    {
      area: "planned-maintenance",
      includes:
        "Maintenance window, expected customer impact, affected components, rollback posture, and cancellation/completion updates.",
      excludes: "Change execution automation, deploy pipeline implementation, and direct provider maintenance orchestration.",
    },
    {
      area: "history-and-subscriptions",
      includes:
        "Launch-safe incident history, maintenance history, subscription handoff expectations, and retention/visibility boundaries.",
      excludes: "Live subscriber management, notification delivery service, and customer-specific incident exports.",
    },
  ],
  componentTaxonomy: [
    {
      id: "control-plane-api",
      label: "Control Plane API",
      ownerLane: "operators-sre",
      evidence: "control-plane availability and deploy API health.",
    },
    {
      id: "deployments",
      label: "Deployments and Planner",
      ownerLane: "reliability-observability-cost",
      evidence: "deploy success rate, queue saturation, and rollback/compensation evidence.",
    },
    {
      id: "identity-auth",
      label: "Identity and Auth",
      ownerLane: "security",
      evidence: "token broker, issuer, session, and auth-port health evidence.",
    },
    {
      id: "runtime-camps",
      label: "Runtime Camps",
      ownerLane: "runtime-operations",
      evidence: "Camp runtime availability, workload execution, and per-Camp degraded labels.",
    },
    {
      id: "docs-and-support",
      label: "Docs and Support",
      ownerLane: "support",
      evidence: "docs portal, support intake, and customer communication readiness.",
    },
  ],
  incidentStates: [
    {
      id: "investigating",
      publicMeaning: "HoBo has confirmed a possible customer-visible issue and is gathering evidence.",
      requiredEvidence: "incident record or support/customer report with affected component candidate.",
    },
    {
      id: "identified",
      publicMeaning: "HoBo has identified the affected component or mitigation path.",
      requiredEvidence: "incident timeline or responder note approved for customer-safe wording.",
    },
    {
      id: "monitoring",
      publicMeaning: "A mitigation is applied and HoBo is watching recovery evidence.",
      requiredEvidence: "mitigation event, SLO/health evidence, or support verification note.",
    },
    {
      id: "resolved",
      publicMeaning: "Customer-visible impact has ended or the maintenance event is complete.",
      requiredEvidence: "resolved incident record or approved maintenance completion evidence.",
    },
  ],
  maintenanceNoticeStates: [
    {
      id: "scheduled",
      requiredFields: ["window_start", "window_end", "affected_components", "expected_impact"],
    },
    {
      id: "in-progress",
      requiredFields: ["incident_id", "affected_components", "current_status", "next_update_condition"],
    },
    {
      id: "completed",
      requiredFields: ["incident_id", "completion_summary", "customer_action", "followup_owner"],
    },
    {
      id: "canceled",
      requiredFields: ["incident_id", "cancellation_reason", "customer_action", "followup_owner"],
    },
  ],
  updateCadence: [
    {
      state: "investigating",
      rule: "Update when scope, affected component, workaround, or next-update condition changes.",
    },
    {
      state: "identified",
      rule: "Update when mitigation starts, customer action changes, or risk classification changes.",
    },
    {
      state: "monitoring",
      rule: "Update when health/SLO evidence confirms recovery or regression.",
    },
    {
      state: "resolved",
      rule: "Publish final customer-safe resolution summary with follow-up owner or known limitation.",
    },
    {
      state: "scheduled-maintenance",
      rule: "Publish schedule, start, material change, completion, or cancellation updates.",
    },
  ],
  incidentTriggers: [
    {
      source: "slo-burn",
      visibility: "internal",
      publicationGate: "customer-visible component impact confirmed by incident commander.",
    },
    {
      source: "synthetic-monitor",
      visibility: "internal",
      publicationGate: "multi-signal confirmation or support/customer corroboration.",
    },
    {
      source: "support-ticket",
      visibility: "external-candidate",
      publicationGate: "support lead confirms broader impact or named affected customer communication need.",
    },
    {
      source: "customer-report",
      visibility: "external-candidate",
      publicationGate: "support lead redacts customer data and confirms component mapping.",
    },
    {
      source: "planned-maintenance",
      visibility: "external-candidate",
      publicationGate: "release owner approves public window, impact, and rollback posture.",
    },
  ],
  customerTemplates: [
    {
      kind: "initial-incident",
      audience: "affected customers and public status subscribers",
      channel: "status page",
      requiredFields: ["incident_id", "affected_components", "current_status", "next_update_condition"],
      evidenceSource: "incident record impact summary",
      redactionGate: true,
      body:
        "We are investigating {{incident_id}} affecting {{affected_components}}. Current status: {{current_status}}. Next update when {{next_update_condition}}.",
    },
    {
      kind: "progress-update",
      audience: "affected customers and launch stakeholders",
      channel: "status page or support ticket",
      requiredFields: ["incident_id", "affected_components", "current_status", "known_workaround", "next_update_condition"],
      evidenceSource: "incident timeline and responder evidence",
      redactionGate: true,
      body:
        "{{incident_id}} update for {{affected_components}}: {{current_status}}. Workaround: {{known_workaround}}. Next update when {{next_update_condition}}.",
    },
    {
      kind: "maintenance-notice",
      audience: "public status subscribers",
      channel: "status page",
      requiredFields: ["incident_id", "window_start", "window_end", "affected_components", "expected_impact"],
      evidenceSource: "approved maintenance plan",
      redactionGate: true,
      body:
        "Scheduled maintenance {{incident_id}} for {{affected_components}} from {{window_start}} to {{window_end}}. Expected impact: {{expected_impact}}.",
    },
    {
      kind: "resolution",
      audience: "affected customers and public status subscribers",
      channel: "status page or support ticket",
      requiredFields: ["incident_id", "affected_components", "resolution_summary", "followup_owner"],
      evidenceSource: "resolved incident record",
      redactionGate: true,
      body:
        "{{incident_id}} affecting {{affected_components}} is resolved. Summary: {{resolution_summary}}. Follow-up owner: {{followup_owner}}.",
    },
  ],
  unsupportedStatusDimensions: [
    {
      id: "per-tenant-private-debug",
      reason: "Private tenant state belongs in support/admin tooling, not public status.",
    },
    {
      id: "raw-provider-internal-topology",
      reason: "Provider internals are not a customer-facing component taxonomy.",
    },
    {
      id: "unverified-root-cause",
      reason: "Speculative root-cause text cannot be published as status evidence.",
    },
    {
      id: "contractual-response-sla",
      reason: "Support SLA commitments require business/legal owner approval and live support policy.",
    },
    {
      id: "customer-specific-data",
      reason: "Customer identifiers, ticket details, and private impact details require support-channel handling.",
    },
  ],
  dependencies: [
    {
      target: "HOBO-496 support SLA and channel readiness",
      use: "Names support-SLA ownership while keeping contractual SLA approval out of this issue.",
    },
    {
      target: "docs/design/reliability-observability-cost.md#plan-05",
      use: "Provides SLO, alert, burn-rate, health, and observability evidence inputs for public status decisions.",
    },
    {
      target: "docs/design/launch-support-escalation.md",
      use: "Provides severity, support/debug prerequisites, redaction, and incident template handoff context.",
    },
    {
      target: "docs/design/adr/02-identity-security.md#adr-0045",
      use: "Pins SLO-as-code, error-budget gating, and alerting as status evidence sources.",
    },
    {
      target: "docs/design/adr/03-data-plane.md#adr-0058",
      use: "Pins incident management, runbooks, and SRE escalation as the operational incident source.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1-M4 status page implementation, live notification, subscriber management, and support-SLA work must wait until this status contract is accepted.",
  },
};

export function canCreateStatusPageFollowUp({ phase, m0Accepted }) {
  return Boolean(m0Accepted) && FOLLOW_UP_PHASES.has(phase);
}

export function validatePublicStatusPageContract(contract) {
  const errors = [];

  if (contract.issue !== "HOBO-497") {
    errors.push("issue must be HOBO-497");
  }
  if (contract.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!contract.goal?.toLowerCase().includes("public status page")) {
    errors.push("goal must name public status page");
  }
  if (!contract.goal?.toLowerCase().includes("incident communication")) {
    errors.push("goal must name incident communication");
  }

  validateStatusPageScope(contract.statusPageScope, errors);
  validateComponents(contract.componentTaxonomy, errors);
  validateStates(contract.incidentStates, "incident states", errors);
  validateStates(contract.maintenanceNoticeStates, "maintenance notice states", errors);
  validateUpdateCadence(contract.updateCadence, errors);
  validateTriggers(contract.incidentTriggers, errors);
  validateTemplates(contract.customerTemplates, errors);
  validateUnsupportedDimensions(contract.unsupportedStatusDimensions, errors);
  validateDependencies(contract.dependencies, errors);

  if (!contract.followUpGate?.allowedAfter || !contract.followUpGate?.blockedBefore) {
    errors.push("follow-up gate must define allowed and blocked states");
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

function validateStatusPageScope(statusPageScope, errors) {
  const requiredAreas = [
    "public-components",
    "active-incidents",
    "planned-maintenance",
    "history-and-subscriptions",
  ];
  const areas = (statusPageScope ?? []).map((entry) => entry.area);

  if (JSON.stringify(areas) !== JSON.stringify(requiredAreas)) {
    errors.push("status page scope must cover public components, active incidents, planned maintenance, and history/subscriptions");
  }

  for (const entry of statusPageScope ?? []) {
    if (!entry.includes || !entry.excludes) {
      errors.push(`status page scope ${entry.area ?? "<unknown>"} must include inclusions and exclusions`);
    }
    pushForbiddenScopeErrors(entry.includes ?? "", errors);
  }
}

function validateComponents(componentTaxonomy, errors) {
  if (!Array.isArray(componentTaxonomy) || componentTaxonomy.length < 5) {
    errors.push("component taxonomy must include the launch component groups");
    return;
  }

  for (const component of componentTaxonomy) {
    if (!component.id || !component.label || !component.ownerLane || !component.evidence) {
      errors.push(`component ${component.id ?? "<unknown>"} must name label, owner lane, and evidence`);
    }
  }
}

function validateStates(states, label, errors) {
  if (!Array.isArray(states) || states.length === 0) {
    errors.push(`${label} must not be empty`);
    return;
  }

  for (const state of states) {
    if (!state.id) {
      errors.push(`${label} must include ids`);
    }
  }
}

function validateUpdateCadence(updateCadence, errors) {
  if (!Array.isArray(updateCadence) || updateCadence.length < 5) {
    errors.push("update cadence must cover incident and maintenance states");
    return;
  }

  for (const cadence of updateCadence) {
    if (!cadence.state || !cadence.rule) {
      errors.push("update cadence entries must name state and rule");
    }
  }
}

function validateTriggers(incidentTriggers, errors) {
  const visibilitySet = new Set((incidentTriggers ?? []).map((trigger) => trigger.visibility));
  if (!visibilitySet.has("internal") || !visibilitySet.has("external-candidate")) {
    errors.push("incident triggers must separate internal and external candidates");
  }

  for (const trigger of incidentTriggers ?? []) {
    if (!trigger.source || !trigger.visibility || !trigger.publicationGate) {
      errors.push(`incident trigger ${trigger.source ?? "<unknown>"} must name visibility and publication gate`);
    }
  }
}

function validateTemplates(customerTemplates, errors) {
  if (!Array.isArray(customerTemplates) || customerTemplates.length < 4) {
    errors.push("customer templates must cover incident, progress, maintenance, and resolution");
    return;
  }

  for (const template of customerTemplates) {
    if (!template.kind || !template.audience || !template.channel) {
      errors.push("customer templates must name kind, audience, and channel");
    }
    if (!template.evidenceSource) {
      errors.push(`${template.kind ?? "template"} must name evidence source`);
    }
    if (!template.redactionGate) {
      errors.push(`${template.kind ?? "template"} must pass redaction gate before publication`);
    }
    if (!Array.isArray(template.requiredFields) || !template.requiredFields.includes("incident_id")) {
      errors.push(`${template.kind ?? "template"} must include incident_id`);
    }
    pushForbiddenScopeErrors(template.body ?? "", errors);
  }
}

function validateUnsupportedDimensions(unsupportedStatusDimensions, errors) {
  if (!Array.isArray(unsupportedStatusDimensions) || unsupportedStatusDimensions.length < 5) {
    errors.push("unsupported status dimensions must document unavailable or unsafe public status dimensions");
    return;
  }

  for (const dimension of unsupportedStatusDimensions) {
    if (!dimension.id || !dimension.reason) {
      errors.push("unsupported status dimensions must name id and reason");
    }
  }
}

function validateDependencies(dependencies, errors) {
  const targets = (dependencies ?? []).map((dependency) => dependency.target);

  if (JSON.stringify(targets) !== JSON.stringify(REQUIRED_DEPENDENCY_TARGETS)) {
    errors.push("dependencies must link support SLA, reliability/SLO evidence, launch support escalation, SLO ADR, and incident ADR");
  }

  for (const dependency of dependencies ?? []) {
    if (!dependency.use) {
      errors.push(`dependency ${dependency.target ?? "<unknown>"} must describe its use`);
    }
  }
}

function pushForbiddenScopeErrors(text, errors) {
  for (const pattern of FORBIDDEN_SCOPE_PATTERNS) {
    if (pattern.test(text)) {
      if (/SLA|guarantee|\d+\s*(minute|minutes|min|hour|hours|hr|hrs)/i.test(text)) {
        errors.push(`unapproved SLA promise detected: ${text}`);
      } else if (/customer-specific|customer data|customer_email/i.test(text)) {
        errors.push(`customer data leakage detected: ${text}`);
      } else if (/live status-page publishing|status-page publish/i.test(text)) {
        errors.push(`live status-page publishing scope creep: ${text}`);
      } else {
        errors.push(`scope creep detected: ${text}`);
      }
    }
  }
}
