import { isJsonString, isJsonNumber, isJsonObject } from "../src/json.js";
import {
  planLiveFixCandidate,
  replayLiveFixEvents,
} from "../../../technical-proofs/live-fix-gated-candidate-contract/src/live-fix-gated-candidate.js";
import {
  evaluateRolloutMetricGate,
} from "../../../technical-proofs/slo-gated-rollback-analysis-contract/src/slo-gated-rollback-analysis.js";

export const GATED_LIVE_FIX_LOOP_SCHEMA_VERSION = "hobo.gated-live-fix-loop/v1";

export class GatedLiveFixLoopError extends Error {
  constructor(code, path = "$", message = code) {
    super(`${code} at ${path}: ${message}`);
    this.name = "GatedLiveFixLoopError";
    this.code = code;
    this.path = path;
  }
}

export function runGatedLiveFixLoop(input = {}) {
  const scenario = parseScenario(input);
  const now = scenario.now;
  const streamId = `livefix-loop:${scenario.incident.id}`;
  const events = [];
  const emit = (type, data) => {
    const event = {
      id: `${streamId}:${events.length + 1}`,
      type,
      schemaVersion: GATED_LIVE_FIX_LOOP_SCHEMA_VERSION,
      streamId,
      seq: events.length + 1,
      ts: now,
      correlationId: scenario.incident.correlationId,
      causationId: events.at(-1)?.id ?? scenario.incident.failureEventId,
      data,
    };
    events.push(event);
    return event;
  };

  const sloAnalysis = evaluateRolloutMetricGate({
    rollout: rolloutContext(scenario.rollout),
    policy: scenario.sloPolicy,
    sloSnapshot: scenario.sloRegression.snapshot,
    windowSamples: scenario.sloRegression.windowSamples,
    goldenSuite: scenario.sloRegression.goldenSuite,
    now,
  });

  emit("slo.RegressionDetected", {
    incidentId: scenario.incident.id,
    sloId: scenario.sloRegression.snapshot.sloId,
    burnRate: scenario.sloRegression.snapshot.burnRate,
    remainingBudgetRatio: scenario.sloRegression.snapshot.remainingBudgetRatio,
    gateVerdict: sloAnalysis.verdict,
  });

  emit("livefix.TraceCaptured", {
    incidentId: scenario.incident.id,
    environment: scenario.incident.environment,
    traceId: scenario.failingTrace.id,
    signal: scenario.incident.signal,
    assertions: scenario.failingTrace.assertions,
  });

  emit("gen.CandidateGenerated", {
    candidateId: scenario.candidate.id,
    patchRef: scenario.candidate.patchRef,
    riskClass: scenario.candidate.riskClass,
    hypothesis: scenario.candidate.hypothesis,
    blastRadius: scenario.candidate.blastRadius,
  });

  const canaryGate = evaluateRolloutMetricGate({
    rollout: rolloutContext({
      ...scenario.rollout,
      stepId: "canary-apply",
    }),
    policy: scenario.sloPolicy,
    sloSnapshot: scenario.canaryObservation.snapshot,
    windowSamples: scenario.canaryObservation.windowSamples,
    goldenSuite: scenario.canaryObservation.goldenSuite,
    now,
  });

  const canaryOutcome = canaryGate.verdict === "rollback" ? "regression" : "healthy";
  const failedGate = canaryGate.verdict === "rollback"
    ? canaryGate.reason
    : scenario.rollout.failedGate;

  emit("gen.ValidationRequested", {
    candidateId: scenario.candidate.id,
    checks: ["sandbox", "conformance", "trace-replay"],
  });

  const liveFixResult = planLiveFixCandidate({
    now,
    incident: scenario.incident,
    failingTrace: scenario.failingTrace,
    candidate: scenario.candidate,
    policy: scenario.policy,
    rollout: {
      id: scenario.rollout.id,
      canaryOutcome,
      failedGate,
      autoRollbackSignals: scenario.rollout.autoRollbackSignals,
    },
  });

  for (const event of liveFixResult.events) {
    if (event.type.startsWith("livefix.TraceCaptured") || event.type.startsWith("gen.CandidateGenerated")) {
      continue;
    }
    events.push({
      ...event,
      id: `${streamId}:${events.length + 1}`,
      seq: events.length + 1,
      schemaVersion: GATED_LIVE_FIX_LOOP_SCHEMA_VERSION,
      streamId,
    });
  }

  return deepFreeze({
    schemaVersion: GATED_LIVE_FIX_LOOP_SCHEMA_VERSION,
    status: liveFixResult.status,
    applied: liveFixResult.applied,
    needsApproval: liveFixResult.needsApproval ?? false,
    approvalRequest: liveFixResult.approvalRequest ?? null,
    rollback: liveFixResult.rollback ?? null,
    reason: liveFixResult.reason ?? null,
    sloTrigger: {
      verdict: sloAnalysis.verdict,
      reason: sloAnalysis.reason,
    },
    canaryGate: {
      verdict: canaryGate.verdict,
      reason: canaryGate.reason,
      outcome: canaryOutcome,
    },
    regressionTests: liveFixResult.regressionTests,
    events,
  });
}

export function replayGatedLiveFixLoop(events = []) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new GatedLiveFixLoopError("livefix.events_required", "$");
  }

  const ordered = [...events].sort((left, right) => left.seq - right.seq);
  const liveFixSubset = ordered.filter((event) =>
    !["slo.RegressionDetected", "gen.ValidationRequested"].includes(event.type),
  );
  const replay = replayLiveFixEvents(liveFixSubset);
  const seenTypes = new Set(ordered.map((event) => event.type));

  return deepFreeze({
    status: replay.status,
    applied: replay.applied,
    needsApproval: replay.needsApproval,
    rolledBack: replay.rolledBack,
    policyEffect: replay.policyEffect,
    sloRegressionDetected: seenTypes.has("slo.RegressionDetected"),
    candidateGenerated: seenTypes.has("gen.CandidateGenerated"),
    validationRequested: seenTypes.has("gen.ValidationRequested"),
    retainedRegressionTests: replay.retainedRegressionTests,
    eventTypes: ordered.map((event) => event.type),
  });
}

function parseScenario(input) {
  const incident = parseIncident(input.incident ?? input);
  const failingTrace = parseFailingTrace(input.failingTrace);
  const candidate = parseCandidate(input.candidate);
  const policy = input.policy ?? { maxBlastRadius: { maxResources: 1 } };
  const rollout = parseRollout(input.rollout);
  const sloRegression = parseSloRegression(input.sloRegression);
  const canaryObservation = parseCanaryObservation(input.canaryObservation ?? input.sloRegression);
  const sloPolicy = input.sloPolicy ?? defaultSloPolicy();

  return {
    now: parseIso(input.now ?? "2026-07-02T00:00:00.000Z", "$.now"),
    incident,
    failingTrace,
    candidate,
    policy,
    rollout,
    sloRegression,
    canaryObservation,
    sloPolicy,
  };
}

function parseIncident(value) {
  const incident = object(value, "$.incident");
  return {
    id: nonEmptyString(incident.id, "$.incident.id"),
    correlationId: nonEmptyString(incident.correlationId ?? incident.id, "$.incident.correlationId"),
    environment: nonEmptyString(incident.environment, "$.incident.environment").toLowerCase(),
    signal: nonEmptyString(incident.signal ?? "slo-burn", "$.incident.signal"),
    failureEventId: nonEmptyString(incident.failureEventId ?? incident.id, "$.incident.failureEventId"),
  };
}

function parseFailingTrace(value) {
  const trace = object(value, "$.failingTrace");
  const assertions = array(trace.assertions, "$.failingTrace.assertions");
  if (assertions.length === 0) {
    throw new GatedLiveFixLoopError(
      "livefix.trace_assertions_required",
      "$.failingTrace.assertions",
      "failing trace must become a permanent regression test",
    );
  }

  return {
    id: nonEmptyString(trace.id, "$.failingTrace.id"),
    assertions: assertions.map((assertion, index) =>
      nonEmptyString(assertion, `$.failingTrace.assertions[${index}]`),
    ),
  };
}

function parseCandidate(value) {
  const candidate = object(value, "$.candidate");
  const blastRadius = object(candidate.blastRadius ?? {}, "$.candidate.blastRadius");

  return {
    id: nonEmptyString(candidate.id, "$.candidate.id"),
    patchRef: nonEmptyString(candidate.patchRef, "$.candidate.patchRef"),
    riskClass: nonEmptyString(candidate.riskClass ?? "low", "$.candidate.riskClass"),
    hypothesis: nonEmptyString(candidate.hypothesis ?? "retry-with-backoff", "$.candidate.hypothesis"),
    sandbox: parseGate(candidate.sandbox, "$.candidate.sandbox"),
    conformance: parseGate(candidate.conformance, "$.candidate.conformance"),
    traceReplay: parseGate(candidate.traceReplay, "$.candidate.traceReplay"),
    blastRadius: {
      maxResources: integerAtLeast(blastRadius.maxResources ?? 1, "$.candidate.blastRadius.maxResources", 1),
      destructive: Boolean(blastRadius.destructive),
      reversible: blastRadius.reversible !== false,
      compensationRef: nonEmptyString(
        blastRadius.compensationRef ?? "livefix:rollback-to-previous-candidate",
        "$.candidate.blastRadius.compensationRef",
      ),
    },
  };
}

function parseGate(value, path) {
  const gate = value && isJsonObject(value) ? value : {};
  return {
    passed: gate.passed !== false,
    reportRef: nonEmptyString(gate.reportRef ?? `${path}:report`, `${path}.reportRef`),
  };
}

function parseRollout(value = {}) {
  const rollout = value && isJsonObject(value) ? value : {};
  return {
    id: nonEmptyString(rollout.id ?? "rollout-live-fix-001", "$.rollout.id"),
    stepId: nonEmptyString(rollout.stepId ?? "canary-observe", "$.rollout.stepId"),
    routeId: nonEmptyString(rollout.routeId ?? "route-checkout", "$.rollout.routeId"),
    fromVersion: nonEmptyString(rollout.fromVersion ?? "checkout@blue", "$.rollout.fromVersion"),
    toVersion: nonEmptyString(rollout.toVersion ?? "checkout@green", "$.rollout.toVersion"),
    tenant: nonEmptyString(rollout.tenant ?? "tenant-a", "$.rollout.tenant"),
    failedGate: nonEmptyString(rollout.failedGate ?? "slo-burn", "$.rollout.failedGate"),
    autoRollbackSignals: array(
      rollout.autoRollbackSignals ?? ["slo-burn", "golden-suite"],
      "$.rollout.autoRollbackSignals",
    ),
  };
}

function parseSloRegression(value = {}) {
  const regression = value && isJsonObject(value) ? value : {};
  const snapshot = sloSample(regression.snapshot ?? defaultRegressionSnapshot(), "$.sloRegression.snapshot");
  const windowSamples = array(regression.windowSamples ?? [
    sloSample({ seq: 20, burnRate: 13.5, remainingBudgetRatio: 0.06, status: "available" }),
    snapshot,
  ], "$.sloRegression.windowSamples")
    .map((sample, index) => sloSample(sample, `$.sloRegression.windowSamples[${index}]`));

  return {
    snapshot,
    windowSamples,
    goldenSuite: parseGoldenSuite(regression.goldenSuite),
  };
}

function parseCanaryObservation(value = {}) {
  const observation = value && isJsonObject(value) ? value : {};
  const snapshot = sloSample(observation.snapshot ?? defaultHealthySnapshot(), "$.canaryObservation.snapshot");
  const windowSamples = array(observation.windowSamples ?? [snapshot], "$.canaryObservation.windowSamples")
    .map((sample, index) => sloSample(sample, `$.canaryObservation.windowSamples[${index}]`));

  return {
    snapshot,
    windowSamples,
    goldenSuite: parseGoldenSuite(observation.goldenSuite),
  };
}

function parseGoldenSuite(value = {}) {
  const goldenSuite = value && isJsonObject(value) ? value : {};
  return {
    suiteId: nonEmptyString(goldenSuite.suiteId ?? "checkout-golden", "$.goldenSuite.suiteId"),
    status: nonEmptyString(goldenSuite.status ?? "passed", "$.goldenSuite.status"),
    failures: array(goldenSuite.failures ?? [], "$.goldenSuite.failures"),
  };
}

function sloSample(value, path) {
  const sample = object(value, path);
  return {
    sloId: nonEmptyString(sample.sloId ?? "checkout-availability", `${path}.sloId`),
    seq: integerAtLeast(sample.seq ?? 1, `${path}.seq`, 1),
    status: nonEmptyString(sample.status ?? "available", `${path}.status`),
    burnRate: numberAtLeast(sample.burnRate ?? 1, `${path}.burnRate`, 0),
    remainingBudgetRatio: numberAtLeast(sample.remainingBudgetRatio ?? 0.5, `${path}.remainingBudgetRatio`, 0),
    observedAt: nonEmptyString(sample.observedAt ?? "2026-07-02T00:00:00.000Z", `${path}.observedAt`),
  };
}

function rolloutContext(rollout) {
  return {
    rolloutId: rollout.id,
    stepId: rollout.stepId,
    routeId: rollout.routeId,
    fromVersion: rollout.fromVersion,
    toVersion: rollout.toVersion,
    tenant: rollout.tenant,
  };
}

function defaultSloPolicy() {
  return {
    analysisWindow: "5m",
    holdBurnRate: 1,
    rollbackBurnRate: 12,
    minRemainingBudgetRatio: 0.08,
    holdRemainingBudgetRatio: 0.2,
    sustainedBreachCount: 2,
    sustainedHealthyCount: 2,
  };
}

function defaultHealthySnapshot() {
  return {
    sloId: "checkout-availability",
    seq: 20,
    status: "available",
    burnRate: 0.4,
    remainingBudgetRatio: 0.82,
    observedAt: "2026-07-02T00:05:00.000Z",
  };
}

function defaultRegressionSnapshot() {
  return {
    sloId: "checkout-availability",
    seq: 21,
    status: "available",
    burnRate: 14.8,
    remainingBudgetRatio: 0.04,
    observedAt: "2026-07-02T00:00:00.000Z",
  };
}

function object(value, path) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new GatedLiveFixLoopError("livefix.object_required", path);
  }
  return value;
}

function array(value, path) {
  if (!Array.isArray(value)) {
    throw new GatedLiveFixLoopError("livefix.array_required", path);
  }
  return value;
}

function nonEmptyString(value, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new GatedLiveFixLoopError("livefix.string_required", path);
  }
  return value;
}

function integerAtLeast(value, path, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new GatedLiveFixLoopError("livefix.integer_required", path);
  }
  return value;
}

function numberAtLeast(value, path, minimum) {
  if (!isJsonNumber(value) || Number.isNaN(value) || value < minimum) {
    throw new GatedLiveFixLoopError("livefix.number_required", path);
  }
  return value;
}

function parseIso(value, path) {
  const text = nonEmptyString(value, path);
  if (Number.isNaN(Date.parse(text))) {
    throw new GatedLiveFixLoopError("livefix.iso_required", path);
  }
  return text;
}

function deepFreeze(value) {
  if (!value || Object.isFrozen(value) || !(Array.isArray(value) || isJsonObject(value))) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
