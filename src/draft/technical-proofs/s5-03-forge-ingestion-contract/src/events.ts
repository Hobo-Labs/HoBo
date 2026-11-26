import { createHash } from "node:crypto";
import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";


const digestPattern = /^sha256:[a-f0-9]{64}$/;

export const FORGE_EVENT_TYPES = new Set([
  "forge.IngestionStarted",
  "forge.SourceFetched",
  "forge.SourcesParsed",
  "forge.PackageEmitted",
  "forge.PackageCompiled"
]);

export class ForgeIngestionError extends Error {
  constructor(
    readonly code: string,
    readonly path = "$"
  ) {
    super(`${code} at ${path}`);
    this.name = "ForgeIngestionError";
  }
}

export function sha256Digest(value: JsonValue): string {
  const serialized = isJsonString(value) ? value : JSON.stringify(value);
  return `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
}

export function buildForgeEvent(input: {
  requestId: string;
  type: string;
  seq: number;
  data: JsonObject;
  ts?: string;
  tenant?: string;
}): ForgeEvent {
  if (!FORGE_EVENT_TYPES.has(input.type) && !input.type.startsWith("gen.")) {
    throw new ForgeIngestionError("forge.event.type", "$.type");
  }

  const event: ForgeEvent = {
    id: `01FORGE${String(input.seq).padStart(4, "0")}`,
    type: input.type,
    v: 1,
    streamId: `forge:${input.requestId}`,
    seq: input.seq,
    ts: input.ts ?? "2026-07-02T00:00:00.000Z",
    actor: {
      kind: "agent",
      id: "agent:forge-ingestion"
    },
    tenant: input.tenant ?? "tenant:demo",
    correlationId: input.requestId,
    data: input.data
  };

  validateForgeEvent(event);
  return event;
}

export function validateForgeEvent(event: ForgeEvent): ForgeEvent {
  assertObject(event, "forge.event.invalid", "$");
  assertNonEmptyString(event.id, "forge.event.id", "$.id");
  assertNonEmptyString(event.type, "forge.event.type", "$.type");
  if (event.v !== 1) {
    throw new ForgeIngestionError("forge.event.version", "$.v");
  }
  assertNonEmptyString(event.streamId, "forge.event.stream_id", "$.streamId");
  if (!Number.isInteger(event.seq) || event.seq <= 0) {
    throw new ForgeIngestionError("forge.event.seq", "$.seq");
  }
  assertNonEmptyString(event.ts, "forge.event.ts", "$.ts");
  if (Number.isNaN(Date.parse(event.ts))) {
    throw new ForgeIngestionError("forge.event.ts", "$.ts");
  }
  assertObject(event.actor, "forge.event.actor", "$.actor");
  assertNonEmptyString(event.actor.kind, "forge.event.actor_kind", "$.actor.kind");
  assertNonEmptyString(event.actor.id, "forge.event.actor_id", "$.actor.id");
  assertNonEmptyString(event.tenant, "forge.event.tenant", "$.tenant");
  assertNonEmptyString(event.correlationId, "forge.event.correlation_id", "$.correlationId");
  assertObject(event.data, "forge.event.data", "$.data");
  if (event.correlationId !== event.data.requestId) {
    throw new ForgeIngestionError("forge.event.correlation_mismatch", "$.correlationId");
  }

  return event;
}

export function validateDigestRef(ref: DigestRef, path: string): DigestRef {
  assertObject(ref, "forge.digest_ref", path);
  assertNonEmptyString(ref.uri, "forge.digest_uri", `${path}.uri`);
  if (!digestPattern.test(ref.digest ?? "")) {
    throw new ForgeIngestionError("forge.digest", `${path}.digest`);
  }
  return ref;
}

export type DigestRef = {
  uri: string;
  digest: string;
};

export type ForgeEvent = {
  id: string;
  type: string;
  v: 1;
  streamId: string;
  seq: number;
  ts: string;
  actor: { kind: string; id: string };
  tenant: string;
  correlationId: string;
  data: JsonObject & { requestId: string };
};

function assertObject(value: JsonValue, code: string, path: string): asserts value is JsonObject {
  if (!value || !isJsonObject(value)) {
    throw new ForgeIngestionError(code, path);
  }
}

function assertNonEmptyString(value: JsonValue, code: string, path: string): asserts value is string {
  if (!isJsonString(value) || value.length === 0) {
    throw new ForgeIngestionError(code, path);
  }
}
