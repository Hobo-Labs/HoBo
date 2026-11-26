import { createHash } from "node:crypto";
import { isJsonString, isJsonNumber, isJsonObject } from "./json.js";


export const OPENINFERENCE_LIVE_EVAL_STREAM_CONTRACT = "hobo.openinference-live-eval-stream/v1";

const OPENINFERENCE_EXPORT_SCHEMA = "openinference.otlp.telemetry/v1";
const TRAJECTORY_SCHEMA = "hobo.training.trajectory/v1";
const TELEMETRY_ENVELOPE_SCHEMA = "hobo.telemetry-envelope/v1";
const EVAL_EVENT_SCHEMA = "hobo.eval.event/v1";
const METRIC_SCHEMA = "hobo.metric/v1";
const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const OPENINFERENCE_KINDS = new Set(["CHAIN", "AGENT", "LLM", "TOOL", "RETRIEVER", "EVALUATOR"]);

const METRICS_CATALOG = Object.freeze([
  { name: "ai.method.invocation.rate", unit: "1", description: "Trainable method invocations by method and candidate." },
  { name: "eval.score", unit: "1", description: "Live-eval rubric scores by dimension." },
  {
    name: "eval.champion_challenger.delta",
    unit: "1",
    description: "Challenger quality delta against the champion on live or shadow traffic.",
  },
  { name: "ai.token.cost_per_call", unit: "USD", description: "Token spend per AI-method call." },
  { name: "ai.shadow_traffic.share", unit: "1", description: "Traffic share mirrored into shadow candidates." },
  { name: "eval.promotion.count", unit: "1", description: "Observed promotion outcomes emitted by the external gate." },
]);

export function createAiMethodTelemetryRuntime(options = {}) {
  const backend = options.backend ?? createMockOpenInferenceBackend();
  const spanIds = [...(options.spanIds ?? [])];
  const clock = [...(options.clock ?? [])];
  const runKeyRef = options.runKeyRef;
  const maxInlinePayloadBytes = options.maxInlinePayloadBytes ?? 16 * 1024;
  const eventLog = [];
  const metricLog = [];
  const cost = {
    billableTokens: 0,
    billableUsd: 0,
    shadowTokens: 0,
    shadowUsd: 0,
  };
  let seq = 0;
  let generatedSpanCount = 0;
  let invocationCount = 0;
  let lastTimestampMs = Date.UTC(2026, 5, 26, 0, 0, 0) - 1;

  function invokeTrainableMethod({
    run,
    method,
    request,
    response,
    model,
    tokenUsage = {},
    latencyMs,
    childSpans = [],
    liveEval,
    sensitiveFields = [],
    shadow = false,
  }) {
    const trace = parseTraceparent(run?.traceparent);
    requireString(run?.id, "run.id");
    requireString(run?.tenantId, "run.tenantId");
    requireString(run?.agentId, "run.agentId");
    requireString(method?.name, "method.name");
    requireString(method?.contractRef, "method.contractRef");
    requireString(method?.candidateId, "method.candidateId");
    requireString(model?.provider, "model.provider");
    requireString(model?.name, "model.name");

    const trajectoryId = `trajectory-${run.id}-${++invocationCount}`;
    const totalTokens = normalizeTokenCount(tokenUsage);
    const costUsd = normalizeCost(tokenUsage.costUsd);
    recordCost({ shadow, totalTokens, costUsd });

    const payloads = sanitizeTelemetryPayloads({
      request,
      response,
      sensitiveFields,
      runId: run.id,
      runKeyRef,
      maxInlinePayloadBytes,
    });

    const rootSpanId = nextSpanId();
    const rootSpan = makeSpan({
      trace,
      spanId: rootSpanId,
      parentSpanId: trace.spanId,
      name: method.name,
      kind: "CHAIN",
      attributes: {
        "hobo.run.id": run.id,
        "hobo.tenant.id": run.tenantId,
        "hobo.agent.id": run.agentId,
        "hobo.method.name": method.name,
        "hobo.contract.ref": method.contractRef,
        "hobo.candidate.id": method.candidateId,
        "hobo.shadow": shadow,
        "hobo.cost.counted": !shadow,
        "llm.provider": model.provider,
        "llm.model_name": model.name,
        "llm.token_count.prompt": tokenUsage.prompt ?? 0,
        "llm.token_count.completion": tokenUsage.completion ?? 0,
        "llm.token_count.total": totalTokens,
        "hobo.latency_ms": latencyMs,
      },
      inputs: payloads.request,
      outputs: payloads.response,
    });

    const spans = [
      rootSpan,
      ...childSpans.map((child) =>
        makeSpan({
          trace,
          spanId: nextSpanId(),
          parentSpanId: rootSpanId,
          name: requireString(child.name, "childSpan.name"),
          kind: child.kind ?? "LLM",
          attributes: {
            "hobo.run.id": run.id,
            "hobo.method.name": method.name,
            "hobo.candidate.id": method.candidateId,
            "llm.model_name": model.name,
            ...(child.attributes ?? undefined),
          },
          inputs: sanitizeValue(child.inputs ?? {}, `childSpans.${child.name}.inputs`, new Set(sensitiveFields), {
            runId: run.id,
            runKeyRef,
            maxInlinePayloadBytes,
          }),
          outputs: sanitizeValue(child.outputs ?? {}, `childSpans.${child.name}.outputs`, new Set(sensitiveFields), {
            runId: run.id,
            runKeyRef,
            maxInlinePayloadBytes,
          }),
        }),
      ),
    ];

    const emittedEvents = [];
    const emittedMetrics = [];
    const evalOutcome = evaluateLiveEval({ liveEval, run, method, traceparent: run.traceparent });

    emittedMetrics.push(
      makeMetric({
        name: "ai.method.invocation.rate",
        value: 1,
        run,
        method,
        traceparent: run.traceparent,
        dimensions: { candidateId: method.candidateId, shadow },
      }),
      makeMetric({
        name: "ai.token.cost_per_call",
        value: costUsd,
        run,
        method,
        traceparent: run.traceparent,
        dimensions: { tokens: totalTokens, costCounted: !shadow, shadow },
      }),
      makeMetric({
        name: "ai.shadow_traffic.share",
        value: shadow ? 1 : 0,
        run,
        method,
        traceparent: run.traceparent,
        dimensions: { candidateId: method.candidateId },
      }),
    );

    for (const metric of evalOutcome.metrics) {
      emittedMetrics.push(metric);
    }

    for (const span of spans) {
      emittedEvents.push(
        appendEvent({
          type: "telemetry.OpenInferenceSpanRecorded",
          run,
          traceparent: run.traceparent,
          data: { trajectoryId, span },
        }),
      );
    }
    for (const event of evalOutcome.events) {
      emittedEvents.push(appendEvent(event));
    }

    const trajectory = {
      schema: TRAJECTORY_SCHEMA,
      id: trajectoryId,
      traceparent: run.traceparent,
      run: {
        id: run.id,
        tenantId: run.tenantId,
        agentId: run.agentId,
      },
      method: {
        name: method.name,
        contractRef: method.contractRef,
        candidateId: method.candidateId,
      },
      spans: cloneValue(spans),
      io: payloads,
      reward: evalOutcome.reward,
      correlation: {
        runId: run.id,
        agentId: run.agentId,
        traceId: trace.traceId,
        trajectoryId,
      },
    };

    emittedEvents.push(
      appendEvent({
        type: evalOutcome.reward.status === "incomplete" ? "training.TrajectoryIncomplete" : "training.TrajectoryCaptured",
        run,
        traceparent: run.traceparent,
        data: {
          trajectoryId,
          trajectoryHash: hashValue(trajectory),
          trajectory,
        },
      }),
    );

    for (const metric of emittedMetrics) {
      metricLog.push(metric);
    }

    const exportResult = backend.export({
      schema: OPENINFERENCE_EXPORT_SCHEMA,
      contract: OPENINFERENCE_LIVE_EVAL_STREAM_CONTRACT,
      spans,
      trajectories: [trajectory],
      metrics: emittedMetrics,
      events: emittedEvents,
    });

    return {
      blocked: false,
      response,
      spans: cloneValue(spans),
      trajectory: cloneValue(trajectory),
      events: cloneValue(emittedEvents),
      metrics: cloneValue(emittedMetrics),
      exportResult: cloneValue(exportResult),
    };
  }

  function evaluateLiveEval({ liveEval, run, method, traceparent }) {
    const metrics = [];
    const events = [];

    if (liveEval === undefined) {
      return {
        reward: {
          status: "incomplete",
          reason: "missing-live-eval-reward",
        },
        metrics,
        events,
      };
    }

    requireString(liveEval.rubricRef, "liveEval.rubricRef");

    if (liveEval.error !== undefined) {
      events.push({
        type: "eval.Ran",
        run,
        traceparent,
        data: {
          schema: EVAL_EVENT_SCHEMA,
          semanticFunction: method.name,
          candidateId: method.candidateId,
          rubricRef: liveEval.rubricRef,
          status: "error",
          error: String(liveEval.error),
        },
      });
      return {
        reward: {
          status: "incomplete",
          reason: "live-eval-error",
          rubricRef: liveEval.rubricRef,
        },
        metrics,
        events,
      };
    }

    const scores = validateScores(liveEval.scores);
    const thresholds = validateThresholds(liveEval.thresholds);
    const failures = Object.entries(thresholds)
      .filter(([name, threshold]) => (scores[name] ?? Number.NEGATIVE_INFINITY) < threshold)
      .map(([name, threshold]) => `${name} below ${threshold}`);
    const gate = failures.length === 0 ? "passed" : "failed";

    events.push({
      type: "eval.Ran",
      run,
      traceparent,
      data: {
        schema: EVAL_EVENT_SCHEMA,
        semanticFunction: method.name,
        candidateId: method.candidateId,
        rubricRef: liveEval.rubricRef,
        status: "scored",
        samples: liveEval.samples,
        scores: cloneValue(scores),
      },
    });

    for (const [dimension, value] of Object.entries(scores)) {
      metrics.push(
        makeMetric({
          name: "eval.score",
          value,
          run,
          method,
          traceparent,
          dimensions: { rubricRef: liveEval.rubricRef, dimension, candidateId: method.candidateId },
        }),
      );
    }

    if (isJsonNumber(liveEval.championScore) && isJsonNumber(liveEval.challengerScore)) {
      metrics.push(
        makeMetric({
          name: "eval.champion_challenger.delta",
          value: round(liveEval.challengerScore - liveEval.championScore),
          run,
          method,
          traceparent,
          dimensions: { rubricRef: liveEval.rubricRef, candidateId: method.candidateId },
        }),
      );
    }

    if (gate === "failed") {
      const failureData = {
        semanticFunction: method.name,
        candidateId: method.candidateId,
        schema: EVAL_EVENT_SCHEMA,
        rubricRef: liveEval.rubricRef,
        outcome: "stay-shadow",
        passFlags: { conformance: true, eval: false, policy: true },
        failures,
      };
      events.push(
        {
          type: "eval.GateFailed",
          run,
          traceparent,
          data: failureData,
        },
        {
          type: "slo.BudgetBurned",
          run,
          traceparent,
          data: {
            reason: "eval-gate-failed",
            sourceEventType: "eval.GateFailed",
            semanticFunction: method.name,
            candidateId: method.candidateId,
          },
        },
        {
          type: "resource.DriftDetected",
          run,
          traceparent,
          data: {
            reason: "live-eval-regression",
            sourceEventType: "eval.GateFailed",
            semanticFunction: method.name,
            candidateId: method.candidateId,
          },
        },
      );
    }

    return {
      reward: {
        status: "scored",
        gate,
        rubricRef: liveEval.rubricRef,
        value: liveEval.reward ?? average(Object.values(scores)),
        scores,
        samples: liveEval.samples,
        failures,
      },
      metrics,
      events,
    };
  }

  function makeSpan({ trace, spanId, parentSpanId, name, kind, attributes, inputs, outputs }) {
    if (!OPENINFERENCE_KINDS.has(kind)) {
      throw new TypeError(`span kind must be an OpenInference kind: ${kind}`);
    }
    const startedAt = now();
    const endedAt = now();
    return {
      name,
      traceId: trace.traceId,
      spanId,
      parentSpanId,
      traceparent: `00-${trace.traceId}-${spanId}-${trace.flags}`,
      startedAt,
      endedAt,
      attributes: {
        ...cloneValue(attributes),
        "openinference.span.kind": kind,
      },
      inputs: cloneValue(inputs),
      outputs: cloneValue(outputs),
    };
  }

  function makeMetric({ name, value, run, method, traceparent, dimensions = {} }) {
    return {
      schema: METRIC_SCHEMA,
      name,
      value,
      unit: METRICS_CATALOG.find((entry) => entry.name === name)?.unit ?? "1",
      time: now(),
      attributes: {
        "hobo.run.id": run.id,
        "hobo.agent.id": run.agentId,
        "hobo.method.name": method.name,
        "hobo.candidate.id": method.candidateId,
        ...cloneValue(dimensions),
      },
      meta: { traceparent },
    };
  }

  function appendEvent({ type, run, traceparent, data }) {
    const event = {
      schema: TELEMETRY_ENVELOPE_SCHEMA,
      id: `evt-${seq}`,
      type,
      ...(type.startsWith("eval.")
        ? {
            source: `hobo://semantic-function/${data.semanticFunction}`,
            subject: `semantic-function/${data.semanticFunction}`,
          }
        : undefined),
      streamId: `${type.split(".")[0]}:${run.id}:${methodSafeStream(data)}`,
      seq,
      time: now(),
      data: cloneValue(data),
      meta: { traceparent },
    };
    seq += 1;
    eventLog.push(event);
    return event;
  }

  function nextSpanId() {
    const value =
      spanIds.shift() ?? createHash("sha256").update(`span-${seq}-${generatedSpanCount++}`).digest("hex").slice(0, 16);
    if (!/^[0-9a-f]{16}$/.test(value) || value === "0000000000000000") {
      throw new TypeError("spanId must be 16 lowercase hex characters and not all zeroes");
    }
    return value;
  }

  function now() {
    const value = clock.shift();
    if (value === undefined) {
      lastTimestampMs += 1;
      return new Date(lastTimestampMs).toISOString();
    }
    const timestamp = isJsonNumber(value) ? value : Date.parse(value);
    if (Number.isNaN(timestamp)) {
      throw new TypeError("clock values must be timestamps");
    }
    lastTimestampMs = Math.max(lastTimestampMs, timestamp);
    return new Date(timestamp).toISOString();
  }

  function recordCost({ shadow, totalTokens, costUsd }) {
    if (shadow) {
      cost.shadowTokens += totalTokens;
      cost.shadowUsd = round(cost.shadowUsd + costUsd);
      return;
    }
    cost.billableTokens += totalTokens;
    cost.billableUsd = round(cost.billableUsd + costUsd);
  }

  return {
    invokeTrainableMethod,
    eventLog: () => cloneValue(eventLog),
    metrics: () => cloneValue(metricLog),
    metricsCatalog: () => cloneValue(METRICS_CATALOG),
    costSummary: () => cloneValue(cost),
  };
}

export function createMockOpenInferenceBackend() {
  const exports = [];

  return {
    export(payload) {
      if (payload?.schema !== OPENINFERENCE_EXPORT_SCHEMA) {
        throw new TypeError(`payload.schema must be ${OPENINFERENCE_EXPORT_SCHEMA}`);
      }
      for (const span of payload.spans ?? []) {
        requireString(span.traceId, "span.traceId");
        requireString(span.spanId, "span.spanId");
        requireString(span.parentSpanId, "span.parentSpanId");
        if (!span.attributes?.["openinference.span.kind"]) {
          throw new TypeError("span must include openinference.span.kind");
        }
      }
      exports.push(cloneValue(payload));
      return { accepted: true, exportedSpans: payload.spans?.length ?? 0 };
    },
    exports() {
      return cloneValue(exports);
    },
  };
}

function sanitizeTelemetryPayloads({ request, response, sensitiveFields, runId, runKeyRef, maxInlinePayloadBytes }) {
  const sensitive = new Set(sensitiveFields);
  const options = { runId, runKeyRef, maxInlinePayloadBytes };
  return {
    request: sanitizeValue(request, "request", sensitive, options),
    response: sanitizeValue(response, "response", sensitive, options),
  };
}

function sanitizeValue(value, path, sensitiveFields, options) {
  if (sensitiveFields.has(path)) {
    if (!options.runKeyRef) {
      throw new TypeError(`sensitive field ${path} requires a per-run key reference`);
    }
    return {
      classification: "pii",
      redaction: "encrypted",
      encryptedRef: `run://${options.runId}/payloads/${path}`,
      runKeyRef: options.runKeyRef,
      ciphertext: `enc:sha256:${hashRaw(`${options.runKeyRef}:${path}:${String(value)}`)}`,
    };
  }
  if (isJsonString(value) && Buffer.byteLength(value, "utf8") > options.maxInlinePayloadBytes) {
    return {
      redaction: "offloaded",
      offloadRef: `run://${options.runId}/offload/${hashRaw(`${path}:${value}`)}`,
      byteLength: Buffer.byteLength(value, "utf8"),
      digest: `sha256:${hashRaw(value)}`,
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => sanitizeValue(entry, `${path}.${index}`, sensitiveFields, options));
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, sanitizeValue(entry, `${path}.${key}`, sensitiveFields, options)]),
    );
  }
  return value;
}

function validateScores(scores) {
  if (!scores || !isJsonObject(scores) || Array.isArray(scores)) {
    throw new TypeError("liveEval.scores must be an object");
  }
  for (const [name, value] of Object.entries(scores)) {
    requireString(name, "score name");
    if (!isJsonNumber(value) || value < 0 || value > 1) {
      throw new TypeError(`score ${name} must be between 0 and 1`);
    }
  }
  return cloneValue(scores);
}

function validateThresholds(thresholds) {
  if (!thresholds || !isJsonObject(thresholds) || Array.isArray(thresholds)) {
    throw new TypeError("liveEval.thresholds must be an object");
  }
  for (const [name, value] of Object.entries(thresholds)) {
    requireString(name, "threshold name");
    if (!isJsonNumber(value) || value < 0 || value > 1) {
      throw new TypeError(`threshold ${name} must be between 0 and 1`);
    }
  }
  return cloneValue(thresholds);
}

function parseTraceparent(value) {
  const match = TRACEPARENT_PATTERN.exec(value ?? "");
  if (!match) {
    throw new TypeError("run.traceparent must be a valid W3C traceparent");
  }
  const [, traceId, spanId, flags] = match;
  if (traceId === "00000000000000000000000000000000" || spanId === "0000000000000000") {
    throw new TypeError("run.traceparent must not contain all-zero trace or span ids");
  }
  return { traceId, spanId, flags };
}

function normalizeTokenCount(tokenUsage) {
  const prompt = tokenUsage.prompt ?? 0;
  const completion = tokenUsage.completion ?? 0;
  if (!Number.isFinite(prompt) || prompt < 0 || !Number.isFinite(completion) || completion < 0) {
    throw new TypeError("tokenUsage prompt and completion must be non-negative numbers");
  }
  return prompt + completion;
}

function normalizeCost(costUsd) {
  if (costUsd === undefined) {
    return 0;
  }
  if (!isJsonNumber(costUsd) || costUsd < 0) {
    throw new TypeError("tokenUsage.costUsd must be a non-negative number");
  }
  return costUsd;
}

function methodSafeStream(data) {
  return data?.semanticFunction ?? data?.trajectoryId ?? "telemetry";
}

function average(values) {
  return values.length === 0 ? 0 : round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function round(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

function hashValue(value) {
  return `sha256:${hashRaw(JSON.stringify(sortKeys(value)))}`;
}

function hashRaw(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireString(value, name) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function cloneValue(value) {
  if (Array.isArray(value)) {
    return value.map(cloneValue);
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, childValue]) => [key, cloneValue(childValue)]));
  }
  return value;
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
