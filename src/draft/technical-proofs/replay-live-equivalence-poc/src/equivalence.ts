import assert from "node:assert/strict";
import crypto from "node:crypto";
import { isJsonObject } from "./json.js";

export class ReplayLiveMismatchError extends Error {
  constructor({ liveState, replayState, liveOrder, replayOrder }) {
    super("replay/live materialization mismatch");
    this.name = "ReplayLiveMismatchError";
    this.liveState = liveState;
    this.replayState = replayState;
    this.liveOrder = liveOrder;
    this.replayOrder = replayOrder;
  }
}

export function assertReplayEqualsLive({
  events,
  fold,
  initialState,
  upcast = (event) => event,
  targetSeq = seqVector(events),
  seed = "hobo-replay-live",
  normalize = stableValue,
}) {
  const eventSlice = events.filter((event) => isAtOrBefore(event, targetSeq));
  const replayEvents = [...eventSlice].sort(compareCanonicalEventOrder);

  const liveState = runFold({
    events: eventSlice,
    fold,
    initialState,
    upcast,
    seed,
    mode: "live",
    ambientNow: 1_900_000_000_000,
    ambientRandom: 0.111111111,
  });

  const replayState = runFold({
    events: replayEvents,
    fold,
    initialState,
    upcast,
    seed,
    mode: "replay",
    ambientNow: 2_000_000_000_000,
    ambientRandom: 0.999999999,
  });

  const normalizedLive = normalize(liveState);
  const normalizedReplay = normalize(replayState);

  try {
    assert.deepEqual(normalizedLive, normalizedReplay);
  } catch {
    throw new ReplayLiveMismatchError({
      liveState: normalizedLive,
      replayState: normalizedReplay,
      liveOrder: eventSlice.map(eventKey),
      replayOrder: replayEvents.map(eventKey),
    });
  }

  return {
    state: normalizedReplay,
    seq: targetSeq,
    readSetHash: hashReadSet(events),
  };
}

export function runFold({ events, fold, initialState, upcast, seed, mode, ambientNow, ambientRandom }) {
  return withAmbientNondeterminism({ now: ambientNow, random: ambientRandom }, () => {
    let state = clone(initialState);

    for (const event of events) {
      const context = materializationContext({ event, seed, mode });
      const lifted = upcast(clone(event), context);
      state = fold(state, lifted, context);
    }

    return state;
  });
}

export function materializationContext({ event, seed, mode }) {
  return Object.freeze({
    seed,
    mode,
    eventKey: eventKey(event),
    now: () =>
      new Date(
        seededInt(`${seed}:${eventKey(event)}:clock`, 1_700_000_000_000, 1_899_999_999_999),
      ).toISOString(),
    random: (label = "default") => seededUnit(`${seed}:${eventKey(event)}:random:${label}`),
  });
}

export function seqVector(events) {
  return stableObject(
    events.reduce((position, event) => {
      position[event.streamId] = Math.max(position[event.streamId] ?? 0, event.seq);
      return position;
    }, {}),
  );
}

export function hashReadSet(events) {
  const streams = [...new Set(events.map((event) => event.streamId))].sort();
  return crypto.createHash("sha256").update(JSON.stringify(streams)).digest("hex");
}

export function interleaveStreams(streams, seed) {
  const queues = new Map(
    Object.entries(streams).map(([streamId, events]) => [
      streamId,
      [...events].sort((left, right) => left.seq - right.seq),
    ]),
  );
  const interleaved = [];

  while ([...queues.values()].some((events) => events.length > 0)) {
    const availableStreams = [...queues.entries()]
      .filter(([, events]) => events.length > 0)
      .map(([streamId]) => streamId)
      .sort();
    const index = Math.floor(seededUnit(`${seed}:${interleaved.length}`) * availableStreams.length);
    interleaved.push(queues.get(availableStreams[index]).shift());
  }

  return interleaved;
}

export function compareCanonicalEventOrder(left, right) {
  return (
    left.streamId.localeCompare(right.streamId) ||
    left.seq - right.seq ||
    String(left.type).localeCompare(String(right.type)) ||
    String(left.id).localeCompare(String(right.id))
  );
}

export function stableValue(value) {
  if (value instanceof Map) {
    return [...value.entries()]
      .map(([key, entry]) => [stableValue(key), stableValue(entry)])
      .sort(([left], [right]) => stableStringify(left).localeCompare(stableStringify(right)));
  }

  if (value instanceof Set) {
    return [...value]
      .map(stableValue)
      .sort((left, right) => stableStringify(left).localeCompare(stableStringify(right)));
  }

  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (value && isJsonObject(value)) {
    return stableObject(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, stableValue(entry)])));
  }

  return value;
}

export function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function isAtOrBefore(event, targetSeq) {
  return event.seq <= (targetSeq[event.streamId] ?? 0);
}

function eventKey(event) {
  return `${event.streamId}:${event.seq}:${event.id ?? event.type}`;
}

function seededUnit(input) {
  const hex = crypto.createHash("sha256").update(input).digest("hex").slice(0, 12);
  return Number.parseInt(hex, 16) / 0xffffffffffff;
}

function seededInt(input, min, max) {
  return Math.floor(seededUnit(input) * (max - min + 1)) + min;
}

function stableObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function clone(value) {
  if (structuredClone instanceof Function) {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

function withAmbientNondeterminism({ now, random }, callback) {
  const originalDateNow = Date.now;
  const originalMathRandom = Math.random;

  Date.now = () => now;
  Math.random = () => random;

  try {
    return callback();
  } finally {
    Date.now = originalDateNow;
    Math.random = originalMathRandom;
  }
}
