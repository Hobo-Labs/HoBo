import { createDeterministicContext } from "./context.js";
import { digest } from "./divergence.js";
import { hashReadSet, seqVector, stableStringify } from "./equivalence.js";
import type { EventStoreReader } from "./store.js";
import type { EventEnvelope, ReplayReport } from "./types.js";
import { isJsonString, isJsonObject, type JsonValue } from "./json.js";


export interface WorkflowDefinition<S, A> {
  name: string;
  initialState(args: A): S;
  execute(ctx: WorkflowReplayContext, state: S, args: A): Promise<S> | S;
}

export interface WorkflowReplayContext {
  runId: string;
  seed: string;
  now(): string;
  random(label?: string): number;
  step<T>(name: string, fn: () => Promise<T> | T): Promise<T>;
  sleep(delayMs: number): Promise<void>;
  resumeHook<T>(payload: T): T;
}

export interface ReplayOptions {
  seed?: string;
}

export interface ReplayResult<S> {
  state: S;
  report: ReplayReport;
}

export async function replayRun<S, A>(
  store: EventStoreReader,
  runId: string,
  workflow: WorkflowDefinition<S, A>,
  args: A,
  options: ReplayOptions = {},
): Promise<ReplayResult<S>> {
  const streamId = `run/${runId}`;
  const events = await store.readStream(streamId);
  const seed = options.seed ?? readSeed(events) ?? `run-${runId}`;
  const started = events.find((event) => event.type === "run.Started");
  if (!started) {
    throw new Error(`missing run.Started for ${runId}`);
  }

  let state = workflow.initialState(args);
  const stepResults = new Map<string, unknown>();
  const hookResults = new Map<string, unknown>();
  const timerResults = new Map<string, { delayMs: number }>();
  let stepCounter = 0;

  const ctx: WorkflowReplayContext = {
    runId,
    seed,
    now: () =>
      createDeterministicContext({
        seed,
        mode: "replay",
        eventKey: `${streamId}:orchestration`,
      }).now(),
    random: (label = "workflow") =>
      createDeterministicContext({
        seed,
        mode: "replay",
        eventKey: `${streamId}:orchestration:${label}`,
      }).random(label),
    async step<T>(name, _fn) {
      const stepId = `${name}:${stepCounter}`;
      const completed = events.find(
        (event) => event.type === "run.StepCompleted" && event.data && matchesStep(event.data, name, stepCounter),
      );
      if (completed) {
        stepCounter += 1;
        // SAFETY: assertion to `const result = (completed.data as { result: T }).result;` is required at this boundary.
        const result = (completed.data as { result: T }).result;
        stepResults.set(stepId, result);
        return result;
      }
      throw new Error(`missing memoized step ${name} at index ${stepCounter}`);
    },
    async sleep(delayMs) {
      const scheduled = events.find((event) => event.type === "run.SleepScheduled");
      if (!scheduled) {
        throw new Error("missing run.SleepScheduled");
      }
      // SAFETY: assertion to `timerResults.set("sleep", { delayMs: (scheduled.data as { delayMs: number }).del` is required at this boundary.
      timerResults.set("sleep", { delayMs: (scheduled.data as { delayMs: number }).delayMs });
      // SAFETY: assertion to `if ((scheduled.data as { delayMs: number }).delayMs !== delayMs) {` is required at this boundary.
      if ((scheduled.data as { delayMs: number }).delayMs !== delayMs) {
        throw new Error("sleep schedule diverged");
      }
    },
    resumeHook<T>(_payload: T) {
      const resumed = events.find((event) => event.type === "run.HookResumed");
      if (!resumed) {
        throw new Error("missing run.HookResumed");
      }
      // SAFETY: assertion to `hookResults.set("hook", (resumed.data as { payload: T }).payload);` is required at this boundary.
      hookResults.set("hook", (resumed.data as { payload: T }).payload);
      // SAFETY: assertion to `return (resumed.data as { payload: T }).payload;` is required at this boundary.
      return (resumed.data as { payload: T }).payload;
    },
  };

  state = await workflow.execute(ctx, state, args);

  const report: ReplayReport = {
    runId,
    seqVector: Object.entries(seqVector(events))
      .map(([streamIdEntry, seq]) => ({ streamId: streamIdEntry, seq }))
      .sort((left, right) => left.streamId.localeCompare(right.streamId)),
    readSetHash: hashReadSet(events),
    stateDigest: digest(state),
    mode: "replay",
    seed,
  };

  return { state, report };
}

function readSeed(events: EventEnvelope[]): string | undefined {
  const started = events.find((event) => event.type === "run.Started");
  if (!started?.data || !isJsonObject(started.data)) {
    return undefined;
  }
  // SAFETY: assertion to `const seed = (started.data as { seed?: unknown }).seed;` is required at this boundary.
  const seed = (started.data as { seed?: unknown }).seed;
  return isJsonString(seed) ? seed : undefined;
}

function matchesStep(data: JsonValue, name: string, index: number): boolean {
  if (!data || !isJsonObject(data)) {
    return false;
  }
  // SAFETY: assertion to `const record = data as { name?: string; index?: number };` is required at this boundary.
  const record = data as { name?: string; index?: number };
  return record.name === name && record.index === index;
}

export function canonicalStateBytes<S>(state: S): string {
  return stableStringify(state);
}
