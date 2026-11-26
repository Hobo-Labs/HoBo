import { isJsonString, isJsonObject } from "./json.js";
const writeCapabilities = new Set(["step", "emit", "append", "write", "command"]);

export class ProjectionFoldError extends Error {
  constructor({ projection, event, cause }) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(`projection fold failed for ${projection} at ${event.streamId}@${event.seq}: ${message}`);
    this.name = "ProjectionFoldError";
    this.projection = projection;
    this.event = clone(event);
    this.cause = cause;
  }
}

export function projection(name, input) {
  const on = normalizeHandlers(input.on);

  return defineNativeProjection({
    ...input,
    name,
    readSet: Object.keys(on),
    fold: (state, event, context) => on[event.type](state, event, context),
  });
}

export function defineNativeProjection(input) {
  const readSet = normalizeReadSet(input.readSet);
  const capabilitiesUsed = [...(input.capabilitiesUsed ?? [])];
  const disallowed = capabilitiesUsed.filter((capability) => writeCapabilities.has(capability));

  if (disallowed.length > 0) {
    throw new Error(`projection fold must be deterministic and read-only; disallowed: ${disallowed.join(", ")}`);
  }

  assertFunction(input.key, "key");
  assertFunction(input.fold, "fold");

  return Object.freeze({
    name: assertNonEmpty(input.name, "name"),
    readModel: assertNonEmpty(input.readModel, "readModel"),
    rowSchema: normalizeRowSchema(input.rowSchema, input.readModel),
    readSet,
    key: input.key,
    fold: input.fold,
    initialState: clone(input.initialState ?? {}),
    indexHints: Object.freeze(normalizeStringList(input.indexHints ?? [])),
    reactivity: Object.freeze({
      class: "reactive",
      source: "native-log",
      reason: "event log is the change stream",
    }),
    sink: Object.freeze({
      type: "projection-sink",
      paradigm: "native",
      reactive: true,
    }),
  });
}

export function declareNativeProjection(projection, envelope) {
  return Object.freeze({
    type: "projection.Declared",
    streamId: assertNonEmpty(envelope.streamId, "streamId"),
    seq: assertSeq(envelope.seq, "seq"),
    data: Object.freeze({
      name: projection.name,
      readModel: projection.readModel,
      rowSchema: projection.rowSchema,
      readSet: projection.readSet,
      reactivityClass: projection.reactivity.class,
      sink: projection.sink,
      indexHints: projection.indexHints,
    }),
  });
}

export function createNativeProjectionLog(seedEvents = []) {
  return new NativeProjectionLog(seedEvents);
}

class NativeProjectionLog {
  #events = [];

  constructor(seedEvents) {
    for (const event of seedEvents) {
      this.append(event);
    }
  }

  append(event) {
    const normalized = normalizeEvent(event);
    this.#events = [...this.#events, normalized].sort(compareEventOrder);
    return clone(normalized);
  }

  materialize(projection) {
    const rows = new Map();
    const seq = {};
    const readSet = new Set(projection.readSet);

    for (const event of this.#events) {
      if (!readSet.has(event.type)) {
        continue;
      }

      try {
        const rowKey = projection.key(clone(event));
        assertNonEmpty(rowKey, "projection row key");
        const prior = rows.has(rowKey) ? rows.get(rowKey) : clone(projection.initialState);
        rows.set(rowKey, clone(projection.fold(clone(prior), clone(event), foldContext(event))));
      } catch (cause) {
        throw new ProjectionFoldError({ projection: projection.name, event, cause });
      }

      seq[event.streamId] = Math.max(seq[event.streamId] ?? 0, event.seq);
    }

    return Object.freeze({
      projection: projection.name,
      readModel: projection.readModel,
      rowSchema: projection.rowSchema,
      readSet: projection.readSet,
      reactivity: projection.reactivity,
      seq: stableObject(seq),
      rows: Object.freeze([...rows.entries()].sort(([left], [right]) => left.localeCompare(right)).map(clone)),
    });
  }
}

function normalizeHandlers(on) {
  if (!on || !isJsonObject(on)) {
    throw new Error("on must be an event handler map");
  }

  const entries = Object.entries(on);
  if (entries.length === 0) {
    throw new Error("on must contain at least one event handler");
  }

  for (const [eventType, handler] of entries) {
    assertNonEmpty(eventType, "on event type");
    assertFunction(handler, `handler for ${eventType}`);
  }

  return Object.freeze(Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right))));
}

function foldContext(event) {
  return Object.freeze({
    streamId: event.streamId,
    seq: event.seq,
    eventType: event.type,
    reactivity: "native-log",
  });
}

function normalizeEvent(event) {
  if (!event || !isJsonObject(event)) {
    throw new Error("event must be an object");
  }

  return Object.freeze({
    ...clone(event),
    streamId: assertNonEmpty(event.streamId, "event.streamId"),
    type: assertNonEmpty(event.type, "event.type"),
    seq: assertSeq(event.seq, "event.seq"),
  });
}

function compareEventOrder(left, right) {
  return (
    left.streamId.localeCompare(right.streamId) ||
    left.seq - right.seq ||
    left.type.localeCompare(right.type) ||
    String(left.id ?? "").localeCompare(String(right.id ?? ""))
  );
}

function normalizeReadSet(readSet) {
  if (!Array.isArray(readSet) || readSet.length === 0) {
    throw new Error("readSet must be a non-empty array");
  }

  return Object.freeze([...new Set(readSet.map((eventType) => assertNonEmpty(eventType, "readSet event type")))].sort());
}

function normalizeRowSchema(rowSchema, readModel) {
  if (!rowSchema || !isJsonObject(rowSchema)) {
    throw new Error("rowSchema must describe the read-model WIT record");
  }

  const rawFields = Array.isArray(rowSchema.fields)
    ? rowSchema.fields.map((field) => [field.name, field.type])
    : Object.entries(rowSchema.fields ?? {});
  if (rawFields.length === 0) {
    throw new Error("rowSchema.fields must contain at least one field");
  }

  return Object.freeze({
    witRecord: assertNonEmpty(rowSchema.witRecord ?? readModel, "rowSchema.witRecord"),
    fields: Object.freeze(
      rawFields
        .map(([name, type]) =>
          Object.freeze({
            name: assertNonEmpty(name, "rowSchema field name"),
            type: assertNonEmpty(type, `rowSchema field type for ${name}`),
          }),
        )
        .sort((left, right) => left.name.localeCompare(right.name)),
    ),
  });
}

function normalizeStringList(values) {
  return [...new Set(values.map((value) => assertNonEmpty(value, "string list value")))].sort();
}

function assertFunction(value, field) {
  if (!(value instanceof Function)) {
    throw new Error(`${field} must be a function`);
  }
}

function assertNonEmpty(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }

  return value;
}

function assertSeq(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }

  return value;
}

function stableObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone instanceof Function ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}
