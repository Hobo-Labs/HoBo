import { type JsonObject } from "./json.js";
export const REQUIRED_DASHBOARD_VIEWS = [
  "deployments-timeline",
  "topology-graph",
  "run-inspector",
  "registry-browser",
  "agent-activity-credential-audit",
  "cost-finops",
  "drift",
  "plan-preview",
  "policy-gate-approvals",
  "promote-rollback",
  "live-tail",
] as const;

export const REQUIRED_INTERACTIONS = [
  "plan-preview",
  "policy-gate-approval",
  "promote",
  "rollback",
  "live-tail",
  "time-travel-scrubber",
  "replay-diff",
] as const;

export const WCAG_TARGET = "WCAG-2.1-AA";
export const PSEUDO_LOC_EXPANSION_FACTOR = 2;
export const PSEUDO_LOC_DIRECTION = "rtl";

export type DashboardViewId = (typeof REQUIRED_DASHBOARD_VIEWS)[number];
export type DashboardInteractionId = (typeof REQUIRED_INTERACTIONS)[number];

export type ProjectionSource =
  | "DeploymentView"
  | "TopologyView"
  | "RunView"
  | "Registry"
  | "CredentialAudit"
  | "CostView"
  | "DriftView"
  | "PlanPreviewView"
  | "PolicyGateView"
  | "CampPointerView"
  | "StreamView";

export type RenderedDashboardView = {
  readonly id: DashboardViewId;
  readonly title: string;
  readonly projectionSource: ProjectionSource;
  readonly fixture: string;
  readonly projectionOnly: true;
  readonly scrubberAtSeq?: number;
  readonly replayDiffStatus?: "unchanged" | "changed";
  readonly payload: JsonObject;
};

// domain-view: parse-produced draft-proof record; its wire form is the DashboardRenderResult proto message in data-models/.
export type DashboardRenderResult = {
  readonly issue: "HOBO-662";
  readonly fixture: string;
  readonly views: readonly RenderedDashboardView[];
  readonly interactions: readonly DashboardInteractionId[];
  readonly projectionOnly: true;
};

type EventEnvelope = {
  readonly seq: number;
  readonly id: string;
  readonly type: string;
  readonly correlationId: string;
  readonly data: JsonObject;
};

type ValidationError = {
  readonly code: string;
  readonly message: string;
};

const parsedDashboardBrand = Symbol.for("hobo.parsedDashboardRenderResult");

export type ParsedDashboardRenderResult = DashboardRenderResult & {
  readonly [key: symbol]: true;
};

export function parseDashboardRenderResult(
  candidate: DashboardRenderResult,
): ParsedDashboardRenderResult {
  const errors = validateDashboardRenderResult(candidate);
  if (errors.length > 0) {
    throw new Error(errors.map((error) => `${error.code}: ${error.message}`).join("; "));
  }
  return Object.freeze({
    ...candidate,
    [parsedDashboardBrand]: true as const,
  });
}

export function validateDashboardRenderResult(
  candidate: DashboardRenderResult,
): readonly ValidationError[] {
  const errors: ValidationError[] = [];

  if (candidate.issue !== "HOBO-662") {
    errors.push({ code: "issue-mismatch", message: "dashboard render must cite HOBO-662" });
  }
  if (!candidate.projectionOnly) {
    errors.push({
      code: "projection-only-required",
      message: "dashboard views must render from projections only",
    });
  }

  const viewIds = candidate.views.map((view) => view.id);
  for (const requiredView of REQUIRED_DASHBOARD_VIEWS) {
    if (!viewIds.includes(requiredView)) {
      errors.push({
        code: "missing-view",
        message: `missing required dashboard view ${requiredView}`,
      });
    }
  }

  for (const view of candidate.views) {
    if (!view.projectionOnly) {
      errors.push({
        code: "view-not-projection-only",
        message: `view ${view.id} must be projection-only`,
      });
    }
    if (view.fixture !== candidate.fixture) {
      errors.push({
        code: "fixture-mismatch",
        message: `view ${view.id} must use fixture ${candidate.fixture}`,
      });
    }
  }

  for (const interaction of REQUIRED_INTERACTIONS) {
    if (!candidate.interactions.includes(interaction)) {
      errors.push({
        code: "missing-interaction",
        message: `missing required interaction ${interaction}`,
      });
    }
  }

  return errors;
}

export interface DashboardClassification {
  readonly owner: "Full Dashboard" | "Production apps/dashboard";
  readonly inScope: boolean;
}

export function classifyDashboardRequest(input: string): DashboardClassification {
  const normalized = input.trim().toLowerCase();
  if (
    /\b(next\.js production app|live gateway websocket|real camp stream|provider api)\b/i.test(
      normalized,
    )
  ) {
    return { owner: "Production apps/dashboard", inScope: false };
  }
  if (/\b(projection|dashboard view|wcag|pseudo-?loc|multi-cloud-shop)\b/i.test(normalized)) {
    return { owner: "Full Dashboard", inScope: true };
  }
  return { owner: "Production apps/dashboard", inScope: false };
}

export function renderDashboardFromProjections(
  events: readonly EventEnvelope[],
  options: { readonly fixture?: string; readonly scrubberAtSeq?: number } = {},
): DashboardRenderResult {
  const fixture = options.fixture ?? "examples/multi-cloud-shop";
  const atSeq = options.scrubberAtSeq ?? events.at(-1)?.seq ?? 0;
  const scoped = events.filter((event) => event.seq <= atSeq);
  const deployCorrelation = findCorrelation(scoped, "deployment.Planned");
  const runCorrelation = findCorrelation(scoped, "run.Started");

  const views: RenderedDashboardView[] = [
    renderDeploymentsTimeline(scoped, fixture, atSeq, deployCorrelation),
    renderTopologyGraph(scoped, fixture, deployCorrelation),
    renderRunInspector(scoped, fixture, atSeq, runCorrelation),
    renderRegistryBrowser(scoped, fixture, deployCorrelation),
    renderCredentialAudit(scoped, fixture, deployCorrelation),
    renderCostFinops(scoped, fixture, deployCorrelation),
    renderDrift(scoped, fixture, deployCorrelation),
    renderPlanPreview(scoped, fixture, deployCorrelation),
    renderPolicyGateApprovals(scoped, fixture, deployCorrelation),
    renderPromoteRollback(scoped, fixture, deployCorrelation),
    renderLiveTail(scoped, fixture, deployCorrelation),
  ];

  return Object.freeze({
    issue: "HOBO-662",
    fixture,
    views: Object.freeze(views),
    interactions: Object.freeze([...REQUIRED_INTERACTIONS]),
    projectionOnly: true,
  });
}

function findCorrelation(events: readonly EventEnvelope[], type: string): string {
  return events.find((event) => event.type === type)?.correlationId ?? "unknown";
}

function renderDeploymentsTimeline(
  events: readonly EventEnvelope[],
  fixture: string,
  atSeq: number,
  correlationId: string,
): RenderedDashboardView {
  const timeline = events
    .filter((event) => event.correlationId === correlationId)
    .filter((event) => event.type.startsWith("deployment."))
    .map((event) => ({
      seq: event.seq,
      type: event.type,
      resourceId: event.data.resourceId,
      state: event.data.state ?? event.data.status,
    }));

  return {
    id: "deployments-timeline",
    title: "Deployments timeline",
    projectionSource: "DeploymentView",
    fixture,
    projectionOnly: true,
    scrubberAtSeq: atSeq,
    payload: {
      correlationId,
      timeline,
      replayEnabled: true,
      timeTravelScrubber: { atSeq, headSeq: events.at(-1)?.seq ?? atSeq },
    },
  };
}

function renderTopologyGraph(
  events: readonly EventEnvelope[],
  fixture: string,
  correlationId: string,
): RenderedDashboardView {
  const resources = events
    .filter((event) => event.type === "topology.ResourceResolved")
    .map((event) => event.data);
  const edges = events
    .filter((event) => event.type === "topology.BindEdge")
    .map((event) => ({
      from: event.data.from,
      to: event.data.to,
      capability: event.data.capability,
      connectivityTier: event.data.tier,
      estimatedCostUsd: event.data.estimatedEgressUsd,
    }));

  return {
    id: "topology-graph",
    title: "Topology graph",
    projectionSource: "TopologyView",
    fixture,
    projectionOnly: true,
    payload: { correlationId, resources, edges },
  };
}

function renderRunInspector(
  events: readonly EventEnvelope[],
  fixture: string,
  atSeq: number,
  runId: string,
): RenderedDashboardView {
  const steps = events
    .filter((event) => event.correlationId === runId)
    .filter((event) => event.type.startsWith("run.Step"))
    .map((event) => ({
      name: event.data.name,
      attempts: event.data.attempts,
      durationMs: event.data.durationMs,
      outputDigest: event.data.outputDigest,
    }));
  const replayDiffStatus = steps.every((step) => step.outputDigest === steps[0]?.outputDigest)
    ? "unchanged"
    : "changed";

  return {
    id: "run-inspector",
    title: "Run inspector",
    projectionSource: "RunView",
    fixture,
    projectionOnly: true,
    scrubberAtSeq: atSeq,
    replayDiffStatus,
    payload: { runId, steps, replayDiff: { status: replayDiffStatus, comparedAtSeq: atSeq } },
  };
}

function renderRegistryBrowser(
  events: readonly EventEnvelope[],
  fixture: string,
  correlationId: string,
): RenderedDashboardView {
  const providers = events
    .filter((event) => event.type === "registry.ProviderPublished")
    .map((event) => ({
      providerId: event.data.providerId,
      capabilityManifestVersion: event.data.capabilityManifestVersion,
      forgeCertification: event.data.forgeCertification,
      provenanceDigest: event.data.provenanceDigest,
    }));

  return {
    id: "registry-browser",
    title: "Registry browser",
    projectionSource: "Registry",
    fixture,
    projectionOnly: true,
    payload: { correlationId, providers },
  };
}

function renderCredentialAudit(
  events: readonly EventEnvelope[],
  fixture: string,
  correlationId: string,
): RenderedDashboardView {
  const grants = events.filter((event) => event.type === "credential.Granted");
  const uses = events.filter((event) => event.type === "credential.Used");

  return {
    id: "agent-activity-credential-audit",
    title: "Agent activity and credential audit",
    projectionSource: "CredentialAudit",
    fixture,
    projectionOnly: true,
    payload: {
      correlationId,
      grants: grants.map((event) => event.data),
      uses: uses.map((event) => event.data),
      policyApprovals: events
        .filter((event) => event.type === "policy.GateOpened")
        .map((event) => event.data),
    },
  };
}

function renderCostFinops(
  events: readonly EventEnvelope[],
  fixture: string,
  correlationId: string,
): RenderedDashboardView {
  const cost = events.find((event) => event.type === "cost.Metered")?.data ?? {};

  return {
    id: "cost-finops",
    title: "Cost and FinOps",
    projectionSource: "CostView",
    fixture,
    projectionOnly: true,
    payload: { correlationId, ...cost },
  };
}

function renderDrift(
  events: readonly EventEnvelope[],
  fixture: string,
  correlationId: string,
): RenderedDashboardView {
  const driftItems = events
    .filter((event) => event.type === "drift.Detected")
    .map((event) => event.data);

  return {
    id: "drift",
    title: "Drift",
    projectionSource: "DriftView",
    fixture,
    projectionOnly: true,
    payload: { correlationId, items: driftItems },
  };
}

function renderPlanPreview(
  events: readonly EventEnvelope[],
  fixture: string,
  correlationId: string,
): RenderedDashboardView {
  const plan = events.find((event) => event.type === "deployment.Planned")?.data.plan ?? {};

  return {
    id: "plan-preview",
    title: "Plan preview",
    projectionSource: "PlanPreviewView",
    fixture,
    projectionOnly: true,
    payload: {
      correlationId,
      plan,
      warnings: [],
      approvable: true,
    },
  };
}

function renderPolicyGateApprovals(
  events: readonly EventEnvelope[],
  fixture: string,
  correlationId: string,
): RenderedDashboardView {
  const gates = events
    .filter((event) => event.type === "policy.GateOpened")
    .map((event) => event.data);

  return {
    id: "policy-gate-approvals",
    title: "Policy gate approvals",
    projectionSource: "PolicyGateView",
    fixture,
    projectionOnly: true,
    payload: { correlationId, gates },
  };
}

function renderPromoteRollback(
  events: readonly EventEnvelope[],
  fixture: string,
  correlationId: string,
): RenderedDashboardView {
  const completed = events.find((event) => event.type === "deployment.Completed");

  return {
    id: "promote-rollback",
    title: "Promote and rollback",
    projectionSource: "CampPointerView",
    fixture,
    projectionOnly: true,
    payload: {
      correlationId,
      currentCamp: "prod",
      status: completed?.data.status ?? "in-flight",
      promoteEnabled: Boolean(completed),
      rollbackEnabled: Boolean(completed),
    },
  };
}

function renderLiveTail(
  events: readonly EventEnvelope[],
  fixture: string,
  correlationId: string,
): RenderedDashboardView {
  const logLines = events
    .filter((event) => event.type === "stream.LogLine")
    .map((event) => event.data);
  const runEvents = events
    .filter((event) => event.type === "stream.RunEvent")
    .map((event) => event.data);

  return {
    id: "live-tail",
    title: "Live tail",
    projectionSource: "StreamView",
    fixture,
    projectionOnly: true,
    payload: { correlationId, logLines, runEvents },
  };
}
