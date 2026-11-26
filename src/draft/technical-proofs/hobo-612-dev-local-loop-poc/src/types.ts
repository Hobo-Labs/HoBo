import { isJsonString, isJsonNumber, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
export const STATE_SCHEMA = "hobo.dev-state/v1" as const;
export const COLD_BOOT_BUDGET_MS = 60_000;
export const DEFAULT_PORT = 4000;

export type FidelityLabel = "real" | "simulated" | "mocked" | "camp-only";

export type DevEventFamily =
  | "dev.SessionStarted"
  | "dev.RequestServed"
  | "dev.HandlerReloaded"
  | "dev.ReloadFailed"
  | "dev.CodegenRan"
  | "dev.SessionStopped";

export interface DevEvent {
  sequence: number;
  family: DevEventFamily;
  at: string;
  payload: JsonObject;
}

// domain-view: parse-produced draft-proof record; its wire form is the DevStateSnapshot proto message in data-models/.
export interface DevStateSnapshot {
  schema: typeof STATE_SCHEMA;
  runCount: number;
  handlerGeneration: number;
  lastReloaded: string | null;
  eventSequence: number;
  requests: Array<{ path: string; body: JsonValue; handlerGeneration: number }>;
}

export interface DevSessionOptions {
  projectRoot: string;
  port?: number;
  bootMs?: number;
  resources?: Array<{ kind: string; name: string }>;
  campOnlyCapabilities?: string[];
}

// domain-view: parse-produced draft-proof record; its wire form is the DevSessionRecord proto message in data-models/.
export interface DevSessionRecord {
  sessionId: string;
  localUrl: string;
  bootMs: number;
  cloudAccountRequired: false;
  runtime: "runtime-local";
  fidelityLabels: Record<string, FidelityLabel>;
  state: DevStateSnapshot;
}

export class DevParseError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly detail: JsonObject = {},
  ) {
    super(message);
    this.name = "DevParseError";
  }
}

export function parseDevPort(raw: JsonValue): number {
  const port = isJsonNumber(raw) ? raw : Number(raw);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new DevParseError("HOBO_DEV_INVALID_PORT", "port must be an integer from 1024 to 65535", {
      port: raw,
    });
  }
  return port;
}

export function parseDevSessionOptions(raw: DevSessionOptions): Required<Pick<DevSessionOptions, "port" | "bootMs">> & DevSessionOptions {
  return {
    ...raw,
    port: parseDevPort(raw.port ?? DEFAULT_PORT),
    bootMs: isJsonNumber(raw.bootMs) && raw.bootMs >= 0 ? raw.bootMs : 1_200,
  };
}

export function parseDevStateSnapshot(raw: JsonValue): DevStateSnapshot {
  if (!raw || !isJsonObject(raw)) {
    throw new DevParseError("HOBO_DEV_STATE_INVALID", "dev state must be an object");
  }
  // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
  const record = raw as JsonObject;
  if (record.schema !== STATE_SCHEMA) {
    throw new DevParseError(
      "HOBO_DEV_STATE_VERSION_UNSUPPORTED",
      `.hobo/dev-state.json schema ${String(record.schema ?? "missing")} is not supported`,
      { expected: STATE_SCHEMA, actual: record.schema },
    );
  }
  return {
    schema: STATE_SCHEMA,
    runCount: isJsonNumber(record.runCount) ? record.runCount : 0,
    handlerGeneration: isJsonNumber(record.handlerGeneration) ? record.handlerGeneration : 1,
    lastReloaded: isJsonString(record.lastReloaded) ? record.lastReloaded : null,
    eventSequence: isJsonNumber(record.eventSequence) ? record.eventSequence : 0,
    requests: Array.isArray(record.requests)
      ? record.requests.map((entry) => {
          // SAFETY: assertion at this parse/brand/host boundary after the surrounding checks.
          const item = entry as JsonObject;
          return {
            path: String(item.path ?? ""),
            body: item.body,
            handlerGeneration: Number(item.handlerGeneration ?? 1),
          };
        })
      : [],
  };
}

export function emptyDevState(): DevStateSnapshot {
  return {
    schema: STATE_SCHEMA,
    runCount: 0,
    handlerGeneration: 1,
    lastReloaded: null,
    eventSequence: 0,
    requests: [],
  };
}
