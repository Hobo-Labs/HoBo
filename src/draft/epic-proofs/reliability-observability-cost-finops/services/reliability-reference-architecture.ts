import {
  parseTelemetryEnvelope,
  toCloudEvent,
  toOtlpSpan,
} from "../../../technical-proofs/telemetry-envelope-contract/src/telemetry-envelope-contract.js";
import {
  createTraceContextRuntime,
} from "../../../technical-proofs/trace-context-propagation-contract/src/trace-context-propagation.js";
import {
  createOtelTracePipeline,
  createMockOtlpCollector as createMockTraceCollector,
} from "../../../technical-proofs/otel-traces-pipeline-contract/src/otel-traces-pipeline.js";
import {
  createMetricPipeline,
  createMockOtlpCollector as createMockMetricCollector,
} from "../../../technical-proofs/metrics-catalog-pipeline-contract/src/metrics-catalog-pipeline.js";
import {
  createMemoryLogSink,
  createStructuredLogPipeline,
} from "../../../technical-proofs/structured-log-pipeline-contract/src/structured-log-pipeline.js";
import {
  createGoldenSlo,
  parseSloDefinition,
} from "../../../technical-proofs/slo-as-code-contract/src/slo-contract.js";
import {
  computeSloStatus,
  createFixtureSliSource,
} from "../../../technical-proofs/slo-computation-engine-contract/src/slo-computation-engine.js";
import {
  evaluateRolloutMetricGate,
} from "../../../technical-proofs/slo-gated-rollback-analysis-contract/src/slo-gated-rollback-analysis.js";
import {
  assessSloDefinitionChange,
} from "../../../technical-proofs/slo-gaming-guard-contract/src/slo-gaming-guard-contract.js";
import {
  snapshotMeteringView,
} from "../../../technical-proofs/metering-view-projection-contract/src/metering-view.js";
import {
  quoteEffectiveMarginalCost,
  snapshotCreditLedger,
} from "../../../technical-proofs/credit-ledger-view-contract/src/credit-ledger-view.js";
import {
  evaluateBudgetQuotaPolicy,
} from "../../../technical-proofs/budget-quota-policy-contract/src/budget-quota-policy.js";
import {
  createShowbackReport,
  selectShowbackRow,
} from "../../../technical-proofs/showback-attribution-contract/src/showback-attribution.js";
import {
  allocateSharedResourceCost,
  showbackForTenant,
} from "../../../technical-proofs/shared-cost-attribution-contract/src/shared-cost-attribution.js";
import {
  evaluateRunawaySpendCircuitBreaker,
} from "../../../technical-proofs/runaway-spend-circuit-breaker-contract/src/runaway-spend-circuit-breaker.js";
import {
  createObservabilityCostGuard,
} from "../../../technical-proofs/observability-cost-guard-contract/src/observability-cost-guard.js";
import {
  classifyFailureSignal,
} from "../../../technical-proofs/failure-taxonomy-safe-fix-classifier/src/failure-taxonomy-classifier.js";
import {
  createSagaEngine,
  makeSagaEvent,
} from "../../../technical-proofs/choreography-saga-engine-contract/src/choreography-saga-engine.js";
import {
  createCompensationEngine,
  replayCompensationEvents,
} from "../../../technical-proofs/saga-compensation-engine-contract/src/saga-compensation-engine.js";
import {
  createRunInspectorProjection,
} from "../../../technical-proofs/run-inspector-projection-contract/src/run-inspector.js";
import {
  evaluateGoldenSuiteChaosTier,
} from "../../../technical-proofs/golden-suite-chaos-verification-contract/src/golden-suite-chaos-verification.js";
import {
  foldReliabilityRollup,
  ratifyReliabilityTargets,
} from "../../../technical-proofs/reliability-sla-rollup-contract/src/reliability-sla-rollup.js";
import {
  buildCompensationPlan,
  reconcileBillingPeriod,
} from "../../../technical-proofs/saga-credit-reconciliation-spike/src/spike.js";

const EPIC = Object.freeze({
  id: "b36b40c8-059f-4d29-8aa1-0a80c852761a",
  title: "Reliability, Observability & Cost (FinOps)",
  slug: "reliability-observability-cost-finops",
});

const CONTRACTS_COVERED = Object.freeze([
  "TelemetryBoundaryExport",
  "TraceContextQueue",
  "SloPolicyGate",
  "MeteringCreditLedger",
  "BudgetQuotaPolicyGate",
  "SagaCompensationBoundary",
  "GoldenChaosBoundary",
  "ReliabilityStatusRollup",
]);

export async function runReliabilityObservabilityCostSimulation() {
  const telemetry = runTelemetrySloGate();
  const finops = runFinopsBudgetGuard();
  const recovery = await runSagaCompensationRecovery();
  const status = runGoldenChaosStatusRollup();

  return {
    epic: EPIC,
    verticalSlices: [
      verticalSlice("telemetry-slo-gate", "SRE on-call", [
        "TelemetryBoundaryExport",
        "TraceContextQueue",
        "SloPolicyGate",
      ]),
      verticalSlice("finops-budget-guard", "FinOps lead", [
        "MeteringCreditLedger",
        "BudgetQuotaPolicyGate",
        "TelemetryBoundaryExport",
      ]),
      verticalSlice("saga-compensation-recovery", "Incident commander", [
        "SagaCompensationBoundary",
        "ReliabilityStatusRollup",
      ]),
      verticalSlice("golden-chaos-status-rollup", "SRE on-call", [
        "GoldenChaosBoundary",
        "ReliabilityStatusRollup",
      ]),
    ],
    telemetry,
    finops,
    recovery,
    status,
    negative: {
      noSliData: telemetry.noSliData,
      malformedTraceparent: telemetry.malformedTraceparent,
      quotaMissingContext: finops.quotaMissingContext,
      staleSagaLease: recovery.staleSagaLease,
      chaosBlastRadiusLeak: status.blastRadiusLeak,
    },
    contracts: {
      covered: [...CONTRACTS_COVERED],
      missing: [],
    },
  };
}

function runTelemetrySloGate() {
  const traceRuntime = createTraceContextRuntime({
    traceIds: ["11111111111111111111111111111111", "cccccccccccccccccccccccccccccccc"],
    spanIds: ["2222222222222222", "dddddddddddddddd"],
    clock: [
      "2026-06-29T03:00:00.000Z",
      "2026-06-29T03:00:00.010Z",
      "2026-06-29T03:00:01.000Z",
      "2026-06-29T03:00:01.010Z",
    ],
  });
  const ingress = traceRuntime.prepareIngressEnvelope(baseEnvelope(), "gateway.request");
  const malformedTraceparent = traceRuntime.prepareIngressEnvelope(
    baseEnvelope({ id: "cmd-malformed", meta: { traceparent: "not-a-traceparent" } }),
    "gateway.request",
  );
  const telemetryEnvelope = parseTelemetryEnvelope(
    telemetryEvent({
      id: "evt-policy-deny",
      type: "policy.Decided",
      correlationId: ingress.correlationId,
      causationId: ingress.id,
      traceparent: ingress.meta.traceparent,
    }),
  );
  const cloudEvent = toCloudEvent(telemetryEnvelope);
  const otlpSpan = toOtlpSpan(telemetryEnvelope);
  const traceExport = runTraceExport(ingress.meta.traceparent);
  const metricExport = runMetricExport();
  const structuredLogs = runStructuredLogs(ingress.meta.traceparent);
  const sloDefinition = createGoldenSlo({
    metadata: { name: "deploy-success-rate" },
    spec: {
      timeWindow: { duration: "1h", isRolling: true },
      burnRateThresholds: [
        {
          name: "fast-burn",
          threshold: 14.4,
          lookbackWindow: "5m",
          samplingInterval: "1m",
        },
        {
          name: "slow-burn",
          threshold: 2,
          lookbackWindow: "1h",
          samplingInterval: "5m",
        },
      ],
    },
  });
  const sloDefinitionCheck = parseSloDefinition(sloDefinition);
  const sloStatus = computeSloStatus({
    definition: sloDefinition,
    sliSource: createFixtureSliSource([
      { time: "2026-06-29T02:59:00.000Z", good: 9850, total: 10000 },
    ]),
    now: "2026-06-29T03:00:00.000Z",
  });
  const noSliData = computeSloStatus({
    definition: sloDefinition,
    sliSource: createFixtureSliSource([]),
    now: "2026-06-29T03:00:00.000Z",
  });
  const rollbackGate = evaluateRolloutMetricGate({
    rollout: {
      rolloutId: "rollout-checkout-prod",
      stepId: "canary-25",
      routeId: "checkout-prod",
      fromVersion: "v1",
      toVersion: "v2",
      tenant: "tenant-a",
    },
    policy: {
      rollbackBurnRate: 2,
      sustainedBreachCount: 1,
      sustainedHealthyCount: 1,
      minRemainingBudgetRatio: 0.1,
    },
    sloSnapshot: {
      sloId: "deploy-success-rate",
      seq: 264,
      status: "available",
      burnRate: 3.2,
      remainingBudgetRatio: 0,
      observedAt: "2026-06-29T03:00:00.000Z",
    },
    goldenSuite: { suiteId: "deploy-golden-suite", status: "passed", failures: [] },
    windowSamples: [
      {
        sloId: "deploy-success-rate",
        seq: 264,
        status: "available",
        burnRate: 3.2,
        remainingBudgetRatio: 0,
        observedAt: "2026-06-29T03:00:00.000Z",
      },
    ],
    now: "2026-06-29T03:00:01.000Z",
  });
  const gamingGuard = assessSloDefinitionChange({
    current: sloDefinition,
    proposed: {
      ...sloDefinition,
      spec: {
        ...sloDefinition.spec,
        objectives: [{ displayName: "availability", target: 0.99 }],
      },
    },
    actor: {
      principal: "user:sre-oncall",
      justification: "investigating outage",
    },
    context: { remainingBudgetRatio: 0.02, burnRate: 3.2 },
    now: "2026-06-29T03:00:00.000Z",
  });

  return {
    traceRepair: ingress.meta.traceRepair,
    traceparent: ingress.meta.traceparent,
    cloudEventType: cloudEvent.type,
    otlpTraceId: otlpSpan.traceId,
    traceExport,
    metricExport,
    structuredLogs,
    sloDefinitionValid: sloDefinitionCheck.ok,
    sloStatus,
    rollbackGate: {
      effect: rollbackGate.verdict,
      reason: rollbackGate.reason,
      obligationCount: rollbackGate.events.filter((event) => event.type === "policy.ObligationCreated").length,
    },
    gamingGuard: {
      verdict: gamingGuard.verdict,
      reasons: gamingGuard.reasons,
    },
    noSliData,
    malformedTraceparent: {
      traceRepair: malformedTraceparent.meta.traceRepair,
      traceparent: malformedTraceparent.meta.traceparent,
    },
  };
}

function runTraceExport(traceparent) {
  const collector = createMockTraceCollector();
  const pipeline = createOtelTracePipeline({
    collector,
    spanIds: ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb"],
    clock: [1_782_700_000_000, 1_782_700_000_010, 1_782_700_000_020, 1_782_700_000_040],
  });
  const root = pipeline.startDeploy({
    traceparent,
    tenant: "tenant-a",
    runId: "run-reliability-rollup",
    deploymentId: "deploy-checkout-prod",
  });
  pipeline.instrumentProviderCall(
    root,
    { provider: "aws", region: "us-east-1", op: "apply" },
    (context) => ({ observedTraceparent: context.traceparent }),
  );
  pipeline.endSpan(root);
  const flush = pipeline.flush({ nowMs: 1_782_700_001_000 });

  return {
    exportedSpans: flush.exportedSpans,
    collectorExports: collector.exports().length,
  };
}

function runMetricExport() {
  const collector = createMockMetricCollector();
  const pipeline = createMetricPipeline({ collector });
  pipeline.recordDeployLifecycle({
    environment: "production",
    result: "failure",
    planStartedAtMs: 1_782_700_000_000,
    deployedAtMs: 1_782_700_055_000,
  });
  pipeline.recordServiceRequest({
    service: "checkout",
    routeTemplate: "/orders",
    method: "POST",
    statusCode: 500,
    durationMs: 240,
  });
  const records = pipeline.exportOtlp();

  return {
    records: records.length,
    collectorRecords: collector.records.length,
  };
}

function runStructuredLogs(traceparent) {
  const sink = createMemoryLogSink("simulation");
  const pipeline = createStructuredLogPipeline({ sinks: [sink] });
  const context = pipeline.createContext({
    tenant: "tenant-a",
    runId: "run-reliability-rollup",
    resource: "checkout",
    traceparent,
  });
  context.log.error("rollback gate tripped", {
    tenant: "tenant-a",
    token: "redacted-token",
    reason: "slo-burn-rate-rollback-threshold",
  });
  pipeline.completeRun("run-reliability-rollup");

  return {
    entries: sink.entries.length,
    redactedToken: sink.entries[0].fields.token,
  };
}

function runFinopsBudgetGuard() {
  const meteringEvents = [
    usage(1, { dimension: "generation-runs", quantity: 2 }),
    usage(2, { dimension: "runtime-compute-seconds", quantity: 12 }),
  ];
  const metering = snapshotMeteringView(meteringEvents, {
    seq: 2,
    costCatalog: FINOPS_COST_CATALOG,
  });
  const creditLedger = snapshotCreditLedger(
    [creditRegistered(1), creditUsage(2, 80)],
    { seq: 2, clock: "2026-06-29T03:00:00.000Z" },
  );
  const creditQuote = quoteEffectiveMarginalCost(creditLedger, {
    providerId: "aws",
    dimension: "runner-minutes",
    units: 45,
  });
  const quotaDecision = evaluateBudgetQuotaPolicy({
    request: policyDecisionRequest({ context: { costEstimateUsd: 1 } }),
    meteringView: withScopeCosts(metering, {
      "camp:tenant-a/camp-prod": 70,
    }),
    policies: [
      {
        id: "cost-availability:camp-prod/monthly",
        scope: { kind: "camp", id: "tenant-a/camp-prod" },
        hardLimitUsd: 100,
        costAvailabilityProfile: {
          id: "cost-availability-profile:camp-prod",
          evaluationAt: "2026-06-29T03:00:00.000Z",
          periodEnd: "2026-06-30T00:00:00.000Z",
          spendVelocityUsdPerHour: 1,
          tiers: [
            {
              name: "observe",
              thresholdFraction: 0.5,
              strategy: "watch-cost-velocity",
              shed: ["cosmetic-telemetry"],
            },
            {
              name: "reduced",
              thresholdFraction: 0.8,
              strategy: "shed-low-priority-work",
              shed: ["background-analysis", "noncritical-retries"],
            },
          ],
        },
        lastEvaluatedSeq: 2,
      },
    ],
  });
  const quotaMissingContext = evaluateBudgetQuotaPolicy({
    request: policyDecisionRequest({ context: { costEstimateUsd: 2 } }),
    meteringView: withScopeCosts(metering, {}),
    policies: [],
  });
  const showback = createShowbackReport({
    meteringView: metering,
    costCatalog: FINOPS_COST_CATALOG,
    displayNames: {
      tenants: { "tenant-a": "Tenant A" },
      camps: { "tenant-a/camp-prod": "Camp Prod" },
      bindles: { "tenant-a/camp-prod/checkout": "Checkout" },
      runs: { "tenant-a/camp-prod/checkout/run-reliability-rollup": "Reliability rollup run" },
    },
  });
  const runShowback = selectShowbackRow(showback, {
    kind: "run",
    id: "tenant-a/camp-prod/checkout/run-reliability-rollup",
  });
  const sharedAllocation = allocateSharedResourceCost({
    resourceId: "shared-observability-pipeline",
    period: "2026-06",
    totalCostCents: 212,
    fixedOverheadCents: 12,
    ownerPrincipal: { kind: "platform", principalId: "hobo-platform" },
    policy: { strategy: "usage-share" },
    consumers: [
      { tenantId: "tenant-a", campId: "camp-prod", bindleId: "checkout" },
      { tenantId: "tenant-b", campId: "camp-prod", bindleId: "search" },
    ],
    usageEvents: [
      {
        id: "usage-checkout",
        seq: 1,
        occurredAt: "2026-06-29T03:00:00.000Z",
        usageUnits: 3,
        consumer: { tenantId: "tenant-a", campId: "camp-prod", bindleId: "checkout" },
      },
      {
        id: "usage-search",
        seq: 2,
        occurredAt: "2026-06-29T03:00:01.000Z",
        usageUnits: 1,
        consumer: { tenantId: "tenant-b", campId: "camp-prod", bindleId: "search" },
      },
    ],
  });
  const runawayBreakerRaw = evaluateRunawaySpendCircuitBreaker({
    policy: {
      id: "spend-circuit:camp-prod",
      scope: { kind: "camp", id: "tenant-a/camp-prod" },
      velocityThresholdUsdPerHour: 10,
      debounce: { minSamples: 2, minDurationSeconds: 60, windowSeconds: 300 },
      requireDegradationExhausted: true,
    },
    meteringView: metering,
    samples: [
      velocitySample(1, "2026-06-29T02:58:00.000Z", 12),
      velocitySample(2, "2026-06-29T02:59:30.000Z", 16),
    ],
    action: { id: "deploy-checkout", kind: "hobo:deployment:apply" },
    now: "2026-06-29T03:00:00.000Z",
  });
  const costGuard = runObservabilityCostGuard();
  const reconciliation = reconcileBillingPeriod({
    provider: "aws",
    period: "2026-06",
    ledgerSeq: 2,
    tolerancePercent: 10,
    lines: [
      { meter: "runtime-compute-seconds", estimated: 2.12, actual: 2.15 },
      { meter: "generation-runs", estimated: 0.5, actual: 0.51 },
    ],
  });

  return {
    metering: {
      seq: metering.seq,
      totalCostUsd: metering.totalCost,
      digest: metering.digest,
    },
    creditQuote,
    quotaDecision: {
      effect: quotaDecision.decision.effect,
      obligations: quotaDecision.decision.obligations.map((obligation) => obligation.kind),
    },
    quotaMissingContext: {
      effect: quotaMissingContext.decision.effect,
      reason: quotaMissingContext.decision.reason,
    },
    showback: {
      totalCost: showback.totalCost,
      runPresentationCost: runShowback.presentationCost,
    },
    sharedAllocation: {
      tenantShowback: showbackForTenant(sharedAllocation, "tenant-a").totalCostCents,
      sharesSumToTotal: sharedAllocation.rollupChecks.sharesSumToTotal,
    },
    runawayBreaker: {
      decision: runawayBreakerRaw.state.status === "open" ? "trip" : "observe",
      actionEffect: runawayBreakerRaw.decision.effect,
      eventTypes: runawayBreakerRaw.events.map((event) => event.type),
    },
    costGuard,
    reconciliation: {
      category: reconciliation.category,
      deltaEvents: reconciliation.deltaEvents.length,
    },
  };
}

async function runSagaCompensationRecovery() {
  const failure = classifyFailureSignal({ kind: "saga-step-failed", partialApply: true });
  const saga = await createSagaEngine({
    now: () => "2026-06-29T03:00:00.000Z",
    idFactory: sagaIdFactory(),
  }).runSaga({
    sagaId: "saga-reliability-rollup",
    tenantId: "tenant-a",
    correlationId: "corr-reliability-rollup",
    causationId: "cmd-rollup",
    steps: [
      { id: "plan", run: () => ({ planId: "plan-rollup" }) },
      {
        id: "apply",
        run: () => {
          const error = new Error("partial provider apply");
          error.code = "MALFORMED_PLAN";
          throw error;
        },
      },
    ],
  });
  const resources = [
    { id: "network", dependsOn: [] },
    { id: "db", dependsOn: ["network"] },
    { id: "api", dependsOn: ["db"] },
  ];
  const compensation = await createCompensationEngine({
    now: () => "2026-06-29T03:00:00.000Z",
    idFactory: sagaIdFactory(),
  }).compensate({
    deploymentId: "deploy-checkout-prod",
    tenantId: "tenant-a",
    correlationId: "corr-reliability-rollup",
    resources,
    eventLog: [
      resourceProvisioned("network", 1),
      resourceProvisioned("db", 2),
      resourceFailed("api", "partial-failure", 3),
    ],
    failedResourceId: "api",
    failure: { class: "partial-failure", reason: "provider-returned-ambiguous-state" },
    destroy: async ({ resourceId }) => ({ destroyed: true, resourceId }),
  });
  const compensationReplay = replayCompensationEvents(compensation.events, resources);
  const compensationPlan = buildCompensationPlan({
    resources,
    provisioned: ["network", "db"],
    failure: { crossesNoGoThreshold: true },
  });
  const runInspector = createRunInspectorProjection(runInspectorEvents()).inspectRun("run-reliability-rollup");
  const staleSagaLease = await staleSagaLeaseMessage();

  return {
    failureClass: failure.failureClass,
    action: failure.action.kind,
    saga: {
      status: saga.state.status,
      events: saga.events.map((event) => event.type),
    },
    compensation: {
      status: compensation.state.status,
      order: compensation.state.compensationOrder,
      replayStatus: compensationReplay.state.status,
      planActions: compensationPlan.actions.map((action) => action.resourceId),
    },
    runInspector: {
      status: runInspector.status,
      timelineEvents: runInspector.timeline.length,
      replayDiffStatus: createRunInspectorProjection(runInspectorEvents()).replayDiff("run-reliability-rollup", [
        { stepId: "plan", signature: "plan(input:v1)", output: { planId: "plan-rollup" } },
        { stepId: "apply", signature: "apply(input:v1)", output: { resourceId: "api-1" } },
      ]).status,
    },
    staleSagaLease,
  };
}

function runGoldenChaosStatusRollup() {
  const goldenChaos = evaluateGoldenSuiteChaosTier({
    suite: {
      id: "deploy-golden-suite",
      requiredTargets: ["runtime-local", "camp"],
      minConfidence: 0.75,
    },
    goldenRuns: [
      passedRun("runtime-local"),
      passedRun("camp"),
    ],
    sloStatus: healthyDeploySlo(),
    chaosExperiment: nodeLossExperiment(),
    policyBudget: {
      id: "ci-chaos-budget",
      environments: ["ci"],
      remainingFaults: 10,
      remainingErrorBudgetRatio: 1,
      maxExperimentCostRatio: 0.25,
      maxBlastRadius: {
        tenant: "tenant-a",
        camp: "camp-ci",
        maxResources: 1,
      },
    },
    now: fixedClock(),
  });
  const blastRadiusLeak = evaluateGoldenSuiteChaosTier({
    suite: {
      id: "deploy-golden-suite",
      requiredTargets: ["runtime-local", "camp"],
      minConfidence: 0.75,
    },
    goldenRuns: [passedRun("runtime-local"), passedRun("camp")],
    sloStatus: healthyDeploySlo(),
    chaosExperiment: nodeLossExperiment({
      observedBlastRadius: {
        tenant: "tenant-a",
        camp: "camp-ci",
        environment: "ci",
        maxResources: 2,
        resources: ["node-a", "node-b"],
      },
    }),
    policyBudget: {
      id: "ci-chaos-budget",
      environments: ["ci"],
      remainingFaults: 10,
      remainingErrorBudgetRatio: 1,
      maxExperimentCostRatio: 0.25,
      maxBlastRadius: {
        tenant: "tenant-a",
        camp: "camp-ci",
        maxResources: 1,
      },
    },
    now: fixedClock(),
  });
  const targets = ratifyReliabilityTargets({
    sloSources: {
      "control-plane-availability": { port: "slo-engine", window: "30d" },
      "deploy-resume-after-node-loss": { port: "slo-engine", window: "7d" },
      "rpo-sync-quorum": { port: "slo-engine", window: "24h" },
      "rpo-async-tier": { port: "slo-engine", window: "24h" },
      "rto-full-yard-rebuild": { port: "slo-engine", window: "dr-drill" },
    },
    availabilityView: {
      "control-plane-availability-single-region": {
        estimatedAvailability: 0.9992,
        declaredFailureDomains: ["aws-us-east-1"],
      },
      "control-plane-availability-multi-region": {
        estimatedAvailability: 0.9991,
        declaredFailureDomains: ["aws-us-east-1"],
      },
    },
    restoreDrill: {
      measuredSeconds: 612,
      targetSeconds: 900,
      replayedEvents: 1_250_000,
      minProductionEvents: 1_000_000,
    },
  });
  const rollup = foldReliabilityRollup([
    reliabilityEvent(1, "sla.TargetRatified", {
      project: "shop",
      environment: "prod",
      targetId: "control-plane-availability-single-region",
      objective: 0.999,
    }),
    reliabilityEvent(2, "slo.Measured", {
      project: "shop",
      environment: "prod",
      targetId: "control-plane-availability-single-region",
      observedAvailability: 0.9986,
      window: "30d",
      fresh: true,
    }),
  ]);

  return {
    goldenChaos: {
      status: goldenChaos.status,
      effect: goldenChaos.decision.effect,
      eventTypes: goldenChaos.events.map((event) => event.type),
    },
    blastRadiusLeak: {
      status: blastRadiusLeak.status,
      reason: blastRadiusLeak.decision.reason,
    },
    targets: {
      ratified: targets.items.filter((target) => target.ratification === "ratified").length,
      provisional: targets.items.filter((target) => target.ratification === "provisional").length,
    },
    rollup: {
      environmentStatus: rollup.environments.prod.status,
      publicStatus: rollup.statusPage.prod.publicStatus,
      incidentCount: rollup.environments.prod.incidents.length,
    },
  };
}

function runObservabilityCostGuard() {
  const guard = createObservabilityCostGuard({
    catalog: {
      metrics: {
        "deploy.rollback.total": {
          labels: ["tenant", "result"],
          labelBudgets: { tenant: 3 },
        },
        "otel.internal.bytes": {
          labels: ["tenant"],
          internal: true,
        },
      },
      cost: {
        currency: "USD",
        unitPrices: {
          "observability-export-bytes": 0.001,
          "observability-trace-spans": 0.05,
          "observability-metric-series": 0.1,
        },
      },
    },
    budget: {
      period: "2026-06",
      hardLimitUsd: 1,
      detailShedThresholdFraction: 0.8,
    },
    tracePolicy: { maxNonErrorSpansPerWindow: 2 },
  });
  guard.recordMetric({
    name: "deploy.rollback.total",
    labels: { tenant: "tenant-a", result: "rollback" },
    value: 1,
    estimatedBytes: 700,
  });
  guard.recordTraceSpan({
    traceId: "11111111111111111111111111111111",
    spanId: "2222222222222222",
    status: "ERROR",
    priority: "slo",
    estimatedBytes: 300,
  });
  const budget = guard.evaluateBudget();
  const snapshot = guard.snapshot();

  return {
    outcome: budget.action === "shed-telemetry-detail" ? "degrade-observability" : "allow",
    appTraffic: budget.appTraffic,
    totalCost: budget.totalCost,
    detailShedding: snapshot.detailShedding,
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

function baseEnvelope(overrides = {}) {
  return {
    id: overrides.id ?? "cmd-rollup",
    type: overrides.type ?? "deployment.Commanded",
    v: 1,
    streamId: overrides.streamId ?? "deployment:checkout-prod",
    seq: overrides.seq ?? 1,
    ts: overrides.ts ?? "2026-06-29T03:00:00.000Z",
    actor: { kind: "system", id: "gateway" },
    tenant: "tenant-a",
    correlationId: "corr-reliability-rollup",
    data: overrides.data ?? {},
    meta: overrides.meta ?? {},
  };
}

function telemetryEvent({ id, type, correlationId, causationId, traceparent }) {
  return {
    schemaVersion: "hobo.telemetry-envelope/v1",
    id,
    type,
    streamId: "yard/prod/reliability",
    seq: 42,
    ts: "2026-06-29T03:00:00.000Z",
    tenant: "tenant-a",
    actor: "policy-engine",
    correlationId,
    causationId,
    data: {
      principalRef: "spiffe://tenant-a/bindle/checkout/resource/api",
      action: "deploy.promote",
      resource: "camp/prod/bindle/checkout",
      decision: "deny",
      reason: "slo-burn-rate-rollback-threshold",
    },
    meta: {
      traceparent,
      idempotencyKey: "idem-rollup-policy-1",
    },
  };
}

const FINOPS_COST_CATALOG = Object.freeze({
  currency: "USD",
  unitPrices: {
    "generation-runs": 1,
    "runtime-compute-seconds": 0.01,
  },
});

function usage(seq, overrides = {}) {
  return {
    id: `usage-${seq}`,
    type: "meter.UsageRecorded",
    seq,
    dimension: overrides.dimension ?? "generation-runs",
    quantity: overrides.quantity ?? 1,
    occurredAt: "2026-06-29T03:00:00.000Z",
    idempotencyKey: `usage-${seq}`,
    owner: {
      tenantId: "tenant-a",
      campId: "camp-prod",
      bindleId: "checkout",
      runId: "run-reliability-rollup",
      agentId: "agent-sre",
      teamId: "team-platform",
    },
  };
}

function creditRegistered(seq) {
  return {
    type: "credit.Registered",
    seq,
    creditId: "credit-aws-runner-june",
    providerId: "aws",
    dimension: "runner-minutes",
    amount: 100,
    currency: "USD",
    listUnitCost: 0.01,
    windowStart: "2026-06-01T00:00:00.000Z",
    windowEnd: "2026-07-01T00:00:00.000Z",
  };
}

function creditUsage(seq, quantity) {
  return {
    type: "meter.UsageRecorded",
    seq,
    providerId: "aws",
    dimension: "runner-minutes",
    quantity,
    occurredAt: "2026-06-29T03:00:00.000Z",
  };
}

function policyDecisionRequest(overrides = {}) {
  return {
    schemaVersion: "hobo.policy-ir/v1",
    subject: {
      kind: "agent",
      id: "agent:tenant-a/agent-sre",
      delegatedBy: "user:sre-oncall",
      roles: ["deployer"],
      scopes: ["hobo:deployment:apply"],
    },
    action: "hobo:deployment:apply",
    resource: {
      kind: "deployment",
      id: "deployment:checkout-prod",
    },
    phase: "plan",
    context: {
      owner: {
        tenantId: "tenant-a",
        campId: "camp-prod",
        agentId: "agent-sre",
      },
      actorId: "user:sre-oncall",
      costEstimateUsd: 0,
      ...overrides.context,
    },
    ...overrides,
  };
}

function withScopeCosts(view, scopeCosts) {
  return {
    ...view,
    scopeCosts: Object.fromEntries(
      Object.entries(scopeCosts).map(([key, cost]) => [key, { cost, currency: "USD" }]),
    ),
  };
}

function velocitySample(seq, observedAt, spendVelocityUsdPerHour) {
  return {
    id: `velocity-${seq}`,
    seq,
    observedAt,
    spendVelocityUsdPerHour,
    degradationExhausted: true,
  };
}

function sagaIdFactory() {
  let nextId = 1;
  return (prefix) => `${prefix}-${nextId++}`;
}

function resourceProvisioned(resourceId, seq) {
  return {
    id: `resource-provisioned-${seq}`,
    type: "resource.Provisioned",
    seq,
    deploymentId: "deploy-checkout-prod",
    resourceId,
    data: { resourceId },
  };
}

function resourceFailed(resourceId, failureClass, seq) {
  return {
    id: `resource-failed-${seq}`,
    type: "resource.Failed",
    seq,
    deploymentId: "deploy-checkout-prod",
    resourceId,
    data: { resourceId, failureClass },
  };
}

async function staleSagaLeaseMessage() {
  const engine = createSagaEngine({ now: () => "2026-06-29T03:00:00.000Z" });
  const startedEvent = makeSagaEvent({
    id: "evt-started",
    type: "saga.Started",
    sagaId: "saga-race",
    tenantId: "tenant-a",
    correlationId: "corr-race",
    causationId: "deployment-command-1",
    data: { stepIds: ["apply"] },
  });

  try {
    await engine.runSaga({
      sagaId: "saga-race",
      tenantId: "tenant-a",
      correlationId: "corr-race",
      eventLog: [startedEvent],
      lease: { ownerId: "actor-b", fenceToken: 7, currentFenceToken: 8 },
      steps: [{ id: "apply", run: () => ({ resourceId: "api-1" }) }],
    });
  } catch (error) {
    return error.message.includes("stale saga lease") ? "stale saga lease" : error.message;
  }
  return "unexpected-pass";
}

function runInspectorEvents() {
  return [
    inspectorEvent(1, "run.Started", { runId: "run-reliability-rollup" }, { causationId: "cmd-rollup" }),
    inspectorEvent(2, "run.StepStarted", {
      runId: "run-reliability-rollup",
      stepId: "plan",
      attempts: 1,
      input: { manifest: "checkout" },
      signature: "plan(input:v1)",
    }),
    inspectorEvent(3, "run.StepCompleted", {
      runId: "run-reliability-rollup",
      stepId: "plan",
      attempts: 1,
      durationMs: 12,
      output: { planId: "plan-rollup" },
      memoizedResult: { planId: "plan-rollup" },
      signature: "plan(input:v1)",
    }),
    inspectorEvent(4, "saga.Started", { sagaId: "deploy-saga", runId: "run-reliability-rollup" }),
    inspectorEvent(5, "run.StepStarted", {
      runId: "run-reliability-rollup",
      stepId: "apply",
      attempts: 1,
      input: { planId: "plan-rollup" },
      signature: "apply(input:v1)",
    }),
    inspectorEvent(6, "run.StepCompleted", {
      runId: "run-reliability-rollup",
      stepId: "apply",
      attempts: 1,
      durationMs: 55,
      output: { resourceId: "api-1" },
      memoizedResult: { resourceId: "api-1" },
      signature: "apply(input:v1)",
    }),
    inspectorEvent(7, "saga.Completed", { sagaId: "deploy-saga", runId: "run-reliability-rollup" }),
    inspectorEvent(8, "run.Completed", { runId: "run-reliability-rollup" }),
  ];
}

function inspectorEvent(seq, type, data, options = {}) {
  return {
    id: `evt-${seq}`,
    seq,
    type,
    ts: `2026-06-29T03:0${seq}:00.000Z`,
    correlationId: data.runId,
    causationId: options.causationId ?? (seq === 1 ? undefined : `evt-${seq - 1}`),
    data,
  };
}

function passedRun(targetKind) {
  return {
    runId: `run-${targetKind}`,
    targetKind,
    completedAt: "2026-06-29T03:00:00.000Z",
    checks: [
      {
        checkId: "deploy-resumes",
        status: "passed",
        confidence: 0.99,
      },
    ],
  };
}

function healthyDeploySlo() {
  return {
    sloName: "deploy-success-rate",
    healthy: true,
    status: "healthy",
    objectiveWindow: {
      burnRate: 0.1,
      remainingBudgetRatio: 0.87,
    },
    violatedThresholds: [],
  };
}

function nodeLossExperiment(overrides = {}) {
  return {
    id: "node-loss-deploy-resume",
    fault: {
      kind: "node-loss",
      target: "node:runner-a",
      durationMs: 120_000,
    },
    steadyState: {
      invariant: "deploy-resumes-under-target",
      targetResumeMs: 180_000,
      observedResumeMs: 119_000,
    },
    blastRadius: {
      tenant: "tenant-a",
      camp: "camp-ci",
      environment: "ci",
      maxResources: 1,
      resources: ["node-a"],
    },
    abortCondition: {
      invariant: "deploy-resumes-under-target",
      armed: true,
    },
    projectedErrorBudgetCostRatio: 0.005,
    cleanup: { status: "removed" },
    ...overrides,
  };
}

function fixedClock() {
  const startMs = Date.parse("2026-06-29T03:00:00.000Z");
  let tick = 0;
  return () => new Date(startMs + tick++ * 60_000).toISOString();
}

function reliabilityEvent(seq, type, data) {
  return {
    id: `evt-${seq}`,
    seq,
    type,
    time: `2026-06-2${seq}T00:00:00.000Z`,
    data,
  };
}
