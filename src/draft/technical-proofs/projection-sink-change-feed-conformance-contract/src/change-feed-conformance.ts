export const CHANGE_FEED_CAPABILITY = "change-feed";
export const DATA_CHANGED_EVENT_TYPE = "data.Changed";
export const PROJECTION_DECLARED_EVENT_TYPE = "projection.Declared";
export const CONFORMANCE_SUITE = "@hobo/conformance/projection-sink-change-feed";

export const PROJECTION_SINK_PARADIGMS = Object.freeze([
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

const VALID_PARADIGMS = new Set(PROJECTION_SINK_PARADIGMS);
const VALID_OPS = new Set(["insert", "update", "delete"]);
const VALID_CONSISTENCY = new Set([
  "strong",
  "bounded-staleness",
  "session",
  "consistent-prefix",
  "eventual",
]);
const tagOf = Object.prototype.toString;

export function nativeLogSink() {
  return freezeSink({
    type: "projection-sink",
    kind: "native",
    paradigm: "native",
    capabilities: [],
  });
}

export function projectionSink(input) {
  if (!input || !isObjectTag(input) || Array.isArray(input)) {
    throw new TypeError("projection sink must be an object");
  }

  return freezeSink({
    ...input,
    type: "projection-sink",
    kind: requiredString(input.kind, "sink.kind"),
    paradigm: requireParadigm(input.paradigm),
    capabilities: normalizeCapabilities(input.capabilities ?? []),
  });
}

export function declareProjectionContract(input) {
  if (!input || !isObjectTag(input) || Array.isArray(input)) {
    throw new TypeError("projection contract input is required");
  }

  const sink = input.sink ? projectionSink(input.sink) : nativeLogSink();
  const reactivity = classifyReactivity(sink);
  const consistency = input.consistency ?? "session";
  if (!VALID_CONSISTENCY.has(consistency)) {
    throw new TypeError(`unknown consistency level: ${consistency}`);
  }

  const projection = {
    name: requiredString(input.name, "projection.name"),
    readModel: requiredString(input.readModel, "projection.readModel"),
    readSet: normalizeReadSet(input.readSet),
    sink,
    consistency,
    reactive: reactivity.reactive,
    reactivityClass: reactivity.reactive ? "reactive" : "non-reactive",
    reactivitySource: reactivity.source,
  };

  return Object.freeze({
    ...projection,
    projectionDeclared: projectionDeclared(projection),
  });
}

export function classifyReactivity(sinkInput) {
  const sink = projectionSink(sinkInput);
  if (sink.kind === "native" || sink.paradigm === "native") {
    return Object.freeze({
      reactive: true,
      source: "native-log",
      reason: "native log is the change stream",
    });
  }

  if (sink.capabilities.includes(CHANGE_FEED_CAPABILITY)) {
    return Object.freeze({
      reactive: true,
      source: "sink-change-feed",
      reason: "projection sink advertises change-feed",
    });
  }

  return Object.freeze({
    reactive: false,
    source: "no-change-feed",
    reason: "projection sink does not advertise change-feed",
  });
}

export function projectionDeclared(projection) {
  return Object.freeze({
    type: PROJECTION_DECLARED_EVENT_TYPE,
    data: Object.freeze({
      name: projection.name,
      readModel: projection.readModel,
      readSet: projection.readSet,
      consistency: projection.consistency,
      reactivityClass: projection.reactivityClass,
      reactivity: Object.freeze({
        reactive: projection.reactive,
        source: projection.reactivitySource,
      }),
      sink: projection.sink,
      reusedEventFamily: DATA_CHANGED_EVENT_TYPE,
    }),
  });
}

export function doctorLiveView(projection) {
  if (projection.reactive) {
    return [];
  }

  return [
    Object.freeze({
      code: "non-reactive-live-view",
      severity: "warning",
      projection: projection.name,
      message:
        '"use query" depends on a non-change-feed projection sink; use snapshot/repo reads or select a native/change-feed sink for live updates.',
    }),
  ];
}

export function assertLiveView(projection) {
  if (!projection.reactive) {
    throw new TypeError(`${projection.name} is not reactive`);
  }

  return projection;
}

export function readSnapshot(projection, rows, options = {}) {
  if (!Array.isArray(rows)) {
    throw new TypeError("snapshot rows must be an array");
  }

  return Object.freeze({
    mode: "snapshot",
    projection: projection.name,
    reactive: projection.reactive,
    seq: Number.isSafeInteger(options.seq) ? options.seq : 0,
    rows: deepFreeze(rows.map(clone)),
  });
}

export function dataChanged(input) {
  const resource = requiredString(input.resource, "data.Changed.resource");
  const key = requiredString(input.key, "data.Changed.key");
  const op = requireOp(input.op);
  const seq = requireSeq(input.seq, "data.Changed.seq");

  return Object.freeze({
    type: DATA_CHANGED_EVENT_TYPE,
    streamId: input.streamId ?? `data/${resource}`,
    seq,
    data: Object.freeze({
      resource,
      key,
      op,
    }),
  });
}

export function runOrderedFeedConformance({ sink, expectedChanges, observedEvents }) {
  const candidate = projectionSink(sink);
  const expected = normalizeExpectedChanges(expectedChanges);
  const observed = Array.isArray(observedEvents) ? observedEvents.map(normalizeObservedEvent) : [];
  const failures = [];

  if (!candidate.capabilities.includes(CHANGE_FEED_CAPABILITY)) {
    failures.push(failure("missing-change-feed-capability", "sink does not advertise change-feed"));
  }

  if (observed.length < expected.length) {
    for (let index = observed.length; index < expected.length; index += 1) {
      failures.push(failure("missing-change", `missing ${changeLabel(expected[index])}`, { index }));
    }
  }

  if (observed.length > expected.length) {
    for (let index = expected.length; index < observed.length; index += 1) {
      failures.push(failure("unexpected-change", `unexpected ${changeLabel(observed[index])}`, { index }));
    }
  }

  const comparableCount = Math.min(expected.length, observed.length);
  for (let index = 0; index < comparableCount; index += 1) {
    const expectedChange = expected[index];
    const observedChange = observed[index];
    if (!sameChange(expectedChange, observedChange)) {
      failures.push(
        failure(
          "unexpected-change-order",
          `expected ${changeLabel(expectedChange)} at ${index}, got ${changeLabel(observedChange)}`,
          { index },
        ),
      );
    }
  }

  failures.push(...findOutOfOrderSeq(observed));
  failures.push(...findDoubleEmits(expected, observed));

  return Object.freeze({
    ok: failures.length === 0,
    suite: CONFORMANCE_SUITE,
    sink: candidate,
    observed: observed.length,
    expected: expected.length,
    failures: Object.freeze(failures),
  });
}

function normalizeExpectedChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new TypeError("expectedChanges must contain at least one change");
  }

  return changes.map((change) =>
    Object.freeze({
      resource: requiredString(change.resource, "expected.resource"),
      key: requiredString(change.key, "expected.key"),
      op: requireOp(change.op),
    }),
  );
}

function normalizeObservedEvent(event) {
  if (!event || !isObjectTag(event) || Array.isArray(event)) {
    throw new TypeError("observed event must be an object");
  }
  if (event.type !== DATA_CHANGED_EVENT_TYPE) {
    throw new TypeError(`observed event type must be ${DATA_CHANGED_EVENT_TYPE}`);
  }

  return Object.freeze({
    resource: requiredString(event.data?.resource, "observed.resource"),
    key: requiredString(event.data?.key, "observed.key"),
    op: requireOp(event.data?.op),
    seq: requireSeq(event.seq, "observed.seq"),
  });
}

function findOutOfOrderSeq(observed) {
  const failures = [];
  const lastByKey = new Map();
  for (let index = 0; index < observed.length; index += 1) {
    const change = observed[index];
    const key = `${change.resource}\0${change.key}`;
    const last = lastByKey.get(key);
    if (last !== undefined && change.seq <= last.seq) {
      failures.push(
        failure(
          "out-of-order-seq",
          `${change.resource}/${change.key} seq ${change.seq} does not follow ${last.seq}`,
          { index },
        ),
      );
    }
    lastByKey.set(key, change);
  }
  return failures;
}

function findDoubleEmits(expected, observed) {
  const expectedCounts = countChanges(expected);
  const observedCounts = countChanges(observed);
  const failures = [];

  for (const [change, count] of observedCounts) {
    const expectedCount = expectedCounts.get(change) ?? 0;
    if (count > expectedCount) {
      failures.push(
        failure("double-emitted-change", `${change} emitted ${count} times; expected ${expectedCount}`),
      );
    }
  }

  return failures;
}

function countChanges(changes) {
  const counts = new Map();
  for (const change of changes) {
    const key = changeLabel(change);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

function sameChange(left, right) {
  return left.resource === right.resource && left.key === right.key && left.op === right.op;
}

function changeLabel(change) {
  return `${change.resource}/${change.key}/${change.op}`;
}

function failure(code, message, extra = {}) {
  return Object.freeze({ code, message, ...extra });
}

function normalizeCapabilities(capabilities) {
  if (!Array.isArray(capabilities)) {
    throw new TypeError("sink.capabilities must be an array");
  }
  return Object.freeze([...new Set(capabilities.map((capability) => requiredString(capability, "sink capability")))]);
}

function normalizeReadSet(readSet) {
  if (!Array.isArray(readSet) || readSet.length === 0) {
    throw new TypeError("readSet must contain at least one event type");
  }
  return Object.freeze([...new Set(readSet.map((eventType) => requiredString(eventType, "readSet event type")))]);
}

function requireParadigm(paradigm) {
  if (!VALID_PARADIGMS.has(paradigm)) {
    throw new TypeError(`unknown projection-sink paradigm: ${paradigm}`);
  }
  return paradigm;
}

function requireOp(op) {
  if (!VALID_OPS.has(op)) {
    throw new TypeError(`data.Changed.op must be one of ${[...VALID_OPS].join(", ")}`);
  }
  return op;
}

function requireSeq(seq, field) {
  if (!Number.isSafeInteger(seq) || seq < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer`);
  }
  return seq;
}

function requiredString(value, field) {
  if (!isString(value) || value.length === 0) {
    throw new TypeError(`${field} is required`);
  }
  return value;
}

function freezeSink(sink) {
  return Object.freeze({
    ...sink,
    capabilities: Object.freeze([...(sink.capabilities ?? [])]),
  });
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(deepFreeze));
  }
  if (value && isObjectTag(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepFreeze(item)])));
  }
  return value;
}

function clone(value) {
  return structuredClone instanceof Function ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function isString(value) {
  return tagOf.call(value) === "[object String]";
}

function isObjectTag(value) {
  return tagOf.call(value) === "[object Object]";
}
