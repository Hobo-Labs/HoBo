import { isJsonString, isJsonNumber, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export type RegionId = string & { readonly __brand: "RegionId" };
export type LogPath = string & { readonly __brand: "LogPath" };
export type StreamId = string & { readonly __brand: "StreamId" };

export type ParsedMultiRegionTopology = {
  contractVersion: string;
  regions: RegionId[];
  authoritativeLog: {
    mode: "active-passive-log" | "sync-quorum";
    primaryRegion: RegionId;
    passiveRegions: RegionId[];
    replication: string;
  };
  statelessTier: {
    mode: "active-active";
    roles: Array<"gateway" | "planner" | "executor">;
    horizontallyScaled: true;
  };
};

export type ParsedReplicatedLog = {
  topology: string;
  primaryRegion: RegionId;
  replicaRegion: RegionId;
  lastCommittedSeq: number;
  replicatedSeq: number;
  replicationLagMs: number;
  snapshotSeq: number;
  streams: Record<StreamId, Array<{ seq: number; type: string; payload?: unknown }>>;
  preLossSnapshots: Record<string, string> | null;
  restoreCompletedAt: string | null;
};

export type ParsedRestoreRequest = {
  logPath: LogPath;
  startedAt: string;
  completedAt: string | null;
};

const AUTHORITATIVE_LOG_MODES = new Set(["active-passive-log", "sync-quorum"]);
const STATELESS_TIER_ROLES = new Set(["gateway", "planner", "executor"]);

export function parseRegionId(value: JsonValue, fieldName: string): RegionId {
  // SAFETY: assertion to `return requiredString(value, fieldName) as RegionId;` is required at this boundary.
  return requiredString(value, fieldName) as RegionId;
}

export function parseLogPath(value: JsonValue): LogPath {
  // SAFETY: assertion to `return requiredString(value, "logPath") as LogPath;` is required at this boundary.
  return requiredString(value, "logPath") as LogPath;
}

export function parseMultiRegionTopology(raw: JsonValue): ParsedMultiRegionTopology {
  if (!raw || !isJsonObject(raw)) {
    throw new Error("topology manifest is required");
  }

  // SAFETY: assertion to `const manifest = raw as JsonObject;` is required at this boundary.
  const manifest = raw as JsonObject;
  const authoritativeLog = requiredObject(manifest.authoritativeLog, "authoritativeLog");
  const statelessTier = requiredObject(manifest.statelessTier, "statelessTier");
  const regions = requiredStringArray(manifest.regions, "regions", { minLength: 2 }).map((region) =>
    parseRegionId(region, "regions"),
  );

  // SAFETY: assertion to `const logMode = requiredEnum(` is required at this boundary.
  const logMode = requiredEnum(
    authoritativeLog.mode,
    "authoritativeLog.mode",
    AUTHORITATIVE_LOG_MODES,
  ) as ParsedMultiRegionTopology["authoritativeLog"]["mode"];
  const primaryRegion = parseRegionId(authoritativeLog.primaryRegion, "authoritativeLog.primaryRegion");

  if (!regions.includes(primaryRegion)) {
    throw new Error("authoritativeLog.primaryRegion must be listed in regions");
  }

  const passiveRegions = regions.filter((region) => region !== primaryRegion);
  // SAFETY: assertion to `const statelessMode = requiredEnum(` is required at this boundary.
  const statelessMode = requiredEnum(
    statelessTier.mode,
    "statelessTier.mode",
    new Set(["active-active"]),
  ) as ParsedMultiRegionTopology["statelessTier"]["mode"];
  const roles = requiredStringArray(statelessTier.roles, "statelessTier.roles", { minLength: 1 });

  const parsedRoles: ParsedMultiRegionTopology["statelessTier"]["roles"] = [];
  for (const role of roles) {
    if (!STATELESS_TIER_ROLES.has(role)) {
      throw new Error(`unsupported stateless role: ${role}`);
    }
    // SAFETY: assertion to `parsedRoles.push(role as ParsedMultiRegionTopology["statelessTier"]["roles"][num` is required at this boundary.
    parsedRoles.push(role as ParsedMultiRegionTopology["statelessTier"]["roles"][number]);
  }

  return Object.freeze({
    contractVersion: "hobo.multi-region-dr-replay/v1",
    regions,
    authoritativeLog: Object.freeze({
      mode: logMode,
      primaryRegion,
      passiveRegions,
      replication: isJsonString(authoritativeLog.replication)
        ? authoritativeLog.replication
        : "cross-region-quorum",
    }),
    statelessTier: Object.freeze({
      mode: statelessMode,
      roles: parsedRoles,
      horizontallyScaled: true as const,
    }),
  });
}

export function parseReplicatedLog(raw: JsonValue): ParsedReplicatedLog {
  if (!raw || !isJsonObject(raw)) {
    throw new Error("replicated log is required");
  }

  // SAFETY: assertion to `const log = raw as JsonObject;` is required at this boundary.
  const log = raw as JsonObject;
  const streams = requiredObject(log.streams, "streams");
  const streamEntries = Object.entries(streams);

  if (streamEntries.length === 0) {
    throw new Error("replicated log streams must not be empty");
  }

  const parsedStreams: ParsedReplicatedLog["streams"] = {};
  for (const [streamId, events] of streamEntries) {
    if (!Array.isArray(events)) {
      throw new Error(`stream ${streamId} must be an event array`);
    }
    // SAFETY: assertion to `parsedStreams[streamId as StreamId] = events;` is required at this boundary.
    parsedStreams[streamId as StreamId] = events;
  }

  const lastCommittedSeq = nonNegativeInteger(log.lastCommittedSeq, "lastCommittedSeq");
  const replicatedSeq = nonNegativeInteger(log.replicatedSeq, "replicatedSeq");

  if (replicatedSeq > lastCommittedSeq) {
    throw new Error("replicatedSeq must not exceed lastCommittedSeq");
  }

  return {
    topology: requiredString(log.topology ?? "cross-region-quorum", "topology"),
    primaryRegion: parseRegionId(log.primaryRegion ?? "us-east-1", "primaryRegion"),
    replicaRegion: parseRegionId(log.replicaRegion ?? "us-west-2", "replicaRegion"),
    lastCommittedSeq,
    replicatedSeq,
    replicationLagMs: nonNegativeInteger(log.replicationLagMs ?? 0, "replicationLagMs"),
    snapshotSeq: nonNegativeInteger(log.snapshotSeq ?? 0, "snapshotSeq"),
    streams: parsedStreams,
    // SAFETY: assertion to `preLossSnapshots: (log.preLossSnapshots as Record<string, string> | null) ?? nul` is required at this boundary.
    preLossSnapshots: (log.preLossSnapshots as Record<string, string> | null) ?? null,
    restoreCompletedAt: isJsonString(log.restoreCompletedAt) ? log.restoreCompletedAt : null,
  };
}

export function parseRestoreRequest(input: JsonValue): ParsedRestoreRequest {
  if (!input || !isJsonObject(input)) {
    throw new Error("restore request is required");
  }

  // SAFETY: assertion to `const request = input as JsonObject;` is required at this boundary.
  const request = input as JsonObject;
  const logPath = parseLogPath(request.logPath ?? request.log);
  return {
    logPath,
    startedAt: validateIso(request.startedAt ?? new Date(0).toISOString(), "startedAt"),
    completedAt: request.completedAt ? validateIso(request.completedAt, "completedAt") : null,
  };
}

function requiredObject(value: JsonValue, fieldName: string): JsonObject {
  if (!value || !isJsonObject(value)) {
    throw new Error(`${fieldName} is required`);
  }
  // SAFETY: assertion to `return value as JsonObject;` is required at this boundary.
  return value as JsonObject;
}

function requiredString(value: JsonValue, fieldName: string): string {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function requiredStringArray(value: JsonValue, fieldName: string, { minLength = 0 } = {}): string[] {
  if (!Array.isArray(value) || value.some((entry) => !isJsonString(entry) || entry.trim().length === 0)) {
    throw new Error(`${fieldName} must be a non-empty string array`);
  }
  if (value.length < minLength) {
    throw new Error(`${fieldName} must contain at least ${minLength} entries`);
  }
  return value.map((entry) => entry.trim());
}

function requiredEnum(value: JsonValue, fieldName: string, allowed: Set<string>): string {
  const normalized = requiredString(value, fieldName);
  if (!allowed.has(normalized)) {
    throw new Error(`${fieldName} must be one of ${[...allowed].join(", ")}`);
  }
  return normalized;
}

function nonNegativeInteger(value: JsonValue, fieldName: string): number {
  if (!isJsonNumber(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

function validateIso(value: JsonValue, fieldName: string): string {
  const text = requiredString(value, fieldName);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`${fieldName} must be ISO-8601`);
  }
  return text;
}
