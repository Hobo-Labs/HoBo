import { isJsonString, isJsonObject } from "./json.js";
export const CHAOS_EVENT_TYPES = Object.freeze({
  experimentStarted: "chaos.ExperimentStarted",
  faultInjected: "chaos.FaultInjected",
  steadyStateChecked: "chaos.SteadyStateChecked",
  aborted: "chaos.Aborted",
  experimentCompleted: "chaos.ExperimentCompleted",
});

const BASELINE_UNSAFE_SEAMS = new Set(["baseline-lease", "non-lane-tagged-egress"]);

export async function orchestrateChaosExperiment(input = {}) {
  const experiment = validateExperiment(input.experiment);
  const now = input.now instanceof Function ? input.now : () => new Date(0).toISOString();
  const policyDecision = decidePolicy(experiment, input.policyBudget, now());
  const events = [policyDecision];
  const nextChaosSeq = chaosSequence();

  if (policyDecision.data.effect !== "allow") {
    return deepFreeze({
      status: "denied",
      executionTarget: null,
      events,
    });
  }

  const executionTarget = chooseExecutionTarget(experiment, input.lane);
  if (executionTarget.kind === "ephemeral-camp-clone") {
    events.push(envClonedEvent({ experiment, executionTarget, ts: now() }));
  }

  events.push(
    chaosEvent(CHAOS_EVENT_TYPES.experimentStarted, {
      id: `chaos-started-${slug(experiment.id)}`,
      experiment,
      seq: nextChaosSeq(),
      ts: now(),
      data: {
        experimentId: experiment.id,
        hypothesis: experiment.hypothesis,
        fault: experiment.fault,
        blastRadius: experiment.blastRadius,
        executionTarget,
      },
    }),
  );

  try {
    const command = faultCommand(experiment, executionTarget);
    const faultResult = await input.injector?.inject(command);
    events.push(
      chaosEvent(CHAOS_EVENT_TYPES.faultInjected, {
        id: `chaos-fault-${slug(experiment.id)}`,
        experiment,
        seq: nextChaosSeq(),
        ts: now(),
        data: {
          experimentId: experiment.id,
          fault: experiment.fault,
          blastRadius: experiment.blastRadius,
          command,
          faultResult: faultResult ?? null,
        },
      }),
    );

    const steadyState = input.steadyStateCheck({
      phase: "after-fault",
      experiment,
      faultResult,
      executionTarget,
    });
    events.push(
      chaosEvent(CHAOS_EVENT_TYPES.steadyStateChecked, {
        id: `chaos-steady-state-${slug(experiment.id)}`,
        experiment,
        seq: nextChaosSeq(),
        ts: now(),
        data: {
          experimentId: experiment.id,
          steadyState,
        },
      }),
    );

    if (steadyState.status === "breached") {
      events.push(
        abortedEvent({
          experiment,
          seq: nextChaosSeq(),
          ts: now(),
          reason: "steady-state-breached",
          steadyState,
        }),
      );
      return result("aborted", executionTarget, events);
    }

    events.push(
      chaosEvent(CHAOS_EVENT_TYPES.experimentCompleted, {
        id: `chaos-completed-${slug(experiment.id)}`,
        experiment,
        seq: nextChaosSeq(),
        ts: now(),
        data: {
          experimentId: experiment.id,
          result: "steady-state-held",
        },
      }),
    );
    return result("completed", executionTarget, events);
  } catch (error) {
    events.push(
      abortedEvent({
        experiment,
        seq: nextChaosSeq(),
        ts: now(),
        reason: "abort-condition-failed",
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    return result("aborted", executionTarget, events);
  }
}

export function replayChaosExperiment(events = []) {
  const eventList = requiredArray(events, "events");
  const terminal = [...eventList]
    .reverse()
    .find(
      (event) =>
        event.type === CHAOS_EVENT_TYPES.aborted ||
        event.type === CHAOS_EVENT_TYPES.experimentCompleted ||
        event.type === "policy.Decided",
    );
  const regressionTests = eventList
    .filter((event) => event.type === CHAOS_EVENT_TYPES.aborted && event.data?.regressionTest)
    .map((event) => event.data.regressionTest);

  return deepFreeze({
    status:
      terminal?.type === CHAOS_EVENT_TYPES.aborted
        ? "aborted"
        : terminal?.type === CHAOS_EVENT_TYPES.experimentCompleted
          ? "completed"
          : terminal?.data?.effect === "deny"
            ? "denied"
            : "unknown",
    regressionTests,
  });
}

function decidePolicy(experiment, budget, ts) {
  const denied = !budget || !budget.environments?.includes(experiment.blastRadius.environment);
  const overBudget =
    !denied &&
    (budget.remainingFaults < 1 ||
      budget.maxBlastRadius?.tenant !== experiment.blastRadius.tenant ||
      budget.maxBlastRadius?.camp !== experiment.blastRadius.camp ||
      budget.maxBlastRadius?.maxResources < experiment.blastRadius.maxResources);

  return deepFreeze({
    id: `policy-chaos-${slug(experiment.id)}`,
    type: "policy.Decided",
    v: 1,
    streamId: `policy:${experiment.id}`,
    seq: 1,
    ts,
    data: denied
      ? { effect: "deny", reason: "missing-prod-chaos-policy-budget" }
      : overBudget
        ? { effect: "deny", reason: "chaos-policy-budget-exceeded" }
        : { effect: "allow", reason: "within-chaos-policy-budget" },
  });
}

function chooseExecutionTarget(experiment, lane) {
  const unsafeSeam = experiment.declaredSeams.find((seam) => BASELINE_UNSAFE_SEAMS.has(seam.kind));
  if (unsafeSeam) {
    return deepFreeze({
      kind: "ephemeral-camp-clone",
      id: `clone-${slug(experiment.blastRadius.camp)}-${slug(experiment.id)}`,
      reason: `${unsafeSeam.kind}-not-containable-in-shared-lane`,
    });
  }

  if (!lane?.signed || lane.tenant !== experiment.blastRadius.tenant) {
    throw new Error("chaos experiment requires a signed tenant-bound lane");
  }

  return deepFreeze({
    kind: "sandbox-lane",
    id: lane.id,
    tenant: lane.tenant,
  });
}

function envClonedEvent({ experiment, executionTarget, ts }) {
  return deepFreeze({
    id: `env-cloned-${slug(experiment.id)}`,
    type: "env.Cloned",
    v: 1,
    streamId: `env:${executionTarget.id}`,
    seq: 1,
    ts,
    data: {
      experimentId: experiment.id,
      sourceCamp: experiment.blastRadius.camp,
      cloneCamp: executionTarget.id,
      reason: executionTarget.reason,
    },
  });
}

function abortedEvent({ experiment, seq, ts, reason, steadyState, error }) {
  return chaosEvent(CHAOS_EVENT_TYPES.aborted, {
    id: `chaos-aborted-${slug(experiment.id)}`,
    experiment,
    seq,
    ts,
    data: {
      experimentId: experiment.id,
      reason,
      ...(steadyState ? { steadyState } : undefined),
      ...(error ? { error } : undefined),
      regressionTest: {
        id: `regression-${slug(experiment.id)}`,
        experimentId: experiment.id,
        sourceEventId: `chaos-aborted-${slug(experiment.id)}`,
        replayCommand: `hobo test --replay ${experiment.id}`,
      },
    },
  });
}

function chaosEvent(type, { id, experiment, seq, ts, data }) {
  return deepFreeze({
    id,
    type,
    v: 1,
    streamId: `chaos:${experiment.id}`,
    seq,
    ts,
    data,
  });
}

function chaosSequence() {
  let seq = 0;
  return () => ++seq;
}

function faultCommand(experiment, executionTarget) {
  return deepFreeze({
    kind: experiment.fault.kind,
    target: experiment.fault.target,
    durationMs: experiment.fault.durationMs,
    ...(executionTarget.kind === "sandbox-lane"
      ? { lane: executionTarget.id }
      : { camp: executionTarget.id }),
  });
}

function result(status, executionTarget, events) {
  return deepFreeze({
    status,
    executionTarget,
    events,
  });
}

function validateExperiment(experiment) {
  if (!experiment || !isJsonObject(experiment) || Array.isArray(experiment)) {
    throw new Error("experiment is required");
  }

  return deepFreeze({
    id: requiredString(experiment.id, "experiment.id"),
    hypothesis: validateObject(experiment.hypothesis, "experiment.hypothesis"),
    fault: {
      kind: requiredString(experiment.fault?.kind, "experiment.fault.kind"),
      target: requiredString(experiment.fault?.target, "experiment.fault.target"),
      durationMs: positiveInteger(experiment.fault?.durationMs, "experiment.fault.durationMs"),
    },
    blastRadius: {
      tenant: requiredString(experiment.blastRadius?.tenant, "experiment.blastRadius.tenant"),
      camp: requiredString(experiment.blastRadius?.camp, "experiment.blastRadius.camp"),
      environment: requiredString(
        experiment.blastRadius?.environment,
        "experiment.blastRadius.environment",
      ),
      maxResources: positiveInteger(
        experiment.blastRadius?.maxResources,
        "experiment.blastRadius.maxResources",
      ),
      resources: requiredArray(experiment.blastRadius?.resources, "experiment.blastRadius.resources"),
    },
    abortCondition: validateObject(experiment.abortCondition, "experiment.abortCondition"),
    declaredSeams: Array.isArray(experiment.declaredSeams) ? experiment.declaredSeams : [],
  });
}

function validateObject(value, fieldName) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${fieldName} is required`);
  }
  return { ...value };
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
