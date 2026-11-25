export const REQUIRED_BOUNDARY_KEYS = ["service", "ux", "security", "support"] as const;

type BoundaryKey = (typeof REQUIRED_BOUNDARY_KEYS)[number];

type Initiative =
  | "Deployment Dashboard & Topology Explorer"
  | "Developer Experience / CLI / MCP"
  | "Control Plane"
  | "Data Plane"
  | "Reliability, Observability & Cost"
  | "Security / RBAC"
  | "Support Workflow";

type ScopeSurface = {
  readonly id: string;
  readonly source: "event-projection";
  readonly consumes: readonly string[];
  readonly proves: string;
  readonly ownsRuntimeImplementation: false;
};

type EvidenceMode = "contract-test" | "design-doc" | "fixture" | "traceability";

type EvidenceRequirement = {
  readonly id: string;
  readonly owner: Initiative;
  readonly mode: EvidenceMode;
  readonly source: string;
  readonly proves: string;
};

type DeploymentDashboardTopologyScope = {
  readonly issue: "HOBO-410";
  readonly phase: "M0";
  readonly project: "Deployment Dashboard & Topology Explorer";
  readonly userBusinessGoal: string;
  readonly primaryPersonas: readonly string[];
  readonly owningInitiatives: readonly Initiative[];
  readonly designRefs: readonly string[];
  readonly adrRefs: readonly string[];
  readonly scopeIn: readonly string[];
  readonly scopeOut: readonly string[];
  readonly nonGoals: readonly string[];
  readonly boundaries: Readonly<Record<BoundaryKey, readonly string[]>>;
  readonly surfaceTaxonomy: readonly ScopeSurface[];
  readonly m1Evidence: readonly EvidenceRequirement[];
};

type ValidationError = {
  readonly code: string;
  readonly message: string;
};

type FollowUpPhase = "M0" | "M1" | "M2" | "M3" | "M4";

declare const parsedScopeBrand: unique symbol;

export type ParsedDeploymentDashboardTopologyScope = DeploymentDashboardTopologyScope & {
  readonly [parsedScopeBrand]: true;
};

const REQUIRED_INITIATIVES: readonly Initiative[] = [
  "Deployment Dashboard & Topology Explorer",
  "Developer Experience / CLI / MCP",
  "Control Plane",
  "Data Plane",
  "Reliability, Observability & Cost",
  "Security / RBAC",
  "Support Workflow",
];

const REQUIRED_SURFACE_IDS = [
  "deployment-timeline",
  "topology-graph",
  "run-inspector",
  "project-environment-fleet",
  "health-cost-incident-rollups",
  "plan-diff-entrypoint",
] as const;

const REQUIRED_EVIDENCE_IDS = [
  "dashboard-surface-taxonomy",
  "projection-source-map",
  "topology-fixture",
  "tenant-rbac-staleness-rules",
  "cli-mcp-parity-map",
  "support-handoff-map",
] as const;

const SCOPE_CREEP_PATTERNS: readonly {
  readonly code: string;
  readonly pattern: RegExp;
}[] = [
  {
    code: "scope-creep-production-ui",
    pattern: /\b(implement|build|ship).*(production|runtime)?.*(dashboard|react|frontend|ui)\b/i,
  },
  {
    code: "scope-creep-live-provider",
    pattern: /\b(live provider|provider topology resolver|cloud call|provider api)\b/i,
  },
  {
    code: "scope-creep-projection-engine",
    pattern: /\b(projection engine|read-store implementation|graphql facade|subscription server)\b/i,
  },
  {
    code: "scope-creep-status-page",
    pattern: /\b(status page publish|incident communication|public incident)\b/i,
  },
  {
    code: "scope-creep-rbac-engine",
    pattern: /\b(rbac engine|policy engine|tenant authorization implementation)\b/i,
  },
];

export const DEPLOYMENT_DASHBOARD_TOPOLOGY_SCOPE: DeploymentDashboardTopologyScope = {
  issue: "HOBO-410",
  phase: "M0",
  project: "Deployment Dashboard & Topology Explorer",
  userBusinessGoal:
    "An operator can trust deployment state, topology health, and follow-up actions without leaving the accepted HoBo projection model.",
  primaryPersonas: [
    "platform operator",
    "application developer",
    "release owner",
    "support engineer",
    "security reviewer",
  ],
  owningInitiatives: REQUIRED_INITIATIVES,
  designRefs: [
    "docs/design/developer-experience.md#plan-07",
    "docs/design/developer-experience.md#plan-49",
    "docs/design/control-plane.md#plan-04",
    "docs/design/data-plane.md#plan-32",
    "docs/design/reliability-observability-cost.md#plan-05",
    "docs/design/cli-spec.md",
  ],
  adrRefs: [
    "docs/design/adr/02-identity-security.md#adr-0077",
    "docs/design/adr/02-identity-security.md#adr-0078",
    "docs/design/adr/03-data-plane.md#adr-0050",
    "docs/design/adr/03-data-plane.md#adr-0089",
  ],
  scopeIn: [
    "Record the user and business goal for the deployment dashboard and topology explorer product surface.",
    "Name the primary personas and the first operational questions each persona must answer.",
    "Define dashboard and topology surfaces as projection-backed read views only.",
    "Map service, UX, security, and support boundaries to existing design sources.",
    "List M1 evidence required before implementation follow-up issues can be created.",
    "Route adjacent runtime, data-plane, security, and support gaps to their owning initiatives.",
  ],
  scopeOut: [
    "No production dashboard frontend or React application implementation.",
    "No live provider calls or provider topology resolver implementation.",
    "No event projection engine, read-store, GraphQL facade, or subscription runtime.",
    "No public status-page publishing or incident communication workflow.",
    "No tenant authorization, RBAC, or policy engine implementation.",
    "No support-ticket automation or human escalation workflow.",
  ],
  nonGoals: [
    "Replace the existing developer-experience, control-plane, or data-plane design documents.",
    "Declare M1/M2 implementation complete.",
    "Render a dashboard UI or topology graph.",
    "Create follow-up issues before M0 acceptance evidence is present.",
  ],
  boundaries: {
    service: [
      "Consumes control-plane DeploymentView, TopologyView, RunView, and PlanDiff projections.",
      "Consumes data-plane read-store snapshots and staleness metadata without owning projectors.",
      "Emits only scope evidence in M0; later runtime commands remain owned by M1+ issues.",
    ],
    ux: [
      "Defines first-screen surfaces: deployment timeline, topology graph, run inspector, and fleet rollups.",
      "Requires CLI/MCP parity for every field a user can inspect in the dashboard.",
      "Requires empty/error/stale states to cite projection source and freshness.",
    ],
    security: [
      "Requires project, environment, tenant, and RBAC redaction rules before M1 implementation.",
      "Keeps public status-page and incident-communication exposure outside this issue.",
      "Fails closed when a surface cannot name its projection source or freshness rule.",
    ],
    support: [
      "Requires a support handoff map that names the event id, projection snapshot, and actor owner.",
      "Separates support troubleshooting evidence from automated ticket or escalation workflow.",
      "Requires replayable evidence for dashboard claims before support runbooks rely on them.",
    ],
  },
  surfaceTaxonomy: [
    {
      id: "deployment-timeline",
      source: "event-projection",
      consumes: ["DeploymentView", "DeploymentSagaEvent", "PlanDiffSummary"],
      proves: "operators can see declared, running, failed, rolled back, and completed deployment state",
      ownsRuntimeImplementation: false,
    },
    {
      id: "topology-graph",
      source: "event-projection",
      consumes: ["TopologyView", "ResourceLinkView", "EnvironmentView"],
      proves: "users can inspect resource relationships without live provider traversal",
      ownsRuntimeImplementation: false,
    },
    {
      id: "run-inspector",
      source: "event-projection",
      consumes: ["RunView", "ActorEvent", "CommandEnvelope"],
      proves: "support and release owners can correlate commands, actors, and events",
      ownsRuntimeImplementation: false,
    },
    {
      id: "project-environment-fleet",
      source: "event-projection",
      consumes: ["ProjectView", "EnvironmentView", "TenantReadScope"],
      proves: "teams can compare project by environment status under tenant boundaries",
      ownsRuntimeImplementation: false,
    },
    {
      id: "health-cost-incident-rollups",
      source: "event-projection",
      consumes: ["AvailabilityView", "CostSignalView", "IncidentSignalView"],
      proves: "operators can see health, cost, and incident cues without owning alerting runtime",
      ownsRuntimeImplementation: false,
    },
    {
      id: "plan-diff-entrypoint",
      source: "event-projection",
      consumes: ["PlanDiffView", "CapabilityReviewView", "CanDeployDecision"],
      proves: "dashboard navigation can hand users to plan and capability evidence",
      ownsRuntimeImplementation: false,
    },
  ],
  m1Evidence: [
    {
      id: "dashboard-surface-taxonomy",
      owner: "Deployment Dashboard & Topology Explorer",
      mode: "design-doc",
      source: "docs/design/deployment-dashboard-topology-explorer.md",
      proves: "M1 slices share accepted dashboard and topology surface names",
    },
    {
      id: "projection-source-map",
      owner: "Data Plane",
      mode: "traceability",
      source: "docs/design/data-plane.md#plan-32",
      proves: "every dashboard field names an event-sourced projection owner",
    },
    {
      id: "topology-fixture",
      owner: "Control Plane",
      mode: "fixture",
      source: "src/draft/exp-proofs/ux/deployment-dashboard-topology-scope-contract",
      proves: "topology graph examples are projection snapshots, not live provider scans",
    },
    {
      id: "tenant-rbac-staleness-rules",
      owner: "Security / RBAC",
      mode: "contract-test",
      source: "docs/design/adr/02-identity-security.md#adr-0077",
      proves: "tenant and environment grouping is explicit before user-visible reads ship",
    },
    {
      id: "cli-mcp-parity-map",
      owner: "Developer Experience / CLI / MCP",
      mode: "design-doc",
      source: "docs/design/developer-experience.md#plan-07",
      proves: "dashboard fields have inspect/logs/doctor or MCP equivalents",
    },
    {
      id: "support-handoff-map",
      owner: "Support Workflow",
      mode: "traceability",
      source: "docs/design/deployment-dashboard-topology-explorer.md",
      proves: "support runbooks can cite event ids and projection snapshots",
    },
  ],
};

export function canCreateDeploymentDashboardFollowUp({
  phase,
  m0Accepted,
}: {
  readonly phase: FollowUpPhase;
  readonly m0Accepted: boolean;
}): boolean {
  return m0Accepted && phase !== "M0";
}

export class DeploymentDashboardTopologyScopeParseError extends Error {
  constructor(readonly errors: readonly ValidationError[]) {
    super(`Deployment Dashboard Topology scope failed parsing: ${errors.map((error) => error.code).join(", ")}`);
    this.name = "DeploymentDashboardTopologyScopeParseError";
  }
}

export function parseDeploymentDashboardTopologyScope(
  scope: DeploymentDashboardTopologyScope,
): ParsedDeploymentDashboardTopologyScope {
  const validation = validateDeploymentDashboardTopologyScope(scope);

  if (!validation.ok) {
    throw new DeploymentDashboardTopologyScopeParseError(validation.errors);
  }

  // SAFETY: `return scope as ParsedDeploymentDashboardTopologyScope;` is required at this I/O or test boundary.
  return scope as ParsedDeploymentDashboardTopologyScope;
}

export function classifyDashboardTopologyGap(summary: string): Initiative {
  const normalized = summary.toLowerCase();

  if (/\b(projection|read-store|snapshot|graphql|subscription|staleness)\b/.test(normalized)) {
    return "Data Plane";
  }
  if (/\b(topology|link resolver|provider graph|resource graph)\b/.test(normalized)) {
    return "Control Plane";
  }
  if (/\b(slo|availability|cost|incident|health)\b/.test(normalized)) {
    return "Reliability, Observability & Cost";
  }
  if (/\b(cli|mcp|inspect|logs|doctor|agent command)\b/.test(normalized)) {
    return "Developer Experience / CLI / MCP";
  }
  if (/\b(tenant|rbac|redaction|policy|authorization|public read)\b/.test(normalized)) {
    return "Security / RBAC";
  }
  if (/\b(support|handoff|troubleshooting|runbook)\b/.test(normalized)) {
    return "Support Workflow";
  }

  return "Deployment Dashboard & Topology Explorer";
}

export interface ValidationOutcome {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
}

export function validateDeploymentDashboardTopologyScope(
  scope: DeploymentDashboardTopologyScope,
): ValidationOutcome {
  const errors: ValidationError[] = [];

  if (scope.issue !== "HOBO-410") {
    errors.push({ code: "wrong-issue", message: "scope record must pin HOBO-410" });
  }
  if (scope.phase !== "M0") {
    errors.push({ code: "wrong-phase", message: "scope record must stay in M0" });
  }
  if (!arraysEqual(scope.owningInitiatives, REQUIRED_INITIATIVES)) {
    errors.push({
      code: "missing-initiative-boundary",
      message: "owning initiatives must match the accepted boundary map",
    });
  }
  for (const boundary of REQUIRED_BOUNDARY_KEYS) {
    const entries = scope.boundaries[boundary];
    if (!entries || entries.length === 0) {
      errors.push({
        code: `missing-${boundary}-boundary`,
        message: `boundary ${boundary} must name at least one constraint`,
      });
    }
  }
  if (!arraysEqual(scope.surfaceTaxonomy.map((surface) => surface.id), REQUIRED_SURFACE_IDS)) {
    errors.push({
      code: "missing-surface-taxonomy",
      message: "surface taxonomy must match the M0 accepted dashboard view list",
    });
  }
  for (const surface of scope.surfaceTaxonomy) {
    if (surface.source !== "event-projection" || surface.ownsRuntimeImplementation !== false) {
      errors.push({
        code: "runtime-surface-owned",
        message: `${surface.id} must remain projection-only in M0`,
      });
    }
    if (surface.consumes.length === 0 || surface.proves.length === 0) {
      errors.push({
        code: "incomplete-surface-proof",
        message: `${surface.id} must name consumed projections and proof purpose`,
      });
    }
  }
  if (!arraysEqual(scope.m1Evidence.map((evidence) => evidence.id), REQUIRED_EVIDENCE_IDS)) {
    errors.push({
      code: "missing-m1-evidence",
      message: "M1 evidence must match the accepted follow-up gate",
    });
  }
  for (const evidence of scope.m1Evidence) {
    if (evidence.source.length === 0 || evidence.proves.length === 0) {
      errors.push({
        code: "incomplete-evidence",
        message: `${evidence.id} must name its source and proof claim`,
      });
    }
  }
  errors.push(...findScopeCreep(scope.scopeIn));

  return { ok: errors.length === 0, errors };
}

function findScopeCreep(scopeIn: readonly string[]): readonly ValidationError[] {
  const errors: ValidationError[] = [];
  const normalizedScope = scopeIn.join("\n");

  for (const { code, pattern } of SCOPE_CREEP_PATTERNS) {
    if (pattern.test(normalizedScope)) {
      errors.push({
        code,
        message: `M0 scope may not include ${code.replace("scope-creep-", "").replaceAll("-", " ")}`,
      });
    }
  }

  return errors;
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
