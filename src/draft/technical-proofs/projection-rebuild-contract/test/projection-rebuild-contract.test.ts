import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CutoverNotReadyError,
  MIGRATION_CUTOVER_EVENT_TYPE,
  MIGRATION_PHASE_APPLIED_EVENT_TYPE,
  NonDeterministicReplayRejectedError,
  createInMemoryProjectionCheckpointStore,
  cutOverProjectionSink,
  positionFromEvents,
  rebuildProjectionSink,
} from "../src/projection-rebuild-contract.js";

const ticketProjectionV2 = {
  name: "ticket-read-model",
  schemaVersion: "ticket.v2",
  initialState() {
    return {
      commentCount: 0,
      status: "missing",
      title: null,
    };
  },
  key(event) {
    return event.data.ticketId;
  },
  on: {
    "ticket.Opened": (state, event) => ({
      ...state,
      id: event.data.ticketId,
      status: "open",
      title: event.data.title,
    }),
    "ticket.Commented": (state, event) => ({
      ...state,
      commentCount: state.commentCount + 1,
      id: event.data.ticketId,
      lastComment: event.data.body,
    }),
    "ticket.Closed": (state) => ({
      ...state,
      status: "closed",
    }),
  },
  toRow(state, key) {
    return {
      id: key,
      schemaVersion: "ticket.v2",
      status: state.status,
      title: state.title,
      commentCount: state.commentCount,
      lastComment: state.lastComment ?? null,
    };
  },
};

const vectorProjection = {
  name: "ticket-vector-index",
  schemaVersion: "ticket-vector.v2",
  determinism: "nondeterministic",
  key(output) {
    return output.data.ticketId;
  },
  fromRecordedOutput(output) {
    return {
      id: output.data.ticketId,
      embeddingDigest: output.data.embeddingDigest,
      textDigest: output.data.textDigest,
    };
  },
};

function ticketEvent(seq, type, data = {}) {
  return {
    streamId: `ticket/${data.ticketId ?? "T-1"}`,
    seq,
    type,
    data: {
      ticketId: "T-1",
      ...data,
    },
  };
}

function largeTicketFixture() {
  const events = [
    ticketEvent(1, "ticket.Opened", { title: "router down" }),
  ];

  for (let seq = 2; seq <= 251; seq += 1) {
    events.push(ticketEvent(seq, "ticket.Commented", { body: `update-${seq}` }));
  }

  events.push(ticketEvent(252, "ticket.Closed"));
  return events;
}

test("large derived projection rebuilds from zero into the new read-model shape", () => {
  const result = rebuildProjectionSink({
    projection: ticketProjectionV2,
    events: largeTicketFixture(),
    targetSinkId: "ticket-read-model-v2-green",
    shardCount: 8,
  });

  assert.equal(result.status, "complete");
  assert.equal(result.strategy, "rebuild-from-zero");
  assert.equal(result.metrics.processedEventCount, 252);
  assert.equal(result.metrics.shardCount, 8);
  assert.deepEqual(result.rows, [
    {
      id: "T-1",
      schemaVersion: "ticket.v2",
      status: "closed",
      title: "router down",
      commentCount: 250,
      lastComment: "update-251",
    },
  ]);
  assert.deepEqual(result.auditEvents, [
    {
      type: MIGRATION_PHASE_APPLIED_EVENT_TYPE,
      streamId: "migration/projection/ticket-read-model/ticket-read-model-v2-green",
      data: {
        backfillKind: "deterministic-replay",
        checkpointed: true,
        phase: "backfill",
        projection: "ticket-read-model",
        targetSinkId: "ticket-read-model-v2-green",
        schemaVersion: "ticket.v2",
        strategy: "rebuild-from-zero",
      },
    },
  ]);
});

test("interrupted shard rebuild resumes from checkpoint without restart or double apply", () => {
  const events = [
    ticketEvent(1, "ticket.Opened", { title: "router down" }),
    ticketEvent(2, "ticket.Commented", { body: "first" }),
    ticketEvent(3, "ticket.Commented", { body: "second" }),
  ];
  const checkpointStore = createInMemoryProjectionCheckpointStore();

  const interrupted = rebuildProjectionSink({
    projection: ticketProjectionV2,
    events,
    targetSinkId: "ticket-read-model-v2-green",
    shardCount: 2,
    checkpointStore,
    crashAfterEvents: 2,
  });
  const resumed = rebuildProjectionSink({
    projection: ticketProjectionV2,
    events,
    targetSinkId: "ticket-read-model-v2-green",
    shardCount: 2,
    checkpointStore,
  });

  assert.equal(interrupted.status, "interrupted");
  assert.deepEqual(interrupted.checkpoint.position, { "ticket/T-1": 2 });
  assert.equal(resumed.status, "complete");
  assert.deepEqual(resumed.metrics.skippedAlreadyApplied, ["ticket/T-1#1", "ticket/T-1#2"]);
  assert.deepEqual(resumed.rows, [
    {
      id: "T-1",
      schemaVersion: "ticket.v2",
      status: "open",
      title: "router down",
      commentCount: 2,
      lastComment: "second",
    },
  ]);
});

test("snapshot-seeded rebuild folds only the tail after the snapshot position", () => {
  const snapshot = {
    seed: "snapshot.SnapshotTaken",
    position: { "ticket/T-1": 2 },
    stateByKey: {
      "T-1": {
        id: "T-1",
        status: "open",
        title: "router down",
        commentCount: 1,
        lastComment: "first",
      },
    },
  };
  const events = [
    ticketEvent(1, "ticket.Opened", { title: "router down" }),
    ticketEvent(2, "ticket.Commented", { body: "first" }),
    ticketEvent(3, "ticket.Commented", { body: "second" }),
    ticketEvent(4, "ticket.Commented", { body: "third" }),
  ];

  const result = rebuildProjectionSink({
    projection: ticketProjectionV2,
    events,
    targetSinkId: "ticket-read-model-v2-green",
    snapshot,
  });

  assert.equal(result.seed, "snapshot");
  assert.deepEqual(result.metrics.appliedEventIds, ["ticket/T-1#3", "ticket/T-1#4"]);
  assert.deepEqual(result.rows[0], {
    id: "T-1",
    schemaVersion: "ticket.v2",
    status: "open",
    title: "router down",
    commentCount: 3,
    lastComment: "third",
  });
});

test("shard-parallel rebuild must catch up to live before blue-green cutover", () => {
  const backlog = [
    ticketEvent(1, "ticket.Opened", { title: "router down" }),
    ticketEvent(2, "ticket.Commented", { body: "first" }),
    ticketEvent(1, "ticket.Opened", { ticketId: "T-2", title: "billing stale" }),
  ];
  const liveTail = [
    ticketEvent(2, "ticket.Commented", { ticketId: "T-2", body: "live update" }),
  ];

  const behind = rebuildProjectionSink({
    projection: ticketProjectionV2,
    events: backlog,
    targetSinkId: "ticket-read-model-v2-green",
    shardCount: 4,
    livePosition: positionFromEvents([...backlog, ...liveTail]),
  });

  assert.throws(
    () =>
      cutOverProjectionSink({
        oldSinkId: "ticket-read-model-v1-blue",
        rebuiltSink: behind,
        livePosition: positionFromEvents([...backlog, ...liveTail]),
      }),
    CutoverNotReadyError,
  );
  assert.throws(
    () =>
      cutOverProjectionSink({
        oldSinkId: "ticket-read-model-v1-blue",
        rebuiltSink: behind,
      }),
    CutoverNotReadyError,
  );

  const caughtUp = rebuildProjectionSink({
    projection: ticketProjectionV2,
    events: [...backlog, ...liveTail],
    targetSinkId: "ticket-read-model-v2-green",
    shardCount: 4,
    livePosition: positionFromEvents([...backlog, ...liveTail]),
  });
  const cutover = cutOverProjectionSink({
    oldSinkId: "ticket-read-model-v1-blue",
    rebuiltSink: caughtUp,
    livePosition: positionFromEvents([...backlog, ...liveTail]),
  });

  assert.equal(caughtUp.caughtUpToLive, true);
  assert.equal(caughtUp.metrics.shardPlan.filter((shard) => shard.eventIds.length > 0).length > 1, true);
  assert.equal(cutover.events[0].type, MIGRATION_CUTOVER_EVENT_TYPE);
  assert.deepEqual(cutover.events[0].data, {
    cutover: "blue-green",
    fromSinkId: "ticket-read-model-v1-blue",
    projection: "ticket-read-model",
    toSinkId: "ticket-read-model-v2-green",
    verifiedPosition: { "ticket/T-1": 2, "ticket/T-2": 2 },
  });
});

test("nondeterministic vector sinks reject deterministic replay and use recorded-output backfill", () => {
  const events = [
    ticketEvent(1, "ticket.Opened", { title: "router down" }),
  ];
  const recordedOutputs = [
    {
      streamId: "ticket/T-1",
      seq: 1,
      type: "embed.OutputRecorded",
      data: {
        ticketId: "T-1",
        embeddingDigest: "sha256:embed-v2",
        textDigest: "sha256:ticket-opened",
      },
    },
  ];

  assert.throws(
    () =>
      rebuildProjectionSink({
        projection: vectorProjection,
        events,
        targetSinkId: "ticket-vector-v2-green",
      }),
    NonDeterministicReplayRejectedError,
  );

  const result = rebuildProjectionSink({
    projection: vectorProjection,
    events,
    targetSinkId: "ticket-vector-v2-green",
    mode: "recorded-output",
    recordedOutputs,
  });

  assert.deepEqual(result.rows, [
    {
      embeddingDigest: "sha256:embed-v2",
      id: "T-1",
      textDigest: "sha256:ticket-opened",
    },
  ]);
  assert.equal(result.auditEvents[0].data.backfillKind, "recorded-output");
  assert.equal(result.auditEvents[0].data.strategy, "recorded-output-backfill");
});
