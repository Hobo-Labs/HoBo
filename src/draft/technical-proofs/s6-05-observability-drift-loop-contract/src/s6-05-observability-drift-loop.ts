import {
  createOtelTracePipeline,
  createMockOtlpCollector as createMockTraceCollector,
} from "../../otel-traces-pipeline-contract/src/otel-traces-pipeline.js";
import {
  createMetricPipeline,
  createMockOtlpCollector as createMockMetricCollector,
} from "../../metrics-catalog-pipeline-contract/src/metrics-catalog-pipeline.js";
import {
  createMemoryLogSink,
  createStructuredLogPipeline,
} from "../../structured-log-pipeline-contract/src/structured-log-pipeline.js";
import {
  createGoldenSlo,
} from "../../slo-as-code-contract/src/slo-contract.js";
import {
  computeSloStatus,
  createFixtureSliSource,
  makeBudgetBurnedEvent,
} from "../../slo-computation-engine-contract/src/slo-computation-engine.js";
import {
  evaluateAlertRouting,
} from "../../alertmanager-routing-contract/src/alertmanager-routing.js";
import {
  handleResourceDrift,
} from "../../autonomous-drift-remediation-contract/src/autonomous-drift-remediation.js";
import {
  parseDriftResources,
  parseGetDriftRequest,
  parseHealDriftRequest,
} from "./parse.js";
import { isJsonObject } from "./json.js";


export const S605_OBSERVABILITY_DRIFT_LOOP_VERSION = "hobo.s6-05-observability-drift-loop/v1";

const DEFAULT_NOW = "2026-07-02T03:00:00.000Z";
const SPAN_IDS = ["aaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbb", "dddddddddddddddd", "eeeeeeeeeeeeeeee"];

export async function runObservabilityDriftLoopE2E(input = {}) {
  const now = input.now ?? DEFAULT_NOW;
  const tenant = input.tenant ?? "tenant-a";
  const traceparent = input.traceparent ?? "00-11111111111111111111111111111111-2222222222222222-01";

  const telemetry = exportControlAndDataPlaneTelemetry({
    traceparent,
    tenant,
    deploymentId: input.deploymentId ?? "deploy-api-prod",
    runId: input.runId ?? "run-checkout-42",
    now,
  });

  const slo = evaluateSloBurnAlert({
    now,
    sloDefinition: input.sloDefinition,
    sliSamples: input.sliSamples,
    alertPolicy: input.alertPolicy,
    receivers: input.receivers,
  });

  const drift = await runDriftLoop({
    resources: input.resources,
    providerState: input.providerState,
    policies: input.policies,
    now,
    gateway: input.gateway,
    gateSignal: input.gateSignal,
  });

  return freeze({
    schema: S605_OBSERVABILITY_DRIFT_LOOP_VERSION,
    telemetry,
    slo,
    drift,
    acceptance: {
      deployTraceExported: telemetry.deploy.exportedSpans > 0,
      runTraceExported: telemetry.run.exportedSpans > 0,
      sloBurnAlertFired: slo.alertEvents.some((event) => event.type === "alert.Fired"),
      driftHealed: drift.healResults.some((result) => result.status === "applied"),
      driftEventsEmitted: drift.allDriftEvents.length > 0,
    },
  });
}

export function exportControlAndDataPlaneTelemetry({ traceparent, tenant, deploymentId, runId, now: _now }) {
  const traceCollector = createMockTraceCollector();
  const metricCollector = createMockMetricCollector();
  const logSink = createMemoryLogSink();
  const clock = [1_782_700_000_000, 1_782_700_000_010, 1_782_700_000_020, 1_782_700_000_040, 1_782_700_000_060];

  const tracePipeline = createOtelTracePipeline({
    collector: traceCollector,
    spanIds: SPAN_IDS,
    clock,
  });
  const metricPipeline = createMetricPipeline({ collector: metricCollector });
  const logPipeline = createStructuredLogPipeline({ sinks: [logSink] });

  const deployRoot = tracePipeline.startDeploy({
    traceparent,
    tenant,
    runId,
    deploymentId,
  });
  tracePipeline.withSpan(deployRoot, "resource.reconcile", { "hobo.resource": "api" }, () => undefined);
  tracePipeline.endSpan(deployRoot);
  const deployFlush = tracePipeline.flush({ nowMs: clock[2] });

  const runRoot = tracePipeline.startSpan(deployRoot, "run.workflow", {
    "hobo.run_id": runId,
    "hobo.plane": "data",
  });
  tracePipeline.withSpan(runRoot, "step.checkout", { "hobo.step": "checkout" }, () => undefined);
  tracePipeline.endSpan(runRoot);
  const runFlush = tracePipeline.flush({ nowMs: clock[4] });

  metricPipeline.recordDeployLifecycle({
    environment: "production",
    result: "success",
    planStartedAtMs: clock[0],
    deployedAtMs: clock[2],
  });
  metricPipeline.recordServiceRequest({
    service: "checkout",
    routeTemplate: "/orders",
    method: "POST",
    statusCode: 200,
    durationMs: 42,
  });
  const metricRecords = metricPipeline.exportOtlp();

  const deployLogContext = logPipeline.createContext({
    tenant,
    runId,
    resource: "api",
    traceparent: deployRoot.traceparent,
  });
  deployLogContext.log.info("deploy reconciled", { deploymentId });
  const runLogContext = logPipeline.createContext({
    tenant,
    runId,
    resource: "checkout",
    traceparent: runRoot.traceparent,
  });
  runLogContext.log.info("workflow step completed", { step: "checkout" });
  logPipeline.completeRun(runId);

  return {
    deploy: {
      traceId: deployRoot.traceId,
      exportedSpans: deployFlush.exportedSpans,
      otlpExports: traceCollector.exports().length,
    },
    run: {
      traceId: runRoot.traceId,
      exportedSpans: runFlush.exportedSpans,
      parentTraceId: deployRoot.traceId,
    },
    metrics: {
      exportedSeries: metricRecords.length,
      collectorExports: metricCollector.records.length,
    },
    logs: {
      entries: logSink.entries.length,
      correlatedToTrace: logSink.entries.every((entry) => entry.traceId),
    },
    otlp: {
      traceCollectorExports: traceCollector.exports().length,
      metricCollectorExports: metricCollector.records.length,
    },
  };
}

export function evaluateSloBurnAlert({
  now = DEFAULT_NOW,
  sloDefinition,
  sliSamples,
  alertPolicy,
  receivers,
}) {
  const definition = sloDefinition ?? createDeploySuccessSlo();
  const samples = sliSamples ?? [
    { time: "2026-07-02T02:59:00.000Z", good: 9850, total: 10000 },
    ...minuteSamples("2026-07-02T03:00:00.000Z", 5, 800, 1000),
  ];

  const status = computeSloStatus({
    definition,
    sliSource: createFixtureSliSource(samples),
    now,
  });
  const budgetEvent = makeBudgetBurnedEvent(status, {
    id: "evt-slo-burn-1",
    seq: 1,
    time: now,
  });

  const alertResult = budgetEvent
    ? evaluateAlertRouting({
        now,
        signals: [
          {
            id: "signal-slo-burn-1",
            kind: "slo",
            type: "burn-rate",
            status: "firing",
            startsAt: now,
            labels: {
              sloName: status.sloName,
              service: status.service,
              window: budgetEvent.data.window,
            },
            metric: {
              burnRate: budgetEvent.data.burnRate,
              remainingBudgetRatio: budgetEvent.data.remainingBudgetRatio,
            },
          },
        ],
        policy: alertPolicy ?? defaultAlertPolicy(),
        receivers: receivers ?? {
          pagerduty: {
            send(delivery) {
              return {
                ok: true,
                receiverId: "pagerduty",
                providerMessageId: `pagerduty:${delivery.groupKey}`,
              };
            },
          },
        },
      })
    : { events: [], deliveries: [] };

  return {
    status,
    budgetEvent,
    alertEvents: alertResult.events,
    alertDeliveries: alertResult.deliveries,
    fired: alertResult.events.some((event) => event.type === "alert.Fired"),
  };
}

export function runDriftSchedulerTick({ resources, providerState, now = DEFAULT_NOW }) {
  const normalizedResources = normalizeResources(resources);
  const state = { ...providerState };
  const detected = [];

  for (const resource of normalizedResources) {
    const desired = resource.desiredRef;
    const observed = state[resource.id] ?? desired;
    if (observed === desired) {
      continue;
    }

    detected.push({
      id: `drift-${resource.id}-${slug(observed)}`,
      type: "resource.DriftDetected",
      resourceId: resource.id,
      environment: resource.environment ?? "staging",
      occurredAt: now,
      correlationId: `corr-${resource.id}`,
      desiredSetRef: desired,
      observedRef: observed,
    });
  }

  return { detected, providerState: state };
}

export async function runDriftLoop({
  resources,
  providerState,
  policies,
  now = DEFAULT_NOW,
  gateway,
  gateSignal,
}) {
  const tick = runDriftSchedulerTick({ resources, providerState, now });
  const healResults = [];
  const allDriftEvents = [];

  for (const drift of tick.detected) {
    const result = await handleResourceDrift({
      drift,
      policies: policies ?? defaultDriftPolicies(resources),
      decidedAt: now,
      gateway: gateway ?? recordingGateway(drift.resourceId),
      gateSignal: gateSignal ?? (() => ({ decision: "pass", reason: "healthy" })),
    });
    healResults.push(result);
    allDriftEvents.push(...result.events.drift);
  }

  return {
    detected: tick.detected,
    healResults,
    allDriftEvents,
    projection: buildDriftProjection(tick.detected, healResults),
  };
}

export function getDrift(input) {
  const request = parseGetDriftRequest(input);
  const items = request.projection.filter(
    (entry) =>
      !request.resourceId ||
      (entry != null &&
        isJsonObject(entry) &&
        "resourceId" in entry &&
        entry.resourceId === request.resourceId),
  );
  return {
    schema: S605_OBSERVABILITY_DRIFT_LOOP_VERSION,
    drift: items,
    count: items.length,
  };
}

export async function healDrift(input) {
  const request = parseHealDriftRequest(input);
  const entry = request.projection.find(
    (item) =>
      item != null &&
      isJsonObject(item) &&
      "resourceId" in item &&
      item.resourceId === request.resourceId,
  );
  if (!entry?.drift) {
    throw new Error(`no drift record for resource ${request.resourceId}`);
  }

  const now = input?.now ?? DEFAULT_NOW;
  const result = await handleResourceDrift({
    drift: entry.drift,
    policies: {
      ...defaultDriftPolicies([{ id: request.resourceId }]),
      ...input?.policies,
      [request.resourceId]: {
        mode: "heal",
        environment: entry.environment ?? "staging",
        estimatedImpact: "medium",
      },
    },
    decidedAt: now,
    gateway: input?.gateway ?? recordingGateway(request.resourceId),
    gateSignal: input?.gateSignal ?? (() => ({ decision: "pass", reason: "healthy" })),
  });

  return {
    resourceId: request.resourceId,
    status: result.status,
    events: result.events.drift,
  };
}

function buildDriftProjection(detected, healResults) {
  return detected.map((drift, index) => ({
    resourceId: drift.resourceId,
    environment: drift.environment,
    desiredSetRef: drift.desiredSetRef,
    observedRef: drift.observedRef,
    drift,
    remediation: healResults[index]?.status ?? "pending",
    events: healResults[index]?.events?.drift ?? [],
  }));
}

function createDeploySuccessSlo() {
  return createGoldenSlo({
    metadata: { name: "deploy-success-rate" },
    spec: {
      service: "deployment-control-plane",
      timeWindow: { duration: "1h", isRolling: true },
      burnRateThresholds: [
        { name: "fast-burn", threshold: 14.4, lookbackWindow: "5m", samplingInterval: "1m" },
        { name: "slow-burn", threshold: 2, lookbackWindow: "1h", samplingInterval: "5m" },
      ],
    },
  });
}

function defaultAlertPolicy() {
  return {
    groupBy: ["sloName"],
    dedupWindow: "5m",
    maxGroupSize: 100,
    routes: [
      {
        id: "slo-burn",
        matcher: { kind: "slo" },
        receiverId: "pagerduty",
      },
    ],
    silences: [],
    inhibitions: [],
  };
}

function defaultDriftPolicies(resources = []) {
  return Object.fromEntries(
    normalizeResources(resources).map((resource) => [
      resource.id,
      { mode: "heal", environment: resource.environment ?? "staging", estimatedImpact: "medium" },
    ]),
  );
}

function normalizeResources(resources = []) {
  return parseDriftResources(resources);
}

function minuteSamples(startIso, count, good, total) {
  const startMs = Date.parse(startIso);
  return Array.from({ length: count }, (_, index) => ({
    time: new Date(startMs - index * 60_000).toISOString(),
    good,
    total,
  }));
}

function recordingGateway(routeId) {
  return {
    state: {
      routeId,
      activeVersion: "desired-set@previous",
      split: { "desired-set@previous": 100, "desired-set@resync": 0 },
    },
    async apply(command) {
      if (command.kind === "gateway.shiftTraffic") {
        this.state = {
          routeId: command.routeId,
          activeVersion: command.toWeight === 100 ? command.toVersion : command.fromVersion,
          split: {
            [command.fromVersion]: 100 - command.toWeight,
            [command.toVersion]: command.toWeight,
          },
        };
        return { status: "applied", state: this.state };
      }
      if (command.kind === "gateway.rollbackTraffic") {
        this.state = {
          routeId: command.routeId,
          activeVersion: command.restoredVersion,
          split: { [command.restoredVersion]: 100, [command.revertedVersion]: 0 },
        };
        return { status: "applied", state: this.state };
      }
      throw new Error(`unexpected gateway command ${command.kind}`);
    },
  };
}

function slug(value) {
  return String(value).replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase();
}

function freeze(value) {
  return Object.freeze(structuredClone(value));
}
