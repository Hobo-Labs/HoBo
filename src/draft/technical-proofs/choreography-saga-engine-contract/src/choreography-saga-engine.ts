import { isJsonObject } from "./json.js";
import { createHash, randomUUID } from "node:crypto";
import {

  classifyFailure,
  crossesNoGoThreshold,
} from "../../system-failure-classifier-contract/src/classifier.js";

const TERMINAL_STATUSES = new Set(["completed", "rolled-back"]);
const DEFAULT_NO_GO_THRESHOLD = Object.freeze({ kind: "any-fatal" });

export function createIdempotencyLedger(entries = []) {
  const memoizedResults = new Map(entries);

  return {
    has(key) {
      return memoizedResults.has(key);
    },
    get(key) {
      return clone(memoizedResults.get(key));
    },
    set(key, result) {
      memoizedResults.set(key, clone(result));
    },
    async runOnce(key, effect) {
      if (memoizedResults.has(key)) {
        return { memoized: true, result: clone(memoizedResults.get(key)) };
      }

      const result = await effect();
      memoizedResults.set(key, clone(result));
      return { memoized: false, result: clone(result) };
    },
  };
}

export function createSagaEngine({
  now = () => new Date().toISOString(),
  idFactory = randomEventId,
  ledger = createIdempotencyLedger(),
  noGoThreshold = DEFAULT_NO_GO_THRESHOLD,
} = {}) {
  return {
    async runSaga({
      sagaId,
      tenantId,
      correlationId,
      causationId = `command:${sagaId}`,
      steps = [],
      eventLog = [],
      appendEvent = () => ({ appended: true }),
      lease,
    }) {
      assertRequired({ sagaId, tenantId, correlationId });
      assertLeaseFresh(lease);

      const workingLog = [...eventLog];
      const stepExecutions = [];
      let replay = replaySagaEvents(workingLog);
      let lastAcceptedEventId = workingLog.at(-1)?.id ?? causationId;
      let nextSequence = nextEventSequence(workingLog);

      const append = async (type, data) => {
        const event = makeSagaEvent({
          id: idFactory("saga-event"),
          type,
          sagaId,
          tenantId,
          correlationId,
          causationId: lastAcceptedEventId,
          time: now(),
          seq: nextSequence,
          data,
        });
        nextSequence += 1;

        const appendResult = await appendEvent(event);
        if (appendResult?.appended === false) {
          return {
            appended: false,
            reason: appendResult.reason ?? "append-rejected",
            event,
          };
        }

        workingLog.push(event);
        lastAcceptedEventId = event.id;
        replay = replaySagaEvents(workingLog);
        return { appended: true, event };
      };

      if (TERMINAL_STATUSES.has(replay.state.status)) {
        return finish(replay.state, workingLog, replay.ignoredEvents, stepExecutions);
      }

      if (replay.state.status === "new") {
        const started = await append("saga.Started", {
          stepIds: steps.map((step) => step.id),
        });
        if (!started.appended) {
          return waitingForRetry(replay.state, workingLog, replay.ignoredEvents, started);
        }
      }

      for (const step of steps) {
        replay = replaySagaEvents(workingLog);
        if (TERMINAL_STATUSES.has(replay.state.status)) {
          return finish(replay.state, workingLog, replay.ignoredEvents, stepExecutions);
        }
        if (Object.hasOwn(replay.state.results, step.id)) {
          continue;
        }

        assertLeaseFresh(lease);
        const idempotencyKey = step.idempotencyKey ?? `${sagaId}:${step.id}`;

        try {
          const stepOutcome = await ledger.runOnce(idempotencyKey, async () => {
            const result = await step.run({
              sagaId,
              tenantId,
              correlationId,
              idempotencyKey,
              previousResults: clone(replay.state.results),
            });
            stepExecutions.push({ stepId: step.id, idempotencyKey });
            return result;
          });

          const completed = await append("saga.StepCompleted", {
            stepId: step.id,
            idempotencyKey,
            memoized: stepOutcome.memoized,
            result: stepOutcome.result,
            resultDigest: stableDigest(stepOutcome.result),
          });
          if (!completed.appended) {
            return waitingForRetry(replay.state, workingLog, replay.ignoredEvents, completed);
          }
        } catch (error) {
          const classification = classifyFailure(error, step.failureContext );
          const failed = await append("saga.StepFailed", {
            stepId: step.id,
            message: error instanceof Error ? error.message : "unknown failure",
            failureClass: classification.class,
            reason: classification.reason,
            strategy: classification.strategy,
          });
          if (!failed.appended) {
            return waitingForRetry(replay.state, workingLog, replay.ignoredEvents, failed);
          }

          replay = replaySagaEvents(workingLog);
          const classifications = replay.state.failures.map((failure) => failure.failureClass);
          if (crossesNoGoThreshold(classifications, noGoThreshold)) {
            const compensating = await append("saga.Compensating", {
              failedStepId: step.id,
              noGoThreshold,
              compensation: {
                seam: "stub",
                plugin: "compensation-strategy",
                status: "not-run-in-this-slice",
              },
            });
            if (!compensating.appended) {
              return waitingForRetry(replay.state, workingLog, replay.ignoredEvents, compensating);
            }

            const rolledBack = await append("saga.RolledBack", {
              failedStepId: step.id,
              compensationStatus: "stubbed",
            });
            if (!rolledBack.appended) {
              return waitingForRetry(replay.state, workingLog, replay.ignoredEvents, rolledBack);
            }
          }

          return finish(
            replaySagaEvents(workingLog).state,
            workingLog,
            replay.ignoredEvents,
            stepExecutions,
          );
        }
      }

      replay = replaySagaEvents(workingLog);
      if (!TERMINAL_STATUSES.has(replay.state.status)) {
        const completed = await append("saga.Completed", {
          completedStepIds: steps.map((step) => step.id),
        });
        if (!completed.appended) {
          return waitingForRetry(replay.state, workingLog, replay.ignoredEvents, completed);
        }
      }

      replay = replaySagaEvents(workingLog);
      return finish(replay.state, workingLog, replay.ignoredEvents, stepExecutions);
    },
  };
}

export function replaySagaEvents(events) {
  const state = {
    sagaId: undefined,
    tenantId: undefined,
    status: "new",
    stepIds: [],
    completedStepIds: [],
    results: {},
    failures: [],
    failure: undefined,
    compensation: undefined,
  };
  const ignoredEvents = [];

  for (const event of events) {
    if (TERMINAL_STATUSES.has(state.status)) {
      ignoredEvents.push({ event, reason: "terminal-saga" });
      continue;
    }

    switch (event.type) {
      case "saga.Started": {
        if (state.status !== "new") {
          ignoredEvents.push({ event, reason: "duplicate-start" });
          break;
        }
        state.sagaId = event.sagaId;
        state.tenantId = event.tenantId;
        state.status = "running";
        state.stepIds = [...(event.data.stepIds ?? [])];
        break;
      }
      case "saga.StepCompleted": {
        if (Object.hasOwn(state.results, event.data.stepId)) {
          ignoredEvents.push({ event, reason: "duplicate-step-completed" });
          break;
        }
        state.completedStepIds.push(event.data.stepId);
        state.results[event.data.stepId] = clone(event.data.result);
        state.status = "running";
        break;
      }
      case "saga.StepFailed": {
        const failure = {
          stepId: event.data.stepId,
          failureClass: event.data.failureClass,
          reason: event.data.reason,
          strategy: event.data.strategy,
        };
        state.failures.push(failure);
        state.failure = failure;
        state.status = "failed";
        break;
      }
      case "saga.Compensating": {
        state.status = "compensating";
        state.compensation = clone(event.data.compensation);
        break;
      }
      case "saga.RolledBack": {
        state.status = "rolled-back";
        state.rolledBack = clone(event.data);
        break;
      }
      case "saga.Completed": {
        state.status = "completed";
        state.completedStepIds = [...(event.data.completedStepIds ?? state.completedStepIds)];
        break;
      }
      default: {
        ignoredEvents.push({ event, reason: "unknown-event-type" });
      }
    }
  }

  return { state, ignoredEvents };
}

export function makeSagaEvent({
  id,
  type,
  sagaId,
  tenantId,
  correlationId,
  causationId,
  data = {},
  time = "1970-01-01T00:00:00.000Z",
  seq = 0,
}) {
  assertRequired({ id, type, sagaId, tenantId, correlationId, causationId });

  return {
    id,
    type,
    schemaVersion: 1,
    seq,
    time,
    sagaId,
    tenantId,
    correlationId,
    causationId,
    data: clone(data),
  };
}

function finish(state, events, ignoredEvents, stepExecutions) {
  return {
    state,
    events: [...events],
    ignoredEvents: [...ignoredEvents],
    stepExecutions: [...stepExecutions],
  };
}

function waitingForRetry(state, events, ignoredEvents, appendResult) {
  return finish(
    {
      ...state,
      status: "waiting-for-retry",
      waitingOn: appendResult.event.type,
      appendFailure: appendResult.reason,
    },
    events,
    ignoredEvents,
    [],
  );
}

function assertLeaseFresh(lease) {
  if (!lease) {
    return;
  }

  if (lease.fenceToken < lease.currentFenceToken) {
    throw new Error(
      `stale saga lease: owner ${lease.ownerId} fence ${lease.fenceToken} < current ${lease.currentFenceToken}`,
    );
  }
}

function assertRequired(fields) {
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") {
      throw new Error(`Missing required saga field: ${field}`);
    }
  }
}

function nextEventSequence(events) {
  const maxSequence = events.reduce((max, event) => Math.max(max, event.seq ?? 0), 0);
  return maxSequence + 1;
}

function randomEventId(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function stableDigest(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }

  if (value && isJsonObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }

  return structuredClone(value);
}
