import { randomUUID } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


const TERMINAL_STATUSES = new Set(["rolled-back", "needs-human"]);

export function createRollbackCompensationEngine({
  now = () => new Date().toISOString(),
  idFactory = (type) => `${type}:${randomUUID()}`,
} = {}) {
  return {
    async compensate({
      rollback,
      plan,
      eventLog = [],
      retryBudget = {},
      executor,
      deadlineAt,
    }) {
      const parsedRollback = parseRollback(rollback);
      const parsedPlan = parsePlan(plan);
      assertExecutor(executor);

      const maxAttemptsPerStep = retryBudget.maxAttemptsPerStep ?? 3;
      if (!Number.isInteger(maxAttemptsPerStep) || maxAttemptsPerStep <= 0) {
        throw new Error("retryBudget.maxAttemptsPerStep must be a positive integer");
      }

      const output = [];
      const append = (type, data) => {
        const event = rollbackEvent({
          rollback: parsedRollback,
          type,
          data,
          seq: nextSeq([...eventLog, ...output]),
          now,
          idFactory,
        });
        output.push(event);
        return event;
      };

      let state = replayRollbackCompensation([...eventLog, ...output], parsedPlan).state;
      if (!state.started) {
        append("rollout.RollbackCompensationStarted", {
          rolloutId: parsedRollback.rolloutId,
          plan: parsedPlan.map((step) => ({ id: step.id, kind: step.kind })),
          autoRevertObligation: obligation(parsedRollback.obligationId, "in-progress"),
        });
        state = replayRollbackCompensation([...eventLog, ...output], parsedPlan).state;
      }

      if (TERMINAL_STATUSES.has(state.status)) {
        return finish(eventLog, output, parsedPlan);
      }

      if (deadlineExceeded({ deadlineAt, now })) {
        appendNeedsHuman({
          append,
          rollback: parsedRollback,
          plan: parsedPlan,
          events: [...eventLog, ...output],
          reason: "rollback-compensation-deadline-exceeded",
        });
        return finish(eventLog, output, parsedPlan);
      }

      for (const step of parsedPlan) {
        state = replayRollbackCompensation([...eventLog, ...output], parsedPlan).state;
        if (state.completedSteps.includes(step.id)) {
          continue;
        }

        let attempts = state.attemptsByStep[step.id] ?? 0;
        let applied = false;

        while (attempts < maxAttemptsPerStep && !applied) {
          attempts += 1;
          const idempotencyKey = `${parsedRollback.rolloutId}:rollback:${step.id}`;
          const command = deepFreeze({
            ...cloneJson(step.command),
            kind: step.kind,
            stepId: step.id,
            idempotencyKey,
          });
          const result = cloneJson(await executor.apply(command));

          append("rollout.RollbackCompensationAttempted", {
            rolloutId: parsedRollback.rolloutId,
            stepId: step.id,
            attempt: attempts,
            idempotencyKey,
            result,
          });

          if (isApplied(result)) {
            append("rollout.RollbackCompensationApplied", {
              rolloutId: parsedRollback.rolloutId,
              stepId: step.id,
              idempotencyKey,
              result,
              observedCompletion: result?.status !== "applied" && result?.observedComplete === true,
            });
            applied = true;
          }
        }

        if (!applied) {
          appendNeedsHuman({
            append,
            rollback: parsedRollback,
            plan: parsedPlan,
            events: [...eventLog, ...output],
            reason: `${step.id} exhausted retry budget`,
            failedStepId: step.id,
          });
          return finish(eventLog, output, parsedPlan);
        }
      }

      append("rollout.RolledBack", {
        rolloutId: parsedRollback.rolloutId,
        restoredVersion: parsedRollback.fromVersion,
        revertedVersion: parsedRollback.toVersion,
        routeId: parsedRollback.routeId,
        reason: "rollback-compensation-complete",
        completedSteps: parsedPlan.map((step) => step.id),
        autoRevertObligation: obligation(parsedRollback.obligationId, "satisfied", false),
      });

      return finish(eventLog, output, parsedPlan);
    },
  };
}

export function replayRollbackCompensation(events, plan = []) {
  const parsedPlan = parsePlan(plan);
  const planIds = parsedPlan.map((step) => step.id);
  const completed = new Set();
  const attemptsByStep = {};
  const latestResultsByStep = {};
  let started = false;
  let status = "new";
  let autoRevertObligation = null;
  let needsHuman = null;
  let rolledBack = null;

  for (const event of events) {
    if (event.type === "rollout.RollbackCompensationStarted") {
      started = true;
      status = "compensating";
      autoRevertObligation = cloneJson(event.data.autoRevertObligation);
      continue;
    }

    if (event.type === "rollout.RollbackCompensationAttempted") {
      attemptsByStep[event.data.stepId] = Math.max(
        attemptsByStep[event.data.stepId] ?? 0,
        event.data.attempt,
      );
      latestResultsByStep[event.data.stepId] = cloneJson(event.data.result);
      continue;
    }

    if (event.type === "rollout.RollbackCompensationApplied") {
      completed.add(event.data.stepId);
      latestResultsByStep[event.data.stepId] = cloneJson(event.data.result);
      continue;
    }

    if (event.type === "rollout.NeedsHuman") {
      needsHuman = cloneJson(event.data);
      autoRevertObligation = cloneJson(event.data.autoRevertObligation);
      status = "needs-human";
      continue;
    }

    if (event.type === "rollout.RolledBack") {
      rolledBack = cloneJson(event.data);
      autoRevertObligation = cloneJson(event.data.autoRevertObligation);
      status = "rolled-back";
    }
  }

  const completedSteps = planIds.filter((stepId) => completed.has(stepId));
  const incompleteSteps = planIds.filter((stepId) => !completed.has(stepId));

  return deepFreeze({
    state: {
      started,
      status,
      completedSteps,
      incompleteSteps,
      attemptsByStep,
      latestResultsByStep,
      autoRevertObligation,
      ...(needsHuman ? { needsHuman } : undefined),
      ...(rolledBack ? { rolledBack } : undefined),
    },
  });
}

function appendNeedsHuman({
  append,
  rollback,
  plan,
  events,
  reason,
  failedStepId,
}) {
  const partialState = partialRollbackState(events, plan);
  append("rollout.NeedsHuman", {
    rolloutId: rollback.rolloutId,
    state: "needs-human",
    reason,
    failedStepId,
    partialState,
    autoRevertObligation: obligation(rollback.obligationId, "unsatisfied", true),
  });
}

function partialRollbackState(events, plan) {
  const state = replayRollbackCompensation(events, plan).state;
  return {
    completedSteps: state.completedSteps,
    incompleteSteps: state.incompleteSteps,
    attemptsByStep: state.attemptsByStep,
    latestResultsByStep: state.latestResultsByStep,
  };
}

function finish(eventLog, output, plan) {
  const events = [...eventLog, ...output];
  const replay = replayRollbackCompensation(events, plan);
  return deepFreeze({
    state: replay.state,
    events: output,
  });
}

function isApplied(result) {
  return result?.status === "applied" ||
    result?.status === "already-applied" ||
    result?.observedComplete === true;
}

function rollbackEvent({ rollback, type, data, seq, now, idFactory }) {
  return deepFreeze({
    specversion: "1.0",
    id: idFactory(type),
    source: "hobo:delivery",
    type,
    subject: rollback.rolloutId,
    runId: rollback.runId,
    tenant: rollback.tenant,
    seq,
    time: now(),
    data: cloneJson(data),
  });
}

function parseRollback(rollback) {
  if (!rollback || !isJsonObject(rollback) || Array.isArray(rollback)) {
    throw new Error("rollback must be an object");
  }

  return deepFreeze({
    rolloutId: assertNonEmptyString(rollback.rolloutId, "rollback.rolloutId"),
    runId: assertNonEmptyString(rollback.runId, "rollback.runId"),
    tenant: assertNonEmptyString(rollback.tenant, "rollback.tenant"),
    obligationId: assertNonEmptyString(rollback.obligationId, "rollback.obligationId"),
    routeId: assertNonEmptyString(rollback.routeId, "rollback.routeId"),
    fromVersion: assertNonEmptyString(rollback.fromVersion, "rollback.fromVersion"),
    toVersion: assertNonEmptyString(rollback.toVersion, "rollback.toVersion"),
  });
}

function parsePlan(plan) {
  if (!Array.isArray(plan) || plan.length === 0) {
    throw new Error("rollback plan must be a non-empty array");
  }

  const seen = new Set();
  return deepFreeze(plan.map((step, index) => {
    if (!step || !isJsonObject(step) || Array.isArray(step)) {
      throw new Error(`rollback plan step ${index} must be an object`);
    }
    const id = assertNonEmptyString(step.id, `rollback plan step ${index}.id`);
    if (seen.has(id)) {
      throw new Error(`duplicate rollback plan step: ${id}`);
    }
    seen.add(id);

    return {
      id,
      kind: assertNonEmptyString(step.kind, `rollback plan step ${id}.kind`),
      command: cloneJson(step.command ?? {}),
    };
  }));
}

function obligation(id, status, blocking = true) {
  return {
    id,
    kind: "auto-revert",
    status,
    blocking,
  };
}

function deadlineExceeded({ deadlineAt, now }) {
  if (!deadlineAt) {
    return false;
  }
  const deadline = new Date(deadlineAt).getTime();
  const current = new Date(now()).getTime();
  if (Number.isNaN(deadline) || Number.isNaN(current)) {
    throw new Error("deadlineAt and now() must be ISO timestamps");
  }
  return current >= deadline;
}

function nextSeq(events) {
  return events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0) + 1;
}

function assertExecutor(executor) {
  if (!executor || !(executor.apply instanceof Function)) {
    throw new Error("executor.apply(command) is required");
  }
}

function assertNonEmptyString(value, path) {
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
