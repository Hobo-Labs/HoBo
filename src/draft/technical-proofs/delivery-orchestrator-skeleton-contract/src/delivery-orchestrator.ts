import { isJsonString, isJsonObject } from "./json.js";
const ROLLOUT_EVENT_TYPES = new Set([
  "rollout.Started",
  "rollout.GateEvaluated",
  "rollout.Stepped",
  "rollout.Promoted",
  "rollout.RolledBack",
  "rollout.Failed",
]);

const REQUIRED_DATA = Object.freeze({
  "rollout.Started": ["rolloutId", "target", "policy", "warnings"],
  "rollout.GateEvaluated": ["rolloutId", "stepIndex", "step", "decision", "reason", "gateRefs"],
  "rollout.Stepped": ["rolloutId", "stepIndex", "step", "state"],
  "rollout.Promoted": ["rolloutId", "finalVersion", "completedSteps", "reason"],
  "rollout.RolledBack": ["rolloutId", "restoredVersion", "reason"],
  "rollout.Failed": ["rolloutId", "state", "reason", "dangling"],
});

export function createDeliveryOrchestrator({ now = () => new Date().toISOString() } = {}) {
  return {
    async runRollout({
      rollout,
      eventLog = [],
      gateEvaluator = () => ({ decision: "pass", reason: "pass-through" }),
      executionBudget = {},
    }) {
      const parsed = parseRollout(rollout);
      const output = [];
      const append = (type, data) => {
        const event = rolloutEvent({
          rollout: parsed,
          type,
          data,
          seq: nextSeq([...eventLog, ...output]),
          now,
        });
        output.push(event);
        return event;
      };

      let state = eventLog.length > 0 ? replayRollout(eventLog) : null;

      if (!state) {
        append("rollout.Started", {
          rolloutId: parsed.rolloutId,
          target: parsed.target,
          policy: parsed.policy,
          warnings: [],
        });
        state = replayRollout(output);
      }

      if (isTerminal(state.state)) {
        return resultFor(eventLog, output);
      }

      let executedSteps = 0;
      for (let stepIndex = state.currentStepIndex; stepIndex < parsed.policy.steps.length; stepIndex += 1) {
        if (
          Number.isInteger(executionBudget.maxSteps) &&
          executedSteps >= executionBudget.maxSteps
        ) {
          break;
        }

        const step = parsed.policy.steps[stepIndex];
        const gateDecision = await evaluateGate({
          gateEvaluator,
          rollout: parsed,
          step,
          stepIndex,
        });

        append("rollout.GateEvaluated", {
          rolloutId: parsed.rolloutId,
          stepIndex,
          step,
          decision: gateDecision.decision,
          reason: gateDecision.reason,
          gateRefs: step.gateRefs ?? [],
        });

        if (gateDecision.decision !== "pass") {
          appendFailureAndRollback(append, parsed, stepIndex, gateDecision.reason);
          return resultFor(eventLog, output);
        }

        append("rollout.Stepped", {
          rolloutId: parsed.rolloutId,
          stepIndex,
          step,
          state: "running",
        });
        executedSteps += 1;
      }

      const latest = replayRollout([...eventLog, ...output]);
      if (latest.state === "running" && latest.currentStepIndex >= parsed.policy.steps.length) {
        append("rollout.Promoted", {
          rolloutId: parsed.rolloutId,
          finalVersion: parsed.target.toVersion,
          completedSteps: latest.completedSteps,
          reason: parsed.policy.steps.length === 0 ? "no-steps" : "all-steps-passed",
        });
      }

      return resultFor(eventLog, output);
    },
  };
}

export function replayRollout(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error("rollout event stream is empty");
  }

  let status = null;
  const completedByStepIndex = new Map();
  const ignoredDuplicates = [];
  const gateResults = [];

  for (const event of events) {
    validateRolloutEvent(event);

    if (event.type === "rollout.Started") {
      status = {
        rolloutId: event.data.rolloutId,
        state: "running",
        currentStepIndex: 0,
        completedSteps: [],
        gateResults,
        ignoredDuplicates,
      };
      continue;
    }

    if (!status) {
      throw new Error(`rollout event stream starts with ${event.type}`);
    }

    if (event.type === "rollout.GateEvaluated") {
      gateResults.push({
        stepIndex: event.data.stepIndex,
        step: event.data.step.name,
        decision: event.data.decision,
        reason: event.data.reason,
      });
      continue;
    }

    if (event.type === "rollout.Stepped") {
      if (completedByStepIndex.has(event.data.stepIndex)) {
        ignoredDuplicates.push({
          type: "rollout.Stepped",
          stepIndex: event.data.stepIndex,
          eventId: event.id,
        });
        continue;
      }

      completedByStepIndex.set(event.data.stepIndex, event.data.step.name);
      status.completedSteps = orderedCompletedSteps(completedByStepIndex);
      status.currentStepIndex = nextStepIndex(completedByStepIndex);
      status.state = event.data.state;
      continue;
    }

    if (event.type === "rollout.Promoted") {
      status.state = "promoted";
      status.currentStepIndex = status.completedSteps.length;
      continue;
    }

    if (event.type === "rollout.Failed") {
      status.state = "failed";
      status.failureReason = event.data.reason;
      continue;
    }

    if (event.type === "rollout.RolledBack") {
      status.state = "rolled-back";
      status.rollbackReason = event.data.reason;
    }
  }

  return deepFreeze({
    rolloutId: status.rolloutId,
    state: status.state,
    currentStepIndex: status.currentStepIndex,
    completedSteps: status.completedSteps,
    gateResults,
    ignoredDuplicates,
    ...(status.failureReason ? { failureReason: status.failureReason } : undefined),
    ...(status.rollbackReason ? { rollbackReason: status.rollbackReason } : undefined),
  });
}

export function validateRolloutEvent(event) {
  if (!event || !isJsonObject(event) || Array.isArray(event)) {
    throw new Error("rollout event must be an object");
  }

  if (!ROLLOUT_EVENT_TYPES.has(event.type)) {
    throw new Error(`unsupported rollout event: ${event.type}`);
  }

  for (const field of ["id", "source", "specversion", "type", "subject", "data", "runId", "tenant"]) {
    if (event[field] === undefined || event[field] === null || event[field] === "") {
      throw new Error(`rollout event missing ${field}`);
    }
  }

  if (event.specversion !== "1.0") {
    throw new Error("rollout event must use CloudEvents specversion 1.0");
  }

  if (event.source !== "hobo:delivery") {
    throw new Error("rollout event source must be hobo:delivery");
  }

  if (!Number.isInteger(event.seq) || event.seq <= 0) {
    throw new Error("rollout event seq must be a positive integer");
  }

  if (event.subject !== event.data.rolloutId) {
    throw new Error("rollout event subject must equal data.rolloutId");
  }

  for (const field of REQUIRED_DATA[event.type]) {
    requirePresent(event.data, field, `${event.type} data`);
  }

  return event;
}

async function evaluateGate({ gateEvaluator, rollout, step, stepIndex }) {
  try {
    const decision = await gateEvaluator({ rollout, step, stepIndex });
    if (decision?.decision === "fail") {
      return {
        decision: "fail",
        reason: decision.reason ?? "gate returned fail",
      };
    }

    return {
      decision: "pass",
      reason: decision?.reason ?? "pass-through",
    };
  } catch (error) {
    return {
      decision: "fail",
      reason: `gate hook threw: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function appendFailureAndRollback(append, rollout, stepIndex, reason) {
  append("rollout.Failed", {
    rolloutId: rollout.rolloutId,
    state: "failed",
    reason,
    dangling: false,
    stepIndex,
  });
  append("rollout.RolledBack", {
    rolloutId: rollout.rolloutId,
    restoredVersion: rollout.target.fromVersion,
    reason,
    stepIndex,
  });
}

function resultFor(eventLog, output) {
  return deepFreeze({
    status: replayRollout([...eventLog, ...output]),
    events: output,
  });
}

function rolloutEvent({ rollout, type, data, seq, now }) {
  const event = {
    specversion: "1.0",
    id: `${type}:${rollout.rolloutId}:${seq}`,
    source: "hobo:delivery",
    type,
    subject: rollout.rolloutId,
    runId: rollout.runId,
    tenant: rollout.tenant,
    seq,
    time: now(),
    actor: cloneJson(rollout.actor),
    data: cloneJson(data),
  };

  return deepFreeze(validateRolloutEvent(event));
}

function parseRollout(rollout) {
  if (!rollout || !isJsonObject(rollout) || Array.isArray(rollout)) {
    throw new Error("rollout must be an object");
  }

  assertNonEmptyString(rollout.rolloutId, "rollout.rolloutId");
  assertNonEmptyString(rollout.runId, "rollout.runId");
  assertNonEmptyString(rollout.tenant, "rollout.tenant");
  const target = parseTarget(rollout.target);
  const policy = parsePolicy(rollout.policy);

  return deepFreeze({
    rolloutId: rollout.rolloutId,
    runId: rollout.runId,
    tenant: rollout.tenant,
    actor: rollout.actor ?? { kind: "system", id: "delivery-orchestrator", tenant: rollout.tenant },
    target,
    policy,
  });
}

function parseTarget(target) {
  if (!target || !isJsonObject(target) || Array.isArray(target)) {
    throw new Error("rollout.target must be an object");
  }

  return {
    service: assertNonEmptyString(target.service, "rollout.target.service"),
    fromVersion: assertNonEmptyString(target.fromVersion, "rollout.target.fromVersion"),
    toVersion: assertNonEmptyString(target.toVersion, "rollout.target.toVersion"),
  };
}

function parsePolicy(policy) {
  if (!policy || !isJsonObject(policy) || Array.isArray(policy)) {
    throw new Error("rollout.policy must be an object");
  }

  if (!Array.isArray(policy.steps)) {
    throw new Error("rollout.policy.steps must be an array");
  }

  return {
    strategy: assertNonEmptyString(policy.strategy, "rollout.policy.strategy"),
    steps: policy.steps.map((step, stepIndex) => parseStep(step, stepIndex)),
  };
}

function parseStep(step, stepIndex) {
  if (!step || !isJsonObject(step) || Array.isArray(step)) {
    throw new Error(`rollout.policy.steps[${stepIndex}] must be an object`);
  }

  return {
    name: assertNonEmptyString(step.name, `rollout.policy.steps[${stepIndex}].name`),
    action: cloneJson(step.action ?? { kind: "noop" }),
    gateRefs: Array.isArray(step.gateRefs) ? cloneJson(step.gateRefs) : [],
  };
}

function nextSeq(events) {
  return events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0) + 1;
}

function orderedCompletedSteps(completedByStepIndex) {
  return [...completedByStepIndex.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, stepName]) => stepName);
}

function nextStepIndex(completedByStepIndex) {
  let cursor = 0;
  while (completedByStepIndex.has(cursor)) {
    cursor += 1;
  }
  return cursor;
}

function isTerminal(state) {
  return state === "promoted" || state === "rolled-back" || state === "failed";
}

function assertNonEmptyString(value, path) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
}

function requirePresent(record, field, label) {
  if (record[field] === undefined || record[field] === null || record[field] === "") {
    throw new Error(`${label} missing ${field}`);
  }
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}
