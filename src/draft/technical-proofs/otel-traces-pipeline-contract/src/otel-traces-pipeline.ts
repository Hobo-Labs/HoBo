import { randomBytes } from "node:crypto";
import { isJsonString, isJsonNumber, isJsonObject } from "./json.js";


const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";
const REDACTED = "[REDACTED]";

export function createOtelTracePipeline(options = {}) {
  const collector = options.collector ?? createMockOtlpCollector();
  const spanIds = [...(options.spanIds ?? [])];
  const clock = [...(options.clock ?? [])];
  const sampleRate = normalizeSampleRate(options.sampleRate ?? 1);
  const maxBufferedSpans = options.maxBufferedSpans ?? Infinity;
  const maxDepth = options.maxDepth ?? 64;
  const retryBaseMs = options.retryBaseMs ?? 1000;
  const buffer = [];
  const stats = {
    droppedSampledSpans: 0,
    droppedBufferSpans: 0
  };
  let nextRetryAtMs = 0;

  function startDeploy(context, attributes = {}) {
    const parent = parseTraceparent(context?.traceparent);
    return startRecordedSpan({
      name: "deploy",
      traceId: parent.traceId,
      parentSpanId: parent.spanId,
      flags: parent.flags,
      depth: 0,
      parent: null,
      sampled: shouldSample(parent.traceId),
      attributes: {
        "hobo.tenant": requireString(context?.tenant, "tenant"),
        "hobo.run_id": requireString(context?.runId, "runId"),
        "hobo.deployment_id": requireString(context?.deploymentId, "deploymentId"),
        ...attributes
      }
    });
  }

  function startSpan(parent, name, attributes = {}) {
    if (!parent || !isJsonObject(parent)) {
      throw new Error("parent span is required");
    }

    return startRecordedSpan({
      name,
      traceId: parent.traceId,
      parentSpanId: parent.spanId,
      flags: parent.flags,
      depth: parent.depth + 1,
      parent,
      sampled: parent.sampled,
      attributes
    });
  }

  function withSpan(parent, name, attributes, operation) {
    const span = startSpan(parent, name, attributes);
    try {
      return operation(span);
    } finally {
      endSpan(span);
    }
  }

  function instrumentProviderCall(parent, providerCall, operation) {
    const provider = requireString(providerCall?.provider, "provider");
    const region = requireString(providerCall?.region, "region");
    const op = requireString(providerCall?.op, "op");

    return withSpan(
      parent,
      `provider.${provider}.${op}`,
      {
        "cloud.provider": provider,
        "cloud.region": region,
        "db.operation": op
      },
      (span) => {
        const result = operation({
          traceId: span.traceId,
          spanId: span.spanId,
          traceparent: span.traceparent
        });

        if (result?.observedTraceparent !== span.traceparent) {
          span.status = {
            code: "ERROR",
            message: "provider-context-lost"
          };
        }

        return result;
      }
    );
  }

  function endSpan(span, attributes = {}) {
    if (!span || !isJsonObject(span)) {
      throw new Error("span is required");
    }
    if (span.endedAtMs !== undefined) {
      return span;
    }

    span.endedAtMs = Math.max(nextTime(), span.startedAtMs);
    span.attributes = {
      ...span.attributes,
      ...redactAttributes(attributes)
    };

    if (!span.sampled) {
      stats.droppedSampledSpans += 1;
      return span;
    }

    const finished = toFinishedSpan(span);
    if (buffer.length >= maxBufferedSpans) {
      stats.droppedBufferSpans += 1;
      return span;
    }

    buffer.push(finished);
    return span;
  }

  function flush(options = {}) {
    const nowMs = options.nowMs ?? Date.now();
    if (nowMs < nextRetryAtMs) {
      return flushResult(0, buffer.length, nextRetryAtMs);
    }
    if (buffer.length === 0) {
      return flushResult(0, 0, undefined);
    }

    const spans = buffer.slice().sort((left, right) => left.startedAtMs - right.startedAtMs);
    const payload = toOtlpTrace(spans);

    try {
      collector.export(payload);
      buffer.length = 0;
      nextRetryAtMs = 0;
      return flushResult(spans.length, 0, undefined);
    } catch (error) {
      nextRetryAtMs = nowMs + retryBaseMs;
      return {
        ...flushResult(0, buffer.length, nextRetryAtMs),
        error: error.message
      };
    }
  }

  function flushResult(exportedSpans, deferredSpans, retryAt) {
    return {
      exportedSpans,
      deferredSpans,
      droppedSampledSpans: stats.droppedSampledSpans,
      droppedBufferSpans: stats.droppedBufferSpans,
      ...(retryAt === undefined ? undefined : { nextRetryAtMs: retryAt })
    };
  }

  function startRecordedSpan(config) {
    const spanId = nextSpanId();
    const attributes = {
      ...redactAttributes(config.attributes),
      ...(config.depth > maxDepth ? { "hobo.depth_exceeded": true } : undefined)
    };

    return {
      name: requireString(config.name, "span name"),
      traceId: config.traceId,
      spanId,
      parentSpanId: config.parentSpanId,
      flags: config.flags,
      traceparent: formatTraceparent(config.traceId, spanId, config.flags),
      parent: config.parent,
      depth: config.depth,
      sampled: config.sampled,
      startedAtMs: nextTime(),
      attributes,
      status: { code: "OK" }
    };
  }

  function shouldSample(traceId) {
    if (sampleRate === 0) {
      return false;
    }
    if (sampleRate === 1) {
      return true;
    }

    const sample = Number.parseInt(traceId.slice(-8), 16) / 0xffffffff;
    return sample <= sampleRate;
  }

  function nextSpanId() {
    const value = spanIds.shift() ?? randomBytes(8).toString("hex");
    if (!/^[0-9a-f]{16}$/.test(value) || value === ZERO_SPAN_ID) {
      throw new Error("span id must be 16 lowercase hex characters and non-zero");
    }
    return value;
  }

  function nextTime() {
    return clock.length > 0 ? clock.shift() : Date.now();
  }

  return {
    endSpan,
    flush,
    instrumentProviderCall,
    startDeploy,
    startSpan,
    withSpan
  };
}

export function createMockOtlpCollector(options = {}) {
  const traces = [];
  let attempts = 0;

  return {
    export(payload) {
      attempts += 1;
      if (attempts <= (options.failAttempts ?? 0)) {
        throw new Error("otlp-collector-unavailable");
      }
      traces.push(cloneValue(payload));
      return { accepted: true };
    },
    tracesFor(traceId) {
      return traces.filter((trace) =>
        trace.resourceSpans.some((resourceSpan) =>
          resourceSpan.scopeSpans.some((scopeSpan) =>
            scopeSpan.spans.some((span) => span.traceId === traceId)
          )
        )
      );
    },
    attempts() {
      return attempts;
    },
    exports() {
      return traces.map(cloneValue);
    }
  };
}

function toFinishedSpan(span) {
  return {
    name: span.name,
    traceId: span.traceId,
    spanId: span.spanId,
    parentSpanId: span.parentSpanId,
    startedAtMs: span.startedAtMs,
    endedAtMs: span.endedAtMs,
    attributes: cloneValue(span.attributes),
    status: cloneValue(span.status)
  };
}

function toOtlpTrace(spans) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: {
            "service.name": "hobo"
          }
        },
        scopeSpans: [
          {
            scope: {
              name: "hobo.otel-traces-pipeline-contract",
              version: "0.1.0"
            },
            spans: spans.map((span) => ({
              name: span.name,
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId,
              startTimeUnixNano: String(BigInt(span.startedAtMs) * 1_000_000n),
              endTimeUnixNano: String(BigInt(span.endedAtMs) * 1_000_000n),
              attributes: cloneValue(span.attributes),
              status: cloneValue(span.status)
            }))
          }
        ]
      }
    ]
  };
}

function parseTraceparent(traceparent) {
  if (!isJsonString(traceparent)) {
    throw new Error("traceparent is required");
  }
  const match = TRACEPARENT_PATTERN.exec(traceparent);
  if (!match) {
    throw new Error("traceparent must be W3C traceparent format");
  }
  const [, traceId, spanId, flags] = match.map((part) => part?.toLowerCase());
  if (traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID) {
    throw new Error("traceparent ids must be non-zero");
  }

  return {
    traceId,
    spanId,
    flags
  };
}

function formatTraceparent(traceId, spanId, flags = "01") {
  return `00-${traceId}-${spanId}-${flags}`;
}

function normalizeSampleRate(rate) {
  if (!isJsonNumber(rate) || rate < 0 || rate > 1) {
    throw new Error("sampleRate must be between 0 and 1");
  }
  return rate;
}

function redactAttributes(attributes = {}) {
  return redactValue(attributes, "");
}

function redactValue(value, key) {
  if (isSensitiveKey(key)) {
    return REDACTED;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, ""));
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactValue(childValue, childKey)
      ])
    );
  }
  return value;
}

function isSensitiveKey(key) {
  return /email|password|passphrase|secret|token|authorization|api[-_]?key|access[-_]?key|ssn/i.test(key);
}

function requireString(value, label) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, childValue]) => [key, cloneValue(childValue)])
    );
  }
  return value;
}
