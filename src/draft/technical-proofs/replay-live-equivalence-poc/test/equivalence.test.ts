import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  ReplayLiveMismatchError,
  assertReplayEqualsLive,
  hashReadSet,
  interleaveStreams,
  seqVector,
} from "../src/equivalence.js";

describe("replay/live equivalence proof harness", () => {
  it("proves deterministic folds across fuzzed stream interleavings", () => {
    for (let seed = 1; seed <= 64; seed += 1) {
      const events = interleaveStreams(makeStreams(seed), `interleave-${seed}`);
      const result = assertReplayEqualsLive({
        events,
        initialState: emptyLedger(),
        fold: deterministicLedgerFold,
        seed: `case-${seed}`,
      });

      assert.equal(result.state.totalCents > 0, true);
      assert.deepEqual(result.seq, seqVector(events));
      assert.equal(result.readSetHash, hashReadSet(events));
    }
  });

  it("catches folds that read the ambient wall clock", () => {
    const events = interleaveStreams(makeStreams(1), "wall-clock");

    assert.throws(
      () =>
        assertReplayEqualsLive({
          events,
          initialState: { lastWallClock: 0 },
          fold: (state) => ({ ...state, lastWallClock: Date.now() }),
        }),
      ReplayLiveMismatchError,
    );
  });

  it("catches arrival-order dependencies instead of seq/vector-position dependencies", () => {
    const events = [
      event("ticket-b", 1, "ticket.delta", { cents: 20 }),
      event("ticket-a", 1, "ticket.delta", { cents: 10 }),
      event("ticket-c", 1, "ticket.delta", { cents: 30 }),
    ];

    assert.throws(
      () =>
        assertReplayEqualsLive({
          events,
          initialState: { seen: [] },
          fold: (state, currentEvent) => ({
            seen: [...state.seen, `${currentEvent.streamId}:${currentEvent.seq}`],
          }),
        }),
      ReplayLiveMismatchError,
    );
  });

  it("catches Map/Set insertion-order dependence", () => {
    const events = [
      event("ticket-b", 1, "ticket.delta", { cents: 20 }),
      event("ticket-a", 1, "ticket.delta", { cents: 10 }),
      event("ticket-c", 1, "ticket.delta", { cents: 30 }),
    ];

    assert.throws(
      () =>
        assertReplayEqualsLive({
          events,
          initialState: { byStream: new Map(), seenStreams: new Set(), signature: "" },
          fold: (state, currentEvent) => {
            const byStream = new Map(state.byStream);
            const seenStreams = new Set(state.seenStreams);

            byStream.set(currentEvent.streamId, currentEvent.data.cents);
            seenStreams.add(currentEvent.streamId);

            return {
              byStream,
              seenStreams,
              signature: `${[...byStream.keys()].join(">")}|${[...seenStreams].join(">")}`,
            };
          },
        }),
      ReplayLiveMismatchError,
    );
  });

  it("catches floating-point accumulation order drift", () => {
    const events = [
      event("a", 1, "metric.delta", { amount: 10_000_000_000_000_000 }),
      event("c", 1, "metric.delta", { amount: 1 }),
      event("b", 1, "metric.delta", { amount: -10_000_000_000_000_000 }),
    ];

    assert.throws(
      () =>
        assertReplayEqualsLive({
          events,
          initialState: { total: 0 },
          fold: (state, currentEvent) => ({
            total: state.total + currentEvent.data.amount,
          }),
        }),
      ReplayLiveMismatchError,
    );
  });

  it("applies upcasters identically before live and replay folds", () => {
    const events = [
      event("ticket", 1, "ticket.delta", { cents: "40" }, 1),
      event("ticket", 2, "ticket.delta", { cents: "2" }, 1),
    ];

    const result = assertReplayEqualsLive({
      events,
      initialState: emptyLedger(),
      fold: deterministicLedgerFold,
      upcast: (currentEvent) => ({
        ...currentEvent,
        v: 2,
        data: { cents: Number.parseInt(currentEvent.data.cents, 10) },
      }),
    });

    assert.equal(result.state.totalCents, 42);
  });

  it("catches impure upcasters before they enter Reactor tests", () => {
    const events = [event("ticket", 1, "ticket.delta", { cents: 1 }, 1)];

    assert.throws(
      () =>
        assertReplayEqualsLive({
          events,
          initialState: emptyLedger(),
          fold: deterministicLedgerFold,
          upcast: (currentEvent) => ({
            ...currentEvent,
            data: { cents: Math.random() },
          }),
        }),
      ReplayLiveMismatchError,
    );
  });
});

function deterministicLedgerFold(state, currentEvent, context) {
  const nextByStream = {
    ...state.byStream,
    [currentEvent.streamId]: (state.byStream[currentEvent.streamId] ?? 0) + currentEvent.data.cents,
  };
  const nextSeq = {
    ...state.seq,
    [currentEvent.streamId]: Math.max(state.seq[currentEvent.streamId] ?? 0, currentEvent.seq),
  };

  return {
    byStream: sortObject(nextByStream),
    seq: sortObject(nextSeq),
    seededClockByEvent: sortObject({
      ...state.seededClockByEvent,
      [`${currentEvent.streamId}:${currentEvent.seq}`]: context.now(),
    }),
    totalCents: Object.values(nextByStream).reduce((sum, cents) => sum + cents, 0),
  };
}

function makeStreams(seed) {
  return {
    "ticket-a": [
      event("ticket-a", 1, "ticket.delta", { cents: 100 + seed }),
      event("ticket-a", 2, "ticket.delta", { cents: 30 }),
      event("ticket-a", 3, "ticket.delta", { cents: 7 }),
    ],
    "ticket-b": [
      event("ticket-b", 1, "ticket.delta", { cents: 50 }),
      event("ticket-b", 2, "ticket.delta", { cents: seed }),
    ],
    "ticket-c": [
      event("ticket-c", 1, "ticket.delta", { cents: 3 }),
      event("ticket-c", 2, "ticket.delta", { cents: 4 }),
    ],
  };
}

function event(streamId, seq, type, data, version = 1) {
  return {
    id: `${streamId}-${seq}`,
    streamId,
    seq,
    type,
    v: version,
    data,
  };
}

function emptyLedger() {
  return {
    byStream: {},
    seq: {},
    seededClockByEvent: {},
    totalCents: 0,
  };
}

function sortObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}
