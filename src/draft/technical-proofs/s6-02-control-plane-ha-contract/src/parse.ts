import { isJsonString, isJsonBoolean, isJsonBigInt, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export type StreamId = string & { readonly __brand: "StreamId" };
export type EventType = string & { readonly __brand: "EventType" };
export type ActionId = string & { readonly __brand: "ActionId" };
export type FenceToken = bigint & { readonly __brand: "FenceToken" };

// domain-view: parse-produced draft-proof record; its wire form is the QuorumFencedAppend proto message in data-models/.
export type QuorumFencedAppend = {
  streamId: StreamId;
  fenceToken: FenceToken;
  eventType: EventType;
  actionId: ActionId | null;
};

// domain-view: parse-produced draft-proof record; its wire form is the LeaderFailoverOutcome proto message in data-models/.
export type LeaderFailoverOutcome = {
  leaderNode: string;
  successorNode: string;
  recoveryMs: number;
  duplicateActionsBlocked: boolean;
};

export function parseStreamId(value: JsonValue): StreamId {
  // SAFETY: `return requireNonEmptyString(value, "streamId") as StreamId;` is required at this I/O or test boundary.
  return requireNonEmptyString(value, "streamId") as StreamId;
}

export function parseEventType(value: JsonValue): EventType {
  // SAFETY: `return requireNonEmptyString(value, "eventType") as EventType;` is required at this I/O or test boundary.
  return requireNonEmptyString(value, "eventType") as EventType;
}

export function parseActionId(value: JsonValue): ActionId | null {
  if (value == null) {
    return null;
  }
  // SAFETY: `return requireNonEmptyString(value, "actionId") as ActionId;` is required at this I/O or test boundary.
  return requireNonEmptyString(value, "actionId") as ActionId;
}

export function parseFenceToken(value: JsonValue): FenceToken {
  if (!isJsonBigInt(value)) {
    throw new TypeError("fenceToken must be a bigint");
  }
  if (value < 1n) {
    throw new TypeError("fenceToken must be >= 1");
  }
  // SAFETY: `return value as FenceToken;` is required at this I/O or test boundary.
  return value as FenceToken;
}

export function parseQuorumFencedAppend(value: JsonValue): QuorumFencedAppend {
  if (value == null || !isJsonObject(value)) {
    throw new TypeError("append request must be an object");
  }
  // SAFETY: `const request = value as JsonObject;` is required at this I/O or test boundary.
  const request = value as JsonObject;
  return {
    streamId: parseStreamId(request.streamId),
    fenceToken: parseFenceToken(request.fenceToken),
    eventType: parseEventType(request.eventType),
    actionId: parseActionId(request.actionId),
  };
}

export function parseLeaderFailoverOutcome(value: JsonValue): LeaderFailoverOutcome {
  if (value == null || !isJsonObject(value)) {
    throw new TypeError("leader failover outcome must be an object");
  }
  // SAFETY: `const outcome = value as JsonObject;` is required at this I/O or test boundary.
  const outcome = value as JsonObject;
  const recoveryMs = requireNonNegativeInteger(outcome.recoveryMs, "recoveryMs");
  if (recoveryMs > 30_000) {
    throw new TypeError("recoveryMs must be <= 30000");
  }
  return {
    leaderNode: requireNonEmptyString(outcome.leaderNode, "leaderNode"),
    successorNode: requireNonEmptyString(outcome.successorNode, "successorNode"),
    recoveryMs,
    duplicateActionsBlocked: requireBoolean(outcome.duplicateActionsBlocked, "duplicateActionsBlocked"),
  };
}

function requireNonEmptyString(value: JsonValue, fieldName: string): string {
  if (!isJsonString(value) || value.trim() === "") {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeInteger(value: JsonValue, fieldName: string): number {
  // SAFETY: `if (!Number.isInteger(value) || (value as number) < 0) {` is required at this I/O or test boundary.
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
  // SAFETY: `return value as number;` is required at this I/O or test boundary.
  return value as number;
}

function requireBoolean(value: JsonValue, fieldName: string): boolean {
  if (!isJsonBoolean(value)) {
    throw new TypeError(`${fieldName} must be a boolean`);
  }
  return value;
}
