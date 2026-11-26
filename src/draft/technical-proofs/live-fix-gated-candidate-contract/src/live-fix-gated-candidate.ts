export const LIVE_FIX_GATED_CANDIDATE_SCHEMA_VERSION = "hobo.live-fix-gated-candidate/v1";

const PROD_ENVIRONMENTS = new Set(["prod", "production"]);
const tagOf = Object.prototype.toString;

export class LiveFixGatedCandidateError extends Error {
  constructor(code, path = "$", message = code) {
    super(`${code} at ${path}: ${message}`);
    this.name = "LiveFixGatedCandidateError";
    this.code = code;
    this.path = path;
  }
}

export function planLiveFixCandidate(input = {}) {
  const incident = parseIncident(input.incident);
  const trace = parseFailingTrace(input.failingTrace);
  const candidate = parseCandidate(input.candidate);
  const policy = parsePolicy(input.policy);
  const rollout = parseRollout(input.rollout);
  const now = parseIso(input.now ?? "2026-06-28T00:00:00.000Z", "$.now");
  const streamId = `livefix:${incident.id}:${candidate.id}`;
  const events = [];
  const emit = (type, data) => {
    const event = {
      id: `${streamId}:${events.length + 1}`,
      type,
      schemaVersion: LIVE_FIX_GATED_CANDIDATE_SCHEMA_VERSION,
      streamId,
      seq: events.length + 1,
      ts: now,
      correlationId: incident.correlationId,
      causationId: events.at(-1)?.id ?? incident.failureEventId,
      data,
    };
    events.push(event);
    return event;
  };

  emit("livefix.TraceCaptured", {
    incidentId: incident.id,
    environment: incident.environment,
    traceId: trace.id,
    signal: incident.signal,
  });
  emit("gen.CandidateGenerated", {
    candidateId: candidate.id,
    patchRef: candidate.patchRef,
    riskClass: candidate.riskClass,
    blastRadius: candidate.blastRadius,
  });

  const regressionTest = createRegressionTest({ trace, incident, candidate });
  const validation = validateCandidate(candidate);
  if (!validation.passed) {
    emit("gen.ValidationFailed", {
      candidateId: candidate.id,
      failures: validation.failures,
    });
    emit("livefix.RegressionTestRetained", { regressionTest });

    return finish({
      status: "blocked-by-validation",
      applied: false,
      needsApproval: false,
      events,
      regressionTests: [regressionTest],
      reason: validation.failures[0],
    });
  }

  emit("gen.ValidationPassed", {
    candidateId: candidate.id,
    sandboxReportRef: candidate.sandbox.reportRef,
    conformanceReportRef: candidate.conformance.reportRef,
    replayTraceId: trace.id,
  });

  const policyDecision = decidePolicy({ incident, candidate, policy });
  emit("policy.Decided", policyDecision);

  if (policyDecision.effect === "require-approval") {
    emit("livefix.ApprovalRequested", {
      candidateId: candidate.id,
      reason: policyDecision.reason,
      approvalKind: "human",
      policyIds: policyDecision.policyIds,
    });
    emit("livefix.RegressionTestRetained", { regressionTest });

    return finish({
      status: "needs-approval",
      applied: false,
      needsApproval: true,
      approvalRequest: {
        kind: "human",
        reason: policyDecision.reason,
        candidateId: candidate.id,
      },
      events,
      regressionTests: [regressionTest],
      reason: policyDecision.reason,
    });
  }

  emit("deployment.CanaryStarted", {
    candidateId: candidate.id,
    rolloutId: rollout.id,
    maxBlastRadius: candidate.blastRadius.maxResources,
    autoRollbackSignals: rollout.autoRollbackSignals,
  });

  if (rollout.canaryOutcome === "regression") {
    emit("deployment.RollbackStarted", {
      rolloutId: rollout.id,
      reason: rollout.failedGate,
      reversible: candidate.blastRadius.reversible,
    });
    const rollbackEvent = emit("deployment.RolledBack", {
      rolloutId: rollout.id,
      candidateId: candidate.id,
      compensationRef: candidate.blastRadius.compensationRef,
      sourceGate: rollout.failedGate,
    });
    emit("livefix.RegressionTestRetained", { regressionTest });

    return finish({
      status: "rolled-back",
      applied: false,
      needsApproval: false,
      rollback: {
        reversible: candidate.blastRadius.reversible,
        eventId: rollbackEvent.id,
        compensationRef: candidate.blastRadius.compensationRef,
      },
      events,
      regressionTests: [regressionTest],
      reason: rollout.failedGate,
    });
  }

  emit("deployment.Promoted", {
    rolloutId: rollout.id,
    candidateId: candidate.id,
    environment: incident.environment,
  });
  emit("livefix.RegressionTestRetained", { regressionTest });

  return finish({
    status: "applied",
    applied: true,
    needsApproval: false,
    events,
    regressionTests: [regressionTest],
  });
}

export function replayLiveFixEvents(inputEvents = []) {
  if (!Array.isArray(inputEvents) || inputEvents.length === 0) {
    throw new LiveFixGatedCandidateError("livefix.events_required", "$");
  }

  const events = [...inputEvents].sort((left, right) => left.seq - right.seq);
  const seenTypes = new Set(events.map((event) => event.type));
  const policy = [...events].reverse().find((event) => event.type === "policy.Decided")?.data ?? null;
  const retainedRegressionTests = events
    .filter((event) => event.type === "livefix.RegressionTestRetained")
    .map((event) => event.data.regressionTest);

  return deepFreeze({
    status: deriveStatus(seenTypes),
    applied: seenTypes.has("deployment.Promoted"),
    needsApproval: seenTypes.has("livefix.ApprovalRequested"),
    rolledBack: seenTypes.has("deployment.RolledBack"),
    policyEffect: policy?.effect ?? null,
    retainedRegressionTests,
    eventTypes: events.map((event) => event.type),
  });
}

function deriveStatus(seenTypes) {
  if (seenTypes.has("deployment.RolledBack")) return "rolled-back";
  if (seenTypes.has("livefix.ApprovalRequested")) return "needs-approval";
  if (seenTypes.has("gen.ValidationFailed")) return "blocked-by-validation";
  if (seenTypes.has("deployment.Promoted")) return "applied";
  return "unknown";
}

function validateCandidate(candidate) {
  const failures = [];
  if (!candidate.sandbox.passed) failures.push("sandbox-validation-failed");
  if (!candidate.conformance.passed) failures.push("conformance-failed");
  if (!candidate.traceReplay.passed) failures.push("failing-trace-replay-regressed");

  return {
    passed: failures.length === 0,
    failures,
  };
}

function decidePolicy({ incident, candidate, policy }) {
  if (candidate.blastRadius.maxResources > policy.maxBlastRadius.maxResources) {
    return {
      effect: "require-approval",
      reason: "max-blast-radius-exceeded",
      policyIds: ["livefix.max-blast-radius"],
    };
  }

  if (candidate.blastRadius.destructive) {
    return {
      effect: "require-approval",
      reason: "destructive-live-fix",
      policyIds: ["livefix.destructive-human-gate"],
    };
  }

  if (PROD_ENVIRONMENTS.has(incident.environment) || candidate.riskClass === "high") {
    return {
      effect: "require-approval",
      reason: "production-or-high-risk-live-fix",
      policyIds: ["livefix.prod-human-gate"],
    };
  }

  return {
    effect: "allow-canary",
    reason: "low-risk-live-fix",
    policyIds: ["livefix.low-risk-canary"],
  };
}

function createRegressionTest({ trace, incident, candidate }) {
  return deepFreeze({
    id: `regression:${trace.id}`,
    kind: "failing-trace-replay",
    permanent: true,
    sourceTraceId: trace.id,
    incidentId: incident.id,
    candidateId: candidate.id,
    assertions: trace.assertions,
  });
}

function finish(result) {
  return deepFreeze({
    schemaVersion: LIVE_FIX_GATED_CANDIDATE_SCHEMA_VERSION,
    ...result,
  });
}

function parseIncident(value) {
  const incident = object(value, "$.incident");
  return {
    id: nonEmptyString(incident.id, "$.incident.id"),
    correlationId: nonEmptyString(incident.correlationId ?? incident.id, "$.incident.correlationId"),
    environment: nonEmptyString(incident.environment, "$.incident.environment").toLowerCase(),
    signal: nonEmptyString(incident.signal, "$.incident.signal"),
    failureEventId: nonEmptyString(incident.failureEventId ?? incident.id, "$.incident.failureEventId"),
  };
}

function parseFailingTrace(value) {
  const trace = object(value, "$.failingTrace");
  const assertions = array(trace.assertions, "$.failingTrace.assertions");
  if (assertions.length === 0) {
    throw new LiveFixGatedCandidateError(
      "livefix.trace_assertions_required",
      "$.failingTrace.assertions",
      "failing trace must become a regression test",
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
  const blastRadius = object(candidate.blastRadius, "$.candidate.blastRadius");

  return {
    id: nonEmptyString(candidate.id, "$.candidate.id"),
    patchRef: nonEmptyString(candidate.patchRef, "$.candidate.patchRef"),
    riskClass: nonEmptyString(candidate.riskClass ?? "low", "$.candidate.riskClass"),
    sandbox: parseGate(candidate.sandbox, "$.candidate.sandbox"),
    conformance: parseGate(candidate.conformance, "$.candidate.conformance"),
    traceReplay: parseGate(candidate.traceReplay, "$.candidate.traceReplay"),
    blastRadius: {
      maxResources: integerAtLeast(blastRadius.maxResources, "$.candidate.blastRadius.maxResources", 1),
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
  const gate = object(value, path);
  return {
    passed: Boolean(gate.passed),
    reportRef: nonEmptyString(gate.reportRef ?? `${path}:report`, `${path}.reportRef`),
  };
}

function parsePolicy(value = {}) {
  const policy = value && isObjectTag(value) ? value : {};
  const maxBlastRadius =
    policy.maxBlastRadius && isObjectTag(policy.maxBlastRadius)
      ? policy.maxBlastRadius
      : { maxResources: 1 };

  return {
    maxBlastRadius: {
      maxResources: integerAtLeast(maxBlastRadius.maxResources, "$.policy.maxBlastRadius.maxResources", 1),
    },
  };
}

function parseRollout(value = {}) {
  const rollout = value && isObjectTag(value) ? value : {};
  const canaryOutcome = rollout.canaryOutcome ?? "healthy";
  if (!["healthy", "regression"].includes(canaryOutcome)) {
    throw new LiveFixGatedCandidateError("livefix.rollout_outcome", "$.rollout.canaryOutcome");
  }

  return {
    id: nonEmptyString(rollout.id ?? "rollout-live-fix", "$.rollout.id"),
    canaryOutcome,
    failedGate: nonEmptyString(rollout.failedGate ?? "slo-burn", "$.rollout.failedGate"),
    autoRollbackSignals: array(rollout.autoRollbackSignals ?? ["slo-burn", "golden-suite"], "$.rollout.autoRollbackSignals"),
  };
}

function object(value, path) {
  if (!value || !isObjectTag(value) || Array.isArray(value)) {
    throw new LiveFixGatedCandidateError("livefix.object_required", path);
  }
  return value;
}

function array(value, path) {
  if (!Array.isArray(value)) {
    throw new LiveFixGatedCandidateError("livefix.array_required", path);
  }
  return value;
}

function nonEmptyString(value, path) {
  if (!isString(value) || value.length === 0) {
    throw new LiveFixGatedCandidateError("livefix.string_required", path);
  }
  return value;
}

function integerAtLeast(value, path, minimum) {
  if (!Number.isInteger(value) || value < minimum) {
    throw new LiveFixGatedCandidateError("livefix.integer_required", path);
  }
  return value;
}

function parseIso(value, path) {
  const text = nonEmptyString(value, path);
  if (Number.isNaN(Date.parse(text))) {
    throw new LiveFixGatedCandidateError("livefix.iso_required", path);
  }
  return text;
}

function deepFreeze(value) {
  if (!value || (!isObjectTag(value) && !Array.isArray(value)) || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function isString(value) {
  return tagOf.call(value) === "[object String]";
}

function isObjectTag(value) {
  return tagOf.call(value) === "[object Object]";
}
