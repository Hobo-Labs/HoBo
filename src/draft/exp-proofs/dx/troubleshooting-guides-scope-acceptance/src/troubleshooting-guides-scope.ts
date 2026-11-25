const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"];
const VALID_PROOF_MODES = new Set([
  "design-record",
  "contract-test",
  "reference-fixture",
  "agent-fixture",
  "redaction-rule",
  "support-handoff",
]);
const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);
const FORBIDDEN_SCOPE_PATTERNS = [
  /build .*support queue/i,
  /run .*production remediation/i,
  /(store|storing|capture|capturing|embed|embedding).*provider credentials?/i,
  /publish .*marketing/i,
  /implement .*runtime/i,
  /ship .*ui/i,
  /live customer data/i,
];

export const TROUBLESHOOTING_GUIDES_SCOPE = {
  issue: "HOBO-437",
  project: "Troubleshooting Guides",
  phase: "M0",
  goal:
    "Define the Troubleshooting Guides productization scope so humans and coding agents can diagnose common HoBo failures with safe evidence, owners, and escalation paths without hiding product, support, or runtime implementation inside docs work.",
  personas: [
    {
      role: "first-time app developer",
      need: "Map a failed first run, plan, deploy, auth, or inspection step to likely cause, safe retry, and evidence to keep.",
    },
    {
      role: "coding agent",
      need: "Follow deterministic symptom checks and refusal states without using private local knowledge or credentials.",
    },
    {
      role: "support operator",
      need: "Receive concise handoff records with symptom, owner, safe next action, and redacted evidence.",
    },
    {
      role: "platform engineer",
      need: "Separate local setup, provider catalog, policy, networking, identity, and hosted-service failure domains.",
    },
    {
      role: "docs maintainer",
      need: "Know which guides are canonical, which evidence refreshes them, and which owner updates each guide.",
    },
  ],
  scopeIn: [
    "Canonical troubleshooting taxonomy with symptom, likely owner, safe first action, evidence to collect, and escalation threshold.",
    "Guide families for local setup, hobo CLI, manifest and closure-builder authoring, auth and policy denials, provider/catalog readiness, networking/connectivity, deploy/reconcile, and hosted-service incidents.",
    "Agent-readable runbook snippets that use mocked or fixture-derived boundaries instead of live provider credentials.",
    "Redaction rules for logs, tokens, tenant identifiers, customer data, provider account IDs, and generated artifacts before support handoff.",
    "M1-ready acceptance checklist for taxonomy records, symptom-to-owner fixtures, safe-action examples, redaction rules, and support handoff examples.",
  ],
  scopeOut: [
    "Building support queues, ticket routing, SLA enforcement, on-call scheduling, or escalation tooling.",
    "Implementing runtime remediation, provider repair, control-plane behavior, CLI behavior, auth flows, or networking changes.",
    "Publishing launch marketing pages, screenshots, videos, or public incident statements.",
    "Using live customer data, provider credentials, production logs, or unredacted tenant evidence.",
    "Creating downstream M1-M4 implementation issues before this M0 scope record is accepted.",
  ],
  nonGoals: [
    "Replace product error messages or CLI diagnostics.",
    "Certify production support readiness from docs fixtures alone.",
    "Define final docs portal IA, search, analytics, or publishing workflow.",
    "Own incident communications, public status-page updates, or support SLA policy.",
  ],
  boundaries: {
    service:
      "Troubleshooting Guides define diagnostic contracts and evidence handoffs only; support systems, hosted operations, incident tooling, and product remediation stay in their owning projects.",
    ux:
      "Guide UX covers symptom grouping, state labels, evidence checklists, and safe next actions, not final docs portal screens or in-product UI.",
    security:
      "Guides must fail closed on static secrets, provider credentials, customer data, unredacted logs, and policy-bypass instructions; every guide names redaction and live-versus-fixture boundaries.",
    support:
      "Support handoff records symptom, likely owner, severity, safe next action, evidence source, and escalation threshold; queues, SLAs, and staffing remain separate.",
  },
  dependencies: [
    {
      source: "docs/design/developer-experience.md#plan-07",
      reason: "Defines CLI, local-dev, dashboard, and inspection surfaces whose failures troubleshooting guides classify.",
    },
    {
      source: "docs/design/walkthrough.md",
      reason: "Provides role journeys whose stuck states become guide entry points.",
    },
    {
      source: "docs/design/launch-support-escalation.md",
      reason: "Defines launch support escalation matrix and gap routing consumed by guide handoffs.",
    },
    {
      source: "docs/design/support-sla-channels.md",
      reason: "Defines channel coverage and unsupported request routing that guides must not override.",
    },
    {
      source: "docs/design/incident-communications.md",
      reason: "Separates troubleshooting guidance from customer-safe incident communications.",
    },
    {
      source: "docs/design/public-status-page-incident-communication.md",
      reason: "Separates public component and incident-state publication from guide evidence collection.",
    },
    {
      source: "docs/design/adr/07-portability-extensibility.md#adr-0064",
      reason: "Keeps business mechanics, marketing, and non-platform launch claims outside guide scope.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Troubleshooting Guides",
      consumes: "Accepted taxonomy, guide families, safe-action fixtures, redaction rules, and follow-up gate.",
      scopeBoundary: "This issue defines scope and acceptance; it does not build final guide content or support tooling.",
    },
    {
      owner: "Docs Portal",
      consumes: "Canonical taxonomy and guide metadata can become portal navigation and search inputs.",
      scopeBoundary: "Portal IA, search, publishing, analytics, and frontend remain outside Troubleshooting M0.",
    },
    {
      owner: "Support Workflow",
      consumes: "Handoff fixture shape and unsupported-state routing.",
      scopeBoundary: "Queues, assignment, SLA timers, and operator staffing remain in support workflow.",
    },
    {
      owner: "V1 Launch Support Desk & Escalation",
      consumes: "Escalation thresholds, severity labels, and launch gap routing.",
      scopeBoundary: "Launch desk process and escalation staffing remain outside guide scope.",
    },
    {
      owner: "Incident Communications",
      consumes: "Customer-safe evidence boundaries and incident handoff triggers.",
      scopeBoundary: "Public or customer incident statements remain in incident communications.",
    },
    {
      owner: "Public Status Page",
      consumes: "Component failure categories and evidence needed before a status-page update.",
      scopeBoundary: "Status components, maintenance notices, and publication cadence remain separate.",
    },
    {
      owner: "V1 Release Program & Cutline",
      consumes: "Readiness dashboards can classify unresolved troubleshooting-guide gaps by owner and proof mode.",
      scopeBoundary: "Go/no-go decisions, accepted risks, and release evidence aggregation stay in the cutline project.",
    },
  ],
  m1Evidence: [
    {
      kind: "guide-taxonomy",
      owner: "docs maintainer",
      proofMode: "design-record",
      proves: "Each guide family has symptom, owner, safe first action, evidence, and escalation threshold.",
    },
    {
      kind: "symptom-to-owner-map",
      owner: "platform engineer",
      proofMode: "reference-fixture",
      proves: "Local setup, CLI, auth, policy, provider, networking, deploy, and incident symptoms route to the right owner.",
    },
    {
      kind: "safe-action-fixtures",
      owner: "support operator",
      proofMode: "reference-fixture",
      proves: "Guides distinguish safe retry, collect evidence, escalate, and stop states.",
    },
    {
      kind: "agent-readable-runbook-snippets",
      owner: "coding agent",
      proofMode: "agent-fixture",
      proves: "Agent-facing guidance includes deterministic checks, expected output shape, and refusal states.",
    },
    {
      kind: "security-redaction-rules",
      owner: "security reviewer",
      proofMode: "redaction-rule",
      proves: "Logs, tokens, tenant identifiers, provider account IDs, and customer data are redacted before handoff.",
    },
    {
      kind: "support-escalation-handoff",
      owner: "support operator",
      proofMode: "support-handoff",
      proves: "Escalation records include symptom, severity, owner, evidence source, and safe next action.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 guide content, docs portal, support workflow, incident communication, and status-page issues must not be created until this record is accepted.",
  },
};

export function canCreateTroubleshootingFollowUp({ phase, m0Accepted }) {
  return Boolean(m0Accepted) && IMPLEMENTATION_PHASES.has(phase);
}

export function classifyTroubleshootingHandoff(text) {
  const normalized = String(text).toLowerCase();

  if (/(password|support queue|ticket|sla|refund|account)/.test(normalized)) {
    return "support-workflow";
  }
  if (/(outage|incident|customer update|degraded hosted|public statement)/.test(normalized)) {
    return "incident-communications";
  }
  if (/(status page|component health|maintenance|public component)/.test(normalized)) {
    return "public-status-page";
  }
  return "troubleshooting-guides";
}

export function validateTroubleshootingGuidesScope(scope) {
  const errors = [];

  if (scope.issue !== "HOBO-437") {
    errors.push("issue must be HOBO-437");
  }
  if (scope.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!scope.goal?.toLowerCase().includes("troubleshooting guides")) {
    errors.push("goal must name Troubleshooting Guides");
  }
  if ((scope.personas ?? []).length < 5) {
    errors.push("at least five personas are required");
  }
  if ((scope.scopeIn ?? []).length < 5) {
    errors.push("scope in must have at least five entries");
  }
  if ((scope.scopeOut ?? []).length < 5) {
    errors.push("scope out must have at least five entries");
  }
  if ((scope.nonGoals ?? []).length < 4) {
    errors.push("non-goals must have at least four entries");
  }

  for (const key of REQUIRED_BOUNDARIES) {
    if (!scope.boundaries?.[key]) {
      errors.push(`missing ${key} boundary`);
    }
  }

  for (const entry of scope.scopeIn ?? []) {
    if (FORBIDDEN_SCOPE_PATTERNS.some((pattern) => pattern.test(entry))) {
      errors.push(`scope creep: ${entry}`);
    }
  }

  for (const evidence of scope.m1Evidence ?? []) {
    if (!evidence.owner || !evidence.proves) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must name owner and proof`);
    }
    if (!VALID_PROOF_MODES.has(evidence.proofMode)) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must declare a proof mode`);
    }
  }

  if ((scope.dependencies ?? []).length < 7) {
    errors.push("design dependencies must map to DX, walkthrough, support, incident, status-page, and scope ADR records");
  }
  if ((scope.initiativeDependencies ?? []).length < 7) {
    errors.push("owning initiative dependencies must map to consuming productization projects");
  }
  for (const dependency of scope.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
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
