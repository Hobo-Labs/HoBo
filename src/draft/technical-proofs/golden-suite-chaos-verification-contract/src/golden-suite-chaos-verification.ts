import { isJsonString, isJsonObject } from "./json.js";
export const GOLDEN_CHAOS_EVENT_TYPES = Object.freeze({
  suiteRan: "golden.SuiteRan",
  suitePassed: "golden.Passed",
  suiteFailed: "golden.Failed",
  suiteQuarantined: "golden.Quarantined",
  policyDecided: "policy.Decided",
  experimentStarted: "chaos.ExperimentStarted",
  faultInjected: "chaos.FaultInjected",
  steadyStateChecked: "chaos.SteadyStateChecked",
  injectorRemoved: "chaos.InjectorRemoved",
  experimentCompleted: "chaos.ExperimentCompleted",
  experimentAborted: "chaos.Aborted",
  cleanupFailed: "chaos.CleanupFailed",
  autoRollbackRequired: "rollout.AutoRollbackRequired",
});

export const SUPPORTED_FAULT_INJECTORS = Object.freeze([
  "provider-429",
  "provider-503",
  "node-loss",
  "partition",
  "latency",
  "severed-link",
]);

export function evaluateGoldenSuiteChaosTier(input = {}) {
  const suite = normalizeSuite(input.suite);
  const goldenRuns = normalizeGoldenRuns(input.goldenRuns);
  const sloStatus = input.sloStatus ?? null;
  const experiment = normalizeExperiment(input.chaosExperiment);
  const now = input.now instanceof Function ? input.now : () => new Date(0).toISOString();
  const seq = sequence();
  const events = [];
  const coverage = computeCoverage(suite, goldenRuns);
  const failedChecks = findFailedChecks(goldenRuns);

  events.push(
    event(GOLDEN_CHAOS_EVENT_TYPES.suiteRan, {
      id: `golden-ran-${slug(suite.id)}`,
      streamId: `golden:${suite.id}`,
      seq: seq(),
      ts: now(),
      data: {
        suiteId: suite.id,
        requiredTargets: coverage.requiredTargets,
        satisfiedTargets: coverage.satisfiedTargets,
        missingTargets: coverage.missingTargets,
      },
    }),
  );

  if (coverage.missingTargets.length > 0) {
    const decision = decisionOf("hold-ci", "missing-required-golden-targets");
    events.push(
      event(GOLDEN_CHAOS_EVENT_TYPES.suiteFailed, {
        id: `golden-failed-${slug(suite.id)}`,
        streamId: `golden:${suite.id}`,
        seq: seq(),
        ts: now(),
        data: {
          suiteId: suite.id,
          reason: decision.reason,
          missingTargets: coverage.missingTargets,
        },
      }),
    );
    return result("failed", decision, coverage, events);
  }

  if (failedChecks.some((check) => check.flaky || check.confidence < suite.minConfidence)) {
    const decision = decisionOf("quarantine", "golden-suite-failure-confidence-below-threshold");
    events.push(
      event(GOLDEN_CHAOS_EVENT_TYPES.suiteQuarantined, {
        id: `golden-quarantined-${slug(suite.id)}`,
        streamId: `golden:${suite.id}`,
        seq: seq(),
        ts: now(),
        data: {
          suiteId: suite.id,
          minConfidence: suite.minConfidence,
          failedChecks,
        },
      }),
    );
    return result("quarantined", decision, coverage, events);
  }

  if (failedChecks.length > 0) {
    events.push(
      event(GOLDEN_CHAOS_EVENT_TYPES.suiteFailed, {
        id: `golden-failed-${slug(suite.id)}`,
        streamId: `golden:${suite.id}`,
        seq: seq(),
        ts: now(),
        data: {
          suiteId: suite.id,
          reason: "golden-suite-check-failed",
          failedChecks,
        },
      }),
    );

    if (isBudgetBurning(sloStatus)) {
      const decision = decisionOf(
        "require-auto-rollback",
        "golden-suite-failed-while-slo-budget-burning",
      );
      events.push(
        event(GOLDEN_CHAOS_EVENT_TYPES.autoRollbackRequired, {
          id: `rollback-required-${slug(suite.id)}`,
          streamId: `rollout:${suite.id}`,
          seq: seq(),
          ts: now(),
          data: {
            suiteId: suite.id,
            sloName: sloStatus?.sloName ?? null,
            sloStatus: sloStatus?.status ?? "unknown",
            failedChecks,
          },
        }),
      );
      return result("rollback-required", decision, coverage, events);
    }

    return result("failed", decisionOf("hold-ci", "golden-suite-check-failed"), coverage, events);
  }

  events.push(
    event(GOLDEN_CHAOS_EVENT_TYPES.suitePassed, {
      id: `golden-passed-${slug(suite.id)}`,
      streamId: `golden:${suite.id}`,
      seq: seq(),
      ts: now(),
      data: {
        suiteId: suite.id,
        targets: coverage.satisfiedTargets,
      },
    }),
  );

  const policyDecision = decideChaosPolicy(experiment, input.policyBudget, {
    seq,
    ts: now(),
  });
  events.push(policyDecision.event);
  if (policyDecision.decision.effect === "deny") {
    return result("denied", policyDecision.decision, coverage, events);
  }

  if (experiment.abortCondition.armed !== true) {
    const decision = decisionOf("abort", "abort-condition-deadman");
    events.push(abortedEvent({ experiment, seq, ts: now(), reason: decision.reason }));
    return result("aborted", decision, coverage, events);
  }

  events.push(
    event(GOLDEN_CHAOS_EVENT_TYPES.experimentStarted, {
      id: `chaos-started-${slug(experiment.id)}`,
      streamId: `chaos:${experiment.id}`,
      seq: seq(),
      ts: now(),
      data: {
        experimentId: experiment.id,
        fault: experiment.fault,
        blastRadius: experiment.blastRadius,
        steadyState: experiment.steadyState,
      },
    }),
  );
  events.push(
    event(GOLDEN_CHAOS_EVENT_TYPES.faultInjected, {
      id: `chaos-fault-${slug(experiment.id)}`,
      streamId: `chaos:${experiment.id}`,
      seq: seq(),
      ts: now(),
      data: {
        experimentId: experiment.id,
        fault: experiment.fault,
        projectedErrorBudgetCostRatio: experiment.projectedErrorBudgetCostRatio,
      },
    }),
  );

  const observedBlastRadius = experiment.observedBlastRadius ?? experiment.blastRadius;
  if (exceedsBlastRadius(observedBlastRadius, experiment.blastRadius)) {
    const decision = decisionOf("abort", "blast-radius-bound-leaked");
    events.push(
      abortedEvent({
        experiment,
        seq,
        ts: now(),
        reason: decision.reason,
        observedBlastRadius,
      }),
    );
    return result("aborted", decision, coverage, events);
  }

  const steadyState = evaluateSteadyState(experiment, sloStatus);
  events.push(
    event(GOLDEN_CHAOS_EVENT_TYPES.steadyStateChecked, {
      id: `chaos-steady-state-${slug(experiment.id)}`,
      streamId: `chaos:${experiment.id}`,
      seq: seq(),
      ts: now(),
      data: {
        experimentId: experiment.id,
        steadyState,
      },
    }),
  );
  if (steadyState.status === "breached") {
    const decision = decisionOf("abort", steadyState.reason);
    events.push(abortedEvent({ experiment, seq, ts: now(), reason: decision.reason }));
    return result("aborted", decision, coverage, events);
  }

  if (experiment.cleanup.status !== "removed") {
    const decision = decisionOf("abort", "fault-injector-cleanup-failed");
    events.push(
      event(GOLDEN_CHAOS_EVENT_TYPES.cleanupFailed, {
        id: `chaos-cleanup-failed-${slug(experiment.id)}`,
        streamId: `chaos:${experiment.id}`,
        seq: seq(),
        ts: now(),
        data: {
          experimentId: experiment.id,
          reason: experiment.cleanup.reason ?? decision.reason,
        },
      }),
    );
    return result("cleanup-failed", decision, coverage, events);
  }

  events.push(
    event(GOLDEN_CHAOS_EVENT_TYPES.injectorRemoved, {
      id: `chaos-injector-removed-${slug(experiment.id)}`,
      streamId: `chaos:${experiment.id}`,
      seq: seq(),
      ts: now(),
      data: {
        experimentId: experiment.id,
        fault: experiment.fault,
      },
    }),
  );
  events.push(
    event(GOLDEN_CHAOS_EVENT_TYPES.experimentCompleted, {
      id: `chaos-completed-${slug(experiment.id)}`,
      streamId: `chaos:${experiment.id}`,
      seq: seq(),
      ts: now(),
      data: {
        experimentId: experiment.id,
        result: "steady-state-held",
      },
    }),
  );

  return result("passed", decisionOf("allow-continue", "golden-suite-and-chaos-steady-state-held"), coverage, events);
}

export function replayGoldenChaosTier(events = []) {
  if (!Array.isArray(events)) {
    throw new Error("events must be an array");
  }
  const terminal = [...events].reverse().find((candidate) =>
    [
      GOLDEN_CHAOS_EVENT_TYPES.cleanupFailed,
      GOLDEN_CHAOS_EVENT_TYPES.experimentAborted,
      GOLDEN_CHAOS_EVENT_TYPES.autoRollbackRequired,
      GOLDEN_CHAOS_EVENT_TYPES.experimentCompleted,
      GOLDEN_CHAOS_EVENT_TYPES.suiteQuarantined,
      GOLDEN_CHAOS_EVENT_TYPES.suiteFailed,
      GOLDEN_CHAOS_EVENT_TYPES.policyDecided,
    ].includes(candidate.type),
  );

  return deepFreeze({
    status:
      terminal?.type === GOLDEN_CHAOS_EVENT_TYPES.cleanupFailed
        ? "cleanup-failed"
        : terminal?.type === GOLDEN_CHAOS_EVENT_TYPES.experimentAborted
          ? "aborted"
          : terminal?.type === GOLDEN_CHAOS_EVENT_TYPES.autoRollbackRequired
            ? "rollback-required"
            : terminal?.type === GOLDEN_CHAOS_EVENT_TYPES.experimentCompleted
              ? "passed"
              : terminal?.type === GOLDEN_CHAOS_EVENT_TYPES.suiteQuarantined
                ? "quarantined"
                : terminal?.type === GOLDEN_CHAOS_EVENT_TYPES.suiteFailed
                  ? "failed"
                  : terminal?.data?.effect === "deny"
                    ? "denied"
                    : "unknown",
  });
}

function decideChaosPolicy(experiment, budget, { seq, ts }) {
  const environment = experiment.blastRadius.environment;
  const malformedBudget =
    !budget ||
    !Array.isArray(budget.environments) ||
    !Number.isFinite(budget.remainingFaults) ||
    !Number.isFinite(budget.remainingErrorBudgetRatio) ||
    !Number.isFinite(budget.maxExperimentCostRatio) ||
    !budget.maxBlastRadius;
  const missingBudget = malformedBudget || !budget.environments.includes(environment);
  const blastRadiusExceeded =
    !missingBudget &&
    (budget.maxBlastRadius?.tenant !== experiment.blastRadius.tenant ||
      budget.maxBlastRadius?.camp !== experiment.blastRadius.camp ||
      budget.maxBlastRadius?.maxResources < experiment.blastRadius.maxResources);
  const errorBudgetExceeded =
    !missingBudget &&
    (budget.remainingFaults < 1 ||
      budget.maxExperimentCostRatio < experiment.projectedErrorBudgetCostRatio ||
      budget.remainingErrorBudgetRatio < experiment.projectedErrorBudgetCostRatio);
  const reason = missingBudget
    ? "missing-chaos-policy-budget"
    : blastRadiusExceeded || errorBudgetExceeded
      ? `${environment}-chaos-policy-budget-exceeded`
      : "within-chaos-policy-budget";
  const decision = decisionOf(
    missingBudget || blastRadiusExceeded || errorBudgetExceeded ? "deny" : "allow",
    reason,
  );

  return {
    decision,
    event: event(GOLDEN_CHAOS_EVENT_TYPES.policyDecided, {
      id: `policy-chaos-${slug(experiment.id)}`,
      streamId: `policy:${experiment.id}`,
      seq: seq(),
      ts,
      data: {
        effect: decision.effect,
        reason: decision.reason,
        environment,
        projectedErrorBudgetCostRatio: experiment.projectedErrorBudgetCostRatio,
        remainingErrorBudgetRatio: budget?.remainingErrorBudgetRatio ?? null,
        blastRadius: experiment.blastRadius,
        maxBlastRadius: budget?.maxBlastRadius ?? null,
      },
    }),
  };
}

function evaluateSteadyState(experiment, sloStatus) {
  const targetResumeMs = experiment.steadyState.targetResumeMs;
  const observedResumeMs = experiment.steadyState.observedResumeMs;
  const breachedByResumeTarget = observedResumeMs > targetResumeMs;
  const breachedBySloStatus = sloStatus && sloStatus.healthy === false && isBudgetBurning(sloStatus);
  const status = breachedByResumeTarget || breachedBySloStatus ? "breached" : "held";

  return deepFreeze({
    status,
    invariant: experiment.steadyState.invariant,
    targetResumeMs,
    observedResumeMs,
    sloName: sloStatus?.sloName ?? null,
    reason: status === "breached" ? "steady-state-slo-invariant-breached" : "steady-state-held",
  });
}

function abortedEvent({ experiment, seq, ts, reason, observedBlastRadius }) {
  return event(GOLDEN_CHAOS_EVENT_TYPES.experimentAborted, {
    id: `chaos-aborted-${slug(experiment.id)}`,
    streamId: `chaos:${experiment.id}`,
    seq: seq(),
    ts,
    data: {
      experimentId: experiment.id,
      reason,
      blastRadius: experiment.blastRadius,
      ...(observedBlastRadius ? { observedBlastRadius } : undefined),
    },
  });
}

function computeCoverage(suite, goldenRuns) {
  const targets = new Set(goldenRuns.map((run) => run.targetKind));
  const satisfiedTargets = suite.requiredTargets.filter((target) => targets.has(target));
  const missingTargets = suite.requiredTargets.filter((target) => !targets.has(target));

  return deepFreeze({
    requiredTargets: [...suite.requiredTargets],
    satisfiedTargets,
    missingTargets,
  });
}

function findFailedChecks(goldenRuns) {
  return goldenRuns.flatMap((run) =>
    run.checks
      .filter((check) => check.status !== "passed")
      .map((check) => ({
        runId: run.runId,
        targetKind: run.targetKind,
        checkId: check.checkId,
        status: check.status,
        confidence: check.confidence,
        flaky: check.flaky,
      })),
  );
}

function isBudgetBurning(status) {
  return Boolean(
    status &&
      status.healthy === false &&
      (status.status === "burning" ||
        status.status === "budget-exhausted" ||
        status.violatedThresholds?.length > 0),
  );
}

function exceedsBlastRadius(observed, declared) {
  const declaredResources = new Set(declared.resources);
  return (
    observed.tenant !== declared.tenant ||
    observed.camp !== declared.camp ||
    observed.environment !== declared.environment ||
    observed.maxResources > declared.maxResources ||
    observed.resources.length > declared.resources.length ||
    observed.resources.some((resource) => !declaredResources.has(resource))
  );
}

function normalizeSuite(suite) {
  if (!suite || !isJsonObject(suite) || Array.isArray(suite)) {
    throw new Error("suite is required");
  }
  const requiredTargets = requiredArray(suite.requiredTargets, "suite.requiredTargets");
  return deepFreeze({
    id: requiredString(suite.id, "suite.id"),
    requiredTargets,
    minConfidence: finiteRatio(suite.minConfidence ?? 0.75, "suite.minConfidence"),
  });
}

function normalizeGoldenRuns(runs) {
  return requiredArray(runs, "goldenRuns").map((run, index) => ({
    runId: requiredString(run.runId ?? `run-${index}`, "goldenRun.runId"),
    targetKind: requiredString(run.targetKind, "goldenRun.targetKind"),
    completedAt: requiredString(run.completedAt, "goldenRun.completedAt"),
    checks: requiredArray(run.checks, "goldenRun.checks").map((check) => ({
      checkId: requiredString(check.checkId, "goldenRun.check.checkId"),
      status: requiredString(check.status, "goldenRun.check.status"),
      confidence: finiteRatio(check.confidence ?? 1, "goldenRun.check.confidence"),
      flaky: check.flaky === true,
    })),
  }));
}

function normalizeExperiment(experiment) {
  if (!experiment || !isJsonObject(experiment) || Array.isArray(experiment)) {
    throw new Error("chaosExperiment is required");
  }
  const blastRadius = normalizeBlastRadius(experiment.blastRadius, "chaosExperiment.blastRadius");
  const faultKind = requiredString(experiment.fault?.kind, "chaosExperiment.fault.kind");
  if (!SUPPORTED_FAULT_INJECTORS.includes(faultKind)) {
    throw new Error(`unsupported chaosExperiment.fault.kind: ${faultKind}`);
  }
  return deepFreeze({
    id: requiredString(experiment.id, "chaosExperiment.id"),
    fault: {
      kind: faultKind,
      target: requiredString(experiment.fault?.target, "chaosExperiment.fault.target"),
      durationMs: positiveInteger(experiment.fault?.durationMs, "chaosExperiment.fault.durationMs"),
    },
    steadyState: {
      invariant: requiredString(experiment.steadyState?.invariant, "chaosExperiment.steadyState.invariant"),
      targetResumeMs: positiveInteger(
        experiment.steadyState?.targetResumeMs,
        "chaosExperiment.steadyState.targetResumeMs",
      ),
      observedResumeMs: positiveInteger(
        experiment.steadyState?.observedResumeMs,
        "chaosExperiment.steadyState.observedResumeMs",
      ),
    },
    blastRadius,
    abortCondition: {
      invariant: requiredString(experiment.abortCondition?.invariant, "chaosExperiment.abortCondition.invariant"),
      armed: experiment.abortCondition?.armed === true,
    },
    projectedErrorBudgetCostRatio: finiteRatio(
      experiment.projectedErrorBudgetCostRatio ?? 0,
      "chaosExperiment.projectedErrorBudgetCostRatio",
    ),
    observedBlastRadius: experiment.observedBlastRadius
      ? normalizeBlastRadius(experiment.observedBlastRadius, "chaosExperiment.observedBlastRadius")
      : null,
    cleanup: {
      status: requiredString(experiment.cleanup?.status ?? "removed", "chaosExperiment.cleanup.status"),
      ...(experiment.cleanup?.reason ? { reason: String(experiment.cleanup.reason) } : undefined),
    },
  });
}

function normalizeBlastRadius(value, fieldName) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${fieldName} is required`);
  }

  return {
    tenant: requiredString(value.tenant, `${fieldName}.tenant`),
    camp: requiredString(value.camp, `${fieldName}.camp`),
    environment: requiredString(value.environment, `${fieldName}.environment`),
    maxResources: positiveInteger(value.maxResources, `${fieldName}.maxResources`),
    resources: requiredArray(value.resources, `${fieldName}.resources`).map((resource) =>
      requiredString(resource, `${fieldName}.resources[]`),
    ),
  };
}

function decisionOf(effect, reason) {
  return deepFreeze({ effect, reason });
}

function result(status, decision, coverage, events) {
  return deepFreeze({
    status,
    decision,
    coverage,
    events,
  });
}

function event(type, { id, streamId, seq, ts, data }) {
  return deepFreeze({
    id,
    type,
    v: 1,
    streamId,
    seq,
    ts,
    data,
  });
}

function sequence() {
  let seq = 0;
  return () => ++seq;
}

function requiredArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  return [...value];
}

function requiredString(value, fieldName) {
  if (!isJsonString(value) || value.trim().length === 0) {
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

function finiteRatio(value, fieldName) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${fieldName} must be a finite non-negative number`);
  }
  return value;
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
