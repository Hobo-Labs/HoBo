import { createRuntimeLocalEventStore } from "../../../camp-eventstore-runtime-port-contract/src/camp-eventstore-runtime-port.js";
import { assertReplayEqualsLive } from "../../../replay-live-equivalence-poc/src/equivalence.js";

import { FatalError, RetryableError } from "../errors.js";
import { parseEnvelope, parseRuntimeEnvelope, stableIdempotencyKey, type ParsedEnvelope } from "../engine/events.js";
import { createDeterministicContext, withDeterminism } from "../engine/determinism.js";
import { findStepCompleted, findStepFailed } from "../engine/memo.js";
import type { Hook, StepOpts } from "../types.js";
import type { RunContextBinding } from "../step.js";
import { isJsonString, isJsonNumber, type JsonValue, type JsonObject } from "../json.js";


const DEFAULT_RETRIES = 3;

export interface TestRuntimeOptions {
  seed?: string;
  startInstant?: string;
}

export interface TestRuntime {
  clock: { now(): string; advance(duration: string | number): void };
  start(workflow: WorkflowLike, args: JsonValue[], opts?: { idempotencyKey?: string }): Promise<RunRef>;
  resumeHook(run: RunRef, payload: JsonValue): Promise<RunRef>;
  continueRun(run: RunRef): Promise<RunRef>;
  reruns(run: RunRef): Promise<RunRef>;
  replay(run: RunRef): Promise<JsonValue>;
  state(run: RunRef): Promise<JsonValue>;
  eventLog(run: RunRef): Promise<ParsedEnvelope[]>;
  allEvents(): Promise<ParsedEnvelope[]>;
  getSideEffectCounter(): number;
  incrementSideEffect(): void;
  registerSaga(saga: RegisteredSaga): void;
  emit(type: string, data: JsonValue): Promise<number>;
}

export interface WorkflowLike {
  name: string;
  run(ctx: RunContextBinding, args: JsonValue[]): Promise<JsonValue>;
}

export interface RegisteredSaga {
  name: string;
  handlers: Map<string, SagaHandler>;
  compensations: Map<string, SagaHandler>;
}

type SagaHandler = (
  event: ParsedEnvelope,
  ctx: { emit: (type: string, data: JsonValue) => Promise<number> },
) => Promise<void> | void;

export interface RunRef {
  runId: string;
}

interface InternalRun {
  runId: string;
  workflow: WorkflowLike;
  args: JsonValue[];
  result?: JsonValue;
  completed: boolean;
  suspended: "hook" | "sleep" | null;
  hookToken?: string;
  sleepWakeAtMs?: number;
}

class RunSuspendedError extends Error {
  constructor(kind: string) {
    super(`run suspended: ${kind}`);
    this.name = "RunSuspendedError";
  }
}

export function testRuntime(options: TestRuntimeOptions = {}): TestRuntime {
  const seed = options.seed ?? "hobo-runtime-ts-primitives";
  const clock = createDeterministicContext(seed, options.startInstant);
  const eventStore = createRuntimeLocalEventStore({ clock: { now: () => clock.now() } });
  const runs = new Map<string, InternalRun>();
  const sagas: RegisteredSaga[] = [];
  let sideEffectCounter = 0;
  let nextTimer = 1;
  let nextHook = 1;
  let globalSeq = 0;
  const catalogEvents: ParsedEnvelope[] = [];

  async function readStream(streamId: string): Promise<ParsedEnvelope[]> {
    const raw = await eventStore.read(streamId, 1);
    // SAFETY: assertion to `return (raw as unknown[]).map((entry) => parseEnvelope(entry));` is required at this boundary.
    return (raw as unknown[]).map((entry) => parseEnvelope(entry));
  }

  async function appendCatalogStream(
    streamId: string,
    type: string,
    data: JsonObject,
  ): Promise<ParsedEnvelope> {
    const existing = await readStream(streamId);
    const result = await eventStore.append(
      streamId,
      [{ type, data, meta: {} }],
      { expectedSeq: existing.length, tenant: "draft-local", actor: { id: "runtime", kind: "system" } },
    );
    const parsed = parseRuntimeEnvelope(result.appended[0] ?? result.deduped[0]);
    catalogEvents.push(parsed);
    return parsed;
  }

  async function dispatchDomainEvent(type: string, data: JsonObject) {
    const synthetic: ParsedEnvelope = Object.freeze({
      id: `domain:${type}:${globalSeq}`,
      type,
      streamId: "global:events",
      seq: globalSeq,
      runId: isJsonString(data.runId) ? data.runId : "global",
      data: Object.freeze(data),
    });

    for (const sagaDef of sagas) {
      const handler = sagaDef.handlers.get(type);
      if (handler) {
        await appendCatalogStream(`saga:${sagaDef.name}`, "saga.StepEmitted", {
          sagaName: sagaDef.name,
          reactedTo: type,
          runId: synthetic.runId,
        });
        await handler(synthetic, { emit: appendGlobalEvent });
      }
      const compensation = sagaDef.compensations.get(type);
      if (compensation) {
        await appendCatalogStream(`saga:${sagaDef.name}`, "saga.Compensated", {
          sagaName: sagaDef.name,
          trigger: type,
          runId: synthetic.runId,
        });
        await compensation(synthetic, { emit: appendGlobalEvent });
      }
    }
  }

  async function appendGlobalEvent(type: string, data: JsonValue): Promise<number> {
    globalSeq += 1;
    // SAFETY: assertion to `const payload = { ...(data as JsonObject), seq: globalSeq };` is required at this boundary.
    const payload = { ...(data as JsonObject), seq: globalSeq };
    const existing = await readStream("global:events");
    await eventStore.append(
      "global:events",
      [{ type, data: payload, meta: {} }],
      { expectedSeq: existing.length, tenant: "draft-local", actor: { id: "runtime", kind: "system" } },
    );
    await dispatchDomainEvent(type, payload);
    return globalSeq;
  }

  async function readRunEvents(runId: string): Promise<ParsedEnvelope[]> {
    return readStream(`run:${runId}`);
  }

  function parseDurationMs(duration: string | number): number {
    if (isJsonNumber(duration)) {
      return duration;
    }
    const match = /^(\d+)(ms|s|m|h)$/.exec(duration.trim());
    if (!match) {
      throw new Error(`invalid duration: ${duration}`);
    }
    const amount = Number.parseInt(match[1], 10);
    switch (match[2]) {
      case "ms":
        return amount;
      case "s":
        return amount * 1000;
      case "m":
        return amount * 60_000;
      case "h":
        return amount * 3_600_000;
      default:
        throw new Error(`invalid duration unit: ${match[2]}`);
    }
  }

  async function runStep<O>(
    run: InternalRun,
    stepKey: string,
    fn: () => Promise<O>,
    opts: StepOpts = {},
  ): Promise<O> {
    const events = await readRunEvents(run.runId);
    const memoHit = findStepCompleted(events, stepKey);
    if (memoHit) {
      // SAFETY: assertion to `return memoHit.data.result as O;` is required at this boundary.
      return memoHit.data.result as O;
    }
    const failed = findStepFailed(events, stepKey);
    if (failed) {
      throw new Error(String(failed.data.message ?? "step failed"));
    }

    const idempotencyKey = opts.idempotencyKey ?? stableIdempotencyKey([run.runId, stepKey]);
    await appendCatalogStream(`run:${run.runId}`, "run.StepScheduled", { runId: run.runId, stepKey, idempotencyKey });

    const maxRetries = opts.retries ?? DEFAULT_RETRIES;
    let attempts = 0;
    while (attempts <= maxRetries) {
      attempts += 1;
      try {
        const result = await fn();
        await appendCatalogStream(`run:${run.runId}`, "run.StepCompleted", {
          runId: run.runId,
          stepKey,
          idempotencyKey,
          result,
        });
        return result;
      } catch (error) {
        if (error instanceof FatalError) {
          await appendCatalogStream(`run:${run.runId}`, "run.StepFailed", {
            runId: run.runId,
            stepKey,
            idempotencyKey,
            message: error.message,
            attempts,
          });
          throw error;
        }
        const retryBudget =
          error instanceof RetryableError && error.retries !== undefined ? error.retries : maxRetries;
        if (attempts > retryBudget) {
          await appendCatalogStream(`run:${run.runId}`, "run.StepFailed", {
            runId: run.runId,
            stepKey,
            idempotencyKey,
            message: error instanceof Error ? error.message : "unknown failure",
            attempts,
          });
          throw error;
        }
      }
    }
    throw new Error("unreachable step retry loop");
  }

  async function runSleep(run: InternalRun, duration: string | number): Promise<void> {
    const events = await readRunEvents(run.runId);
    const existing = events.find((event) => event.type === "run.SleepScheduled");
    // SAFETY: assertion to `const wakeAtMs = existing?.data.wakeAtMs as number | undefined;` is required at this boundary.
    const wakeAtMs = existing?.data.wakeAtMs as number | undefined;
    if (existing && wakeAtMs !== undefined && clock.nowMs() >= wakeAtMs) {
      return;
    }
    if (existing && wakeAtMs !== undefined && clock.nowMs() < wakeAtMs) {
      run.suspended = "sleep";
      run.sleepWakeAtMs = wakeAtMs;
      throw new RunSuspendedError("sleep");
    }

    const ms = parseDurationMs(duration);
    const timerId = `timer-${nextTimer++}`;
    const nextWake = clock.nowMs() + ms;
    await appendCatalogStream(`run:${run.runId}`, "run.SleepScheduled", {
      runId: run.runId,
      timerId,
      durationMs: ms,
      wakeAtMs: nextWake,
    });

    if (clock.nowMs() >= nextWake) {
      return;
    }

    run.suspended = "sleep";
    run.sleepWakeAtMs = nextWake;
    throw new RunSuspendedError("sleep");
  }

  function createRunHook<T>(run: InternalRun, name?: string): Hook<T> {
    const token = name ?? `hook-${nextHook++}`;

    return {
      token,
      async wait() {
        const events = await readRunEvents(run.runId);
        const resumed = events.find(
          (event) => event.type === "run.HookResumed" && event.data.token === token,
        );
        if (resumed) {
          // SAFETY: assertion to `return resumed.data.payload as T;` is required at this boundary.
          return resumed.data.payload as T;
        }

        if (!events.some((event) => event.type === "run.HookCreated" && event.data.token === token)) {
          await appendCatalogStream(`run:${run.runId}`, "run.HookCreated", { runId: run.runId, token });
        }

        run.suspended = "hook";
        run.hookToken = token;
        throw new RunSuspendedError("hook");
      },
    };
  }

  async function executeRun(run: InternalRun): Promise<void> {
    const ctx: RunContextBinding = {
      step: (stepKey, fn, opts) => runStep(run, stepKey, fn, opts),
      sleep: (duration) => runSleep(run, duration),
      createHook: (name) => createRunHook(run, name),
      emit: appendGlobalEvent,
    };

    try {
      run.result = await withDeterminism(clock, () => run.workflow.run(ctx, run.args));
      run.suspended = null;
      if (!run.completed) {
        await appendCatalogStream(`run:${run.runId}`, "run.Completed", { runId: run.runId, result: run.result });
        run.completed = true;
      }
    } catch (error) {
      if (error instanceof RunSuspendedError) {
        return;
      }
      if (!run.completed) {
        await appendCatalogStream(`run:${run.runId}`, "run.Failed", {
          runId: run.runId,
          message: error instanceof Error ? error.message : "unknown failure",
        });
        run.completed = true;
      }
      throw error;
    }
  }

  const api: TestRuntime = {
    clock: {
      now: () => clock.now(),
      advance(duration) {
        clock.advance(parseDurationMs(duration));
      },
    },

    async start(workflow, args, opts) {
      const runId = `run-${runs.size + 1}`;
      const run: InternalRun = {
        runId,
        workflow,
        args,
        completed: false,
        suspended: null,
      };
      runs.set(runId, run);
      await appendCatalogStream(`run:${runId}`, "run.Started", {
        runId,
        workflow: workflow.name,
        args,
        idempotencyKey: opts?.idempotencyKey,
      });
      await executeRun(run);
      return { runId };
    },

    async resumeHook(runRef, payload) {
      const run = runs.get(runRef.runId);
      if (!run?.hookToken) {
        throw new Error("no pending hook");
      }
      await appendCatalogStream(`run:${run.runId}`, "run.HookResumed", {
        runId: run.runId,
        token: run.hookToken,
        payload,
      });
      run.suspended = null;
      run.hookToken = undefined;
      await executeRun(run);
      return { runId: run.runId };
    },

    async continueRun(runRef) {
      const run = runs.get(runRef.runId);
      if (!run) {
        throw new Error("unknown run");
      }
      if (run.suspended === "sleep" && run.sleepWakeAtMs && clock.nowMs() >= run.sleepWakeAtMs) {
        run.suspended = null;
        run.sleepWakeAtMs = undefined;
        await executeRun(run);
      }
      return { runId: run.runId };
    },

    async reruns(runRef) {
      const run = runs.get(runRef.runId);
      if (!run) {
        throw new Error("unknown run");
      }
      run.completed = false;
      run.suspended = null;
      await executeRun(run);
      return { runId: run.runId };
    },

    async replay(runRef) {
      const events = await readRunEvents(runRef.runId);
      const replayed = assertReplayEqualsLive({
        events: events.map((event) => ({
          streamId: event.streamId,
          seq: event.seq,
          id: event.id,
          type: event.type,
          data: event.data,
        })),
        fold: (_state, event) => (event.type === "run.Completed" ? event.data.result : _state),
        initialState: undefined,
        seed,
      });
      return replayed.state;
    },

    async state(runRef) {
      const run = runs.get(runRef.runId);
      if (run?.completed) {
        return run.result;
      }
      const events = await readRunEvents(runRef.runId);
      const completed = events.find((event) => event.type === "run.Completed");
      return completed?.data.result;
    },

    eventLog: (runRef) => readRunEvents(runRef.runId),

    allEvents: async () => [...catalogEvents].sort((a, b) => a.seq - b.seq),

    getSideEffectCounter: () => sideEffectCounter,

    incrementSideEffect: () => {
      sideEffectCounter += 1;
    },

    registerSaga(sagaDef) {
      sagas.push(sagaDef);
      void appendCatalogStream(`saga:${sagaDef.name}`, "saga.Started", { sagaName: sagaDef.name });
    },

    emit: appendGlobalEvent,
  };

  return api;
}
