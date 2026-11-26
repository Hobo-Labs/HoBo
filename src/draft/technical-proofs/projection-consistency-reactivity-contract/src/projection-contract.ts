export const PROJECTION_DECLARED_EVENT_TYPE = "projection.Declared";

export const CONSISTENCY_LEVELS = Object.freeze([
  "strong",
  "bounded-staleness",
  "session",
  "consistent-prefix",
  "eventual",
]);

const VALID_CONSISTENCY_LEVELS = new Set(CONSISTENCY_LEVELS);
const VALID_CAMP_SCOPES = new Set(["single-camp", "cross-camp"]);
const tagOf = Object.prototype.toString;

export function nativeSink() {
  return freezeSink({
    kind: "native",
    paradigm: "native",
    capabilities: [],
  });
}

export function projectionSink(sink) {
  if (!sink || !isObjectTag(sink)) {
    throw new TypeError("projection sink must be an object");
  }

  if (!sink.kind || !isString(sink.kind)) {
    throw new TypeError("projection sink kind is required");
  }

  if (!sink.paradigm || !isString(sink.paradigm)) {
    throw new TypeError("projection sink paradigm is required");
  }

  return freezeSink({
    ...sink,
    capabilities: [...(sink.capabilities ?? [])],
  });
}

export function declareProjection(spec) {
  if (!spec || !isObjectTag(spec)) {
    throw new TypeError("projection spec is required");
  }

  const name = requiredString(spec.name, "projection name");
  const readModel = requiredString(spec.readModel, "read model");
  const eventTypes = requireNonEmptyStrings(spec.eventTypes, "event types");
  const sink = spec.sink ? projectionSink(spec.sink) : nativeSink();
  const consistency = spec.consistency ?? "session";
  const scope = spec.scope ?? "single-camp";

  if (!VALID_CONSISTENCY_LEVELS.has(consistency)) {
    throw new TypeError(`Unknown consistency level: ${consistency}`);
  }

  if (!VALID_CAMP_SCOPES.has(scope)) {
    throw new TypeError(`Unknown projection scope: ${scope}`);
  }

  const reactivity = classifyReactivity(sink);
  const projection = {
    name,
    readModel,
    eventTypes,
    sink,
    consistency,
    scope,
    reactive: reactivity.reactive,
    reactivityClass: reactivity.reactive ? "reactive" : "non-reactive",
  };

  return Object.freeze({
    ...projection,
    projectionDeclared: makeProjectionDeclaredEvent(projection, reactivity),
  });
}

export function makeProjectionDeclaredEvent(projection, reactivity = classifyReactivity(projection.sink)) {
  return Object.freeze({
    type: PROJECTION_DECLARED_EVENT_TYPE,
    payload: Object.freeze({
      projection: projection.name,
      readModel: projection.readModel,
      readSet: Object.freeze([...projection.eventTypes]),
      consistency: projection.consistency,
      matchDecided: Object.freeze({
        outcome: "match.Decided",
        consistencyLevel: projection.consistency,
      }),
      reactivity: Object.freeze({
        class: reactivity.reactive ? "reactive" : "non-reactive",
        reactive: reactivity.reactive,
        source: reactivity.source,
      }),
      sink: Object.freeze({
        kind: projection.sink.kind,
        paradigm: projection.sink.paradigm,
        capabilities: Object.freeze([...(projection.sink.capabilities ?? [])]),
      }),
    }),
  });
}

export function doctorUseQuery(projection) {
  if (projection.reactive) {
    return [];
  }

  return [
    Object.freeze({
      code: "non-reactive-use-query",
      severity: "warning",
      projection: projection.name,
      message:
        '"use query" depends on a non-reactive projection sink; use snapshot/repo reads or choose native/change-feed sink for live updates.',
    }),
  ];
}

export function assessConsistencyTradeoffs(projection) {
  if (projection.consistency === "strong" && projection.scope === "cross-camp") {
    return [
      Object.freeze({
        code: "strong-cross-camp-tradeoff",
        severity: "warning",
        projection: projection.name,
        preservedLevel: "strong",
        message:
          "Strong cross-Camp consistency is preserved but must be surfaced as a latency/cost tradeoff.",
      }),
    ];
  }

  return [];
}

export function assertReactiveProjection(projection) {
  if (!projection.reactive) {
    throw new TypeError(`${projection.name} is not reactive`);
  }

  return projection;
}

export function assertNonReactiveProjection(projection) {
  if (projection.reactive) {
    throw new TypeError(`${projection.name} is reactive`);
  }

  return projection;
}

function classifyReactivity(sink) {
  if (sink.kind === "native") {
    return { reactive: true, source: "native-log" };
  }

  if ((sink.capabilities ?? []).includes("change-feed")) {
    return { reactive: true, source: "sink-change-feed" };
  }

  return { reactive: false, source: "no-change-feed" };
}

function requiredString(value, label) {
  if (!isString(value) || value.length === 0) {
    throw new TypeError(`${label} is required`);
  }

  return value;
}

function requireNonEmptyStrings(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must contain at least one entry`);
  }

  for (const entry of value) {
    if (!isString(entry) || entry.length === 0) {
      throw new TypeError(`${label} must contain only non-empty strings`);
    }
  }

  return Object.freeze([...value]);
}

function isString(value) {
  return tagOf.call(value) === "[object String]";
}

function isObjectTag(value) {
  return tagOf.call(value) === "[object Object]";
}

function freezeSink(sink) {
  return Object.freeze({
    ...sink,
    capabilities: Object.freeze([...(sink.capabilities ?? [])]),
  });
}
