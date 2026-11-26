import { EventEmitter } from "node:events";
import { isJsonString, isJsonObject } from "./json.js";


let nextMaterializationId = 1;

export function createEventLog(seedEvents = []) {
  return new EventLog(seedEvents);
}

export function from(...eventTypes) {
  if (eventTypes.length === 0 || eventTypes.some((eventType) => !isJsonString(eventType) || eventType.length === 0)) {
    throw new Error("from() requires at least one event type");
  }

  return new Materialization({
    kind: "pipeline",
    eventTypes,
    predicates: [],
    operators: [],
  });
}

export function subscribe(log, materialization, options = {}) {
  if (!(log instanceof EventLog)) {
    throw new Error("subscribe requires an EventLog");
  }
  if (!isMaterialization(materialization)) {
    throw new Error("subscribe requires a materialization");
  }

  let current = log.evaluate(materialization);
  options.onValue?.(clone(current.data), clone(current));

  const onAppend = (event) => {
    if (!materialization.matches(event)) {
      return;
    }

    const next = log.evaluate(materialization);
    if (stableStringify(next) === stableStringify(current)) {
      return;
    }

    current = next;
    options.onValue?.(clone(current.data), clone(current));
  };

  log.on("append", onAppend);

  return {
    current: () => clone(current),
    unsubscribe: () => log.off("append", onAppend),
  };
}

export function createUseSubscriptionProbe(log, materialization, args = {}) {
  let value;
  let renderCount = 0;
  const subscription = subscribe(log, materialization.withArgs(args), {
    onValue(data, snapshot) {
      value = clone(snapshot);
      renderCount += 1;
    },
  });

  return {
    value: () => clone(value),
    renderCount: () => renderCount,
    unsubscribe: subscription.unsubscribe,
  };
}

export function useQuery(log, materialization, args = {}) {
  return subscribe(log, materialization.withArgs(args));
}

export function map(project) {
  assertFunction(project, "map");
  return { type: "map", project };
}

export function filter(predicate) {
  assertFunction(predicate, "filter");
  return { type: "filter", predicate };
}

export function scan(reducer, initialValue) {
  assertFunction(reducer, "scan");
  return { type: "scan", reducer, initialValue: clone(initialValue) };
}

export function fold(reducer, initialValue) {
  assertFunction(reducer, "fold");
  return { type: "fold", reducer, initialValue: clone(initialValue) };
}

export function distinctUntilChanged(compare = stableEqual) {
  assertFunction(compare, "distinctUntilChanged");
  return { type: "distinctUntilChanged", compare };
}

export function combineLatest(sources) {
  if (!sources || !isJsonObject(sources) || Array.isArray(sources)) {
    throw new Error("combineLatest requires a named source object");
  }

  for (const [name, source] of Object.entries(sources)) {
    if (!isJsonString(name) || name.length === 0 || !isMaterialization(source)) {
      throw new Error("combineLatest sources must be named materializations");
    }
  }

  return new Materialization({
    kind: "combineLatest",
    sources,
  });
}

export function join(source, options = {}) {
  if (!isMaterialization(source)) {
    throw new Error("join requires a materialization");
  }

  const { leftKey, rightKey, project = (left, right) => ({ left, right }) } = options;
  assertFunction(leftKey, "join.leftKey");
  assertFunction(rightKey, "join.rightKey");
  assertFunction(project, "join.project");

  return { type: "join", source, leftKey, rightKey, project };
}

export function window(size) {
  assertPositiveInteger(size, "window.size");
  return { type: "window", size };
}

export function buffer(size) {
  assertPositiveInteger(size, "buffer.size");
  return { type: "buffer", size };
}

export function debounce({ ms, seed } = {}) {
  assertPositiveInteger(ms, "debounce.ms");
  if (!isJsonString(seed) || seed.length === 0) {
    throw new Error("debounce requires a deterministic seed");
  }
  return { type: "debounce", ms, seed };
}

export function coalesce() {
  return { type: "coalesce" };
}

class EventLog extends EventEmitter {
  #events = [];
  #version = 0;
  #cache = new Map();

  constructor(seedEvents) {
    super();
    this.#events = normalizeEvents(seedEvents);
  }

  append(event) {
    const normalized = normalizeEvent(event);
    this.#events = normalizeEvents([...this.#events, normalized]);
    this.#version += 1;
    this.#cache.clear();
    this.emit("append", clone(normalized));
    return normalized;
  }

  evaluate(materialization) {
    const cacheKey = `${materialization.id}:${this.#version}`;
    const cached = this.#cache.get(cacheKey);
    if (cached) {
      return clone(cached);
    }

    const result = materialization.evaluate(this.#events);
    this.#cache.set(cacheKey, clone(result));
    return result;
  }
}

class Materialization {
  constructor(definition) {
    this.id = nextMaterializationId;
    nextMaterializationId += 1;
    this.definition = definition;
    this.args = {};
  }

  where(predicate) {
    assertFunction(predicate, "where");
    return this.#extend({
      predicates: [...(this.definition.predicates ?? []), predicate],
    });
  }

  pipe(...operators) {
    for (const operator of operators) {
      if (!operator || !isJsonString(operator.type)) {
        throw new Error("pipe expects read-surface operators");
      }
    }

    return this.#extend({
      operators: [...(this.definition.operators ?? []), ...operators],
    });
  }

  withArgs(args = {}) {
    const next = this.#extend({});
    next.args = clone(args);
    return next;
  }

  matches(event) {
    if (this.definition.kind === "combineLatest") {
      return Object.values(this.definition.sources).some((source) => source.matches(event));
    }

    return (
      this.definition.eventTypes.includes(event.type) ||
      this.definition.operators.some((operator) => operator.source?.matches(event))
    );
  }

  evaluate(events) {
    if (this.definition.kind === "combineLatest") {
      const data = {};
      let seq = {};
      for (const [name, source] of Object.entries(this.definition.sources)) {
        const result = source.withArgs(this.args).evaluate(events);
        data[name] = Array.isArray(result.data) ? result.data.at(-1) : result.data;
        seq = mergeSeq(seq, result.seq);
      }
      return { data: stableObject(data), seq, stale: false };
    }

    const selected = events
      .filter((event) => this.definition.eventTypes.includes(event.type))
      .filter((event) => this.definition.predicates.every((predicate) => predicate(clone(event), this.args)))
      .map(clone);

    const data = applyOperators(selected, this.definition.operators, this.args, events);

    return {
      data,
      seq: mergeSeq(seqVector(selected), operatorSeq(this.definition.operators, this.args, events)),
      stale: false,
    };
  }

  #extend(patch) {
    const next = new Materialization({
      ...this.definition,
      ...patch,
    });
    next.args = clone(this.args);
    return next;
  }
}

function operatorSeq(operators, args, events) {
  let seq = {};
  for (const operator of operators) {
    if (operator.source) {
      seq = mergeSeq(seq, operator.source.withArgs(args).evaluate(events).seq);
    }
  }
  return seq;
}

function applyOperators(input, operators, args, events) {
  let value = clone(input);

  for (const operator of operators) {
    switch (operator.type) {
      case "filter":
        value = asArray(value).filter((entry) => operator.predicate(clone(entry), args));
        break;
      case "map":
        value = asArray(value).map((entry) => operator.project(clone(entry), args));
        break;
      case "scan":
      case "fold":
        value = asArray(value).reduce(
          (state, entry) => operator.reducer(clone(state), clone(entry), args),
          clone(operator.initialValue),
        );
        break;
      case "distinctUntilChanged":
        if (Array.isArray(value)) {
          value = value.filter((entry, index, entries) => index === 0 || !operator.compare(entries[index - 1], entry));
        }
        break;
      case "join": {
        const joined = [];
        const rightResult = operator.source.withArgs(args).evaluate(events);
        const rightByKey = new Map();

        for (const right of asArray(rightResult.data).filter((entry) => entry !== undefined)) {
          const key = stableStringify(operator.rightKey(clone(right), args));
          rightByKey.set(key, [...(rightByKey.get(key) ?? []), right]);
        }

        for (const left of asArray(value)) {
          const key = stableStringify(operator.leftKey(clone(left), args));
          for (const right of rightByKey.get(key) ?? []) {
            joined.push(operator.project(clone(left), clone(right), args));
          }
        }

        value = joined;
        break;
      }
      case "window":
        value = trailingWindows(asArray(value), operator.size);
        break;
      case "buffer":
        value = chunks(asArray(value), operator.size);
        break;
      case "debounce":
        value = asArray(value).length === 0 ? [] : [asArray(value).at(-1)];
        break;
      case "coalesce":
        value = asArray(value).at(-1);
        break;
      default:
        throw new Error(`unknown read-surface operator: ${operator.type}`);
    }
  }

  return clone(value);
}

function trailingWindows(entries, size) {
  if (entries.length < size) {
    return [];
  }
  return [entries.slice(entries.length - size)];
}

function chunks(entries, size) {
  const result = [];
  for (let index = 0; index < entries.length; index += size) {
    result.push(entries.slice(index, index + size));
  }
  return result;
}

function asArray(value) {
  return Array.isArray(value) ? value : [value];
}

function normalizeEvents(events) {
  return events.map(normalizeEvent).sort(compareCanonicalEventOrder);
}

function normalizeEvent(event) {
  if (!event || !isJsonObject(event)) {
    throw new Error("event must be an object");
  }
  assertNonEmpty(event.streamId, "event.streamId");
  assertNonEmpty(event.type, "event.type");
  assertNonNegativeInteger(event.seq, "event.seq");
  return clone(event);
}

function compareCanonicalEventOrder(left, right) {
  return (
    left.streamId.localeCompare(right.streamId) ||
    left.seq - right.seq ||
    String(left.type).localeCompare(String(right.type)) ||
    String(left.id ?? "").localeCompare(String(right.id ?? ""))
  );
}

function seqVector(events) {
  return stableObject(
    events.reduce((position, event) => {
      position[event.streamId] = Math.max(position[event.streamId] ?? 0, event.seq);
      return position;
    }, {}),
  );
}

function mergeSeq(left, right) {
  const merged = { ...left };
  for (const [streamId, seq] of Object.entries(right)) {
    merged[streamId] = Math.max(merged[streamId] ?? 0, seq);
  }
  return stableObject(merged);
}

function isMaterialization(value) {
  return value instanceof Materialization;
}

function assertFunction(value, field) {
  if (!(value instanceof Function)) {
    throw new Error(`${field} requires a function`);
  }
}

function assertPositiveInteger(value, field) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
}

function assertNonNegativeInteger(value, field) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative integer`);
  }
}

function assertNonEmpty(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function stableEqual(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (value && isJsonObject(value)) {
    return stableObject(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, stableValue(entry)])));
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
