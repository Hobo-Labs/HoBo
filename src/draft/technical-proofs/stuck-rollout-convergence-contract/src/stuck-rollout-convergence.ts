import {
  replayRollout,
} from "../../delivery-orchestrator-skeleton-contract/src/delivery-orchestrator.js";
import { isJsonString, isJsonObject } from "./json.js";


export function createInMemoryRecoveryLease() {
  const owners = new Map();
  return {
    acquire(rolloutId, owner) {
      const current = owners.get(rolloutId);
      if (current && current !== owner) {
        return { acquired: false, owner: current };
      }
      owners.set(rolloutId, owner);
      return { acquired: true, owner };
    },
  };
}

export function convergeStuckRollout({
  rollout,
  eventLog,
  observedState,
  progressDeadlineMs,
  now = () => new Date().toISOString(),
  recoveryLease,
  recoveryRunId = "stuck-rollout-convergence",
}) {
  const parsed = parseRollout(rollout);
  const events = Array.isArray(eventLog) ? eventLog : [];
  const observed = parseObservedState(observedState, parsed.target);

  if (recoveryLease) {
    const lease = recoveryLease.acquire(parsed.rolloutId, recoveryRunId);
    if (!lease.acquired) {
      return freezeResult({
        status: { state: "held-by-other-writer", owner: lease.owner },
        recoveredFromStepIndex: currentStepIndex(events),
        actions: [],
        events: [],
      });
    }
  }

  const status = replayRollout(events);
  const terminalStatus = terminalStatusFromEvents(status, events);
  if (terminalStatus) {
    return freezeResult({
      status: terminalStatus,
      recoveredFromStepIndex: terminalStatus.currentStepIndex,
      actions: [],
      events: [],
    });
  }

  const stepIndex = status.currentStepIndex;
  const reason = recoveryReason({
    events,
    now: now(),
    progressDeadlineMs,
    observed,
  });

  if (!reason) {
    return freezeResult({
      status,
      recoveredFromStepIndex: stepIndex,
      actions: [],
      events: [],
    });
  }

  if (observed.partialSplit && observed.targetHealthy) {
    return promoteRecoveredTarget({ parsed, events, stepIndex, now, observed });
  }

  const rollbackAction = rollbackTrafficAction(parsed.target, reason);
  if (observed.rollbackConverged === false) {
    const failureReason = `rollback-non-convergeable: ${observed.rollbackFailureReason ?? "unknown"}`;
    const failed = makeEvent({
      parsed,
      events,
      type: "rollout.Failed",
      now,
      data: {
        rolloutId: parsed.rolloutId,
        state: "needs-human",
        reason: failureReason,
        dangling: true,
        stepIndex,
        observed: observed.raw,
      },
    });

    return freezeResult({
      status: {
        rolloutId: parsed.rolloutId,
        state: "needs-human",
        currentStepIndex: stepIndex,
        failureReason,
      },
      recoveredFromStepIndex: stepIndex,
      actions: [rollbackAction],
      events: [failed],
    });
  }

  const failed = makeEvent({
    parsed,
    events,
    type: "rollout.Failed",
    now,
    data: {
      rolloutId: parsed.rolloutId,
      state: "failed",
      reason,
      dangling: false,
      stepIndex,
      observed: observed.raw,
    },
  });
  const rolledBack = makeEvent({
    parsed,
    events: [...events, failed],
    type: "rollout.RolledBack",
    now,
    data: {
      rolloutId: parsed.rolloutId,
      restoredVersion: parsed.target.fromVersion,
      reason,
      stepIndex,
      observed: rollbackAction,
    },
  });

  return freezeResult({
    status: replayRollout([...events, failed, rolledBack]),
    recoveredFromStepIndex: stepIndex,
    actions: [rollbackAction],
    events: [failed, rolledBack],
  });
}

export function rolloutEvent({
  rollout,
  type,
  data,
  time = new Date().toISOString(),
  seq = 1,
}) {
  const rolloutId = data?.rolloutId ?? rollout?.rolloutId;
  if (!rolloutId) {
    throw new Error("rolloutEvent requires data.rolloutId or rollout.rolloutId");
  }

  return deepFreeze({
    id: `${type}:${rolloutId}:${seq}:${time}`,
    source: "hobo:delivery",
    specversion: "1.0",
    type,
    subject: rolloutId,
    time,
    seq,
    runId: rollout?.runId ?? "run_unknown",
    tenant: rollout?.tenant ?? "tenant_unknown",
    data: cloneJson(data),
  });
}

function promoteRecoveredTarget({ parsed, events, stepIndex, now, observed }) {
  const produced = [];
  for (let index = stepIndex; index < parsed.policy.steps.length; index += 1) {
    produced.push(makeEvent({
      parsed,
      events: [...events, ...produced],
      type: "rollout.Stepped",
      now,
      data: {
        rolloutId: parsed.rolloutId,
        stepIndex: index,
        step: parsed.policy.steps[index],
        state: "running",
        observed: observed.raw,
        recovered: true,
      },
    }));
  }

  produced.push(makeEvent({
    parsed,
    events: [...events, ...produced],
    type: "rollout.Promoted",
    now,
    data: {
      rolloutId: parsed.rolloutId,
      finalVersion: parsed.target.toVersion,
      completedSteps: parsed.policy.steps.map((step) => step.name),
      reason: "observed-target-healthy-after-controller-recovery",
      observed: observed.raw,
    },
  }));

  return freezeResult({
    status: replayRollout([...events, ...produced]),
    recoveredFromStepIndex: stepIndex,
    actions: [{
      kind: "gateway.shiftTraffic",
      routeId: parsed.target.routeId,
      toWeight: 100,
      fromVersion: parsed.target.fromVersion,
      toVersion: parsed.target.toVersion,
      reason: "observed-target-healthy-after-controller-recovery",
    }],
    events: produced,
  });
}

function makeEvent({ parsed, events, type, data, now }) {
  return rolloutEvent({
    rollout: parsed,
    type,
    data,
    time: now(),
    seq: nextSeq(events),
  });
}

function recoveryReason({ events, now, progressDeadlineMs, observed }) {
  if (observed.partialSplit) {
    return "observed-traffic-mismatch";
  }

  if (!Number.isInteger(progressDeadlineMs) || progressDeadlineMs < 0) {
    throw new Error("progressDeadlineMs must be a non-negative integer");
  }

  const latest = latestEvent(events);
  if (!latest) {
    return null;
  }

  const elapsedMs = Date.parse(now) - Date.parse(latest.time);
  if (!Number.isFinite(elapsedMs) || elapsedMs < progressDeadlineMs) {
    return null;
  }

  const reason = latest.data?.reason ?? "no rollout progress";
  return `progress-deadline-exceeded: ${reason}`;
}

function parseRollout(rollout) {
  if (!rollout || !isJsonObject(rollout) || Array.isArray(rollout)) {
    throw new Error("rollout must be an object");
  }
  const target = rollout.target ?? {};
  const policy = rollout.policy ?? {};
  if (!Array.isArray(policy.steps)) {
    throw new Error("rollout.policy.steps must be an array");
  }

  return deepFreeze({
    rolloutId: nonEmptyString(rollout.rolloutId, "rollout.rolloutId"),
    runId: rollout.runId ?? "run_unknown",
    tenant: rollout.tenant ?? "tenant_unknown",
    target: {
      service: nonEmptyString(target.service, "rollout.target.service"),
      routeId: nonEmptyString(target.routeId, "rollout.target.routeId"),
      fromVersion: nonEmptyString(target.fromVersion, "rollout.target.fromVersion"),
      toVersion: nonEmptyString(target.toVersion, "rollout.target.toVersion"),
    },
    policy: {
      strategy: policy.strategy ?? "unknown",
      steps: policy.steps.map((step, index) => ({
        name: nonEmptyString(step.name, `rollout.policy.steps[${index}].name`),
        action: cloneJson(step.action ?? { kind: "noop" }),
        gateRefs: cloneJson(step.gateRefs ?? []),
      })),
    },
  });
}

function parseObservedState(observedState, target) {
  const raw = cloneJson(observedState ?? {});
  const split = raw.split ?? {};
  const fromWeight = Number(split[target.fromVersion] ?? 0);
  const toWeight = Number(split[target.toVersion] ?? 0);
  const partialSplit = fromWeight > 0 && toWeight > 0 && toWeight < 100;

  return {
    raw,
    partialSplit,
    targetHealthy: raw.targetHealthy === true,
    rollbackConverged: raw.rollbackConverged,
    rollbackFailureReason: raw.rollbackFailureReason,
  };
}

function rollbackTrafficAction(target, reason) {
  return {
    kind: "gateway.rollbackTraffic",
    routeId: target.routeId,
    restoredVersion: target.fromVersion,
    revertedVersion: target.toVersion,
    reason,
  };
}

function currentStepIndex(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return 0;
  }

  try {
    return replayRollout(events).currentStepIndex;
  } catch {
    return 0;
  }
}

function latestEvent(events) {
  return [...events].reverse().find((event) => event?.time);
}

function nextSeq(events) {
  return events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0) + 1;
}

function isTerminal(state) {
  return state === "promoted" || state === "rolled-back" || state === "failed" || state === "needs-human";
}

function terminalStatusFromEvents(status, events) {
  if (status.state === "failed") {
    const latestFailure = [...events].reverse().find((event) => event?.type === "rollout.Failed");
    if (latestFailure?.data?.state === "needs-human") {
      return {
        ...status,
        state: "needs-human",
        failureReason: latestFailure.data.reason,
      };
    }
  }

  if (isTerminal(status.state)) {
    return status;
  }

  return null;
}

function nonEmptyString(value, path) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new Error(`${path} must be a non-empty string`);
  }
  return value;
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

function freezeResult(result) {
  return deepFreeze(result);
}
