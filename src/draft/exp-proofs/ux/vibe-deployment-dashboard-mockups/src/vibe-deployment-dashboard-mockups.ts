export const REQUIRED_DASHBOARD_MOCKUP_PERSONAS = [
  "platform operator",
  "application developer",
  "release owner",
  "support engineer",
  "security reviewer",
] as const;

export const REQUIRED_DASHBOARD_MOCKUP_SURFACES = [
  "deployment-timeline",
  "topology-graph",
  "run-inspector",
  "project-environment-fleet",
  "health-cost-incident-rollups",
] as const;

export const REQUIRED_DASHBOARD_MOCKUP_SCENARIOS = [
  "happy-path",
  "blocked-path",
  "stale-or-unknown-evidence",
  "support-handoff",
] as const;

export const REQUIRED_DASHBOARD_MOCKUP_PROOF_MODES = [
  "live",
  "simulated",
  "reference fixture",
  "scope-out",
] as const;

export const REQUIRED_DASHBOARD_QUICKSTART_FIXTURE_IDS = [
  "rlq-deploy-run-accepted-v1",
  "rlq-inspect-event-projection-v1",
  "rlq-manage-stale-evidence-v1",
  "rlq-recover-snapshot-restore-v1",
  "rlq-recover-scope-out-v1",
] as const;

export const REQUIRED_DASHBOARD_QUICKSTART_PROOF_MODES = [
  "reference-fixture",
  "simulated",
  "live",
  "scope-out",
] as const;

type DashboardMockupPersona = (typeof REQUIRED_DASHBOARD_MOCKUP_PERSONAS)[number];
type DashboardMockupSurface = (typeof REQUIRED_DASHBOARD_MOCKUP_SURFACES)[number];
type DashboardMockupScenario = (typeof REQUIRED_DASHBOARD_MOCKUP_SCENARIOS)[number];
type DashboardMockupProofMode = (typeof REQUIRED_DASHBOARD_MOCKUP_PROOF_MODES)[number];
type DashboardQuickstartFixtureId = (typeof REQUIRED_DASHBOARD_QUICKSTART_FIXTURE_IDS)[number];
type DashboardQuickstartProofMode = (typeof REQUIRED_DASHBOARD_QUICKSTART_PROOF_MODES)[number];

type FreshnessStatus = "fresh" | "bounded-stale" | "unknown" | "scope-out" | "unspecified";

type FreshnessRecord = {
  readonly status: FreshnessStatus;
  readonly observedAt: string;
  readonly freshnessBound: string;
  readonly staleDisposition: string;
};

type DashboardFieldGroup = {
  readonly id: string;
  readonly surface: DashboardMockupSurface;
  readonly projectionSource: string;
  readonly freshness: FreshnessRecord;
  readonly owner: string;
  readonly tenantRbacDisposition: string;
  readonly safeNextAction: string;
  readonly proofMode: DashboardMockupProofMode;
};

type DashboardWireframe = {
  readonly id: string;
  readonly surface: DashboardMockupSurface;
  readonly title: string;
  readonly personas: readonly DashboardMockupPersona[];
  readonly questionsAnswered: readonly string[];
  readonly fieldGroupIds: readonly string[];
};

type DashboardScenarioPath = {
  readonly id: DashboardMockupScenario;
  readonly narrative: string;
  readonly fieldGroupIds: readonly string[];
  readonly safeOutcome: string;
};

type DashboardQuickstartFixtureReference = {
  readonly sourceIssue: "HOBO-577";
  readonly fixtureId: DashboardQuickstartFixtureId;
  readonly proofMode: DashboardQuickstartProofMode;
  readonly consumingSurface: DashboardMockupSurface;
  readonly dashboardUse: string;
};

type VibeDeploymentDashboardMockups = {
  readonly issue: "HOBO-544";
  readonly phase: "M1";
  readonly packagePath: "src/draft/exp-proofs/ux/vibe-deployment-dashboard-mockups";
  readonly proofPath: "docs/design/proofs/vibe-deployment-dashboard-mockups/README.md";
  readonly designRefs: readonly string[];
  readonly quickstartFixtureRefs: readonly DashboardQuickstartFixtureReference[];
  readonly personas: readonly DashboardMockupPersona[];
  readonly wireframes: readonly DashboardWireframe[];
  readonly fieldGroups: readonly DashboardFieldGroup[];
  readonly scenarioPaths: readonly DashboardScenarioPath[];
  readonly accessibilityNotes: readonly string[];
  readonly scopeOut: readonly string[];
};

type ValidationError = {
  readonly code: string;
  readonly message: string;
};

declare const parsedDashboardMockupsBrand: unique symbol;

export type ParsedVibeDeploymentDashboardMockups = VibeDeploymentDashboardMockups & {
  readonly [parsedDashboardMockupsBrand]: true;
};

const FIELD_GROUPS: readonly DashboardFieldGroup[] = [
  {
    id: "deployment-state",
    surface: "deployment-timeline",
    projectionSource: "DeploymentView plus deployment saga event projection",
    freshness: {
      status: "fresh",
      observedAt: "fixture://events/deploy-2026-07-01T13:35:20Z",
      freshnessBound: "reads-your-writes seq >= deploy.accepted",
      staleDisposition: "show current state with event id and replay scrubber",
    },
    owner: "Deployment Dashboard & Topology Explorer",
    tenantRbacDisposition: "tenant scoped first, then project/environment RBAC grants intersect",
    safeNextAction: "inspect run run-982 or open plan diff pd-177",
    proofMode: "live",
  },
  {
    id: "topology-edges",
    surface: "topology-graph",
    projectionSource: "TopologyView and ResourceLinkView projection snapshot",
    freshness: {
      status: "bounded-stale",
      observedAt: "fixture://snapshots/topology-seq-812",
      freshnessBound: "bounded-staleness label from replicated owner Camp stream",
      staleDisposition: "render delayed/unknown edge labels instead of provider certainty",
    },
    owner: "Control Plane",
    tenantRbacDisposition: "redact providers, Camp names, and cross-tenant edges outside grants",
    safeNextAction: "wait for projection refresh or inspect topology from CLI parity",
    proofMode: "simulated",
  },
  {
    id: "run-replay",
    surface: "run-inspector",
    projectionSource: "RunView, ActorEvent, CommandEnvelope, and replay snapshot",
    freshness: {
      status: "fresh",
      observedAt: "fixture://events/run-982-step-4",
      freshnessBound: "monotonic event seq returned by command ack",
      staleDisposition: "show replay correlation and current-code diff marker",
    },
    owner: "Developer Experience / CLI / MCP",
    tenantRbacDisposition: "run reads require project grant and event redaction profile",
    safeNextAction: "handoff support packet with event id evt-771 and actor DeploymentSaga",
    proofMode: "reference fixture",
  },
  {
    id: "fleet-tenant-scope",
    surface: "project-environment-fleet",
    projectionSource: "ProjectView, EnvironmentView, and TenantReadScope projection",
    freshness: {
      status: "scope-out",
      observedAt: "fixture://scope-out/rbac-not-implemented",
      freshnessBound: "requires Security / RBAC contract before customer visible reads",
      staleDisposition: "label the panel as scope-out rather than showing a green fleet",
    },
    owner: "Security / RBAC",
    tenantRbacDisposition: "tenant filter is mandatory; RBAC enforcement is not implemented here",
    safeNextAction: "review RBAC proof before enabling fleet comparison",
    proofMode: "scope-out",
  },
  {
    id: "health-cost-incident",
    surface: "health-cost-incident-rollups",
    projectionSource: "AvailabilityView, CostSignalView, and IncidentSignalView projections",
    freshness: {
      status: "unknown",
      observedAt: "fixture://signals/incident-open-cost-delayed",
      freshnessBound: "SLO and cost projections have independent freshness bounds",
      staleDisposition: "show health unknown and cost delayed instead of green rollup",
    },
    owner: "Reliability, Observability & Cost",
    tenantRbacDisposition: "showback by tenant/project/environment; redact cost outside grants",
    safeNextAction: "escalate incident inc-41 or review can-deploy warning",
    proofMode: "live",
  },
];

const QUICKSTART_FIXTURE_REFS: readonly DashboardQuickstartFixtureReference[] = [
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-deploy-run-accepted-v1",
    proofMode: "simulated",
    consumingSurface: "deployment-timeline",
    dashboardUse: "timeline state labels and safe next action copy come from the accepted deploy quickstart fixture",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-inspect-event-projection-v1",
    proofMode: "reference-fixture",
    consumingSurface: "topology-graph",
    dashboardUse: "topology cards cite the accepted projection fixture instead of inventing live provider state",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-manage-stale-evidence-v1",
    proofMode: "reference-fixture",
    consumingSurface: "run-inspector",
    dashboardUse: "run inspector stale-evidence copy reuses the quickstart manage fixture and freshness language",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-recover-snapshot-restore-v1",
    proofMode: "live",
    consumingSurface: "health-cost-incident-rollups",
    dashboardUse: "rollups mark future live recovery as gated, not currently implemented",
  },
  {
    sourceIssue: "HOBO-577",
    fixtureId: "rlq-recover-scope-out-v1",
    proofMode: "scope-out",
    consumingSurface: "project-environment-fleet",
    dashboardUse: "fleet cards inherit the quickstart scope-out boundary for production restore and broad dashboard claims",
  },
];

export const VIBE_DEPLOYMENT_DASHBOARD_MOCKUPS: VibeDeploymentDashboardMockups = {
  issue: "HOBO-544",
  phase: "M1",
  packagePath: "src/draft/exp-proofs/ux/vibe-deployment-dashboard-mockups",
  proofPath: "docs/design/proofs/vibe-deployment-dashboard-mockups/README.md",
  designRefs: [
    "docs/design/deployment-dashboard-topology-explorer.md",
    "docs/design/developer-experience.md#plan-07",
    "docs/design/developer-experience.md#plan-49",
    "docs/design/data-plane.md#plan-32",
    "docs/design/reliability-observability-cost.md#plan-05",
    "docs/design/proofs/resource-lifecycle-quickstart-examples/README.md",
  ],
  quickstartFixtureRefs: QUICKSTART_FIXTURE_REFS,
  personas: REQUIRED_DASHBOARD_MOCKUP_PERSONAS,
  wireframes: [
    {
      id: "wf-deployment-timeline",
      surface: "deployment-timeline",
      title: "Deployment timeline with plan, rollout, rollback, and replay markers",
      personas: ["platform operator", "application developer", "release owner"],
      questionsAnswered: [
        "What deployment state is current, what event proved it, and what safe next action exists?",
        "Can the release owner decide rollback or promotion from accepted projection evidence?",
      ],
      fieldGroupIds: ["deployment-state"],
    },
    {
      id: "wf-topology-graph",
      surface: "topology-graph",
      title: "Topology graph labels over projection snapshots",
      personas: ["platform operator", "application developer", "security reviewer"],
      questionsAnswered: [
        "Which resources, dependencies, hop classes, and redactions are visible from projections only?",
        "Where is topology delayed or unknown so users do not infer live provider certainty?",
      ],
      fieldGroupIds: ["topology-edges"],
    },
    {
      id: "wf-run-inspector",
      surface: "run-inspector",
      title: "Run inspector with replay, actor, command, and support handoff rows",
      personas: ["application developer", "release owner", "support engineer"],
      questionsAnswered: [
        "Which command, actor, attempt, event id, and replay snapshot explain the run outcome?",
        "What customer-safe packet can support hand off without exposing internal-only data?",
      ],
      fieldGroupIds: ["run-replay"],
    },
    {
      id: "wf-project-environment-fleet",
      surface: "project-environment-fleet",
      title: "Project and environment fleet rollup with tenant-first filter labels",
      personas: ["platform operator", "security reviewer"],
      questionsAnswered: [
        "Which tenant, project, and environment axes are visible, redacted, or scope-out?",
        "What must security approve before fleet comparison becomes customer visible?",
      ],
      fieldGroupIds: ["fleet-tenant-scope"],
    },
    {
      id: "wf-health-cost-incident-rollups",
      surface: "health-cost-incident-rollups",
      title: "Health, cost, and incident rollups with delayed or unknown evidence states",
      personas: ["platform operator", "release owner", "support engineer"],
      questionsAnswered: [
        "Is the deployment healthy, blocked by incident state, or only delayed by projection lag?",
        "Which cost or incident signal should the owner review before the next deploy action?",
      ],
      fieldGroupIds: ["health-cost-incident"],
    },
  ],
  fieldGroups: FIELD_GROUPS,
  scenarioPaths: [
    {
      id: "happy-path",
      narrative: "Deployment accepted, topology snapshot current enough, and run replay links prove safe continuation.",
      fieldGroupIds: ["deployment-state", "topology-edges", "run-replay"],
      safeOutcome: "inspect run run-982 and continue release review",
    },
    {
      id: "blocked-path",
      narrative: "Fleet/RBAC and incident rollups block customer-visible confidence while keeping the next owner clear.",
      fieldGroupIds: ["fleet-tenant-scope", "health-cost-incident"],
      safeOutcome: "review RBAC proof and escalate incident inc-41",
    },
    {
      id: "stale-or-unknown-evidence",
      narrative: "Topology and rollup fields render delayed or unknown instead of using stale evidence as green.",
      fieldGroupIds: ["topology-edges", "health-cost-incident"],
      safeOutcome: "wait for projection refresh before declaring operational state",
    },
    {
      id: "support-handoff",
      narrative: "Run inspector emits event ids, projection snapshot, actor owner, and customer-safe wording.",
      fieldGroupIds: ["run-replay", "deployment-state"],
      safeOutcome: "handoff support packet with event id evt-771",
    },
  ],
  accessibilityNotes: [
    "Keyboard order follows timeline, topology, run inspector, fleet, then rollup regions.",
    "Screen reader labels include projection source, freshness, owner, proof mode, and safe next action.",
    "Color is never the only signal; stale, blocked, and scope-out states include text labels.",
    "Motion is optional; replay scrubber and topology transitions must respect reduced-motion preferences.",
  ],
  scopeOut: [
    "No production dashboard frontend or React application.",
    "No visual graph renderer.",
    "No projection engine, read store, GraphQL facade, or dashboard read API.",
    "No live provider traversal.",
    "No tenant RBAC implementation.",
    "No launch readiness or customer-facing claim without evidence.",
  ],
};

const SCOPE_OUT_PATTERNS: readonly RegExp[] = [
  /\b(production dashboard|dashboard frontend|react application|production ui)\b/i,
  /\b(visual graph renderer|render graph|canvas graph|svg graph)\b/i,
  /\b(projection engine|read store|graphql facade|subscription server|dashboard read api)\b/i,
  /\b(live provider|provider traversal|cloud provider scan|provider topology)\b/i,
  /\b(rbac enforcement|tenant rbac|authorization engine|policy engine)\b/i,
  /\b(launch readiness|launch claim|go live|customer-facing claim).*\b(evidence|without evidence)?\b/i,
];

export type DashboardMockupRequestClassification = "in-scope-proof" | "scope-out";

export class VibeDeploymentDashboardMockupsParseError extends Error {
  constructor(readonly errors: readonly ValidationError[]) {
    super(`Vibe deployment dashboard mockups failed parsing: ${errors.map((error) => error.code).join(", ")}`);
    this.name = "VibeDeploymentDashboardMockupsParseError";
  }
}

export function parseVibeDeploymentDashboardMockups(
  mockups: VibeDeploymentDashboardMockups,
): ParsedVibeDeploymentDashboardMockups {
  const validation = validateVibeDeploymentDashboardMockups(mockups);

  if (!validation.ok) {
    throw new VibeDeploymentDashboardMockupsParseError(validation.errors);
  }

  // SAFETY: `return mockups as ParsedVibeDeploymentDashboardMockups;` is required at this I/O or test boundary.
  return mockups as ParsedVibeDeploymentDashboardMockups;
}

export interface ValidationOutcome {
  readonly ok: boolean;
  readonly errors: readonly ValidationError[];
}

export function validateVibeDeploymentDashboardMockups(
  mockups: VibeDeploymentDashboardMockups,
): ValidationOutcome {
  const errors: ValidationError[] = [];

  if (mockups.issue !== "HOBO-544") {
    errors.push({ code: "wrong-issue", message: "mockup contract must pin HOBO-544" });
  }
  if (mockups.phase !== "M1") {
    errors.push({ code: "wrong-phase", message: "mockup contract must stay in M1" });
  }
  if (mockups.packagePath !== "src/draft/exp-proofs/ux/vibe-deployment-dashboard-mockups") {
    errors.push({ code: "wrong-package-path", message: "target package path drifted" });
  }
  if (mockups.proofPath !== "docs/design/proofs/vibe-deployment-dashboard-mockups/README.md") {
    errors.push({ code: "wrong-proof-path", message: "target proof path drifted" });
  }
  if (!arraysEqual(mockups.personas, REQUIRED_DASHBOARD_MOCKUP_PERSONAS)) {
    errors.push({ code: "missing-persona", message: "required persona set must be exact" });
  }
  validateQuickstartFixtureRefs(mockups.quickstartFixtureRefs, errors);

  const wireframeSurfaces = mockups.wireframes.map((wireframe) => wireframe.surface);
  if (!arraysEqual(wireframeSurfaces, REQUIRED_DASHBOARD_MOCKUP_SURFACES)) {
    errors.push({
      code: "missing-wireframe-surface",
      message: "wireframes must cover the required dashboard surfaces in accepted order",
    });
  }

  const fieldGroupIds = new Set(mockups.fieldGroups.map((fieldGroup) => fieldGroup.id));
  for (const wireframe of mockups.wireframes) {
    if (wireframe.personas.length === 0 || wireframe.questionsAnswered.length === 0) {
      errors.push({
        code: "incomplete-wireframe-question",
        message: `${wireframe.id} must name personas and operating questions`,
      });
    }
    for (const fieldGroupId of wireframe.fieldGroupIds) {
      if (!fieldGroupIds.has(fieldGroupId)) {
        errors.push({
          code: "unknown-wireframe-field-group",
          message: `${wireframe.id} references missing ${fieldGroupId}`,
        });
      }
    }
  }

  const fieldGroupSurfaces = new Set(mockups.fieldGroups.map((fieldGroup) => fieldGroup.surface));
  for (const surface of REQUIRED_DASHBOARD_MOCKUP_SURFACES) {
    if (!fieldGroupSurfaces.has(surface)) {
      errors.push({
        code: "missing-field-group-surface",
        message: `${surface} must have fixture metadata`,
      });
    }
  }

  const proofModes = new Set<DashboardMockupProofMode>();
  for (const group of mockups.fieldGroups) {
    if (
      !group.projectionSource ||
      !group.owner ||
      !group.tenantRbacDisposition ||
      !group.safeNextAction
    ) {
      errors.push({
        code: "missing-field-metadata",
        message: `${group.id} must name source, owner, tenant/RBAC disposition, and safe next action`,
      });
    }
    if (!REQUIRED_DASHBOARD_MOCKUP_PROOF_MODES.includes(group.proofMode)) {
      errors.push({
        code: "unsupported-proof-mode",
        message: `${group.id} uses unsupported proof mode ${String(group.proofMode)}`,
      });
    } else {
      proofModes.add(group.proofMode);
    }
    if (!group.freshness || !group.freshness.freshnessBound || group.freshness.status === "unspecified") {
      errors.push({
        code: "missing-freshness",
        message: `${group.id} must name freshness behavior`,
      });
    }
  }

  if (!arraysEqual([...proofModes], REQUIRED_DASHBOARD_MOCKUP_PROOF_MODES)) {
    errors.push({
      code: "missing-proof-mode-label",
      message: "proof modes must cover live, simulated, reference fixture, and scope-out",
    });
  }

  if (!arraysEqual(mockups.scenarioPaths.map((scenario) => scenario.id), REQUIRED_DASHBOARD_MOCKUP_SCENARIOS)) {
    errors.push({
      code: "missing-scenario-path",
      message: "scenario paths must cover happy, blocked, stale/unknown, and support handoff",
    });
  }
  for (const scenario of mockups.scenarioPaths) {
    if (!scenario.narrative || !scenario.safeOutcome || scenario.fieldGroupIds.length === 0) {
      errors.push({
        code: "incomplete-scenario",
        message: `${scenario.id} must name narrative, fixtures, and safe outcome`,
      });
    }
  }

  const accessibilityText = mockups.accessibilityNotes.join(" ").toLowerCase();
  for (const requiredNote of ["keyboard", "screen reader", "color", "motion"]) {
    if (!accessibilityText.includes(requiredNote)) {
      errors.push({
        code: "missing-accessibility-note",
        message: `accessibility notes must include ${requiredNote}`,
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

export function classifyDashboardMockupRequest(summary: string): DashboardMockupRequestClassification {
  return SCOPE_OUT_PATTERNS.some((pattern) => pattern.test(summary)) ? "scope-out" : "in-scope-proof";
}

function validateQuickstartFixtureRefs(
  refs: readonly DashboardQuickstartFixtureReference[],
  errors: ValidationError[],
): void {
  if (!Array.isArray(refs)) {
    errors.push({
      code: "missing-quickstart-fixture-refs",
      message: "dashboard mockups must cite accepted HOBO-577 quickstart fixtures",
    });
    return;
  }

  const fixtureIds = refs.map((ref) => ref.fixtureId);
  const proofModes = new Set<DashboardQuickstartProofMode>();
  const surfaces = new Set<DashboardMockupSurface>();

  for (const ref of refs) {
    if (ref.sourceIssue !== "HOBO-577") {
      errors.push({
        code: "wrong-quickstart-source",
        message: `${ref.fixtureId} must cite HOBO-577 as the quickstart source`,
      });
    }
    if (!REQUIRED_DASHBOARD_QUICKSTART_FIXTURE_IDS.includes(ref.fixtureId)) {
      errors.push({
        code: "unknown-quickstart-fixture",
        message: `${ref.fixtureId} is not an accepted HOBO-577 dashboard fixture`,
      });
    }
    if (!REQUIRED_DASHBOARD_QUICKSTART_PROOF_MODES.includes(ref.proofMode)) {
      errors.push({
        code: "unknown-quickstart-proof-mode",
        message: `${ref.fixtureId} uses unsupported HOBO-577 proof mode ${String(ref.proofMode)}`,
      });
    } else {
      proofModes.add(ref.proofMode);
    }
    if (!REQUIRED_DASHBOARD_MOCKUP_SURFACES.includes(ref.consumingSurface)) {
      errors.push({
        code: "unknown-quickstart-consuming-surface",
        message: `${ref.fixtureId} targets unsupported surface ${String(ref.consumingSurface)}`,
      });
    } else {
      surfaces.add(ref.consumingSurface);
    }
    if (!ref.dashboardUse) {
      errors.push({
        code: "missing-quickstart-dashboard-use",
        message: `${ref.fixtureId} must explain dashboard consumption`,
      });
    }
  }

  if (!arraysEqual(fixtureIds, REQUIRED_DASHBOARD_QUICKSTART_FIXTURE_IDS)) {
    errors.push({
      code: "missing-quickstart-fixture",
      message: "dashboard mockups must cite the required HOBO-577 quickstart fixture ids",
    });
  }
  for (const proofMode of REQUIRED_DASHBOARD_QUICKSTART_PROOF_MODES) {
    if (proofModes.has(proofMode)) continue;
    errors.push({
      code: "missing-quickstart-proof-mode",
      message: "dashboard mockups must preserve HOBO-577 reference-fixture, simulated, live, and scope-out labels",
    });
  }
  for (const surface of REQUIRED_DASHBOARD_MOCKUP_SURFACES) {
    if (!surfaces.has(surface)) {
      errors.push({
        code: "missing-quickstart-consuming-surface",
        message: `${surface} must cite a HOBO-577 quickstart fixture`,
      });
    }
  }
}

function arraysEqual<T>(left: readonly T[], right: readonly T[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
