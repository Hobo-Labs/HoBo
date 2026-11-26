import { randomBytes } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const TRACE_CONTEXT_CONTRACT = "hobo.trace-context/v1";

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";

export function isTraceparent(value) {
  return parseTraceparent(value) !== null;
}

export function createTraceContextRuntime(options = {}) {
  const traceIds = [...(options.traceIds ?? [])];
  const spanIds = [...(options.spanIds ?? [])];
  const clock = [...(options.clock ?? [])];
  const recordedSpans = [];

  function nextTraceId() {
    return normalizeGeneratedId(traceIds.shift() ?? randomBytes(16).toString("hex"), 32, "traceId");
  }

  function nextSpanId() {
    return normalizeGeneratedId(spanIds.shift() ?? randomBytes(8).toString("hex"), 16, "spanId");
  }

  function now() {
    const value = clock.length > 0 ? clock.shift() : new Date().toISOString();
    const timestamp = Date.parse(value);
    if (Number.isNaN(timestamp)) {
      throw new TypeError("clock values must be ISO-8601 timestamps");
    }
    return new Date(timestamp).toISOString();
  }

  function prepareIngressEnvelope(envelope, spanName, attributes = {}) {
    const prepared = cloneEnvelope(envelope);
    const current = parseTraceparent(prepared.meta?.traceparent);
    if (current) {
      if (spanName) {
        const spanId = nextSpanId();
        prepared.meta = {
          ...prepared.meta,
          traceparent: formatTraceparent(current.traceId, spanId, current.flags),
        };
        recordIngressSpan({
          name: spanName,
          traceId: current.traceId,
          spanId,
          parentSpanId: current.spanId,
          causationId: prepared.id,
          correlationId: prepared.correlationId,
          attributes: { envelopeType: prepared.type, ...attributes },
        });
      }
      return prepared;
    }

    const reason = prepared.meta?.traceparent
      ? "regenerated-malformed-traceparent"
      : "synthesized-root";
    const traceId = nextTraceId();
    const spanId = nextSpanId();
    prepared.meta = {
      ...prepared.meta,
      traceparent: formatTraceparent(traceId, spanId),
      traceRepair: reason,
    };

    if (spanName) {
      recordIngressSpan({
        name: spanName,
        traceId,
        spanId,
        parentSpanId: null,
        causationId: prepared.id,
        correlationId: prepared.correlationId,
        attributes: { envelopeType: prepared.type, ...attributes },
      });
    }

    return prepared;
  }

  function recordIngressSpan(span) {
    const startedAt = now();
    const endedAt = now();
    recordedSpans.push(finishSpan({ ...span, startedAt }, endedAt));
  }

  function withSpan(parentEnvelope, name, attributes, operation) {
    if (!(operation instanceof Function)) {
      throw new TypeError("operation must be a function");
    }

    const parent = ensureTraceContext(parentEnvelope);
    const spanId = nextSpanId();
    const spanEnvelope = cloneEnvelope(parentEnvelope);
    spanEnvelope.meta = {
      ...spanEnvelope.meta,
      traceparent: formatTraceparent(parent.traceId, spanId, parent.flags),
    };

    const span = {
      name: requireString(name, "span name"),
      traceId: parent.traceId,
      spanId,
      parentSpanId: parent.spanId,
      causationId: parentEnvelope.id,
      correlationId: parentEnvelope.correlationId,
      attributes: { ...attributes },
    };

    const startedAt = now();
    try {
      return operation(spanEnvelope);
    } finally {
      const endedAt = now();
      recordedSpans.push(finishSpan({ ...span, startedAt }, endedAt));
    }
  }

  function createChildCommand(parentEnvelope, overrides) {
    const parent = ensureTraceContext(parentEnvelope);
    return {
      id: requireString(overrides?.id, "child.id"),
      type: requireString(overrides?.type, "child.type"),
      v: overrides?.v ?? parentEnvelope.v ?? 1,
      streamId: requireString(overrides?.streamId, "child.streamId"),
      seq: requireNonNegativeInteger(overrides?.seq ?? 0, "child.seq"),
      ts: overrides?.ts ?? parentEnvelope.ts,
      actor: overrides?.actor ?? parentEnvelope.actor,
      tenant: overrides?.tenant ?? parentEnvelope.tenant,
      project: overrides?.project ?? parentEnvelope.project,
      causationId: parentEnvelope.id,
      correlationId: parentEnvelope.correlationId ?? parentEnvelope.id,
      data: overrides?.data ?? {},
      meta: {
        ...overrides?.meta,
        traceparent: formatTraceparent(parent.traceId, parent.spanId, parent.flags),
      },
    };
  }

  function enqueue(envelope) {
    ensureTraceContext(envelope);
    return JSON.stringify(cloneEnvelope(envelope));
  }

  function dequeue(message) {
    const envelope = isJsonString(message) ? JSON.parse(message) : cloneEnvelope(message);
    ensureTraceContext(envelope);
    return envelope;
  }

  return {
    prepareIngressEnvelope,
    withSpan,
    createChildCommand,
    enqueue,
    dequeue,
    spans: () => recordedSpans.map((span) => ({ ...span, attributes: { ...span.attributes } })),
  };
}

function parseTraceparent(value) {
  if (!isJsonString(value)) {
    return null;
  }
  const match = TRACEPARENT_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const [, traceId, spanId, flags] = match;
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) {
    return null;
  }
  return { traceId, spanId, flags };
}

function ensureTraceContext(envelope) {
  const context = parseTraceparent(envelope?.meta?.traceparent);
  if (!context) {
    throw new TypeError("envelope.meta.traceparent must be a valid W3C traceparent");
  }
  return context;
}

function finishSpan(span, observedEnd) {
  const startedMs = Date.parse(span.startedAt);
  const observedEndMs = Date.parse(observedEnd);
  const clockSkewAdjusted = observedEndMs < startedMs;
  return {
    name: span.name,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    causationId: span.causationId,
    correlationId: span.correlationId,
    startedAt: span.startedAt,
    endedAt: clockSkewAdjusted ? span.startedAt : observedEnd,
    attributes: span.attributes,
    ...(clockSkewAdjusted ? { clockSkewAdjusted: true } : undefined),
  };
}

function formatTraceparent(traceId, spanId, flags = "01") {
  return `00-${traceId}-${spanId}-${flags}`;
}

function cloneEnvelope(envelope) {
  if (!envelope || !isJsonObject(envelope)) {
    throw new TypeError("envelope must be an object");
  }
  return {
    ...envelope,
    actor: clonePlain(envelope.actor),
    data: clonePlain(envelope.data),
    meta: { ...envelope.meta },
  };
}

function clonePlain(value) {
  if (value === undefined) {
    return value;
  }
  return JSON.parse(JSON.stringify(value));
}

function normalizeGeneratedId(value, expectedLength, fieldName) {
  if (!isJsonString(value) || !/^[0-9a-f]+$/.test(value) || value.length !== expectedLength) {
    throw new TypeError(`${fieldName} must be ${expectedLength} lowercase hex characters`);
  }
  if ((expectedLength === 32 && value === ZERO_TRACE_ID) || (expectedLength === 16 && value === ZERO_SPAN_ID)) {
    throw new TypeError(`${fieldName} must not be all zeroes`);
  }
  return value;
}

function requireString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
  return value;
}
