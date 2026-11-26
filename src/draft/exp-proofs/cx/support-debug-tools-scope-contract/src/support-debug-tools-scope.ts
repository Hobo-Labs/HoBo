import { isJsonObject, type JsonValue } from "./json.js";
export const REQUIRED_BOUNDARIES = ["service", "ux", "security", "support"] as const;

type Boundary = (typeof REQUIRED_BOUNDARIES)[number];

type ProofMode =
  | "design-record"
  | "contract-test"
  | "reference-fixture"
  | "audit-fixture"
  | "support-handoff"
  | "policy-fixture"
  | "replay-fixture";

interface Persona {
  role: string;
  need: string;
}

interface Dependency {
  source: string;
  reason: string;
}

interface InitiativeDependency {
  owner: string;
  consumes: string;
  scopeBoundary: string;
}

interface DiagnosticBundleClass {
  id: string;
  owner: string;
  eventFamilies: string[];
  customerVisible: boolean;
  redactionRequired: boolean;
  safeFields: string[];
}

interface RecoveryRoute {
  id: string;
  owner: string;
  trigger: string;
  safeNextAction: string;
  mutationAllowed: boolean;
}

interface EvidenceItem {
  kind: string;
  owner: string;
  proofMode: ProofMode;
  proves: string;
}

interface FollowUpGate {
  allowedAfter: string;
  blockedBefore: string;
}

interface SupportDebugToolsScope {
  issue: string;
  project: string;
  phase: string;
  goal: string;
  personas: Persona[];
  scopeIn: string[];
  scopeOut: string[];
  nonGoals: string[];
  boundaries: Record<Boundary, string>;
  dependencies: Dependency[];
  initiativeDependencies: InitiativeDependency[];
  diagnosticBundleClasses: DiagnosticBundleClass[];
  recoveryRoutes: RecoveryRoute[];
  m1Evidence: EvidenceItem[];
  followUpGate: FollowUpGate;
}

const IMPLEMENTATION_PHASES = new Set(["M1", "M2", "M3", "M4"]);
const VALID_PROOF_MODES = new Set<ProofMode>([
  "design-record",
  "contract-test",
  "reference-fixture",
  "audit-fixture",
  "support-handoff",
  "policy-fixture",
  "replay-fixture",
]);

const REQUIRED_DEPENDENCIES = [
  "docs/design/developer-experience.md#plan-07",
  "docs/design/developer-experience.md#plan-49",
  "docs/design/workspace-activation-telemetry-contract.md",
  "docs/design/admin-console.md",
  "docs/design/audit-explorer.md",
  "docs/design/support-sla-channels.md",
  "docs/design/launch-support-escalation.md",
  "docs/design/operators-sre.md#plan-40",
  "docs/design/data-plane.md#plan-11",
  "docs/design/adr/02-identity-security.md#adr-0074",
  "docs/design/adr/03-data-plane.md#adr-0050",
  "docs/design/adr/03-data-plane.md#adr-0058",
];

const REQUIRED_DIAGNOSTIC_FIELDS = ["tenant", "project", "environment", "correlation-id"];

const FORBIDDEN_SCOPE_PATTERNS = [
  /\breact screens?\b/i,
  /\bui implementation\b/i,
  /\bcomponent implementation\b/i,
  /\bui routes?\b/i,
  /\bsupport tickets?\b/i,
  /\bhelpdesk\b/i,
  /\bticket queue\b/i,
  /\bsla automation\b/i,
  /\blive logs?\b/i,
  /\blog tail/i,
  /\btrace collector\b/i,
  /\bevent[- ]store runtime\b/i,
  /\bprojector runtime\b/i,
  /\bsearch index\b/i,
  /\brunbook remediation\b/i,
  /\bauto[- ]?fix\b/i,
  /\brestart service\b/i,
  /\bmutate live\b/i,
  /\brbac enforcement\b/i,
  /\bpolicy engine\b/i,
  /\bprovider credentials?\b/i,
  /\bcredential secret\b/i,
  /\bsecret material\b/i,
  /\braw customer data\b/i,
  /\bcustomer data access\b/i,
  /\bfollow-up implementation issues?\b/i,
];

export const SUPPORT_DEBUG_TOOLS_SCOPE: SupportDebugToolsScope = {
  issue: "HOBO-426",
  project: "Support & Debug Tools",
  phase: "M0",
  goal:
    "Define Support & Debug Tools M0 scope so support operators, on-call responders, workspace admins, platform engineers, and security reviewers share accepted diagnostic bundle, recovery route, support handoff, and boundary evidence before design/build issues fan out.",
  personas: [
    {
      role: "support operator",
      need: "Assemble customer-safe diagnostic context with owner, severity, redaction state, and next route without accessing secrets or live data.",
    },
    {
      role: "on-call responder",
      need: "Receive incident and recovery handoffs with correlation ids, timeline evidence, and safe runbook ownership without hidden remediation authority.",
    },
    {
      role: "workspace admin",
      need: "Understand which project, environment, resource, and support state are affected without seeing internal credentials or raw customer data.",
    },
    {
      role: "platform engineer",
      need: "Debug deploy, plan, runtime, provider, and drift failures from replayable facts and projected diagnostics.",
    },
    {
      role: "security/compliance reviewer",
      need: "Verify support diagnostics are tenant-scoped, redacted, audited, and least-privilege before support tooling is implemented.",
    },
  ],
  scopeIn: [
    "Define Support & Debug Tools user/business goal, personas, and accepted M0 diagnostic scope.",
    "Define support-safe diagnostic bundle classes for first-run recovery, deploy/plan rejection, auth or policy denial, provider or network drift, runtime health, and incident handoff.",
    "Define recovery routes from customer-visible symptoms to owning initiatives with safe next action, evidence source, and no mutation authority.",
    "Map service, UX, security, and support boundaries across Admin Console, Audit Explorer, Support Workflow, Operators/SRE, Reliability/Observability/Cost, CLI/MCP, Data Plane, and Security Verification.",
    "List M1-ready evidence for diagnostic bundles, redaction fixtures, route matrices, read-only tool intents, incident handoff context, replay correlation, and follow-up gating.",
  ],
  scopeOut: [
    "Do not build Support & Debug Tools screens, routes, components, client state, or interaction flows in this issue.",
    "Do not implement support ticket queues, helpdesk integrations, SLA automation, staffing workflows, or customer communication dispatch.",
    "Do not implement live log tailing, trace collection, event-store storage, projector runtime, search indexing, or read-store persistence.",
    "Do not execute runbook remediation, restart services, mutate live customer state, apply fixes, or perform rollback/restore actions.",
    "Do not read provider credentials, credential secret values, secret material, unredacted logs, or raw customer data.",
    "Do not implement RBAC enforcement, policy evaluation, role binding, break-glass access, or authorization runtime.",
    "Do not create M1-M4 implementation issues until this M0 acceptance record is accepted.",
  ],
  nonGoals: [
    "Replace Support SLA Channels, Launch Support Escalation, Audit Explorer, Admin Console, Operators/SRE, or Data Plane records.",
    "Approve customer-facing SLA language, production support staffing, or contractual support commitments.",
    "Define production observability pipelines, incident command automation, or support desk procurement.",
  ],
  boundaries: {
    service:
      "Support & Debug Tools defines diagnostic bundle and recovery route contract boundaries; observability pipelines, event storage, projectors, and remediation execution remain later service work.",
    ux:
      "Support & Debug Tools defines information architecture, bundle fields, and route states; it does not build screens, components, routes, or interactions in this issue.",
    security:
      "Support diagnostics require tenant-first scoping, redaction, auditability, least-privilege read authority, and no credential or raw customer data exposure without implementing authorization.",
    support:
      "Support & Debug Tools defines support handoff evidence and safe next actions; Support Workflow owns ticket queues, SLAs, staffing, customer communications, and escalation execution.",
  },
  dependencies: [
    {
      source: "docs/design/developer-experience.md#plan-07",
      reason: "Defines inspect, logs, run inspector, dashboard, and CLI/MCP views that support diagnostics later consume.",
    },
    {
      source: "docs/design/developer-experience.md#plan-49",
      reason: "Defines operations dashboard, project/environment grouping, status surfaces, and incident/status projection discipline.",
    },
    {
      source: "docs/design/workspace-activation-telemetry-contract.md",
      reason: "Names first failure recovered as a Support & Debug Tools product question and recovery use.",
    },
    {
      source: "docs/design/admin-console.md",
      reason: "Defines admin-visible project, environment, entitlement, support, and security context consumed by support diagnostics.",
    },
    {
      source: "docs/design/audit-explorer.md",
      reason: "Defines audit facts, tenant-first filters, redaction, export evidence, and support handoff context.",
    },
    {
      source: "docs/design/support-sla-channels.md",
      reason: "Defines support channels, response language, unsupported request routing, and support workflow boundaries.",
    },
    {
      source: "docs/design/launch-support-escalation.md",
      reason: "Defines severity routing, incident communication templates, support/debug prerequisites, and gap routing.",
    },
    {
      source: "docs/design/operators-sre.md#plan-40",
      reason: "Defines incident management, runbooks, operator agents, and autonomous-action boundaries.",
    },
    {
      source: "docs/design/data-plane.md#plan-11",
      reason: "Defines event audit trail, projections, replay, and materialized views used by diagnostic bundles.",
    },
    {
      source: "docs/design/adr/02-identity-security.md#adr-0074",
      reason: "Pins org governance, RBAC, mandatory policy rules, deny ceilings, and audit obligations.",
    },
    {
      source: "docs/design/adr/03-data-plane.md#adr-0050",
      reason: "Pins event-sourced projections, materialized views, read stores, and replay semantics.",
    },
    {
      source: "docs/design/adr/03-data-plane.md#adr-0058",
      reason: "Pins incidents, runbooks, self-healing decisions, and SRE handoff semantics.",
    },
  ],
  initiativeDependencies: [
    {
      owner: "Support & Debug Tools",
      consumes: "Owns accepted diagnostic bundle classes, recovery route matrix, support-safe fields, and M1 proof gates.",
      scopeBoundary: "This issue defines scope and acceptance; it does not build UI, services, live diagnostics, or remediation.",
    },
    {
      owner: "Admin Console",
      consumes: "Supplies project, environment, entitlement, support, and security context for support-visible diagnostics.",
      scopeBoundary: "Admin Console owns UI navigation, read models, and action intents, not diagnostic bundle semantics.",
    },
    {
      owner: "Audit Explorer",
      consumes: "Supplies audit facts, redaction status, export evidence, and correlation ids for support handoff.",
      scopeBoundary: "Audit Explorer owns audit querying and export shape, not support workflow execution.",
    },
    {
      owner: "Support Workflow",
      consumes: "Uses bundle classes, route owners, severity hints, and unsupported-request routing.",
      scopeBoundary: "Ticket queues, SLA routing, staffing, and customer communications stay in Support Workflow.",
    },
    {
      owner: "Operators/SRE",
      consumes: "Receives incident handoff, runbook owner, remediation boundary, and escalation state.",
      scopeBoundary: "Runbook execution, auto-fix, rollback, restore, and incident command automation stay in Operators/SRE.",
    },
    {
      owner: "Reliability/Observability/Cost",
      consumes: "Supplies metrics, logs, traces, SLO burn, health, drift, and cost context as read-only evidence sources.",
      scopeBoundary: "Telemetry pipelines, alert routing, SLO engines, and cost enforcement stay outside this M0 record.",
    },
    {
      owner: "Security Verification",
      consumes: "Uses no-secret exposure, redaction, tenant scoping, and least-privilege fixture requirements.",
      scopeBoundary: "RBAC enforcement, policy engines, break-glass runtime, and leak tests stay with Security Verification.",
    },
    {
      owner: "CLI/MCP & Developer Experience",
      consumes: "Uses diagnostic bundle and route semantics for future inspect, doctor, logs, and MCP support tools.",
      scopeBoundary: "CLI verbs, MCP tools, dashboards, and inspector implementation are not built in this issue.",
    },
    {
      owner: "Data Plane",
      consumes: "Supplies replayable events, projection cursors, materialized views, and read-store snapshot semantics.",
      scopeBoundary: "Event storage, projector runtime, live log tailing, search indexing, and persistence remain Data Plane work.",
    },
  ],
  diagnosticBundleClasses: [
    {
      id: "first-run-recovery",
      owner: "Support & Debug Tools",
      eventFamilies: ["workspace.ActivationFailed", "workspace.RecoverySuggested"],
      customerVisible: true,
      redactionRequired: true,
      safeFields: ["tenant", "project", "environment", "correlation-id", "step", "owner", "safe-next-action"],
    },
    {
      id: "deploy-plan-rejection",
      owner: "CLI/MCP & Developer Experience",
      eventFamilies: ["deployment.PlanRejected", "policy.Denied", "canDeploy.Failed"],
      customerVisible: true,
      redactionRequired: true,
      safeFields: ["tenant", "project", "environment", "correlation-id", "plan-id", "denial-reason", "owner"],
    },
    {
      id: "auth-policy-denial",
      owner: "Security Verification",
      eventFamilies: ["token.Revoked", "policy.Denied", "auth.SessionExpired"],
      customerVisible: false,
      redactionRequired: true,
      safeFields: ["tenant", "project", "environment", "correlation-id", "principal-ref", "policy-rule", "redaction-state"],
    },
    {
      id: "provider-network-drift",
      owner: "Operators/SRE",
      eventFamilies: ["drift.Detected", "resource.Unhealthy", "network.Partitioned"],
      customerVisible: false,
      redactionRequired: true,
      safeFields: ["tenant", "project", "environment", "correlation-id", "resource-ref", "drift-class", "owner"],
    },
    {
      id: "runtime-health-summary",
      owner: "Reliability/Observability/Cost",
      eventFamilies: ["slo.BurnRateChanged", "run.Failed", "incident.Opened"],
      customerVisible: true,
      redactionRequired: true,
      safeFields: ["tenant", "project", "environment", "correlation-id", "service", "status", "slo-state"],
    },
    {
      id: "incident-support-handoff",
      owner: "Support Workflow",
      eventFamilies: ["incident.Opened", "incident.Escalated", "crew.HandoffRequested"],
      customerVisible: false,
      redactionRequired: true,
      safeFields: ["tenant", "project", "environment", "correlation-id", "incident-id", "severity", "handoff-owner"],
    },
  ],
  recoveryRoutes: [
    {
      id: "first-run-failure",
      owner: "Support & Debug Tools",
      trigger: "Workspace activation or first deploy fails before first value evidence.",
      safeNextAction: "Attach recovery owner, failing step, accepted limitation, and retry guidance without executing the retry.",
      mutationAllowed: false,
    },
    {
      id: "deploy-plan-rejected",
      owner: "CLI/MCP & Developer Experience",
      trigger: "Plan, can-deploy, contract, policy, or compatibility gate rejects deployment.",
      safeNextAction: "Route to plan evidence, denial reason, owning gate, and remediation issue owner without overriding the gate.",
      mutationAllowed: false,
    },
    {
      id: "auth-or-policy-denied",
      owner: "Security Verification",
      trigger: "Token, session, RBAC, deny-ceiling, or policy decision blocks a support-visible action.",
      safeNextAction: "Expose redacted policy and principal references, then route to security owner without granting access.",
      mutationAllowed: false,
    },
    {
      id: "provider-or-network-drift",
      owner: "Operators/SRE",
      trigger: "Provider, resource, topology, network, or drift state requires operational triage.",
      safeNextAction: "Attach resource reference, drift class, SLO state, and runbook owner without invoking the runbook.",
      mutationAllowed: false,
    },
    {
      id: "incident-handoff",
      owner: "Support Workflow",
      trigger: "Customer-visible incident or degraded state needs support and incident communication handoff.",
      safeNextAction: "Attach incident id, severity, customer-safe summary, redaction state, and communication owner.",
      mutationAllowed: false,
    },
  ],
  m1Evidence: [
    {
      kind: "diagnostic-bundle-contract",
      owner: "Support & Debug Tools",
      proofMode: "contract-test",
      proves: "First-run, deploy, auth, provider, runtime, and incident bundles have owner, source events, redaction, and safe fields.",
    },
    {
      kind: "redaction-and-no-secret-fixture",
      owner: "Security Verification",
      proofMode: "audit-fixture",
      proves: "Diagnostics reject provider credentials, secret material, raw customer data, and unredacted logs.",
    },
    {
      kind: "recovery-route-matrix",
      owner: "Support & Debug Tools",
      proofMode: "reference-fixture",
      proves: "Support symptoms route to first-run, deploy, auth, drift, or incident owners with safe next actions.",
    },
    {
      kind: "read-only-tool-intent",
      owner: "CLI/MCP & Developer Experience",
      proofMode: "design-record",
      proves: "Future inspect, doctor, logs, and MCP tools are read-only until separate implementation issues grant authority.",
    },
    {
      kind: "incident-handoff-context",
      owner: "Support Workflow",
      proofMode: "support-handoff",
      proves: "Support can attach severity, incident id, owner, and customer-safe summary without ticket automation.",
    },
    {
      kind: "replay-correlation-fixture",
      owner: "Data Plane",
      proofMode: "replay-fixture",
      proves: "Diagnostic bundles can cite projection snapshots and correlation ids without owning event-store runtime.",
    },
    {
      kind: "follow-up-issue-gate",
      owner: "Support & Debug Tools",
      proofMode: "policy-fixture",
      proves: "M1/M2/M3/M4 support/debug implementation issues remain blocked until this M0 record is accepted.",
    },
  ],
  followUpGate: {
    allowedAfter: "M0 accepted",
    blockedBefore:
      "M1/M2/M3/M4 Support & Debug Tools UI, service, diagnostics, support workflow, remediation, CLI/MCP, security, data-plane, or observability implementation issues must not be created until this record is accepted.",
  },
};

export function canCreateSupportDebugFollowUp({
  phase,
  m0Accepted,
}: {
  phase: string;
  m0Accepted: boolean;
}): boolean {
  return Boolean(m0Accepted) && IMPLEMENTATION_PHASES.has(phase);
}

export interface ScopeClassification {
  owner: string;
  inScope: boolean;
}

export interface ScopeValidation {
  ok: boolean;
  errors: string[];
}

export function classifySupportDebugRequest(request: JsonValue): ScopeClassification {
  const text = String(request ?? "").toLowerCase();

  if (/\b(provider credential|credential secret|secret material|raw customer data|unredacted)\b/.test(text)) {
    return { owner: "Security Verification", inScope: false };
  }
  if (/\brbac\b|\brole binding\b|\bpolicy engine\b|\benforce\b|\bauthorization runtime\b/.test(text)) {
    return { owner: "Security Verification", inScope: false };
  }
  if (/\bsupport ticket\b|\bhelpdesk\b|\bticket queue\b|\bsla\b|\bstaffing\b/.test(text)) {
    return { owner: "Support Workflow", inScope: false };
  }
  if (/\bui screen\b|\breact\b|\bcomponent\b|\broute\b|\binteraction\b/.test(text)) {
    return { owner: "Admin Console", inScope: false };
  }
  if (/\brunbook\b|\bremediation\b|\bauto[- ]?fix\b|\brestart\b|\brollback\b|\brestore\b/.test(text)) {
    return { owner: "Operators/SRE", inScope: false };
  }
  if (/\bevent-store\b|\bprojector\b|\bsearch index\b|\bread store\b|\blive log\b|\braw logs?\b|\btrace collector\b/.test(text)) {
    return { owner: "Data Plane", inScope: false };
  }
  if (/\bcli\b|\bmcp\b|\bdoctor\b|\binspect command\b|\blogs command\b/.test(text)) {
    return { owner: "CLI/MCP & Developer Experience", inScope: false };
  }

  return { owner: "Support & Debug Tools", inScope: true };
}

export function validateSupportDebugToolsScope(scope: SupportDebugToolsScope | JsonValue): ScopeValidation {
  const errors: string[] = [];

  if (!scope || !isJsonObject(scope)) {
    return { ok: false, errors: ["scope record is required"] };
  }

  // SAFETY: `const record = scope as Partial<SupportDebugToolsScope>;` is required at this I/O or test boundary.
  const record = scope as Partial<SupportDebugToolsScope>;

  if (record.issue !== "HOBO-426") {
    errors.push("issue must be HOBO-426");
  }
  if (record.phase !== "M0") {
    errors.push("phase must be M0");
  }
  if (!/support.*debug/i.test(record.goal ?? "")) {
    errors.push("goal must name Support & Debug Tools");
  }
  if ((record.personas ?? []).length < 5) {
    errors.push("at least five personas are required");
  }
  if ((record.scopeIn ?? []).length < 5) {
    errors.push("scope in must have at least five entries");
  }
  if ((record.scopeOut ?? []).length < 6) {
    errors.push("scope out must have at least six entries");
  }

  for (const key of REQUIRED_BOUNDARIES) {
    if (!record.boundaries?.[key]) {
      errors.push(`missing ${key} boundary`);
    }
  }

  for (const entry of record.scopeIn ?? []) {
    if (FORBIDDEN_SCOPE_PATTERNS.some((pattern) => pattern.test(entry))) {
      errors.push(`scope creep: ${entry}`);
    }
  }

  const sources = (record.dependencies ?? []).map((dependency) => dependency.source);
  if (JSON.stringify(sources) !== JSON.stringify(REQUIRED_DEPENDENCIES)) {
    errors.push("design dependencies must map to DX, support, admin, audit, SRE, data-plane, and ADR sources");
  }
  for (const dependency of record.dependencies ?? []) {
    if (!dependency.source || !dependency.reason) {
      errors.push(`dependency ${dependency.source ?? "<missing>"} must include a reason`);
    }
  }

  if ((record.initiativeDependencies ?? []).length < 9) {
    errors.push("owning initiative dependencies must map support/debug consuming projects");
  }
  for (const dependency of record.initiativeDependencies ?? []) {
    if (!dependency.owner || !dependency.consumes || !dependency.scopeBoundary) {
      errors.push(`initiative dependency ${dependency.owner ?? "<unknown>"} must name owner, consumption, and scope boundary`);
    }
  }

  if ((record.diagnosticBundleClasses ?? []).length < 6) {
    errors.push("diagnostic bundle classes must cover first-run, deploy, auth, drift, runtime, and incident facts");
  }
  for (const bundle of record.diagnosticBundleClasses ?? []) {
    if (!bundle.id || !bundle.owner || bundle.eventFamilies.length === 0) {
      errors.push(`diagnostic bundle ${bundle.id ?? "<unknown>"} must name id, owner, and event families`);
    }
    if (!bundle.redactionRequired) {
      errors.push(`diagnostic bundle ${bundle.id} must require redaction`);
    }
    for (const field of REQUIRED_DIAGNOSTIC_FIELDS) {
      if (!bundle.safeFields.includes(field)) {
        errors.push(`diagnostic bundle ${bundle.id} must include ${field}`);
      }
    }
  }

  if ((record.recoveryRoutes ?? []).length < 5) {
    errors.push("recovery routes must cover first-run, deploy, auth, drift, and incident handoff");
  }
  for (const route of record.recoveryRoutes ?? []) {
    if (!route.id || !route.owner || !route.trigger || !route.safeNextAction) {
      errors.push(`recovery route ${route.id ?? "<unknown>"} must name id, owner, trigger, and safe next action`);
    }
    if (route.mutationAllowed !== false) {
      errors.push(`recovery route ${route.id} must not execute mutation`);
    }
  }

  for (const evidence of record.m1Evidence ?? []) {
    if (!evidence.kind || !evidence.owner || !evidence.proves) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must name kind, owner, and proof`);
    }
    if (!VALID_PROOF_MODES.has(evidence.proofMode)) {
      errors.push(`evidence ${evidence.kind ?? "<unknown>"} must declare a proof mode`);
    }
  }

  if (!record.followUpGate?.allowedAfter || !record.followUpGate?.blockedBefore) {
    errors.push("follow-up gate must record allowed-after and blocked-before states");
  }

  return { ok: errors.length === 0, errors };
}
