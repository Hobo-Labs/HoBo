import { isJsonObject } from "./json.js";
export const MIGRATION_PHASE_APPLIED_EVENT_TYPE = "migration.PhaseApplied";
export const MIGRATION_CUTOVER_EVENT_TYPE = "migration.CutOver";
export const PROJECTION_SINK_REBOUND_EVENT_TYPE = "projection.SinkRebound";

const DETERMINISTIC_REPLAY_MODE = "deterministic-replay";
const RECORDED_OUTPUT_MODE = "recorded-output";

export class NonDeterministicReplayRejectedError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "NonDeterministicReplayRejectedError";
    this.details = details;
  }
}

export class CutoverNotReadyError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "CutoverNotReadyError";
    this.details = details;
  }
}

export function createInMemoryProjectionCheckpointStore(initialCheckpoint = null) {
  let checkpoint = initialCheckpoint ? clonePlain(initialCheckpoint) : null;

  return {
    read() {
      return checkpoint ? clonePlain(checkpoint) : null;
    },
    write(nextCheckpoint) {
      checkpoint = clonePlain(nextCheckpoint);
      return this.read();
    },
    clear() {
      checkpoint = null;
    },
  };
}

export function rebuildProjectionSink({
  projection,
  events = [],
  targetSinkId,
  shardCount = 1,
  snapshot = null,
  checkpointStore = null,
  crashAfterEvents = null,
  livePosition = null,
  mode = DETERMINISTIC_REPLAY_MODE,
  recordedOutputs = [],
} = {}) {
  assertProjection(projection);
  assertTargetSink(targetSinkId);
  assertShardCount(shardCount);

  if (projection.determinism === "nondeterministic") {
    if (mode !== RECORDED_OUTPUT_MODE) {
      throw new NonDeterministicReplayRejectedError(
        "nondeterministic projection sinks must rebuild from recorded outputs",
        {
          mode,
          projection: projection.name,
          targetSinkId,
        },
      );
    }

    return rebuildFromRecordedOutputs({
      projection,
      recordedOutputs,
      targetSinkId,
      livePosition,
    });
  }

  if (mode === RECORDED_OUTPUT_MODE) {
    throw new TypeError("recorded-output mode is only valid for nondeterministic projections");
  }

  return rebuildDeterministicProjection({
    projection,
    events,
    targetSinkId,
    shardCount,
    snapshot,
    checkpointStore,
    crashAfterEvents,
    livePosition,
  });
}

export function cutOverProjectionSink({ oldSinkId, rebuiltSink, livePosition }) {
  if (!rebuiltSink || !isJsonObject(rebuiltSink)) {
    throw new TypeError("rebuiltSink is required");
  }

  const verifiedPosition = sortRecord(rebuiltSink.position ?? {});
  if (!livePosition) {
    throw new CutoverNotReadyError("live position evidence is required before cutover", {
      projection: rebuiltSink.projection,
      rebuiltPosition: verifiedPosition,
      targetSinkId: rebuiltSink.targetSinkId,
    });
  }

  const requiredPosition = sortRecord(livePosition);
  if (!isCaughtUp(verifiedPosition, requiredPosition)) {
    throw new CutoverNotReadyError("rebuilt projection sink is not caught up to live", {
      livePosition: requiredPosition,
      projection: rebuiltSink.projection,
      rebuiltPosition: verifiedPosition,
      targetSinkId: rebuiltSink.targetSinkId,
    });
  }

  return {
    status: "cut-over",
    events: [
      {
        type: MIGRATION_CUTOVER_EVENT_TYPE,
        streamId: `migration/projection/${rebuiltSink.projection}/${rebuiltSink.targetSinkId}`,
        data: {
          cutover: "blue-green",
          fromSinkId: oldSinkId,
          projection: rebuiltSink.projection,
          toSinkId: rebuiltSink.targetSinkId,
          verifiedPosition,
        },
      },
      {
        type: PROJECTION_SINK_REBOUND_EVENT_TYPE,
        streamId: `projection/${rebuiltSink.projection}/sink`,
        data: {
          fromSinkId: oldSinkId,
          projection: rebuiltSink.projection,
          toSinkId: rebuiltSink.targetSinkId,
          reason: "migration-cutover",
        },
      },
    ],
  };
}

export function positionFromEvents(events) {
  const position = {};

  for (const event of normalizeEvents(events)) {
    position[event.streamId] = Math.max(position[event.streamId] ?? 0, event.seq);
  }

  return sortRecord(position);
}

function rebuildDeterministicProjection({
  projection,
  events,
  targetSinkId,
  shardCount,
  snapshot,
  checkpointStore,
  crashAfterEvents,
  livePosition,
}) {
  const checkpoint = checkpointStore?.read() ?? null;
  const seed = checkpoint ? "checkpoint" : snapshot ? "snapshot" : "zero";
  const stateByKey = mapFromRecord(checkpoint?.stateByKey ?? snapshot?.stateByKey ?? {});
  const position = sortRecord(checkpoint?.position ?? snapshot?.position ?? {});
  const metrics = {
    appliedEventIds: [],
    processedEventCount: 0,
    shardCount,
    shardPlan: Array.from({ length: shardCount }, (_, shardId) => ({
      shardId,
      eventIds: [],
    })),
    skippedAlreadyApplied: [],
  };

  const sharded = normalizeEvents(events).map((event) => ({
    event,
    shardId: shardForStream(event.streamId, shardCount),
  }));

  for (const { event, shardId } of sharded) {
    metrics.shardPlan[shardId].eventIds.push(eventId(event));
  }

  for (let shardId = 0; shardId < shardCount; shardId += 1) {
    const shardEvents = sharded
      .filter((entry) => entry.shardId === shardId)
      .map((entry) => entry.event);

    for (const event of shardEvents) {
      if (!isAfterPosition(event, position)) {
        metrics.skippedAlreadyApplied.push(eventId(event));
        continue;
      }

      applyProjectionEvent({ projection, stateByKey, event });
      position[event.streamId] = Math.max(position[event.streamId] ?? 0, event.seq);
      metrics.appliedEventIds.push(eventId(event));
      metrics.processedEventCount += 1;

      const checkpointSnapshot = createCheckpoint({
        projection,
        targetSinkId,
        stateByKey,
        position,
        seed,
      });
      checkpointStore?.write(checkpointSnapshot);

      if (crashAfterEvents !== null && metrics.processedEventCount >= crashAfterEvents) {
        return createRebuildResult({
          status: "interrupted",
          projection,
          targetSinkId,
          stateByKey,
          position,
          metrics,
          seed,
          livePosition,
          includeAuditEvent: false,
        });
      }
    }
  }

  const result = createRebuildResult({
    status: "complete",
    projection,
    targetSinkId,
    stateByKey,
    position,
    metrics,
    seed,
    livePosition,
    includeAuditEvent: true,
  });
  checkpointStore?.write(result.checkpoint);
  return result;
}

function rebuildFromRecordedOutputs({ projection, recordedOutputs, targetSinkId, livePosition }) {
  if (!(projection.fromRecordedOutput instanceof Function)) {
    throw new TypeError("nondeterministic projections require fromRecordedOutput(output)");
  }

  const rowsByKey = new Map();
  const outputs = normalizeEvents(recordedOutputs);
  for (const output of outputs) {
    rowsByKey.set(String(projection.key(output)), projection.fromRecordedOutput(output));
  }

  const position = positionFromEvents(outputs);
  return {
    auditEvents: [
      phaseAppliedEvent({
        backfillKind: RECORDED_OUTPUT_MODE,
        projection,
        targetSinkId,
        strategy: "recorded-output-backfill",
      }),
    ],
    caughtUpToLive: livePosition ? isCaughtUp(position, livePosition) : false,
    checkpoint: {
      position,
      projection: projection.name,
      stateByKey: Object.fromEntries([...rowsByKey.entries()].map(([key, row]) => [key, clonePlain(row)])),
      targetSinkId,
    },
    metrics: {
      appliedEventIds: outputs.map(eventId),
      processedEventCount: outputs.length,
      shardCount: 1,
      shardPlan: [
        {
          shardId: 0,
          eventIds: outputs.map(eventId),
        },
      ],
      skippedAlreadyApplied: [],
    },
    mode: RECORDED_OUTPUT_MODE,
    position,
    projection: projection.name,
    rows: [...rowsByKey.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([, row]) => clonePlain(row)),
    seed: "recorded-output",
    status: "complete",
    strategy: "recorded-output-backfill",
    targetSinkId,
  };
}

function applyProjectionEvent({ projection, stateByKey, event }) {
  const handler = projection.on?.[event.type];
  if (!handler) {
    return;
  }

  const key = String(projection.key(event));
  const current = stateByKey.has(key) ? stateByKey.get(key) : projection.initialState?.(key) ?? {};
  stateByKey.set(key, handler(clonePlain(current), event));
}

function createRebuildResult({
  status,
  projection,
  targetSinkId,
  stateByKey,
  position,
  metrics,
  seed,
  livePosition,
  includeAuditEvent,
}) {
  const sortedPosition = sortRecord(position);
  const checkpoint = createCheckpoint({
    projection,
    targetSinkId,
    stateByKey,
    position: sortedPosition,
    seed,
  });

  return {
    auditEvents: includeAuditEvent
      ? [
          phaseAppliedEvent({
            backfillKind: DETERMINISTIC_REPLAY_MODE,
            projection,
            targetSinkId,
            strategy: "rebuild-from-zero",
          }),
        ]
      : [],
    caughtUpToLive: livePosition ? isCaughtUp(sortedPosition, livePosition) : false,
    checkpoint,
    metrics: clonePlain(metrics),
    position: sortedPosition,
    projection: projection.name,
    rows: rowsFromState(projection, stateByKey),
    seed,
    status,
    strategy: "rebuild-from-zero",
    targetSinkId,
  };
}

function createCheckpoint({ projection, targetSinkId, stateByKey, position, seed }) {
  return {
    position: sortRecord(position),
    projection: projection.name,
    seed,
    stateByKey: recordFromMap(stateByKey),
    targetSinkId,
  };
}

function phaseAppliedEvent({ backfillKind, projection, targetSinkId, strategy }) {
  return {
    type: MIGRATION_PHASE_APPLIED_EVENT_TYPE,
    streamId: `migration/projection/${projection.name}/${targetSinkId}`,
    data: {
      backfillKind,
      checkpointed: true,
      phase: "backfill",
      projection: projection.name,
      targetSinkId,
      schemaVersion: projection.schemaVersion,
      strategy,
    },
  };
}

function rowsFromState(projection, stateByKey) {
  return [...stateByKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, state]) => {
      const row = projection.toRow ? projection.toRow(clonePlain(state), key) : state;
      return clonePlain(row);
    });
}

function isCaughtUp(rebuiltPosition, livePosition) {
  return Object.entries(livePosition).every(
    ([streamId, seq]) => (rebuiltPosition[streamId] ?? 0) >= seq,
  );
}

function isAfterPosition(event, position) {
  return event.seq > (position[event.streamId] ?? 0);
}

function normalizeEvents(events) {
  return [...events]
    .map((event) => {
      if (!event?.streamId || !Number.isInteger(event.seq)) {
        throw new TypeError("events must include streamId and integer seq");
      }

      return event;
    })
    .sort(compareEvents);
}

function compareEvents(left, right) {
  return left.streamId.localeCompare(right.streamId) || left.seq - right.seq;
}

function eventId(event) {
  return `${event.streamId}#${event.seq}`;
}

function shardForStream(streamId, shardCount) {
  let hash = 2166136261;
  for (let index = 0; index < streamId.length; index += 1) {
    hash ^= streamId.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) % shardCount;
}

function mapFromRecord(record) {
  return new Map(Object.entries(record).map(([key, value]) => [key, clonePlain(value)]));
}

function recordFromMap(map) {
  return Object.fromEntries([...map.entries()].map(([key, value]) => [key, clonePlain(value)]));
}

function sortRecord(record) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function clonePlain(value) {
  return value == null ? value : structuredClone(value);
}

function assertProjection(projection) {
  if (!projection?.name) {
    throw new TypeError("projection.name is required");
  }

  if (projection.determinism !== "nondeterministic" && !(projection.key instanceof Function)) {
    throw new TypeError("deterministic projections require key(event)");
  }
}

function assertTargetSink(targetSinkId) {
  if (!targetSinkId) {
    throw new TypeError("targetSinkId is required");
  }
}

function assertShardCount(shardCount) {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new TypeError("shardCount must be a positive integer");
  }
}
