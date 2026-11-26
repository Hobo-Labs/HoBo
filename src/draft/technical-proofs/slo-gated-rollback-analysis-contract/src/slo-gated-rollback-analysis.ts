import { createHash } from "node:crypto";

import { evaluatePromotionGate } from "../../slo-promotion-gate-contract/src/slo-promotion-gate-contract.js";

export const SLO_GATED_ROLLBACK_ANALYSIS_VERSION = "hobo.slo-gated-rollback-analysis/v1";

export const SLO_GATE_EVENT_TYPES = Object.freeze({
  metricAnalysisDecided: "delivery.MetricAnalysisDecided",
  obligationCreated: "policy.ObligationCreated",
  obligationSatisfied: "policy.ObligationSatisfied",
  obligationEscalated: "policy.ObligationEscalated",
});

export function evaluateRolloutMetricGate(input = {}) {
  const rollout = normalizeRollout(input.rollout);
  const sloPromotionGate = input.sloPromotionGate ?? input.resolvedPromotionGate;
  const policy = normalizePolicy(input.policy ?? policyFromSloPromotionGate(sloPromotionGate));
  const snapshot = normalizeSnapshot(input.sloSnapshot ?? snapshotFromSloPromotionGate(sloPromotionGate));
  const goldenSuite = normalizeGoldenSuite(input.goldenSuite ?? goldenSuiteFromSloPromotionGate(sloPromotionGate));
  const windowSamples = normalizeSamples(input.windowSamples ?? [snapshot]);
  const now = normalizeNow(input.now);
  const seq = sequence(input.startSeq ?? 0);
  const decision = decide({ policy, snapshot, goldenSuite, windowSamples });
  const upstreamGate = sloPromotionGate === undefined ? undefined : evaluatePromotionGate(sloPromotionGate);
  let evidence = {
    schemaVersion: SLO_GATED_ROLLBACK_ANALYSIS_VERSION,
    rollout,
    policy,
    sloSnapshot: snapshot,
    goldenSuite,
    windowSamples,
  };
  if (sloPromotionGate !== undefined) {
    evidence.sloPromotionGate = cloneJson(sloPromotionGate);
    evidence.upstreamGate = cloneJson(upstreamGate);
  }
  evidence = deepFreeze(evidence);
  const decided = event(SLO_GATE_EVENT_TYPES.metricAnalysisDecided, {
    id: `delivery.MetricAnalysisDecided:${rollout.rolloutId}:${snapshot.seq}`,
    streamId: `rollout:${rollout.rolloutId}`,
    seq: seq(),
    ts: now(),
    data: {
      rolloutId: rollout.rolloutId,
      stepId: rollout.stepId,
      verdict: decision.verdict,
      reason: decision.reason,
      reasonSloId: snapshot.sloId,
      evidence,
      inputHash: stableDigest(evidence),
    },
  });
  const events = [decided];

  if (decision.verdict === "rollback") {
    events.push(createRollbackObligation({ rollout, decisionEvent: decided, seq: seq(), ts: now() }));
  }

  return deepFreeze({
    schemaVersion: SLO_GATED_ROLLBACK_ANALYSIS_VERSION,
    verdict: decision.verdict,
    reason: decision.reason,
    gateSignal: toRolloutGateSignal(decision, snapshot),
    events,
  });
}

export function toRolloutGateSignal(decision, snapshot = {}) {
  if (decision.verdict === "promote") {
    return {
      decision: "pass",
      reason: decision.reason,
      signals: {
        sloBurn: {
          verdict: "promote",
          reason: decision.reason,
          sourceSeq: snapshot.seq,
          sloId: snapshot.sloId,
        },
      },
    };
  }

  if (decision.verdict === "rollback") {
    return {
      decision: "fail",
      reason: decision.reason,
      signals: {
        sloBurn: {
          verdict: "rollback",
          reason: decision.reason,
          sourceSeq: snapshot.seq,
          sloId: snapshot.sloId,
        },
      },
    };
  }

  return {
    decision: "hold",
    reason: decision.reason,
    signals: {
      sloBurn: {
        verdict: "hold",
        reason: decision.reason,
        sourceSeq: snapshot.seq,
        sloId: snapshot.sloId,
      },
    },
  };
}

export function completeRollbackObligation({
  obligationEvent,
  rollbackEvent,
  status = "satisfied",
  reason,
  now = new Date().toISOString(),
  seq = nextSeqAfter([obligationEvent, rollbackEvent].filter(Boolean)),
} = {}) {
  const obligation = normalizeObligation(obligationEvent);
  if (status === "satisfied") {
    assertRollbackEvent(rollbackEvent, obligation);
    return event(SLO_GATE_EVENT_TYPES.obligationSatisfied, {
      id: `policy.ObligationSatisfied:${obligation.id}:${rollbackEvent.id}`,
      streamId: obligation.streamId,
      seq,
      ts: now,
      data: {
        obligationId: obligation.id,
        policyDecisionId: obligation.policyDecisionId,
        resultEventId: rollbackEvent.id,
        satisfiedAt: now,
      },
    });
  }

  if (status === "escalated") {
    return event(SLO_GATE_EVENT_TYPES.obligationEscalated, {
      id: `policy.ObligationEscalated:${obligation.id}:${seq}`,
      streamId: obligation.streamId,
      seq,
      ts: now,
      data: {
        obligationId: obligation.id,
        policyDecisionId: obligation.policyDecisionId,
        reason: reason ?? "rollback-obligation-not-satisfied",
        escalatedAt: now,
      },
    });
  }

  throw new Error("status must be satisfied or escalated");
}

export function replayMetricGateEvents(events = []) {
  if (!Array.isArray(events)) {
    throw new Error("events must be an array");
  }

  const decisions = events.filter((event) => event.type === SLO_GATE_EVENT_TYPES.metricAnalysisDecided);
  const created = new Map();
  const satisfied = new Set();
  const escalated = new Set();

  for (const event of events) {
    if (event.type === SLO_GATE_EVENT_TYPES.obligationCreated) {
      created.set(event.id, event);
    }
    if (event.type === SLO_GATE_EVENT_TYPES.obligationSatisfied) {
      satisfied.add(event.data.obligationId);
    }
    if (event.type === SLO_GATE_EVENT_TYPES.obligationEscalated) {
      escalated.add(event.data.obligationId);
    }
  }

  const openObligations = [...created.values()].filter(
    (obligation) => !satisfied.has(obligation.id) && !escalated.has(obligation.id),
  );
  const latestDecision = decisions.at(-1) ?? null;

  return deepFreeze({
    status: openObligations.length > 0 ? "rollback-obligation-open" : latestDecision?.data.verdict ?? "unknown",
    latestVerdict: latestDecision?.data.verdict ?? null,
    decisions,
    openObligations,
    satisfiedObligationIds: [...satisfied],
    escalatedObligationIds: [...escalated],
  });
}

export function stableDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function decide({ policy, snapshot, goldenSuite, windowSamples }) {
  if (goldenSuite.status === "failed" || goldenSuite.failures.length > 0) {
    return { verdict: "rollback", reason: "golden-suite-failure" };
  }

  if (snapshot.status !== "available") {
    return { verdict: "hold", reason: `slo-snapshot-${snapshot.status}` };
  }

  const recentUsable = windowSamples.filter((sample) => sample.status === "available");
  if (recentUsable.length < policy.sustainedBreachCount) {
    return { verdict: "hold", reason: "slo-window-insufficient-samples" };
  }

  const recent = recentUsable.slice(-policy.sustainedBreachCount);
  const rollbackWindow =
    recent.every((sample) => sample.burnRate >= policy.rollbackBurnRate) ||
    recent.every((sample) => sample.remainingBudgetRatio <= policy.minRemainingBudgetRatio);

  if (rollbackWindow) {
    return { verdict: "rollback", reason: "slo-burn-rate-rollback-threshold" };
  }

  const latest = recentUsable.at(-1);
  if (
    latest.burnRate >= policy.holdBurnRate ||
    latest.remainingBudgetRatio <= policy.holdRemainingBudgetRatio
  ) {
    return { verdict: "hold", reason: "slo-burn-rate-hold-threshold" };
  }

  const healthyWindow = recentUsable.slice(-policy.sustainedHealthyCount);
  if (
    healthyWindow.length < policy.sustainedHealthyCount ||
    !healthyWindow.every((sample) =>
      sample.burnRate < policy.holdBurnRate &&
      sample.remainingBudgetRatio > policy.holdRemainingBudgetRatio,
    )
  ) {
    return { verdict: "hold", reason: "slo-hysteresis-waiting-for-sustained-health" };
  }

  return { verdict: "promote", reason: "within-slo-budget" };
}

function createRollbackObligation({ rollout, decisionEvent, seq, ts }) {
  return event(SLO_GATE_EVENT_TYPES.obligationCreated, {
    id: `policy.ObligationCreated:${rollout.rolloutId}:${decisionEvent.seq}`,
    streamId: `rollout:${rollout.rolloutId}`,
    seq,
    ts,
    data: {
      status: "open",
      kind: "error-budget.auto-revert",
      policyDecisionId: decisionEvent.id,
      target: {
        kind: "rollout",
        rolloutId: rollout.rolloutId,
        routeId: rollout.routeId,
        fromVersion: rollout.fromVersion,
        toVersion: rollout.toVersion,
      },
      reason: decisionEvent.data.reason,
      blocksPromotionUntil: "policy.ObligationSatisfied",
    },
  });
}

function policyFromSloPromotionGate(sloPromotionGate) {
  if (sloPromotionGate === undefined) {
    return {};
  }

  const gate = firstSloPromotionGate(sloPromotionGate);
  return {
    analysisWindow: gate.analysisWindow,
    holdBurnRate: gate.thresholds?.holdBurnRate,
    rollbackBurnRate: gate.thresholds?.rollbackBurnRate,
    minRemainingBudgetRatio: gate.thresholds?.minRemainingBudgetRatio,
    holdRemainingBudgetRatio: gate.thresholds?.holdRemainingBudgetRatio,
  };
}

function snapshotFromSloPromotionGate(sloPromotionGate) {
  if (sloPromotionGate === undefined) {
    return undefined;
  }

  const gate = firstSloPromotionGate(sloPromotionGate);
  const snapshot = gate.snapshot ?? {};
  return {
    sloId: requiredString(gate.sloId, "sloPromotionGate.gates[0].sloId"),
    seq: nonNegativeInteger(sloPromotionGate.seq, "sloPromotionGate.seq"),
    status: requiredString(snapshot.status ?? "unavailable", "sloPromotionGate.gates[0].snapshot.status"),
    burnRate: finiteNumber(snapshot.burnRate ?? 0, "sloPromotionGate.gates[0].snapshot.burnRate"),
    remainingBudgetRatio: finiteRatio(
      snapshot.remainingBudgetRatio ?? 0,
      "sloPromotionGate.gates[0].snapshot.remainingBudgetRatio",
    ),
    observedAt: requiredString(sloPromotionGate.generatedAt, "sloPromotionGate.generatedAt"),
  };
}

function goldenSuiteFromSloPromotionGate(sloPromotionGate) {
  if (sloPromotionGate === undefined || sloPromotionGate.goldenSuite === undefined) {
    return undefined;
  }

  const failures = Array.isArray(sloPromotionGate.goldenSuite.failures)
    ? sloPromotionGate.goldenSuite.failures
    : [];
  return {
    suiteId: requiredString(
      sloPromotionGate.goldenSuite.suiteId ?? sloPromotionGate.goldenSuite.id ?? "golden.default",
      "sloPromotionGate.goldenSuite.suiteId",
    ),
    status: requiredString(
      sloPromotionGate.goldenSuite.status ?? (failures.length > 0 ? "failed" : "passed"),
      "sloPromotionGate.goldenSuite.status",
    ),
    failures,
  };
}

function firstSloPromotionGate(sloPromotionGate) {
  assertObject(sloPromotionGate, "sloPromotionGate");
  if (!Array.isArray(sloPromotionGate.gates) || sloPromotionGate.gates.length === 0) {
    throw new Error("sloPromotionGate requires at least one gate");
  }
  return sloPromotionGate.gates[0];
}

function normalizeRollout(rollout) {
  assertObject(rollout, "rollout");
  return {
    rolloutId: requiredString(rollout.rolloutId, "rollout.rolloutId"),
    stepId: requiredString(rollout.stepId, "rollout.stepId"),
    routeId: requiredString(rollout.routeId, "rollout.routeId"),
    fromVersion: requiredString(rollout.fromVersion, "rollout.fromVersion"),
    toVersion: requiredString(rollout.toVersion, "rollout.toVersion"),
    tenant: requiredString(rollout.tenant, "rollout.tenant"),
  };
}

function normalizePolicy(policy = {}) {
  return {
    analysisWindow: requiredString(policy.analysisWindow ?? "5m", "policy.analysisWindow"),
    holdBurnRate: positiveNumber(policy.holdBurnRate ?? 1, "policy.holdBurnRate"),
    rollbackBurnRate: positiveNumber(policy.rollbackBurnRate ?? 2, "policy.rollbackBurnRate"),
    minRemainingBudgetRatio: finiteRatio(
      policy.minRemainingBudgetRatio ?? 0.1,
      "policy.minRemainingBudgetRatio",
    ),
    holdRemainingBudgetRatio: finiteRatio(
      policy.holdRemainingBudgetRatio ?? 0.2,
      "policy.holdRemainingBudgetRatio",
    ),
    sustainedBreachCount: positiveInteger(
      policy.sustainedBreachCount ?? 2,
      "policy.sustainedBreachCount",
    ),
    sustainedHealthyCount: positiveInteger(
      policy.sustainedHealthyCount ?? 2,
      "policy.sustainedHealthyCount",
    ),
  };
}

function normalizeSnapshot(snapshot) {
  assertObject(snapshot, "sloSnapshot");
  return normalizeSample(snapshot);
}

function normalizeSamples(samples) {
  if (!Array.isArray(samples)) {
    throw new Error("windowSamples must be an array");
  }
  return samples.map(normalizeSample);
}

function normalizeSample(sample) {
  assertObject(sample, "slo sample");
  return {
    sloId: requiredString(sample.sloId, "slo sample.sloId"),
    seq: nonNegativeInteger(sample.seq, "slo sample.seq"),
    status: requiredString(sample.status, "slo sample.status"),
    burnRate: finiteNumber(sample.burnRate ?? 0, "slo sample.burnRate"),
    remainingBudgetRatio: finiteRatio(
      sample.remainingBudgetRatio ?? 0,
      "slo sample.remainingBudgetRatio",
    ),
    observedAt: requiredString(sample.observedAt, "slo sample.observedAt"),
  };
}

function normalizeGoldenSuite(suite = {}) {
  const failures = Array.isArray(suite.failures) ? suite.failures.map(cloneJson) : [];
  return {
    suiteId: requiredString(suite.suiteId ?? "golden.default", "goldenSuite.suiteId"),
    status: requiredString(suite.status ?? (failures.length > 0 ? "failed" : "passed"), "goldenSuite.status"),
    failures,
  };
}

function normalizeNow(now) {
  if (isCallable(now)) {
    return now;
  }
  if (now === undefined) {
    return () => new Date().toISOString();
  }
  return () => requiredString(now, "now");
}

function normalizeObligation(eventValue) {
  assertObject(eventValue, "obligationEvent");
  if (eventValue.type !== SLO_GATE_EVENT_TYPES.obligationCreated) {
    throw new Error("obligationEvent.type must be policy.ObligationCreated");
  }
  return {
    id: requiredString(eventValue.id, "obligationEvent.id"),
    streamId: requiredString(eventValue.streamId, "obligationEvent.streamId"),
    policyDecisionId: requiredString(eventValue.data?.policyDecisionId, "obligationEvent.data.policyDecisionId"),
    rolloutId: requiredString(eventValue.data?.target?.rolloutId, "obligationEvent.data.target.rolloutId"),
  };
}

function assertRollbackEvent(eventValue, obligation) {
  assertObject(eventValue, "rollbackEvent");
  if (eventValue.type !== "rollout.RolledBack") {
    throw new Error("rollbackEvent.type must be rollout.RolledBack");
  }
  const rolloutId = eventValue.data?.rolloutId;
  if (rolloutId !== obligation.rolloutId) {
    throw new Error(`rollbackEvent rollout ${rolloutId} does not satisfy ${obligation.rolloutId}`);
  }
}

function event(type, { id, streamId, seq, ts, data }) {
  return deepFreeze({
    id,
    type,
    schemaVersion: SLO_GATED_ROLLBACK_ANALYSIS_VERSION,
    streamId,
    seq,
    ts,
    data: cloneJson(data),
  });
}

function nextSeqAfter(events) {
  return events.reduce((max, candidate) => Math.max(max, candidate?.seq ?? 0), 0) + 1;
}

function sequence(start = 0) {
  let current = start;
  return () => ++current;
}

function requiredString(value, fieldName) {
  if (!isString(value) || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function positiveInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
  return value;
}

function finiteNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${fieldName} must be finite`);
  }
  return number;
}

function positiveNumber(value, fieldName) {
  const number = finiteNumber(value, fieldName);
  if (number <= 0) {
    throw new Error(`${fieldName} must be positive`);
  }
  return number;
}

function finiteRatio(value, fieldName) {
  const number = finiteNumber(value, fieldName);
  if (number < 0 || number > 1) {
    throw new Error(`${fieldName} must be between 0 and 1`);
  }
  return number;
}

function assertObject(value, fieldName) {
  if (!isObjectRecord(value)) {
    throw new Error(`${fieldName} must be an object`);
  }
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!isObjectRecord(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!isObjectRecord(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function isObjectRecord(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isCallable(value) {
  return ["[object Function]", "[object AsyncFunction]", "[object GeneratorFunction]"].includes(
    Object.prototype.toString.call(value),
  );
}

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}
