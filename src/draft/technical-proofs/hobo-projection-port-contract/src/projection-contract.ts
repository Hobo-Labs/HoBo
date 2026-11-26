import { isJsonString } from "./json.js";
export const sinkParadigms = Object.freeze([
  "native",
  "relational",
  "document",
  "kv",
  "wide-column",
  "graph",
  "vector",
  "object-lake",
  "olap",
]);

const consistencyLevels = new Set([
  "strong",
  "bounded-staleness",
  "session",
  "consistent-prefix",
  "eventual",
]);

const reactivityClasses = new Set(["reactive", "non-reactive"]);
const writeCapabilities = new Set(["step", "emit", "append", "write", "command"]);

export function nativeLogSink() {
  return Object.freeze({
    type: "projection-sink",
    paradigm: "native",
    reactive: true,
  });
}

export function projectionSpec(input) {
  const spec = {
    name: requiredString(input.name, "name"),
    readModel: requiredString(input.readModel, "readModel"),
    readSet: validateReadSet(input.readSet),
    fold: requiredString(input.fold, "fold"),
    capabilitiesUsed: [...(input.capabilitiesUsed ?? [])],
    reactivity: validateMember(input.reactivity, reactivityClasses, "reactivity"),
    consistency: validateMember(input.consistency, consistencyLevels, "consistency"),
    sink: validateSink(input.sink),
  };

  return Object.freeze({
    ...spec,
    readSet: Object.freeze(spec.readSet),
    capabilitiesUsed: Object.freeze(spec.capabilitiesUsed),
  });
}

export function createProjectionPort(options = {}) {
  const knownEventTypes = new Set(options.knownEventTypes ?? []);
  const registeredSinks = new Set(options.registeredSinkParadigms ?? sinkParadigms);
  const declared = new Map();
  const eventStore = createEventStore();

  return Object.freeze({
    sinkParadigms,
    eventStore,

    declare(spec) {
      validateKnownReadSet(spec, knownEventTypes);
      validateReadOnlyFold(spec);

      if (!registeredSinks.has(spec.sink.paradigm)) {
        return sinkRequirementMiss(spec, spec.sink.paradigm);
      }

      declared.set(spec.name, spec);
      return projectionDeclared(spec, {
        streamId: `projection/${spec.name}`,
        seq: 0,
      }).data;
    },

    materialize(name) {
      const spec = getDeclared(declared, name);
      return {
        projection: spec.name,
        seq: eventStore.lastSeq(`projection/${spec.name}`),
        encodedJson: JSON.stringify({ readModel: spec.readModel }),
      };
    },

    rebuild(name) {
      return this.materialize(name);
    },

    read(query) {
      return this.materialize(query.projection);
    },

    readRaw(call) {
      return {
        ...this.materialize(call.projection),
        rawDriver: call.driver,
      };
    },
  });
}

export function projectionDeclared(spec, envelope) {
  return eventEnvelope("projection.Declared", envelope, {
    name: spec.name,
    readModel: spec.readModel,
    readSet: [...spec.readSet],
    reactivity: spec.reactivity,
    consistency: spec.consistency,
    sink: spec.sink,
  });
}

export function projectionLagged(name, input) {
  if (!Number.isFinite(input.observedLagMs) || input.observedLagMs < 0) {
    throw new Error("observedLagMs must be non-negative");
  }
  if (!Number.isFinite(input.boundMs) || input.boundMs < 0) {
    throw new Error("boundMs must be non-negative");
  }

  return eventEnvelope("projection.Lagged", input, {
    name,
    observedLagMs: input.observedLagMs,
    boundMs: input.boundMs,
    policyInput: input.policyInput === true,
  });
}

export function projectionSinkRebound(name, input) {
  return eventEnvelope("projection.SinkRebound", input, {
    name,
    matchDecisionId: requiredString(input.matchDecisionId, "matchDecisionId"),
    from: validateSink(input.from),
    to: validateSink(input.to),
    reusedEventFamilies: {
      matchDecision: "match.Decided",
      changeFeed: "data.Changed",
      schemaChange: "migration.*",
      adoption: "resource.Adopted",
    },
  });
}

export function sinkRequirementMiss(spec, paradigm) {
  return Object.freeze({
    ok: false,
    reason: "require-miss",
    projection: spec.name,
    missing: {
      type: "projection-sink",
      paradigm,
    },
    event: "deployment.PlanRejected",
  });
}

function createEventStore() {
  const streams = new Map();

  return Object.freeze({
    append(streamId, event, options = {}) {
      const stream = streams.get(streamId) ?? [];
      if (options.expectedSeq !== undefined && options.expectedSeq !== stream.length) {
        throw new Error(`stale seq for ${streamId}: expected ${options.expectedSeq}, got ${stream.length}`);
      }

      stream.push(event);
      streams.set(streamId, stream);
      return event;
    },

    read(streamId) {
      return [...(streams.get(streamId) ?? [])];
    },

    replay(streamId) {
      return this.read(streamId);
    },

    lastSeq(streamId) {
      return streams.get(streamId)?.length ?? 0;
    },
  });
}

function eventEnvelope(type, envelope, data) {
  return Object.freeze({
    type,
    streamId: requiredString(envelope.streamId, "streamId"),
    seq: validateSeq(envelope.seq),
    data: Object.freeze(data),
  });
}

function validateKnownReadSet(spec, knownEventTypes) {
  for (const eventType of spec.readSet) {
    if (!knownEventTypes.has(eventType)) {
      throw new Error(`unknown event type: ${eventType}`);
    }
  }
}

function validateReadOnlyFold(spec) {
  const used = spec.capabilitiesUsed.filter((capability) => writeCapabilities.has(capability));
  if (used.length > 0) {
    throw new Error(`projection fold must be deterministic and read-only; disallowed: ${used.join(", ")}`);
  }
}

function validateReadSet(readSet) {
  if (!Array.isArray(readSet) || readSet.length === 0) {
    throw new Error("readSet must contain at least one event type");
  }

  return [...new Set(readSet.map((eventType) => requiredString(eventType, "readSet event type")))];
}

function validateSink(sink) {
  if (!sink || sink.type !== "projection-sink") {
    throw new Error("sink must be a projection-sink");
  }

  return Object.freeze({
    type: "projection-sink",
    paradigm: validateMember(sink.paradigm, new Set(sinkParadigms), "sink.paradigm"),
    reactive: sink.reactive === true,
  });
}

function validateMember(value, allowed, field) {
  if (!allowed.has(value)) {
    throw new Error(`invalid ${field}: ${value}`);
  }

  return value;
}

function requiredString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} is required`);
  }

  return value;
}

function validateSeq(seq) {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new Error("seq must be a non-negative safe integer");
  }

  return seq;
}

function getDeclared(declared, name) {
  const spec = declared.get(name);
  if (!spec) {
    throw new Error(`projection not declared: ${name}`);
  }

  return spec;
}
