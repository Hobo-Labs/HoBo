import { createHash } from "node:crypto";
import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "../json.js";


const RUN_EVENT_TYPES = new Set([
  "run.Started",
  "run.StepScheduled",
  "run.StepCompleted",
  "run.StepFailed",
  "run.SleepScheduled",
  "run.HookCreated",
  "run.HookResumed",
  "run.Suspended",
  "run.Completed",
  "run.Failed",
]);

const ACTOR_EVENT_TYPES = new Set([
  "actor.Activated",
  "actor.StateAppended",
  "actor.Passivated",
]);

const SAGA_EVENT_TYPES = new Set([
  "saga.Started",
  "saga.StepEmitted",
  "saga.Compensated",
  "saga.Completed",
]);

export class EventParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventParseError";
  }
}

export interface ParsedEnvelope {
  id: string;
  type: string;
  streamId: string;
  seq: number;
  runId: string;
  data: JsonObject;
}

export function parseRuntimeEnvelope(raw: JsonValue): ParsedEnvelope {
  return parseEnvelope(raw, { requireCatalogType: true });
}

export function parseEnvelope(raw: JsonValue, opts: { requireCatalogType?: boolean } = {}): ParsedEnvelope {
  if (!raw || !isJsonObject(raw)) {
    throw new EventParseError("envelope must be an object");
  }
  // SAFETY: assertion to `const source = raw as JsonObject;` is required at this boundary.
  const source = raw as JsonObject;
  const type = requireNonEmptyString(source.type, "type");
  const streamId = requireNonEmptyString(source.streamId, "streamId");
  const id = requireNonEmptyString(source.id, "id");
  const seq = requirePositiveInt(source.seq, "seq");
  const data = parseData(source.data);

  if (opts.requireCatalogType && !isCatalogEventType(type)) {
    throw new EventParseError(`unknown catalog event type: ${type}`);
  }

  const runId = isJsonString(data.runId) && data.runId.length > 0 ? data.runId : streamId.replace(/^run:/, "");

  if (runId.length === 0) {
    throw new EventParseError("runId must be non-empty");
  }

  return Object.freeze({ id, type, streamId, seq, runId, data: Object.freeze(data) });
}

export function isCatalogEventType(type: string): boolean {
  return RUN_EVENT_TYPES.has(type) || ACTOR_EVENT_TYPES.has(type) || SAGA_EVENT_TYPES.has(type);
}

export function stableIdempotencyKey(parts: JsonValue[]): string {
  return createHash("sha256").update(stableStringify(parts)).digest("hex").slice(0, 32);
}

function parseData(value: JsonValue): JsonObject {
  if (value === undefined) {
    return {};
  }
  if (!value || !isJsonObject(value)) {
    throw new EventParseError("data must be an object");
  }
  // SAFETY: assertion to `return structuredClone(value as JsonObject);` is required at this boundary.
  return structuredClone(value as JsonObject);
}

function requireNonEmptyString(value: JsonValue, field: string): string {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new EventParseError(`${field} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInt(value: JsonValue, field: string): number {
  // SAFETY: assertion to `if (!Number.isInteger(value) || (value as number) <= 0) {` is required at this boundary.
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new EventParseError(`${field} must be a positive integer`);
  }
  // SAFETY: assertion to `return value as number;` is required at this boundary.
  return value as number;
}

function stableStringify(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && isJsonObject(value)) {
    // SAFETY: assertion to `return {${Object.keys(value as JsonObject)` is required at this boundary.
    return `{${Object.keys(value as JsonObject)
      .sort()
      // SAFETY: assertion to `.map((key) => ${JSON.stringify(key)}:${stableStringify((value as JsonObject)[ke` is required at this boundary.
      .map((key) => `${JSON.stringify(key)}:${stableStringify((value as JsonObject)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
