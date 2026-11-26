import { isJsonString, isJsonObject } from "./json.js";
export function createProjectionStore({
  name,
  sink = { type: "native", reactive: true },
  indexKeys = [],
  rows = [],
} = {}) {
  return new ProjectionStore({ name, sink, indexKeys, rows });
}

export function tenantContext(tenantId) {
  return Object.freeze({ tenantId: assertString(tenantId, "tenantId") });
}

export function eq(field, value) {
  return Object.freeze({
    op: "eq",
    field: assertString(field, "predicate field"),
    value,
  });
}

function inPredicate(field, values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError("in requires at least one value");
  }

  return Object.freeze({
    op: "in",
    field: assertString(field, "predicate field"),
    values: Object.freeze(values.map(clone)),
  });
}

export { inPredicate as in };

export function range(field, { gte, lte } = {}) {
  if (gte === undefined && lte === undefined) {
    throw new TypeError("range requires gte or lte");
  }

  return Object.freeze({
    op: "range",
    field: assertString(field, "predicate field"),
    ...(gte === undefined ? undefined : { gte }),
    ...(lte === undefined ? undefined : { lte }),
  });
}

export function and(...predicates) {
  const all = predicates.flatMap((predicate) => flattenPredicate(predicate));
  if (all.length === 0) {
    throw new TypeError("and requires at least one predicate");
  }

  return Object.freeze({ all: Object.freeze(all.map(clone)) });
}

export function snapshot(store) {
  assertStore(store);
  return store.snapshot();
}

export function repo(store, name) {
  assertProjection(store, name);
  return Object.freeze({
    get(id, context) {
      return store.get(assertString(id, "id"), context);
    },
    find(predicate, context) {
      return store.find(predicate, context);
    },
  });
}

export function view(store, name, context) {
  assertProjection(store, name);
  return Object.freeze({
    where(predicate) {
      return Object.freeze({
        asLiveView() {
          return store.find(predicate, context, { liveView: true });
        },
        snapshot() {
          return store.find(predicate, context);
        },
      });
    },
  });
}

export function useQuery(store, name, context) {
  return view(store, name, context);
}

export function runDoctor(store) {
  assertStore(store);
  return Object.freeze({
    warnings: Object.freeze(store.warnings().map(clone)),
  });
}

class ProjectionStore {
  #rows = new Map();
  #warnings = new Map();

  constructor({ name, sink, indexKeys, rows }) {
    this.name = assertString(name, "projection name");
    this.sink = normalizeSink(sink);
    this.indexKeys = new Set(indexKeys.map((key) => assertString(key, "index key")));

    for (const row of rows) {
      const normalized = normalizeRow(row);
      this.#rows.set(normalized.id, normalized);
    }
  }

  snapshot() {
    const rows = this.#allRows();
    return Object.freeze({
      projection: this.name,
      cache: "hit",
      rows: Object.freeze(rows),
      seq: Object.freeze(seqVector(rows)),
    });
  }

  get(id, context) {
    const tenantId = this.#tenantId(context);
    const row = this.#rows.get(id);
    const visible = row && row.tenantId === tenantId ? clone(row) : null;

    return Object.freeze({
      cache: "hit",
      row: visible,
      seq: Object.freeze(visible ? { [visible.streamId]: visible.seq } : {}),
    });
  }

  find(predicate, context, { liveView = false } = {}) {
    const tenantId = this.#tenantId(context);
    const terms = flattenPredicate(predicate);

    if (liveView && !this.sink.reactive) {
      this.#warn({
        code: "NON_REACTIVE_LIVE_VIEW",
        projection: this.name,
        severity: "reactivity-risk",
        sink: this.sink.type,
      });
    }

    for (const term of terms) {
      if (term.field === "tenantId" && !tenantPredicateAllowsOnly(term, tenantId)) {
        throw new Error("cross-tenant predicate denied");
      }
      if (!this.indexKeys.has(term.field)) {
        this.#warn({
          code: "NON_INDEXED_PREDICATE",
          field: term.field,
          projection: this.name,
          severity: "cost-risk",
        });
      }
    }

    const appliedTerms = [
      ...terms.filter((term) => term.field !== "tenantId"),
      { field: "tenantId", op: "eq", value: tenantId, source: "platform" },
    ];
    const rows = this.#allRows().filter((row) => row.tenantId === tenantId && terms.every((term) => matches(row, term)));

    return Object.freeze({
      cache: "hit",
      rows: Object.freeze(rows),
      seq: Object.freeze(seqVector(rows)),
      appliedPredicate: Object.freeze({ all: Object.freeze(appliedTerms.map(clone)) }),
    });
  }

  warnings() {
    return [...this.#warnings.values()].sort(compareWarnings).map(clone);
  }

  #tenantId(context) {
    if (!context || !isJsonString(context.tenantId) || context.tenantId.length === 0) {
      throw new Error("tenant scope required");
    }
    return context.tenantId;
  }

  #allRows() {
    return [...this.#rows.values()].sort((left, right) => left.id.localeCompare(right.id)).map(clone);
  }

  #warn(warning) {
    this.#warnings.set(JSON.stringify(stableValue(warning)), Object.freeze(clone(warning)));
  }
}

function normalizeSink(sink) {
  if (!sink || !isJsonObject(sink)) {
    throw new TypeError("sink must be an object");
  }
  return Object.freeze({
    type: assertString(sink.type, "sink.type"),
    reactive: Boolean(sink.reactive),
  });
}

function normalizeRow(row) {
  if (!row || !isJsonObject(row)) {
    throw new TypeError("row must be an object");
  }
  return Object.freeze({
    ...clone(row),
    id: assertString(row.id, "row.id"),
    streamId: assertString(row.streamId, "row.streamId"),
    seq: assertSeq(row.seq),
  });
}

function flattenPredicate(predicate) {
  if (!predicate || !isJsonObject(predicate)) {
    throw new TypeError("predicate is required");
  }
  if (Array.isArray(predicate.all)) {
    return predicate.all.flatMap((entry) => flattenPredicate(entry));
  }
  if (predicate.op === "eq") {
    return [clone(predicate)];
  }
  if (predicate.op === "in") {
    if (!Array.isArray(predicate.values) || predicate.values.length === 0) {
      throw new TypeError("in requires at least one value");
    }
    return [clone(predicate)];
  }
  if (predicate.op === "range") {
    if (predicate.gte === undefined && predicate.lte === undefined) {
      throw new TypeError("range requires gte or lte");
    }
    return [clone(predicate)];
  }

  throw new TypeError(`unsupported predicate operator: ${predicate.op ?? "unknown"}`);
}

function matches(row, term) {
  if (term.op === "eq") {
    return row[term.field] === term.value;
  }
  if (term.op === "in") {
    return term.values.includes(row[term.field]);
  }
  if (term.op === "range") {
    const value = row[term.field];
    return (term.gte === undefined || value >= term.gte) && (term.lte === undefined || value <= term.lte);
  }

  throw new TypeError(`unsupported predicate operator: ${term.op}`);
}

function tenantPredicateAllowsOnly(term, tenantId) {
  if (term.op === "eq") {
    return term.value === tenantId;
  }
  if (term.op === "in") {
    return term.values.length === 1 && term.values[0] === tenantId;
  }
  return false;
}

function seqVector(rows) {
  return stableObject(
    rows.reduce((seq, row) => {
      seq[row.streamId] = Math.max(seq[row.streamId] ?? 0, row.seq);
      return seq;
    }, {}),
  );
}

function assertProjection(store, name) {
  assertStore(store);
  if (name !== store.name) {
    throw new TypeError(`unknown projection: ${name}`);
  }
}

function assertStore(store) {
  if (!(store instanceof ProjectionStore)) {
    throw new TypeError("expected a projection store");
  }
}

function assertString(value, label) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function assertSeq(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("row.seq must be a non-negative safe integer");
  }
  return value;
}

function compareWarnings(left, right) {
  return JSON.stringify(stableValue(left)).localeCompare(JSON.stringify(stableValue(right)));
}

function stableObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)));
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

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone instanceof Function ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}
