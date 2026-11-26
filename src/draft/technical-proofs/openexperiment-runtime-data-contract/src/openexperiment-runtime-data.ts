import { isJsonString, isJsonObject } from "./json.js";
const maxBasisPoints = 10_000;
const traceparentPattern = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;
const trafficModes = new Set(["sampled", "full"]);

export class OpenExperimentRuntimeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OpenExperimentRuntimeError";
    this.code = code;
  }
}

export function createOpenExperimentRuntime(options = {}) {
  const assignments = new Map();
  const exposures = new Map();
  const eventLog = [];
  const clock = Array.isArray(options.clock) ? [...options.clock] : null;
  let eventSeq = 0;

  function assign(definition, input = {}) {
    const experiment = normalizeExperiment(definition);
    const context = normalizeEvaluationContext(input.evaluationContext);
    const subject = subjectFromContext(context);
    const subjectKey = subjectKeyFromContext(context);
    const key = assignmentKey(experiment.key, subjectKey);
    const existing = assignments.get(key);

    if (existing) {
      return {
        assignment: { ...cloneValue(existing.assignment), pinned: true },
        event: cloneValue(existing.event)
      };
    }

    const bucket = stableBucket(`${experiment.flagKey}:${experiment.key}`, subjectKey);
    const variant = pickVariant(experiment.variants, bucket);
    const trace = parseTraceparent(input.traceparent);
    const sampling = samplingMarker(experiment, subjectKey);
    const assignment = {
      experimentKey: experiment.key,
      flagKey: experiment.flagKey,
      subject,
      subjectKey,
      variantKey: variant.key,
      flagVariant: variant.flagVariant,
      bucket,
      allocationSeq: experiment.allocationSeq,
      metricRefs: cloneValue(experiment.metricRefs),
      sampling,
      assignedAt: nextTime(),
      pinned: false
    };
    const event = appendEvent("experiment.Assigned", experiment.key, subjectKey, {
      experimentKey: assignment.experimentKey,
      flagKey: assignment.flagKey,
      subject: assignment.subject,
      subjectKey: assignment.subjectKey,
      variantKey: assignment.variantKey,
      flagVariant: assignment.flagVariant,
      bucket: assignment.bucket,
      allocationSeq: assignment.allocationSeq,
      sampling: assignment.sampling,
      trace
    });

    assignments.set(key, {
      assignment: cloneValue(assignment),
      event: cloneValue(event)
    });

    return {
      assignment: cloneValue(assignment),
      event: cloneValue(event)
    };
  }

  function recordExposure(assignment, input = {}) {
    assertObject(assignment, "assignment");

    if (input.influenced !== true) {
      return {
        emitted: false,
        reason: "variant-not-used"
      };
    }

    const experimentKey = requireString(assignment.experimentKey, "assignment.experimentKey");
    const subjectKey = requireString(assignment.subjectKey, "assignment.subjectKey");
    const key = assignmentKey(experimentKey, subjectKey);
    const existing = exposures.get(key);

    if (existing) {
      return {
        emitted: false,
        reason: "already-exposed",
        event: cloneValue(existing)
      };
    }

    const trace = parseTraceparent(input.traceparent);
    const event = appendEvent("experiment.Exposed", experimentKey, subjectKey, {
      experimentKey,
      flagKey: requireString(assignment.flagKey, "assignment.flagKey"),
      subject: cloneValue(assignment.subject),
      subjectKey,
      variantKey: requireString(assignment.variantKey, "assignment.variantKey"),
      flagVariant: requireString(assignment.flagVariant, "assignment.flagVariant"),
      sampling: cloneValue(assignment.sampling),
      trace,
      metricRefs: metricJoinRefs(assignment.metricRefs, trace)
    });

    exposures.set(key, cloneValue(event));

    return {
      emitted: true,
      event: cloneValue(event)
    };
  }

  function appendEvent(type, experimentKey, subjectKey, data) {
    eventSeq += 1;
    const id = `${experimentKey}:${eventSeq}`;
    const event = {
      type,
      version: 1,
      id,
      streamId: `experiment:${experimentKey}:${subjectKey}`,
      time: nextTime(),
      data: cloneValue(data)
    };

    if (event.data.metricRefs) {
      event.data.metricRefs = event.data.metricRefs.map((metricRef) => ({
        ...metricRef,
        eventId: id
      }));
    }

    eventLog.push(cloneValue(event));
    return event;
  }

  function nextTime() {
    return clock?.shift() ?? new Date(0).toISOString();
  }

  return {
    assign,
    recordExposure,
    events: () => eventLog.map(cloneValue)
  };
}

export function projectExposureStream(events, options = {}) {
  const traffic = options.traffic ?? "sampled";
  if (!trafficModes.has(traffic)) {
    throw new TypeError(`unknown exposure traffic mode ${traffic}`);
  }

  const exposures = events.filter((event) => event?.type === "experiment.Exposed");
  if (
    traffic === "full" &&
    exposures.some((event) => event.data?.sampling?.population !== "full")
  ) {
    throw new OpenExperimentRuntimeError(
      "sampled-stream-not-full",
      "sampled exposure stream cannot be read as full traffic"
    );
  }

  return exposures.map(cloneValue);
}

function normalizeExperiment(definition) {
  assertObject(definition, "experiment definition");
  const experiment = {
    key: requireString(definition.key, "experiment key"),
    flagKey: requireString(definition.flagKey, "flag key"),
    allocationSeq: normalizeInteger(definition.allocationSeq ?? 1, "allocationSeq"),
    sampleRatioBasisPoints: normalizeBasisPoints(
      definition.sampleRatioBasisPoints ?? maxBasisPoints,
      "sample ratio"
    ),
    variants: normalizeVariants(definition.variants),
    metricRefs: normalizeMetricRefs(definition.metricRefs)
  };

  return experiment;
}

function normalizeVariants(variants) {
  if (!Array.isArray(variants) || variants.length < 2) {
    throw new TypeError("experiment definition requires at least two variants");
  }

  const seen = new Set();
  let total = 0;

  const normalized = variants.map((variant) => {
    assertObject(variant, "variant");
    const key = requireString(variant.key, "variant key");
    if (seen.has(key)) {
      throw new TypeError(`duplicate variant key ${key}`);
    }
    seen.add(key);

    const allocationBasisPoints = normalizeBasisPoints(
      variant.allocationBasisPoints,
      "variant allocation"
    );
    total += allocationBasisPoints;

    return {
      key,
      flagVariant: requireString(variant.flagVariant, "flag variant"),
      allocationBasisPoints
    };
  });

  if (total !== maxBasisPoints) {
    throw new TypeError("variant allocations must total 10000 basis points");
  }

  return normalized;
}

function normalizeMetricRefs(metricRefs) {
  if (!Array.isArray(metricRefs) || metricRefs.length === 0) {
    throw new TypeError("experiment definition requires metric refs");
  }

  return metricRefs.map((metricRef) => {
    assertObject(metricRef, "metric ref");
    return {
      name: requireString(metricRef.name, "metric name"),
      source: requireString(metricRef.source, "metric source"),
      role: metricRef.role ?? "secondary"
    };
  });
}

function normalizeEvaluationContext(context) {
  assertObject(context, "evaluation context");
  if (isJsonString(context.targetingKey) && context.targetingKey.length > 0) {
    return context;
  }
  subjectFromContext(context);
  return context;
}

function subjectFromContext(context) {
  const subject = context.user ?? context.identity;
  assertObject(subject, "evaluation context subject");
  requireString(subject.id, "subject id");
  return cloneValue(subject);
}

function subjectKeyFromContext(context) {
  if (isJsonString(context.targetingKey) && context.targetingKey.length > 0) {
    return context.targetingKey;
  }

  const subject = subjectFromContext(context);
  return subject.tenant ? `${subject.tenant}:${subject.id}` : subject.id;
}

function assignmentKey(experimentKey, subjectKey) {
  return `${experimentKey}\0${subjectKey}`;
}

function pickVariant(variants, bucket) {
  let cursor = 0;
  for (const variant of variants) {
    cursor += variant.allocationBasisPoints;
    if (bucket < cursor) {
      return variant;
    }
  }
  return variants.at(-1);
}

function samplingMarker(experiment, subjectKey) {
  const sampleBucket = stableBucket(`sample:${experiment.key}`, subjectKey);
  return {
    population: "sampled",
    sampled: sampleBucket < experiment.sampleRatioBasisPoints,
    rateBasisPoints: experiment.sampleRatioBasisPoints
  };
}

function metricJoinRefs(metricRefs = [], trace) {
  if (!Array.isArray(metricRefs) || metricRefs.length === 0) {
    throw new TypeError("assignment requires metric refs");
  }

  return metricRefs.map((metricRef) => ({
    name: requireString(metricRef.name, "metric name"),
    source: requireString(metricRef.source, "metric source"),
    role: metricRef.role ?? "secondary",
    traceId: trace.traceId,
    spanId: trace.spanId
  }));
}

function parseTraceparent(traceparent) {
  const value = requireString(traceparent, "traceparent");
  const match = traceparentPattern.exec(value);
  if (!match) {
    throw new TypeError("traceparent must use W3C traceparent format");
  }

  const [, traceId, spanId, flags] = match;
  return {
    traceparent: value.toLowerCase(),
    traceId: traceId.toLowerCase(),
    spanId: spanId.toLowerCase(),
    flags: flags.toLowerCase()
  };
}

function stableBucket(flagKey, subjectKey) {
  const input = `${flagKey}\0${subjectKey}`;
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0) % maxBasisPoints;
}

function normalizeBasisPoints(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > maxBasisPoints) {
    throw new TypeError(`${label} must be 0..10000 basis points`);
  }
  return value;
}

function normalizeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function assertObject(value, name) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function requireString(value, label) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${label} is required`);
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
