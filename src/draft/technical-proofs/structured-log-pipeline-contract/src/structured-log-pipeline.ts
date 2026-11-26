import { isJsonString, isJsonObject } from "./json.js";
const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
});

const ZERO_TRACE_ID = "00000000000000000000000000000000";
const ZERO_SPAN_ID = "0000000000000000";
const REDACTED = "[REDACTED]";

const TRACEPARENT_PATTERN =
  /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

export function createStructuredLogPipeline(options = {}) {
  const threshold = normalizeLevel(options.minimumLevel ?? "debug", "minimumLevel");
  const sinks = (options.sinks ?? []).map(normalizeSink);
  const rateLimit = normalizeRateLimit(options.rateLimit);
  const runs = new Map();

  function createContext(context) {
    const normalized = normalizeContext(context);

    return {
      ...normalized,
      log: {
        debug: (message, fields, logOptions) =>
          emit(normalized, "debug", message, fields, logOptions),
        info: (message, fields, logOptions) =>
          emit(normalized, "info", message, fields, logOptions),
        warn: (message, fields, logOptions) =>
          emit(normalized, "warn", message, fields, logOptions),
        error: (message, fields, logOptions) =>
          emit(normalized, "error", message, fields, logOptions),
        emit: (level, message, fields, logOptions) =>
          emit(normalized, level, message, fields, logOptions)
      }
    };
  }

  function subscribeRun(runId, options = {}) {
    assertNonEmptyString(runId, "runId");
    const run = ensureRun(runId);
    const subscriberId = options.subscriberId ?? `subscriber-${run.subscribers.size + 1}`;
    assertNonEmptyString(subscriberId, "subscriberId");

    const subscriber = {
      id: subscriberId,
      connected: true,
      disconnectedReason: undefined,
      queue: run.entries
        .filter((entry) => entry.seq > (options.replayFromSeq ?? 0))
        .map(cloneEntry),
      maxQueue: options.maxQueue ?? 1000,
      dropped: 0
    };
    run.subscribers.set(subscriberId, subscriber);

    return {
      id: subscriberId,
      disconnect(reason = "client-disconnected") {
        subscriber.connected = false;
        subscriber.disconnectedReason = reason;
        return {
          subscriberId,
          connected: false,
          reason
        };
      },
      readAll() {
        const entries = subscriber.queue.map(cloneEntry);
        subscriber.queue = [];
        return entries;
      },
      status() {
        return subscriberStatus(subscriber);
      }
    };
  }

  function emit(context, level, message, fields = {}, logOptions = {}) {
    const normalizedLevel = normalizeLevel(level, "level");
    if (LEVELS[normalizedLevel] < LEVELS[threshold]) {
      return {
        accepted: false,
        reason: "below-threshold",
        level: normalizedLevel,
        threshold
      };
    }

    const run = ensureRun(context.runId);
    const nowMs = logOptions.nowMs ?? Date.now();
    if (!consumeRateLimit(run, nowMs, rateLimit)) {
      run.dropped.rateLimited += 1;
      return {
        accepted: false,
        reason: "rate-limited",
        level: normalizedLevel,
        threshold,
        dropped: cloneValue(run.dropped)
      };
    }

    const entry = {
      seq: ++run.seq,
      timestampMs: nowMs,
      level: normalizedLevel,
      message: String(message),
      fields: redactFields(fields),
      tenant: context.tenant,
      runId: context.runId,
      resource: context.resource,
      traceId: context.traceId,
      traceparent: context.traceparent,
      tags: {
        tenant: context.tenant,
        runId: context.runId,
        resource: context.resource,
        traceId: context.traceId
      }
    };

    run.entries.push(entry);
    const delivery = deliverToSubscribers(run, entry);
    const exported = sinks.map((sink) => sink.write(cloneEntry(entry)));

    return {
      accepted: true,
      entry: cloneEntry(entry),
      deliveredSubscribers: delivery.delivered,
      skippedSubscribers: delivery.skipped,
      backpressuredSubscribers: delivery.backpressured,
      exported
    };
  }

  function history(runId) {
    assertNonEmptyString(runId, "runId");
    return ensureRun(runId).entries.map(cloneEntry);
  }

  function completeRun(runId) {
    assertNonEmptyString(runId, "runId");
    const run = ensureRun(runId);
    run.completed = true;
    return runStatus(runId);
  }

  function runStatus(runId) {
    assertNonEmptyString(runId, "runId");
    const run = ensureRun(runId);
    const subscribers = [...run.subscribers.values()];

    return {
      runId,
      completed: run.completed,
      seq: run.seq,
      entries: run.entries.length,
      dropped: cloneValue(run.dropped),
      subscribers: {
        total: subscribers.length,
        connected: subscribers.filter((subscriber) => subscriber.connected).length,
        disconnected: subscribers.filter((subscriber) => !subscriber.connected).length
      }
    };
  }

  function ensureRun(runId) {
    if (!runs.has(runId)) {
      runs.set(runId, {
        runId,
        completed: false,
        seq: 0,
        entries: [],
        subscribers: new Map(),
        dropped: {
          rateLimited: 0,
          subscriberBackpressure: 0
        },
        rateWindow: {
          startedAtMs: undefined,
          count: 0
        }
      });
    }

    return runs.get(runId);
  }

  return {
    completeRun,
    createContext,
    history,
    runStatus,
    subscribeRun
  };
}

export function createMemoryLogSink(target = "memory") {
  assertNonEmptyString(target, "target");
  const entries = [];

  return {
    target,
    entries,
    write(entry) {
      const copy = cloneEntry(entry);
      entries.push(copy);
      return {
        target,
        seq: copy.seq
      };
    }
  };
}

function normalizeContext(context) {
  assertNonEmptyString(context?.tenant, "tenant");
  assertNonEmptyString(context?.runId, "runId");
  assertNonEmptyString(context?.resource, "resource");

  const trace = parseTraceparent(context.traceparent);
  return {
    tenant: context.tenant,
    runId: context.runId,
    resource: context.resource,
    traceId: trace.traceId,
    spanId: trace.spanId,
    traceparent: trace.traceparent
  };
}

function parseTraceparent(traceparent) {
  if (!isJsonString(traceparent)) {
    throw new Error("ctx.log requires a valid W3C traceparent");
  }

  const match = traceparent.match(TRACEPARENT_PATTERN);
  if (!match || match[1] === ZERO_TRACE_ID || match[2] === ZERO_SPAN_ID) {
    throw new Error("ctx.log requires a valid W3C traceparent");
  }

  const [, traceId, spanId, flags] = match;
  return {
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    flags: flags.toLowerCase(),
    traceparent: `00-${traceId.toLowerCase()}-${spanId.toLowerCase()}-${flags.toLowerCase()}`
  };
}

function deliverToSubscribers(run, entry) {
  const delivered = [];
  const skipped = [];
  const backpressured = [];

  for (const subscriber of run.subscribers.values()) {
    if (!subscriber.connected) {
      skipped.push(subscriber.id);
      continue;
    }

    if (subscriber.queue.length >= subscriber.maxQueue) {
      subscriber.dropped += 1;
      run.dropped.subscriberBackpressure += 1;
      backpressured.push(subscriber.id);
      continue;
    }

    subscriber.queue.push(cloneEntry(entry));
    delivered.push(subscriber.id);
  }

  return { delivered, skipped, backpressured };
}

function consumeRateLimit(run, nowMs, rateLimit) {
  if (!Number.isFinite(rateLimit.maxPerWindow)) {
    return true;
  }

  if (
    run.rateWindow.startedAtMs === undefined ||
    nowMs - run.rateWindow.startedAtMs >= rateLimit.windowMs
  ) {
    run.rateWindow.startedAtMs = nowMs;
    run.rateWindow.count = 0;
  }

  if (run.rateWindow.count >= rateLimit.maxPerWindow) {
    return false;
  }

  run.rateWindow.count += 1;
  return true;
}

function normalizeRateLimit(rateLimit) {
  if (rateLimit === undefined) {
    return {
      maxPerWindow: Infinity,
      windowMs: 1000
    };
  }

  const maxPerWindow = rateLimit.maxPerWindow;
  const windowMs = rateLimit.windowMs ?? 1000;
  if (!Number.isInteger(maxPerWindow) || maxPerWindow < 1) {
    throw new Error("rateLimit.maxPerWindow must be a positive integer");
  }
  if (!Number.isInteger(windowMs) || windowMs < 1) {
    throw new Error("rateLimit.windowMs must be a positive integer");
  }

  return { maxPerWindow, windowMs };
}

function normalizeSink(sink) {
  if (!sink || !(sink.write instanceof Function)) {
    throw new Error("historical log sink requires a write(entry) function");
  }

  return sink;
}

function normalizeLevel(level, label) {
  const normalized = String(level).toLowerCase();
  if (!Object.hasOwn(LEVELS, normalized)) {
    throw new Error(`${label} must be one of ${Object.keys(LEVELS).join(", ")}`);
  }

  return normalized;
}

function redactFields(fields) {
  return redactValue(fields, "");
}

function redactValue(value, key) {
  if (isSensitiveField(key)) {
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

function isSensitiveField(key) {
  return /password|passphrase|secret|token|authorization|api[-_]?key|access[-_]?key/i.test(key);
}

function subscriberStatus(subscriber) {
  return {
    subscriberId: subscriber.id,
    connected: subscriber.connected,
    reason: subscriber.disconnectedReason,
    queued: subscriber.queue.length,
    dropped: subscriber.dropped
  };
}

function cloneEntry(entry) {
  return cloneValue(entry);
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

function assertNonEmptyString(value, label) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${label} is required`);
  }
}
