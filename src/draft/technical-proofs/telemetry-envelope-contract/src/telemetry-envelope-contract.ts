import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const TELEMETRY_ENVELOPE_SCHEMA_VERSION = "hobo.telemetry-envelope/v1";
export const BOUNDARY_EXPORT_SCHEMA_VERSION = "hobo.boundary-export/v1";

const TRACEPARENT =
  /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";

const TELEMETRY_EVENT_FAMILIES = new Set([
  "run",
  "actor",
  "saga",
  "slo",
  "alert",
  "meter",
  "spend",
  "credit",
  "eval",
  "policy",
  "token",
  "identity",
  "session",
  "domain",
  "registry",
  "flag",
  "listing",
]);

export function parseTelemetryEnvelope(input, options = {}) {
  const envelope = requireObject(input, "envelope");
  assertEqual(
    envelope.schemaVersion,
    TELEMETRY_ENVELOPE_SCHEMA_VERSION,
    "envelope.schemaVersion",
  );

  const normalized = {
    schemaVersion: TELEMETRY_ENVELOPE_SCHEMA_VERSION,
    id: requireString(envelope.id, "envelope.id"),
    type: normalizeEventType(envelope.type),
    streamId: requireString(envelope.streamId, "envelope.streamId"),
    seq: requireNonNegativeInteger(envelope.seq, "envelope.seq"),
    ts: normalizeInstant(envelope.ts, "envelope.ts"),
    tenant: requireString(envelope.tenant, "envelope.tenant"),
    actor: requireString(envelope.actor, "envelope.actor"),
    data: requirePlainObject(envelope.data ?? {}, "envelope.data"),
    meta: requirePlainObject(envelope.meta ?? {}, "envelope.meta"),
  };

  if (envelope.correlationId !== undefined) {
    normalized.correlationId = requireString(envelope.correlationId, "envelope.correlationId");
  }
  if (envelope.causationId !== undefined) {
    normalized.causationId = requireString(envelope.causationId, "envelope.causationId");
  }

  normalized.meta = normalizeTraceMeta(normalized, options);
  return normalized;
}

export function serializeTelemetryEnvelope(envelope) {
  return canonicalJson(parseTelemetryEnvelope(envelope));
}

export function toCloudEvent(input) {
  const envelope = parseTelemetryEnvelope(input);
  return {
    specversion: "1.0",
    id: envelope.id,
    source: `/hobo/${envelope.tenant}/${envelope.streamId}`,
    subject: envelope.streamId,
    type: envelope.type,
    time: envelope.ts,
    datacontenttype: "application/json",
    dataschema: TELEMETRY_ENVELOPE_SCHEMA_VERSION,
    data: envelope.data,
    traceparent: envelope.meta.traceparent,
    hobotraceparent: envelope.meta.traceparent,
    hoboschemaversion: envelope.schemaVersion,
    hoboseq: envelope.seq,
    hobostreamid: envelope.streamId,
    hobotenant: envelope.tenant,
    hoboactor: envelope.actor,
    hoboenvelope: canonicalJson(envelope),
  };
}

export function fromCloudEvent(cloudEvent) {
  const event = requireObject(cloudEvent, "cloudEvent");
  for (const field of ["specversion", "id", "source", "type", "time", "data"]) {
    if (event[field] === undefined || event[field] === null || event[field] === "") {
      throw new TypeError(`cloudEvent.${field} is required`);
    }
  }
  assertEqual(event.specversion, "1.0", "cloudEvent.specversion");

  if (isJsonString(event.hoboenvelope)) {
    return parseTelemetryEnvelope(JSON.parse(event.hoboenvelope));
  }

  return parseTelemetryEnvelope({
    schemaVersion: event.hoboschemaversion,
    id: event.id,
    type: event.type,
    streamId: event.hobostreamid ?? event.subject,
    seq: event.hoboseq,
    ts: event.time,
    tenant: event.hobotenant,
    actor: event.hoboactor,
    data: event.data,
    meta: {
      traceparent: event.hobotraceparent ?? event.traceparent,
    },
  });
}

export function toOtlpSpan(input) {
  const envelope = parseTelemetryEnvelope(input);
  const parsedTraceparent = parseTraceparent(envelope.meta.traceparent);
  return {
    schemaVersion: BOUNDARY_EXPORT_SCHEMA_VERSION,
    protocol: "otlp-span/v1",
    traceId: parsedTraceparent.traceId,
    spanId: parsedTraceparent.spanId,
    parentSpanId: envelope.causationId,
    name: envelope.type,
    startTimeUnixNano: instantToUnixNanos(envelope.ts),
    attributes: {
      "hobo.schema_version": envelope.schemaVersion,
      "hobo.event_id": envelope.id,
      "hobo.event_type": envelope.type,
      "hobo.stream_id": envelope.streamId,
      "hobo.seq": envelope.seq,
      "hobo.tenant": envelope.tenant,
      "hobo.actor": envelope.actor,
      "hobo.traceparent": envelope.meta.traceparent,
      "hobo.raw_event": canonicalJson(envelope),
    },
  };
}

export function fromOtlpSpan(span) {
  const normalized = requireObject(span, "span");
  assertEqual(normalized.protocol, "otlp-span/v1", "span.protocol");
  const attributes = requireObject(normalized.attributes, "span.attributes");
  const envelope = parseTelemetryEnvelope(
    JSON.parse(requireString(attributes["hobo.raw_event"], "span.attributes.hobo.raw_event")),
  );
  const parsedTraceparent = parseTraceparent(envelope.meta.traceparent);
  assertEqual(normalized.traceId, parsedTraceparent.traceId, "span.traceId");
  assertEqual(normalized.spanId, parsedTraceparent.spanId, "span.spanId");
  return envelope;
}

export function toOcsfEvent(input) {
  const envelope = parseTelemetryEnvelope(input);
  if (envelope.type === "policy.Decided") {
    requireString(envelope.data.principalRef, "envelope.data.principalRef");
    requireString(envelope.data.action, "envelope.data.action");
    requireString(envelope.data.resource, "envelope.data.resource");
    requireString(envelope.data.decision, "envelope.data.decision");
  }

  const parsedTraceparent = parseTraceparent(envelope.meta.traceparent);
  return {
    schemaVersion: BOUNDARY_EXPORT_SCHEMA_VERSION,
    profile: "ocsf/v1-authorization",
    class_name: "Authorization",
    category_name: "Identity & Access Management",
    activity_name: envelope.data.action ?? envelope.type,
    status: envelope.data.decision === "allow" ? "Success" : "Failure",
    status_detail: envelope.data.decision ?? "recorded",
    time: Date.parse(envelope.ts),
    actor: {
      user: {
        uid: envelope.data.principalRef ?? envelope.actor,
      },
    },
    resource: {
      uid: envelope.data.resource ?? envelope.streamId,
    },
    metadata: {
      product: {
        name: "HoBo",
      },
      version: TELEMETRY_ENVELOPE_SCHEMA_VERSION,
      event_code: envelope.type,
      uid: envelope.id,
      correlation_uid: envelope.correlationId,
    },
    trace: {
      uid: parsedTraceparent.traceId,
      span_uid: parsedTraceparent.spanId,
    },
    raw_event: canonicalJson(envelope),
  };
}

export function fromOcsfEvent(event) {
  const ocsf = requireObject(event, "ocsf");
  assertEqual(ocsf.profile, "ocsf/v1-authorization", "ocsf.profile");
  return parseTelemetryEnvelope(JSON.parse(requireString(ocsf.raw_event, "ocsf.raw_event")));
}

export function validateEventNamespaceCatalog(eventTypes) {
  if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
    throw new TypeError("eventTypes must be a non-empty array");
  }

  const seen = new Set();
  for (const eventType of eventTypes) {
    const normalized = normalizeEventType(eventType);
    if (seen.has(normalized)) {
      throw new TypeError(`duplicate event type ${normalized}`);
    }
    seen.add(normalized);
  }
  return [...seen];
}

function normalizeTraceMeta(envelope, options) {
  const meta = { ...envelope.meta };
  if (!isJsonString(meta.traceparent)) {
    if (options.missingTraceparent === "synthesize-root") {
      meta.traceparent = synthesizeTraceparent(envelope);
      meta.traceparentSynthetic = true;
    } else {
      throw new TypeError("envelope.meta.traceparent is required");
    }
  }

  parseTraceparent(meta.traceparent);
  if (meta.tracestate !== undefined) {
    meta.tracestate = requireString(meta.tracestate, "envelope.meta.tracestate");
  }
  return meta;
}

function parseTraceparent(traceparent) {
  const match = requireString(traceparent, "traceparent").match(TRACEPARENT);
  if (!match || match[1] === ZERO_TRACE_ID || match[2] === ZERO_SPAN_ID) {
    throw new TypeError("traceparent must be a valid W3C traceparent");
  }
  return {
    traceId: match[1],
    spanId: match[2],
    flags: match[3],
  };
}

function synthesizeTraceparent(envelope) {
  const digest = sha256(`${envelope.id}:${envelope.streamId}:${envelope.seq}`);
  const traceId = digest.slice(0, 32).replace(/^0{32}$/, "1".padStart(32, "0"));
  const spanId = digest.slice(32, 48).replace(/^0{16}$/, "1".padStart(16, "0"));
  return `00-${traceId}-${spanId}-01`;
}

function normalizeEventType(type) {
  const eventType = requireString(type, "envelope.type");
  const [family, name, ...rest] = eventType.split(".");
  if (!family || !name || rest.length > 0) {
    throw new TypeError("envelope.type must be an event family and name");
  }
  if (!TELEMETRY_EVENT_FAMILIES.has(family)) {
    throw new TypeError(`unsupported event family ${family}`);
  }
  return eventType;
}

function requireObject(value, path) {
  if (value === null || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError(`${path} must be an object`);
  }
  return value;
}

function requirePlainObject(value, path) {
  return { ...requireObject(value, path) };
}

function requireString(value, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeInteger(value, path) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${path} must be a non-negative integer`);
  }
  return value;
}

function normalizeInstant(value, path) {
  const instant = requireString(value, path);
  const date = new Date(instant);
  if (!Number.isFinite(date.valueOf()) || date.toISOString() !== instant) {
    throw new TypeError(`${path} must be an ISO-8601 UTC instant`);
  }
  return instant;
}

function instantToUnixNanos(instant) {
  return `${BigInt(Date.parse(instant)) * 1_000_000n}`;
}

function assertEqual(actual, expected, path) {
  if (actual !== expected) {
    throw new TypeError(`${path} must be ${expected}`);
  }
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entryValue]) => entryValue !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entryValue]) => [key, sortJson(entryValue)]),
    );
  }
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
