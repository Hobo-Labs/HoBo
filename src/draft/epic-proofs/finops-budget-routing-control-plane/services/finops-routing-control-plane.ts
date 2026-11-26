import { evaluateRoutingScenario, parseMetricContracts, parseResourceIntent, routingInputHashes } from "./routing-engine.js";
export { evaluateRoutingScenario, parseMetricContracts, parseResourceIntent, routingInputHashes } from "./routing-engine.js";

const EPIC = Object.freeze({
  id: "post-core-finops-control-plane",
  title: "Standards-first FinOps Budget Routing Control Plane",
  slug: "finops-budget-routing-control-plane",
});

const CONTRACTS_COVERED = Object.freeze([
  "MetricContractRegistry",
  "ConstraintEngine",
  "ParetoEvaluator",
  "StabilityController",
  "DecisionGraphPublisher",
  "FeedbackProposalGate",
  "SimulationRunner",
]);

const STANDARD_BASELINES = Object.freeze([
  { name: "FOCUS", version: "1.4", role: "normalized actual-cost ledger" },
  { name: "FinOps Framework", version: "current", role: "budget, forecast, allocation vocabulary" },
  { name: "CloudEvents", version: "1.0.x", role: "lifecycle, cost, usage, audit envelopes" },
  { name: "CDEvents", version: "0.5.x", role: "delivery lifecycle semantics" },
  { name: "OpenTelemetry", version: "1.58.0", role: "trace, metric, log correlation" },
  { name: "OpenAPI", version: "3.2.0", role: "synchronous public API view" },
  { name: "AsyncAPI", version: "3.1.0", role: "event-channel API view" },
  { name: "JSON Schema", version: "2020-12", role: "generated public schema view" },
  { name: "CEL", version: "current", role: "default embedded policy expression" },
  { name: "OPA/Rego", version: "current", role: "policy-engine adapter" },
]);

const NOW = "2026-07-01T16:00:00.000Z";

export async function runFinopsRoutingControlPlaneSimulation() {
  const approvedRoute = evaluateRoutingScenario({
    id: "approved-route",
    intent: baseIntent(),
    candidates: candidateFixture(),
    metricContracts: metricContractsFixture(),
    history: [],
    budgetState: { spendToDate: 700, committedCost: 0, uncertainCost: 0, recoveryReserve: 0 },
    snapshot: snapshotFixture(),
  });
  const approvalRequired = evaluateRoutingScenario({
    id: "approval-required",
    intent: {
      ...baseIntent(),
      budget: {
        ...baseIntent().budget,
        amount: 3_200,
        softLimitBehavior: "requireApproval",
      },
    },
    candidates: candidateFixture(),
    metricContracts: metricContractsFixture(),
    history: [],
    budgetState: { spendToDate: 900, committedCost: 0, uncertainCost: 0, recoveryReserve: 0 },
    snapshot: snapshotFixture(),
  });
  const budgetDeny = evaluateRoutingScenario({
    id: "budget-deny",
    intent: {
      ...baseIntent(),
      budget: {
        ...baseIntent().budget,
        amount: 2_000,
        hardLimitBehavior: "deny",
      },
      constraints: {
        ...baseIntent().constraints,
        maxCost: 1_900,
      },
    },
    candidates: candidateFixture(),
    metricContracts: metricContractsFixture(),
    history: [],
    budgetState: { spendToDate: 1_900, committedCost: 0, uncertainCost: 0, recoveryReserve: 0 },
    snapshot: snapshotFixture(),
  });
  const stabilityCooldown = evaluateRoutingScenario({
    id: "stability-cooldown",
    intent: baseIntent(),
    candidates: candidateFixture(),
    metricContracts: metricContractsFixture(),
    history: [
      {
        candidateId: "candidate-economy",
        decidedAt: "2026-07-01T08:00:00.000Z",
      },
    ],
    budgetState: { spendToDate: 700, committedCost: 0, uncertainCost: 0, recoveryReserve: 0 },
    snapshot: snapshotFixture(),
  });
  const invalidMetricContracts = parseMetricContracts(invalidMetricContractsFixture());
  const providerLeakage = parseResourceIntent(providerLeakingIntent());
  const feedbackGovernance = createFeedbackGovernance(approvedRoute, metricContractsFixture());
  const simulationPreview = createSimulationPreview(approvedRoute, stabilityCooldown);

  return {
    epic: EPIC,
    standards: [...STANDARD_BASELINES],
    verticalSlices: [
      verticalSlice("standards-first-intent-routing", "application developer", [
        "ConstraintEngine",
        "DecisionGraphPublisher",
        "SimulationRunner",
      ]),
      verticalSlice("governed-metric-routing", "platform engineer", [
        "MetricContractRegistry",
        "FeedbackProposalGate",
      ]),
      verticalSlice("constraint-first-selection", "FinOps lead", [
        "ConstraintEngine",
        "ParetoEvaluator",
        "DecisionGraphPublisher",
      ]),
      verticalSlice("stability-controlled-feedback", "SRE operator", [
        "StabilityController",
        "FeedbackProposalGate",
      ]),
    ],
    approvedRoute,
    approvalRequired,
    budgetDeny,
    stabilityCooldown,
    invalidMetricContracts,
    providerLeakage,
    feedbackGovernance,
    simulationPreview,
    experienceSurfaces: createExperienceSurfaces(approvedRoute),
    adapterFixtures: [
      adapterFixture("terraform-plan-json"),
      adapterFixture("pulumi-automation-api"),
      adapterFixture("crossplane-composition"),
      adapterFixture("kubernetes-runtime-controller"),
    ],
    contracts: {
      covered: [...CONTRACTS_COVERED],
      missing: [],
    },
  };
}

function createFeedbackGovernance(route, metricContracts) {
  const before = structuredClone(metricContracts);
  const proposals = [
    {
      id: "feedback-proposal:cost-drift",
      source: "actual-cost",
      target: "cost.monthly",
      effect: "propose-metric-change",
      observed: { estimateUsd: 3_000, actualUsd: 3_420, driftRatio: 0.14 },
      decisionGraphId: route.decisionGraph.id,
    },
    {
      id: "feedback-proposal:operator-override",
      source: "override",
      target: "stability.minImprovementThreshold",
      effect: "propose-policy-review",
      observed: { reason: "incident freeze requested by SRE" },
      decisionGraphId: route.decisionGraph.id,
    },
  ];
  const metricVersionChange = {
    metricName: "cost.monthly",
    fromVersion: "v1.0.0",
    toVersion: "v1.1.0",
    approvalState: "requires-approval",
  };

  return {
    proposals,
    metricVersionChange,
    metricsMutatedDirectly: JSON.stringify(before) !== JSON.stringify(metricContracts),
    policyMutatedDirectly: false,
  };
}

function createExperienceSurfaces(route) {
  return {
    dx: {
      surface: "dry-run-preview",
      decisionGraphId: route.decisionGraph.id,
      questionsAnswered: ["why-this-placement", "what-if-budget-changes", "simulation-preview"],
    },
    opsx: {
      surface: "runtime-control",
      decisionGraphId: route.decisionGraph.id,
      safeActions: ["override", "freeze", "rollback", "migrate", "incident-reroute"],
    },
    finx: {
      surface: "financial-control",
      decisionGraphId: route.decisionGraph.id,
      views: ["budget", "forecast", "attribution", "anomaly-signal", "commitment-recommendation"],
    },
  };
}

function createSimulationPreview(approvedRoute, stabilityCooldown) {
  return {
    request: {
      id: "simulation-request:budget-drop",
      scenarios: ["budget_drop_30_percent", "incident_freeze"],
    },
    result: {
      requestId: "simulation-request:budget-drop",
      decisionGraphIds: [approvedRoute.decisionGraph.id, stabilityCooldown.decisionGraph.id],
      costTrajectory: [3_900, 3_600, 3_420],
      reliabilityTrajectory: [0.97, 0.97, 0.96],
      migrationEvents: stabilityCooldown.stability.overridden ? [] : ["migration-requested"],
      stabilityScore: stabilityCooldown.stability.overridden ? 1 : 0.64,
    },
  };
}

function adapterFixture(adapter) {
  return {
    adapter,
    boundary: "ExecutionAdapterPort",
    fixtureOnly: true,
    routingLogic: false,
  };
}

function verticalSlice(id, persona, boundaries) {
  return {
    id,
    persona,
    scenario: `${persona} exercises ${id} through mocked service boundaries`,
    boundaries: boundaries.map((name) => ({ name, mocked: true })),
  };
}

function baseIntent() {
  return {
    schemaVersion: "hobo.finops.resource-intent/v1",
    owner: {
      tenant: "tenant-a",
      workspace: "payments",
      environment: "production",
    },
    capability: {
      category: "compute",
      requirements: {
        availability: "high",
        minAvailability: 0.95,
        latencyP95Ms: 120,
        durability: "standard",
        compliance: "pci",
      },
    },
    budget: {
      amount: 5_000,
      currency: "USD",
      period: "monthly",
      softLimitBehavior: "requireApproval",
      hardLimitBehavior: "deny",
    },
    constraints: {
      allowedJurisdictions: ["US"],
      disallowedJurisdictions: [],
      maxCost: 4_500,
      minSecurityLevel: 4,
    },
    routing: {
      objective: "balanced",
    },
  };
}

function providerLeakingIntent() {
  return {
    ...baseIntent(),
    routing: {
      ...baseIntent().routing,
      provider: "aws",
      region: "us-east-1",
      backendApi: "terraform apply",
    },
  };
}

function candidateFixture() {
  return [
    candidate("candidate-economy", 2_200, 0.96, 110, 0.2, ["pci"], "US", 4, true),
    candidate("candidate-balanced", 3_000, 0.97, 95, 0.1, ["pci"], "US", 5, true),
    candidate("candidate-premium", 4_200, 0.985, 80, 0.16, ["pci"], "US", 5, true),
    candidate("candidate-wasteful", 3_600, 0.96, 110, 0.25, ["pci"], "US", 4, true),
    candidate("candidate-ineligible", 1_700, 0.98, 70, 0.05, ["none"], "EU", 2, false),
  ];
}

function candidate(id, monthlyCost, reliability, latencyP95Ms, risk, compliance, jurisdiction, securityLevel, eligible) {
  return {
    id,
    capabilityClass: "compute",
    monthlyCost,
    transitionCost: 0,
    commitmentBound: monthlyCost,
    period: "monthly",
    reliability,
    latencyP95Ms,
    risk,
    compliance,
    jurisdiction,
    securityLevel,
    eligible,
    abstractTraits: ["capability-match", "adapter-hidden", "budget-visible"],
  };
}

function metricContractsFixture() {
  return [
    {
      name: "cost.monthly",
      tier: "system",
      unit: "USD",
      source: "focus-ledger",
      normalization: "fixed-usd-10000/v1",
      version: "v1.0.0",
      mutable: false,
    },
    {
      name: "reliability.uptime",
      tier: "system",
      unit: "ratio",
      source: "opentelemetry-slo",
      normalization: "fixed-0-1/v1",
      version: "v1.0.0",
      mutable: false,
    },
    {
      name: "latency.p95",
      tier: "system",
      unit: "ms",
      source: "opentelemetry-metrics",
      normalization: "fixed-ms-200/v1",
      version: "v1.0.0",
      mutable: false,
    },
    {
      name: "risk.incident",
      tier: "system",
      unit: "ratio",
      source: "incident-system",
      normalization: "fixed-0-1/v1",
      version: "v1.0.0",
      mutable: false,
    },
    {
      name: "experienced.reliability",
      tier: "derived",
      version: "v1.0.0",
      dependsOn: ["reliability.uptime", "latency.p95"],
      transforms: ["weighted_sum"],
      weights: { "reliability.uptime": 0.7, "latency.p95": 0.3 },
    },
    {
      name: "business.quality",
      tier: "user",
      version: "v1.0.0",
      compositionSources: ["experienced.reliability", "cost.monthly"],
      weights: { "experienced.reliability": 0.7, "cost.monthly": 0.3 },
      requiresApproval: true,
      approvalState: "approved",
      approvalRef: "metric-approval:business-quality:v1",
    },
  ];
}

function invalidMetricContractsFixture() {
  return [
    {
      name: "cost.monthly",
      tier: "system",
      source: "focus-ledger",
      normalization: "fixed-usd-10000/v1",
      version: "v1.0.0",
    },
    {
      name: "experienced.reliability",
      tier: "derived",
      version: "v1.0.0",
      dependsOn: ["reliability.uptime"],
      transforms: ["arbitrary-js"],
    },
    {
      name: "team.happiness",
      tier: "user",
      version: "v1.0.0",
      compositionSources: ["raw:otel.request.duration"],
      requiresApproval: false,
    },
    {
      name: "risk.incident",
      tier: "system",
      unit: "ratio",
      source: "incident-system",
      normalization: "lower-is-better",
      version: "latest",
    },
  ];
}

function snapshotFixture() {
  return { ...routingInputHashes(candidateFixture(), metricContractsFixture()), budgetId: "budget:tenant-a:production", periodId: "2026-07", policyRevision: "routing-policy:v1", ledgerSeq: 42, observedAt: NOW };
}
