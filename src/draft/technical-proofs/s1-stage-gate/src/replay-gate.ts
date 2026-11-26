import {
  ReplayLiveMismatchError,
  assertReplayEqualsLive,
  runFold,
  seqVector,
} from "../../replay-live-equivalence-poc/src/equivalence.js";

import { readPersistedEventLog } from "./offline-gate.js";
import { type JsonObject } from "./json.js";


export { ReplayLiveMismatchError };

export type ReplayGateResult = {
  readonly seq: Record<string, number>;
  readonly state: JsonObject;
};

export async function runReplayEqualsLiveGate(eventLogPath: string): Promise<ReplayGateResult> {
  const events = await readPersistedEventLog(eventLogPath);
  const result = assertReplayEqualsLive({
    events,
    initialState: emptyFoldState(),
    fold: helloBindleFold,
    seed: "s1-stage-gate",
  });

  return Object.freeze({
    seq: result.seq,
    // SAFETY: `state: result.state as JsonObject,` is required at this I/O or test boundary.
    state: result.state as JsonObject,
  });
}

export async function assertMutatedEventFails(eventLogPath: string): Promise<void> {
  const events = await readPersistedEventLog(eventLogPath);
  const liveState = runFold({
    events,
    fold: helloBindleFold,
    initialState: emptyFoldState(),
    upcast: (event) => event,
    seed: "s1-stage-gate-live",
    mode: "live",
    ambientNow: 1_900_000_000_000,
    ambientRandom: 0.111111111,
  });

  const mutated = events.map((event, index) =>
    index === 0
      ? { ...event, data: { ...event.data, orderId: "mutated" } }
      : event,
  );

  const replayState = runFold({
    events: mutated,
    fold: helloBindleFold,
    initialState: emptyFoldState(),
    upcast: (event) => event,
    seed: "s1-stage-gate-replay",
    mode: "replay",
    ambientNow: 2_000_000_000_000,
    ambientRandom: 0.999999999,
  });

  try {
    assertReplayEqualsLive({
      events,
      initialState: emptyFoldState(),
      fold: helloBindleFold,
      seed: "s1-stage-gate-positive-control",
    });
  } catch {
    throw new Error("original event log must satisfy replay == live");
  }

  if (JSON.stringify(liveState) === JSON.stringify(replayState)) {
    throw new Error("expected tampered log replay state to diverge from live snapshot");
  }

  throw new ReplayLiveMismatchError({
    liveState,
    replayState,
    liveOrder: events.map((event) => `${event.streamId}:${event.seq}`),
    replayOrder: mutated.map((event) => `${event.streamId}:${event.seq}`),
  });
}

function emptyFoldState() {
  return {
    workflows: 0,
    actors: 0,
    sagas: 0,
    compensationExercised: false,
    totalBootMs: 0,
    orderId: "",
    // SAFETY: `seq: {} as Record<string, number>,` is required at this I/O or test boundary.
    seq: {} as Record<string, number>,
  };
}

function helloBindleFold(
  state: ReturnType<typeof emptyFoldState>,
  event: { streamId: string; seq: number; type: string; data: JsonObject },
) {
  const next = { ...state, seq: { ...state.seq, [event.streamId]: event.seq } };

  if (event.type === "workflow.Completed") {
    next.workflows += 1;
    next.totalBootMs = Number(event.data.bootMs ?? next.totalBootMs);
    next.orderId = String(event.data.orderId ?? "");
  }

  if (event.type === "actor.SignalHandled") {
    next.actors += 1;
  }

  if (event.type.startsWith("saga.")) {
    next.sagas += 1;
  }

  if (event.type === "saga.Compensating" || event.type === "saga.RolledBack") {
    next.compensationExercised = true;
  }

  return next;
}

export function summarizeReplayVector(events: readonly { streamId: string; seq: number }[]) {
  return seqVector(events);
}
