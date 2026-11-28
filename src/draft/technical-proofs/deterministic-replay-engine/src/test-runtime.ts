import { createDeterministicContext } from "./context.js";
import { ReplayDivergenceError, digest } from "./divergence.js";
import { canonicalStateBytes } from "./replayer.js";
import { nextEnvelope, recordEffect } from "./recorder.js";
import { createInMemoryEventStore } from "./store.js";
import { stableStringify } from "./equivalence.js";
import { isJsonObject, type JsonValue } from "./json.js";


export interface WorkflowHandlers<S, A> {
  name: string;
  initialState(args: A): S;
  onStart?: (ctx: RuntimeContext, state: S, args: A) => S | Promise<S>;
  onHook?: (ctx: RuntimeContext, state: S, payload: JsonValue) => S | Promise<S>;
  onTimer?: (ctx: RuntimeContext, state: S, timer: TimerRef) => S | Promise<S>;
}

export interface RuntimeContext {
  runId: string;
  seed: string;
  now(): string;
  random(label?: string): number;
  step<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  sleep(delayMs: number, options?: { id?: string; label?: string }): TimerRef;
  emit(type: string, data?: JsonValue): { type: string; data: unknown };
  waitForHook(name?: string): HookRef;
}

export interface TimerRef {
  timerId: string;
  label?: string;
  fireAt: string;
}

export interface HookRef {
  name: string;
  waitingAt: string;
}

export interface RunRef {
  runId: string;
}

export interface TestRuntime {
  start<S, A>(workflow: WorkflowHandlers<S, A>, args: A): Promise<RunRef>;
  resumeHook(run: RunRef, payload: JsonValue): Promise<RunRef>;
  state<S>(run: RunRef): Promise<S>;
  replay<S>(run: RunRef): Promise<S>;
  clock: { advance(ms: number): Promise<void>; now(): string };
}

interface RunRecord<S, A> {
  runId: string;
  workflow: WorkflowHandlers<S, A>;
  args: A;
  state: S;
  streamId: string;
  nextSeq: number;
  stepIndex: number;
  timers: TimerRecord[];
  trace: TraceEntry[];
}

interface TimerRecord {
  timerId: string;
  label?: string;
  delayMs: number;
  fireAtMs: number;
  fired: boolean;
}

type TraceEntry =
  | { type: "hook.waiting"; hook: HookRef; atMs: number }
  | { type: "timer.scheduled"; timerId: string; label?: string; delayMs: number; fireAtMs: number }
  | { type: "timer.fired"; timerId: string; label?: string; atMs: number; fireAtMs: number }
  | { type: "hook.resumed"; payload: JsonValue; atMs: number };

export function defineWorkflow<S, A>(name: string, handlers: Omit<WorkflowHandlers<S, A>, "name">) {
  return Object.freeze({ ...handlers, name });
}

export function testRuntime(options: { seed?: string; startInstant?: string } = {}): TestRuntime {
  const store = createInMemoryEventStore();
  const seed = options.seed ?? "runtime-local-test-seed";
  let nowMs = Date.parse(options.startInstant ?? "2026-06-26T00:00:00.000Z");
  let timerSeq = 1;
  const runs = new Map<string, RunRecord<unknown, unknown>>();

  async function appendRunEvent<S, A>(run: RunRecord<S, A>, type: string, data: JsonValue) {
    run.nextSeq += 1;
    await recordEffect(
      store,
      nextEnvelope(run.streamId, run.nextSeq, type, data, {
        ts: formatInstant(nowMs),
        meta: { idempotencyKey: `${run.runId}:${type}:${run.nextSeq}` },
      }),
      run.nextSeq - 1,
    );
  }

  function createCtx<S, A>(run: RunRecord<S, A>, record: boolean): RuntimeContext {
    const orchestrationKey = `${run.streamId}:orchestration`;
    const seeded = createDeterministicContext({ seed, mode: record ? "live" : "replay", eventKey: orchestrationKey });
    const replayTimers = record
      ? null
      : {
          entries: run.trace.filter((entry) => entry.type === "timer.scheduled"),
          index: 0,
        };

    return Object.freeze({
      runId: run.runId,
      seed,
      now: () => seeded.now(),
      random: (label?: string) => seeded.random(label),
      async step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
        const index = run.stepIndex;
        if (record) {
          await appendRunEvent(run, "run.StepScheduled", { name, index });
          const result = await fn();
          await appendRunEvent(run, "run.StepCompleted", { name, index, result });
          run.stepIndex += 1;
          return result;
        }
        const events = await store.readStream(run.streamId);
        const completed = events.find(
          (event) =>
            event.type === "run.StepCompleted" &&
            event.data &&
            isJsonObject(event.data) &&
            // SAFETY: assertion to `(event.data as { name?: string; index?: number }).name === name &&` is required at this boundary.
            (event.data as { name?: string; index?: number }).name === name &&
            // SAFETY: assertion to `(event.data as { name?: string; index?: number }).index === index,` is required at this boundary.
            (event.data as { name?: string; index?: number }).index === index,
        );
        if (!completed) {
          throw new ReplayDivergenceError({
            runId: run.runId,
            liveState: { missingStep: name, index },
            replayState: {},
            liveOrder: events.map((event) => event.type),
            replayOrder: [],
          });
        }
        run.stepIndex += 1;
        // SAFETY: assertion to `return (completed.data as { result: T }).result;` is required at this boundary.
        return (completed.data as { result: T }).result;
      },
      sleep(delayMs, options = {}) {
        if (!record) {
          return replaySleep(delayMs, options, replayTimers!, run.runId);
        }
        const timerId = options.id ?? `timer-${timerSeq++}`;
        const timer: TimerRecord = {
          timerId,
          label: options.label,
          delayMs,
          fireAtMs: nowMs + delayMs,
          fired: false,
        };
        run.timers.push(timer);
        run.trace.push({
          type: "timer.scheduled",
          timerId,
          label: timer.label,
          delayMs,
          fireAtMs: timer.fireAtMs,
        });
        return { timerId, label: timer.label, fireAt: formatInstant(timer.fireAtMs) };
      },
      emit(type, data = {}) {
        return { type, data };
      },
      waitForHook(name = "default") {
        const hook = { name, waitingAt: formatInstant(nowMs) };
        if (record) {
          run.trace.push({ type: "hook.waiting", hook, atMs: nowMs });
        }
        return hook;
      },
    });
  }

  async function applyHandler<S, A>(
    run: RunRecord<S, A>,
    handler: ((ctx: RuntimeContext, state: S, input: JsonValue) => S | Promise<S>) | undefined,
    input: JsonValue,
    record: boolean,
  ) {
    if (!handler) {
      return;
    }
    const ctx = createCtx(run, record);
    const next = await handler(ctx, clone(run.state), input);
    if (next !== undefined) {
      run.state = clone(next);
    }
  }

  async function replayRunRecord<S, A>(run: RunRecord<S, A>) {
    return withReplayAmbientPoisoning(async () => {
      const replay: RunRecord<S, A> = {
        ...run,
        state: run.workflow.initialState(clone(run.args)),
        stepIndex: 0,
        timers: [],
        trace: run.trace,
      };

      await applyHandler(replay, run.workflow.onStart, clone(run.args), false);
      for (const entry of run.trace) {
        if (entry.type === "hook.resumed") {
          await applyHandler(replay, run.workflow.onHook, entry.payload, false);
        } else if (entry.type === "timer.fired") {
          await applyHandler(
            replay,
            run.workflow.onTimer,
            { timerId: entry.timerId, label: entry.label, fireAt: formatInstant(entry.fireAtMs) },
            false,
          );
        }
      }
      return replay;
    });
  }

  return {
    clock: {
      now() {
        return formatInstant(nowMs);
      },
      advance(ms: number) {
        nowMs += ms;
        const pending: Promise<void>[] = [];
        for (const run of runs.values()) {
          for (const timer of run.timers) {
            if (!timer.fired && timer.fireAtMs <= nowMs) {
              timer.fired = true;
              run.trace.push({
                type: "timer.fired",
                timerId: timer.timerId,
                label: timer.label,
                atMs: nowMs,
                fireAtMs: timer.fireAtMs,
              });
              pending.push(
                applyHandler(
                  run,
                  run.workflow.onTimer,
                  { timerId: timer.timerId, label: timer.label, fireAt: formatInstant(timer.fireAtMs) },
                  true,
                ).then(() => undefined),
              );
            }
          }
        }
        return Promise.all(pending).then(() => undefined);
      },
    },

    async start(workflow, args) {
      const runId = `run-${runs.size + 1}`;
      const run: RunRecord<typeof args, typeof args> = {
        runId,
        workflow,
        args: clone(args),
        state: workflow.initialState(clone(args)),
        streamId: `run/${runId}`,
        nextSeq: 0,
        stepIndex: 0,
        timers: [],
        trace: [],
      };
      // SAFETY: assertion to `runs.set(runId, run as RunRecord<unknown, unknown>);` is required at this boundary.
      runs.set(runId, run as RunRecord<unknown, unknown>);
      await appendRunEvent(run, "run.Started", { seed, args });
      await applyHandler(run, workflow.onStart, clone(args), true);
      return { runId };
    },

    async resumeHook(runRef, payload) {
      const run = getRun(runs, runRef);
      run.trace.push({ type: "hook.resumed", payload: clone(payload), atMs: nowMs });
      await appendRunEvent(run, "run.HookResumed", { payload });
      await applyHandler(run, run.workflow.onHook, clone(payload), true);
      return { runId: run.runId };
    },

    async state(runRef) {
      return clone(getRun(runs, runRef).state);
    },

    async replay(runRef) {
      const run = getRun(runs, runRef);
      const replayed = await replayRunRecord(run);
      const events = await store.readStream(run.streamId);

      if (
        digest(run.state) !== digest(replayed.state) ||
        canonicalStateBytes(run.state) !== canonicalStateBytes(replayed.state)
      ) {
        throw new ReplayDivergenceError({
          runId: run.runId,
          liveState: run.state,
          replayState: replayed.state,
          liveOrder: events.map((event) => `${event.streamId}:${event.seq}:${event.type}`),
          replayOrder: [...events]
            .sort((left, right) => left.streamId.localeCompare(right.streamId) || left.seq - right.seq)
            .map((event) => `${event.streamId}:${event.seq}:${event.type}`),
        });
      }

      return clone(replayed.state);
    },
  };
}

export { ReplayDivergenceError, stableStringify, canonicalStateBytes };

function replaySleep(
  delayMs: number,
  options: { id?: string; label?: string },
  replayTimers: { entries: TraceEntry[]; index: number },
  runId: string,
): TimerRef {
  const recorded = replayTimers.entries[replayTimers.index++];
  if (!recorded || recorded.type !== "timer.scheduled") {
    throw new ReplayDivergenceError({
      runId,
      liveState: {},
      replayState: {},
      liveOrder: [],
      replayOrder: [],
      firstDivergentEventKey: "timer",
    });
  }
  if (
    recorded.delayMs !== delayMs ||
    (options.id !== undefined && recorded.timerId !== options.id) ||
    (options.label !== undefined && recorded.label !== options.label)
  ) {
    throw new ReplayDivergenceError({
      runId,
      liveState: { recorded },
      replayState: { delayMs, options },
      liveOrder: [],
      replayOrder: [],
      firstDivergentEventKey: "timer",
    });
  }
  return {
    timerId: recorded.timerId,
    label: recorded.label,
    fireAt: formatInstant(recorded.fireAtMs),
  };
}

function getRun(runs: Map<string, RunRecord<unknown, unknown>>, runRef: RunRef) {
  const run = runs.get(runRef.runId);
  if (!run) {
    throw new TypeError(`unknown run ${runRef.runId}`);
  }
  return run;
}

function formatInstant(ms: number): string {
  return new Date(ms).toISOString();
}

function clone<T>(value: T): T {
  if (structuredClone instanceof Function) {
    return structuredClone(value);
  }
  // SAFETY: JSON.parse round-trip clones T at this document boundary.
  const cloned: T = JSON.parse(JSON.stringify(value)) as T;
  return cloned;
}

function withReplayAmbientPoisoning<T>(callback: () => T | Promise<T>): T | Promise<T> {
  const originalDateNow = Date.now;
  const originalMathRandom = Math.random;
  Date.now = () => 2_000_000_000_000;
  Math.random = () => 0.999999999;
  try {
    return callback();
  } finally {
    Date.now = originalDateNow;
    Math.random = originalMathRandom;
  }
}
