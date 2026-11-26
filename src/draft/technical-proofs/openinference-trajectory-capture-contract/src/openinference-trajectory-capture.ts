import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const OPENINFERENCE_TRAJECTORY_CAPTURE_CONTRACT = "hobo.openinference-trajectory-capture/v1";
export const TRAJECTORY_SCHEMA = "hobo.training.trajectory/v1";
export const EVENT_SCHEMA = "hobo.event-envelope/v1";

const TRACEPARENT_PATTERN = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;
const OPENINFERENCE_KINDS = new Set([
  "CHAIN",
  "LLM",
  "TOOL",
  "RETRIEVER",
  "RERANKER",
  "EMBEDDING",
  "AGENT",
  "GUARDRAIL",
  "EVALUATOR",
  "PROMPT",
]);

export function createTrajectoryCaptureRuntime(options = {}) {
  const eventLog = [];
  const spanIds = [...(options.spanIds ?? [])];
  const clock = [...(options.clock ?? [])];
  const retention = {
    traceTtlDays: options.retention?.traceTtlDays ?? 7,
    trajectoryTtlDays: options.retention?.trajectoryTtlDays ?? 30,
  };
  const sampling = {
    capture: options.sampling?.capture !== false,
    reason: options.sampling?.reason ?? "always-capture",
  };
  const runKeyRef = options.runKeyRef;
  let seq = 0;
  let generatedSpanCount = 0;
  let lastTimestampMs = Date.UTC(2026, 5, 25, 0, 0, 0) - 1;
  let invocationNumber = 0;

  function invokeTrainedMethod({
    run,
    method,
    inputs = {},
    outputs = {},
    childSpans = [],
    rewardSlot,
    sensitiveFields = [],
  }) {
    const parentTrace = parseTraceparent(run?.traceparent);
    requireString(run?.id, "run.id");
    requireString(run?.tenantId, "run.tenantId");
    requireString(run?.agentId, "run.agentId");
    requireString(method?.name, "method.name");
    requireString(method?.contractRef, "method.contractRef");
    requireGeneratedRegion(method?.generatedRegion);
    requireString(rewardSlot?.rubricRef, "rewardSlot.rubricRef");

    const trajectoryId = `trajectory-${run.id}-${++invocationNumber}`;

    if (!sampling.capture) {
      appendEvent({
        type: "training.TrajectorySampledOut",
        runId: run.id,
        traceparent: run.traceparent,
        data: {
          trajectoryId,
          methodName: method.name,
          reason: sampling.reason,
          sampling: { captured: false, reason: sampling.reason },
          retention,
        },
      });
      return { captured: false, trajectory: null, trajectoryId };
    }

    const payloads = sanitizePayloads({
      inputs,
      outputs,
      sensitiveFields,
      runId: run.id,
      runKeyRef,
    });
    const rootSpanId = nextSpanId();
    const rootSpan = makeSpan({
      id: rootSpanId,
      parentId: parentTrace.spanId,
      traceId: parentTrace.traceId,
      name: method.name,
      kind: "CHAIN",
      attributes: {
        "hobo.run.id": run.id,
        "hobo.agent.id": run.agentId,
        "hobo.contract.ref": method.contractRef,
        "openinference.span.kind": "CHAIN",
      },
      inputs: payloads.inputs,
      outputs: payloads.outputs,
    });

    const spans = [
      rootSpan,
      ...childSpans.map((span) =>
        makeSpan({
          id: nextSpanId(),
          parentId: rootSpanId,
          traceId: parentTrace.traceId,
          name: requireString(span.name, "childSpan.name"),
          kind: span.kind ?? "LLM",
          attributes: span.attributes ?? {},
          inputs: span.inputs ?? {},
          outputs: span.outputs ?? {},
        }),
      ),
    ];

    const trajectory = {
      schema: TRAJECTORY_SCHEMA,
      id: trajectoryId,
      traceparent: run.traceparent,
      run: {
        id: run.id,
        tenantId: run.tenantId,
        agentId: run.agentId,
      },
      subject: {
        method: method.name,
        contractRef: method.contractRef,
        generatedRegion: clone(method.generatedRegion),
      },
      spans,
      payloads,
      reward: clone(rewardSlot),
      retention,
      sampling: { captured: true, reason: sampling.reason },
    };

    for (const span of spans) {
      appendEvent({
        type: "telemetry.OpenInferenceSpanRecorded",
        runId: run.id,
        traceparent: run.traceparent,
        data: {
          trajectoryId,
          span,
          retention,
        },
      });
    }

    appendEvent({
      type: "training.TrajectoryCaptured",
      runId: run.id,
      traceparent: run.traceparent,
      data: {
        trajectoryId,
        trajectoryHash: hashTrajectory(trajectory),
        trajectory,
        retention,
      },
    });

    return { captured: true, trajectory: clone(trajectory), trajectoryId };
  }

  function recordCandidateProvenance({ candidateId, trajectoryIds, generatedRegion }) {
    requireString(candidateId, "candidateId");
    if (!Array.isArray(trajectoryIds) || trajectoryIds.length === 0) {
      throw new TypeError("trajectoryIds must be a non-empty array");
    }
    if (generatedRegion !== undefined) {
      requireGeneratedRegion(generatedRegion);
    }

    appendEvent({
      type: "training.CandidateProposed",
      runId: "training",
      traceparent: "00-ffffffffffffffffffffffffffffffff-ffffffffffffffff-01",
      data: {
        candidateId,
        trajectoryIds: [...trajectoryIds],
        generatedRegion: generatedRegion === undefined ? undefined : clone(generatedRegion),
      },
    });
  }

  function appendEvent({ type, runId, traceparent, data }) {
    const event = {
      schema: EVENT_SCHEMA,
      id: `evt-${seq}`,
      type,
      streamId: `training:${runId}`,
      seq,
      time: now(),
      data: clone(data),
      meta: {
        traceparent,
      },
    };
    seq += 1;
    eventLog.push(event);
    return event;
  }

  function makeSpan({ id, parentId, traceId, name, kind, attributes, inputs, outputs }) {
    if (!OPENINFERENCE_KINDS.has(kind)) {
      throw new TypeError(`span kind must be an OpenInference kind: ${kind}`);
    }
    const startedAt = now();
    const endedAt = now();
    return {
      id,
      parentId,
      traceId,
      name,
      startedAt,
      endedAt,
      attributes: {
        ...clone(attributes),
        "openinference.span.kind": kind,
      },
      inputs: clone(inputs),
      outputs: clone(outputs),
    };
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
    const timestamp = value === undefined ? lastTimestampMs + 1 : Date.parse(value);
    if (Number.isNaN(timestamp)) {
      throw new TypeError("clock values must be ISO-8601 timestamps");
    }
    lastTimestampMs = Math.max(lastTimestampMs, timestamp);
    return new Date(timestamp).toISOString();
  }

  return {
    invokeTrainedMethod,
    recordCandidateProvenance,
    eventLog: () => clone(eventLog),
  };
}

export function reconstructTrajectoryFromLog(events, trajectoryId) {
  requireString(trajectoryId, "trajectoryId");
  const ordered = orderEvents(events);
  const captured = ordered.find(
    (event) => event.type === "training.TrajectoryCaptured" && event.data?.trajectoryId === trajectoryId,
  );

  if (!captured) {
    const spanEvidence = ordered.some(
      (event) => event.type === "telemetry.OpenInferenceSpanRecorded" && event.data?.trajectoryId === trajectoryId,
    );
    if (spanEvidence) {
      throw new Error("audit invariant: OpenInference spans exist but trajectory was not appended");
    }
    const sampledOut = ordered.find(
      (event) => event.type === "training.TrajectorySampledOut" && event.data?.trajectoryId === trajectoryId,
    );
    if (sampledOut) {
      throw new Error(`trajectory ${trajectoryId} was sampled out: ${sampledOut.data.reason}`);
    }
    throw new Error(`trajectory ${trajectoryId} not found`);
  }

  const trajectory = clone(captured.data.trajectory);
  if (captured.data.trajectoryHash !== hashTrajectory(trajectory)) {
    throw new Error(`trajectory ${trajectoryId} hash mismatch`);
  }

  const spanEvents = ordered.filter(
    (event) => event.type === "telemetry.OpenInferenceSpanRecorded" && event.data?.trajectoryId === trajectoryId,
  );
  for (const span of trajectory.spans ?? []) {
    if (!spanEvents.some((event) => event.data.span?.id === span.id)) {
      throw new Error(`audit invariant: trajectory span ${span.id} missing from log`);
    }
  }

  return trajectory;
}

export function recoverCandidateTrajectorySet(events, candidateId) {
  requireString(candidateId, "candidateId");
  const ordered = orderEvents(events);
  const candidate = ordered.find(
    (event) => event.type === "training.CandidateProposed" && event.data?.candidateId === candidateId,
  );
  if (!candidate) {
    throw new Error(`candidate ${candidateId} provenance not found`);
  }

  return candidate.data.trajectoryIds.map((trajectoryId) => {
    const trajectory = reconstructTrajectoryFromLog(ordered, trajectoryId);
    return {
      trajectory,
      hash: hashTrajectory(trajectory),
    };
  });
}

export function hashTrajectory(trajectory) {
  return `sha256:${createHash("sha256").update(canonicalJson(trajectory)).digest("hex")}`;
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sanitizePayloads({ inputs, outputs, sensitiveFields, runId, runKeyRef }) {
  const sensitive = new Set(sensitiveFields);
  return {
    inputs: sanitizeValue(inputs, "inputs", sensitive, runId, runKeyRef),
    outputs: sanitizeValue(outputs, "outputs", sensitive, runId, runKeyRef),
  };
}

function sanitizeValue(value, path, sensitiveFields, runId, runKeyRef) {
  if (sensitiveFields.has(path)) {
    if (!runKeyRef) {
      throw new TypeError(`sensitive field ${path} requires a per-run key reference`);
    }
    return {
      classification: "pii",
      redaction: "encrypted",
      encryptedRef: `run://${runId}/payloads/${path}`,
      runKeyRef,
      ciphertext: `enc:sha256:${createHash("sha256").update(`${runKeyRef}:${path}:${String(value)}`).digest("hex")}`,
    };
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => sanitizeValue(entry, `${path}.${index}`, sensitiveFields, runId, runKeyRef));
  }
  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        sanitizeValue(entry, `${path}.${key}`, sensitiveFields, runId, runKeyRef),
      ]),
    );
  }
  return value;
}

function parseTraceparent(value) {
  const match = TRACEPARENT_PATTERN.exec(value ?? "");
  if (!match) {
    throw new TypeError("run.traceparent must be a valid W3C traceparent");
  }
  const [, traceId, spanId, flags] = match;
  return { traceId, spanId, flags };
}

function requireString(value, name) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function requireGeneratedRegion(region) {
  if (!region || !isJsonObject(region) || Array.isArray(region)) {
    throw new TypeError("generatedRegion must be an object");
  }
  requireString(region.regionId, "generatedRegion.regionId");
  requireString(region.artifactRef, "generatedRegion.artifactRef");
  if (!Number.isInteger(region.startOffset) || region.startOffset < 0) {
    throw new TypeError("generatedRegion.startOffset must be a non-negative integer");
  }
  if (!Number.isInteger(region.endOffset) || region.endOffset <= region.startOffset) {
    throw new TypeError("generatedRegion.endOffset must be greater than startOffset");
  }
}

function orderEvents(events) {
  if (!Array.isArray(events)) {
    throw new TypeError("events must be an array");
  }
  return [...events].sort((left, right) => left.seq - right.seq || left.id.localeCompare(right.id));
}

function clone(value) {
  return value === undefined ? value : structuredClone(value);
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
