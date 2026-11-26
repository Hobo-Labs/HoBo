import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export const CONTRACT_VERSION = "hobo.multi-region-dr-replay/v1";

export const RTO_TARGET_MS = 15 * 60 * 1000;
export const RPO_ASYNC_TARGET_MS = 5_000;

export {
  parseLogPath,
  parseMultiRegionTopology,
  parseReplicatedLog,
  parseRegionId,
  parseRestoreRequest,
} from "./parse.ts";

export type {
  LogPath,
  ParsedMultiRegionTopology,
  ParsedReplicatedLog,
  ParsedRestoreRequest,
  RegionId,
  StreamId,
} from "./parse.ts";

import {
  parseMultiRegionTopology,
  parseReplicatedLog,
  parseRestoreRequest,
} from "./parse.ts";

export function assessCrossRegionReplication(rawLog: JsonValue) {
  const log = parseReplicatedLog(rawLog);
  const lagMs = log.replicationLagMs;
  const seqGap = log.lastCommittedSeq - log.replicatedSeq;
  const withinRpo = lagMs <= RPO_ASYNC_TARGET_MS && seqGap === 0
    ? true
    : lagMs <= RPO_ASYNC_TARGET_MS;

  return deepFreeze({
    topology: log.topology,
    primaryRegion: log.primaryRegion,
    replicaRegion: log.replicaRegion,
    lastCommittedSeq: log.lastCommittedSeq,
    replicatedSeq: log.replicatedSeq,
    replicationLagMs: lagMs,
    rpo: {
      ms: lagMs,
      targetMs: RPO_ASYNC_TARGET_MS,
      withinTarget: withinRpo,
      claimsZeroDataLoss: lagMs === 0 && seqGap === 0,
      unreplicatedSeqRange: seqGap > 0 ? [log.replicatedSeq + 1, log.lastCommittedSeq] : [],
    },
  });
}

export function yardUpRestore(input: JsonObject = {}) {
  const request = parseRestoreRequest(input);
  const log = parseReplicatedLog(input.log ?? input.sourceLog);
  const topology = input.topology ? parseMultiRegionTopology(input.topology) : null;
  const replication = assessCrossRegionReplication(log);
  const replay = replayEventLog(log);
  const integrity = verifyProjectionIntegrity({
    before: input.preLossSnapshots ?? log.preLossSnapshots,
    after: replay.projectionSnapshots,
  });

  const startedAt = Date.parse(request.startedAt);
  const completedAt = Date.parse(request.completedAt ?? replay.completedAt);
  const rtoMs = completedAt - startedAt;

  if (rtoMs < 0) {
    throw new Error("completedAt must not be before startedAt");
  }

  const status = integrity.byteIdentical && replay.ok && replication.rpo.withinTarget
    ? "restored"
    : "failed";

  return deepFreeze({
    command: {
      argv: ["hobo", "yard", "up", "--restore", request.logPath],
      logPath: request.logPath,
    },
    status,
    contractVersion: CONTRACT_VERSION,
    topology,
    replication,
    replay,
    integrity,
    rto: {
      ms: rtoMs,
      targetMs: RTO_TARGET_MS,
      withinTarget: rtoMs < RTO_TARGET_MS,
    },
    actorsRehydrated: replay.actorsRehydrated,
    projectionsRehydrated: replay.projectionsRehydrated,
  });
}

export function replayEventLog(rawLog: JsonValue) {
  const log = parseReplicatedLog(rawLog);
  const projectionSnapshots: Record<string, string> = {};
  const actorStreams: Record<string, { lastSeq: number; head: string }> = {};
  let replayedEvents = 0;

  for (const [streamId, events] of Object.entries(log.streams)) {
    const ordered = [...events].sort((left, right) => left.seq - right.seq);

    for (const event of ordered) {
      if (!Number.isInteger(event.seq) || event.seq < 0) {
        throw new Error(`invalid seq on stream ${streamId}`);
      }
      if (!isJsonString(event.type) || event.type.length === 0) {
        throw new Error(`invalid event type on stream ${streamId}`);
      }
      replayedEvents += 1;
    }

    if (streamId.startsWith("projection:")) {
      const rebuilt = foldProjectionStream(ordered);
      projectionSnapshots[streamId] = rebuilt.snapshot;
    }

    if (streamId.startsWith("actor:")) {
      actorStreams[streamId] = foldActorStream(ordered);
    }
  }

  if (replayedEvents === 0) {
    throw new Error("replicated log contains no replayable events");
  }

  return deepFreeze({
    ok: true,
    replayedEvents,
    actorsRehydrated: Object.keys(actorStreams).length,
    projectionsRehydrated: Object.keys(projectionSnapshots).length,
    projectionSnapshots,
    actorHeads: actorStreams,
    completedAt: log.restoreCompletedAt ?? new Date().toISOString(),
  });
}

export function runRegionLossDrill(scenario: JsonObject = {}) {
  const lostRegion = requiredString(scenario.lostRegion, "lostRegion");
  const targetRegion = requiredString(scenario.targetRegion, "targetRegion");
  const topology = parseMultiRegionTopology(scenario.topology);
  const log = parseReplicatedLog(scenario.log);
  const detectedAt = validateIso(scenario.detectedAt, "detectedAt");
  const restoredAt = validateIso(
    // SAFETY: assertion to `scenario.restoredAt ?? addMilliseconds(detectedAt, (scenario.restoreDurationMs a` is required at this boundary.
    scenario.restoredAt ?? addMilliseconds(detectedAt, (scenario.restoreDurationMs as number) ?? 8 * 60 * 1000),
    "restoredAt",
  );

  if (lostRegion === targetRegion) {
    throw new Error("targetRegion must differ from lostRegion");
  }

  // SAFETY: assertion to `if (!topology.regions.includes(lostRegion as never) || !topology.regions.include` is required at this boundary.
  if (!topology.regions.includes(lostRegion as never) || !topology.regions.includes(targetRegion as never)) {
    throw new Error("drill regions must be declared in topology manifest");
  }

  const restore = yardUpRestore({
    // SAFETY: assertion to `logPath: (scenario.logPath as string) ?? /replicated/${targetRegion}/yard-event` is required at this boundary.
    logPath: (scenario.logPath as string) ?? `/replicated/${targetRegion}/yard-event-log`,
    log,
    topology: scenario.topology,
    preLossSnapshots: scenario.preLossSnapshots ?? log.preLossSnapshots,
    startedAt: detectedAt,
    completedAt: restoredAt,
  });

  const _rtoMs = Date.parse(restoredAt) - Date.parse(detectedAt);
  void _rtoMs;
  const passed = restore.status === "restored"
    && restore.rto.withinTarget
    && restore.replication.rpo.withinTarget
    && restore.integrity.byteIdentical;

  return deepFreeze({
    status: passed ? "passed" : "failed",
    lostRegion,
    targetRegion,
    restore,
    rto: restore.rto,
    rpo: restore.replication.rpo,
    integrity: restore.integrity,
    functional: restore.replay.ok && restore.actorsRehydrated > 0 && restore.projectionsRehydrated > 0,
  });
}

export function verifyProjectionIntegrity({ before, after }: { before?: JsonValue; after?: unknown } = {}) {
  const beforeSnapshots = requiredObject(before ?? {}, "before");
  const afterSnapshots = requiredObject(after ?? {}, "after");
  const mismatches: Array<Record<string, string>> = [];

  for (const [streamId, expectedHash] of Object.entries(beforeSnapshots)) {
    const actualHash = afterSnapshots[streamId];
    if (!isJsonString(actualHash)) {
      mismatches.push({ streamId, reason: "missing-after-snapshot" });
      continue;
    }
    if (actualHash !== expectedHash) {
      mismatches.push({ streamId, reason: "hash-mismatch", expected: expectedHash, actual: actualHash });
    }
  }

  for (const streamId of Object.keys(afterSnapshots)) {
    if (!(streamId in beforeSnapshots)) {
      mismatches.push({ streamId, reason: "unexpected-after-snapshot" });
    }
  }

  return deepFreeze({
    byteIdentical: mismatches.length === 0,
    comparedStreams: Object.keys(beforeSnapshots).length,
    mismatches,
  });
}

function foldProjectionStream(events: Array<{ seq: number; type: string; payload?: unknown }>) {
  const payload = events.map((event) => `${event.seq}:${event.type}:${stablePayload(event.payload)}`).join("|");
  return {
    lastSeq: events.at(-1)?.seq ?? 0,
    snapshot: hashText(payload),
  };
}

function foldActorStream(events: Array<{ seq: number; type: string; payload?: { state?: string } }>) {
  return {
    lastSeq: events.at(-1)?.seq ?? 0,
    head: events.at(-1)?.payload?.state ?? "rehydrated",
  };
}

function stablePayload(payload: JsonValue) {
  if (payload === undefined || payload === null) {
    return "";
  }
  if (isJsonString(payload)) {
    return payload;
  }
  return JSON.stringify(payload);
}

function hashText(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function requiredObject(value: JsonValue, fieldName: string): Record<string, string> {
  if (!value || !isJsonObject(value)) {
    throw new Error(`${fieldName} is required`);
  }
  // SAFETY: assertion to `return value as Record<string, string>;` is required at this boundary.
  return value as Record<string, string>;
}

function requiredString(value: JsonValue, fieldName: string): string {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function validateIso(value: JsonValue, fieldName: string): string {
  const text = requiredString(value, fieldName);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`${fieldName} must be ISO-8601`);
  }
  return text;
}

function addMilliseconds(iso: string, milliseconds: number) {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

function deepFreeze<T>(value: T): T {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  // SAFETY: assertion to `for (const child of Object.values(value as JsonObject)) {` is required at this boundary.
  for (const child of Object.values(value as JsonObject)) {
    deepFreeze(child);
  }
  return value;
}
