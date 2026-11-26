import { isJsonString, isJsonNumber, isJsonObject } from "./json.js";
export function defineTextIndex(input) {
  assertObject(input, "text index");
  const fields = normalizeStringList(input.fields, "index.fields");
  const filterFields = new Set(normalizeStringList(input.filterFields ?? [], "index.filterFields"));
  filterFields.add("tenantId");

  return Object.freeze({
    name: assertNonEmptyString(input.name, "index.name"),
    kind: "full-text",
    fields: Object.freeze(fields),
    filterFields: Object.freeze([...filterFields].sort()),
    prefix: Boolean(input.prefix),
  });
}

export function createSearchProjection(input) {
  return new SearchProjection(input);
}

export function eq(field, value) {
  return Object.freeze({ type: "eq", field: assertNonEmptyString(field, "eq.field"), value: clone(value) });
}

export function inList(field, values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error("inList.values must be a non-empty array");
  }
  return Object.freeze({
    type: "in",
    field: assertNonEmptyString(field, "inList.field"),
    values: Object.freeze(values.map(clone)),
  });
}

export function range(field, bounds) {
  assertObject(bounds, "range.bounds");
  const allowed = new Set(["gte", "lte", "gt", "lt"]);
  const entries = Object.entries(bounds);
  if (entries.length === 0 || entries.some(([key, value]) => !allowed.has(key) || !isJsonNumber(value))) {
    throw new Error("range.bounds must contain numeric gt/gte/lt/lte bounds");
  }
  return Object.freeze({
    type: "range",
    field: assertNonEmptyString(field, "range.field"),
    bounds: stableObject(bounds),
  });
}

export function and(...predicates) {
  const flattened = predicates.flatMap((predicate) => {
    assertPredicate(predicate);
    return predicate.type === "and" ? predicate.predicates : [predicate];
  });
  if (flattened.length === 0) {
    throw new Error("and requires at least one predicate");
  }
  return Object.freeze({ type: "and", predicates: Object.freeze(flattened.map(clone)) });
}

export function resolveSearchBackend(bindle, context) {
  assertObject(bindle, "bindle");
  assertObject(context, "context");

  if (context.camp === "preview") {
    return {
      kind: "postgres-fts",
      reason: "preview Camp uses the in-core colocated full-text default",
    };
  }

  if (context.camp === "prod") {
    return {
      kind: assertNonEmptyString(
        bindle.preferredManagedEngine ?? "managed-search",
        "bindle.preferredManagedEngine",
      ),
      reason: "prod Camp uses the managed search equivalence class",
    };
  }

  throw new Error(`unsupported Camp class for search resolution: ${context.camp ?? "<missing>"}`);
}

class SearchProjection {
  #resource;
  #index;
  #records = new Map();
  #subscriptions = new Map();

  constructor(input) {
    assertObject(input, "search projection");
    this.#resource = assertNonEmptyString(input.resource, "resource");
    this.#index = normalizeIndex(input.index);

    for (const record of input.records ?? []) {
      this.#records.set(assertNonEmptyString(record.id, "record.id"), normalizeRecord(record));
    }
  }

  query(input) {
    const normalized = this.#normalizeQuery(input);
    const hits = [...this.#records.values()]
      .filter((record) => evaluatePredicate(normalized.appliedFilter, record))
      .map((record) => ({ id: record.id, score: scoreRecord(record, this.#index, normalized) }))
      .filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

    return {
      hits,
      seq: mergeSeq(hits.map((hit) => this.#records.get(hit.id).seq)),
      appliedFilter: normalized.appliedFilter,
    };
  }

  subscribe(input) {
    const subscriptionId = assertNonEmptyString(input?.subscriptionId, "subscriptionId");
    if (!(input.onPush instanceof Function)) {
      throw new Error("subscribe.onPush must be a function");
    }

    const query = this.#normalizeQuery(input);
    const current = this.#runNormalizedQuery(query);
    const subscription = {
      subscriptionId,
      query,
      current,
      onPush: input.onPush,
    };
    this.#subscriptions.set(subscriptionId, subscription);

    return Object.freeze({
      subscriptionId,
      current: () => clone(subscription.current),
      unsubscribe: () => this.#subscriptions.delete(subscriptionId),
    });
  }

  indexRecord(record) {
    const normalized = normalizeRecord(record);
    this.#records.set(normalized.id, normalized);
    const change = {
      type: "data.Changed",
      op: "upsert",
      resource: this.#resource,
      key: normalized.id,
    };

    for (const subscription of this.#subscriptions.values()) {
      const next = this.#runNormalizedQuery(subscription.query);
      if (deepEqual(next.hits, subscription.current.hits)) {
        subscription.current = next;
        continue;
      }

      subscription.current = next;
      subscription.onPush({
        type: "subscription.Pushed",
        subscriptionId: subscription.subscriptionId,
        seq: clone(next.seq),
        result: { hits: clone(next.hits) },
        cause: clone(change),
      });
    }

    return change;
  }

  #normalizeQuery(input = {}) {
    assertObject(input, "query");
    if (!isJsonString(input.tenantId) || input.tenantId.trim() === "") {
      throw new Error("tenant-scoped search requires a resolved tenant");
    }
    if (input.prefix && !this.#index.prefix) {
      throw new Error("prefix query requires a prefix-enabled text index");
    }

    const filter = input.filter ? normalizePredicate(input.filter) : null;
    if (filter) {
      validateFilterFields(filter, this.#index.filterFields);
    }

    const tenantFilter = eq("tenantId", input.tenantId);
    const appliedFilter = filter ? and(tenantFilter, filter) : tenantFilter;

    return Object.freeze({
      text: assertNonEmptyString(input.text, "query.text"),
      terms: Object.freeze(tokenize(input.text)),
      prefix: Boolean(input.prefix),
      appliedFilter,
    });
  }

  #runNormalizedQuery(normalized) {
    const hits = [...this.#records.values()]
      .filter((record) => evaluatePredicate(normalized.appliedFilter, record))
      .map((record) => ({ id: record.id, score: scoreRecord(record, this.#index, normalized) }))
      .filter((hit) => hit.score > 0)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

    return {
      hits,
      seq: mergeSeq(hits.map((hit) => this.#records.get(hit.id).seq)),
      appliedFilter: normalized.appliedFilter,
    };
  }
}

function scoreRecord(record, index, query) {
  let score = 0;
  for (const field of index.fields) {
    const tokens = tokenize(record.fields[field] ?? "");
    for (const term of query.terms) {
      score += tokens.filter((token) => (query.prefix ? token.startsWith(term) : token === term)).length;
    }
  }
  return score;
}

function evaluatePredicate(predicate, record) {
  const fieldValue = (field) => (field === "tenantId" ? record.tenantId : record.fields[field]);

  switch (predicate.type) {
    case "eq":
      return fieldValue(predicate.field) === predicate.value;
    case "in":
      return predicate.values.includes(fieldValue(predicate.field));
    case "range": {
      const value = fieldValue(predicate.field);
      if (!isJsonNumber(value)) {
        return false;
      }
      return Object.entries(predicate.bounds).every(([operator, bound]) => {
        if (operator === "gte") return value >= bound;
        if (operator === "gt") return value > bound;
        if (operator === "lte") return value <= bound;
        if (operator === "lt") return value < bound;
        return false;
      });
    }
    case "and":
      return predicate.predicates.every((child) => evaluatePredicate(child, record));
    default:
      throw new Error(`unknown predicate type: ${predicate.type}`);
  }
}

function validateFilterFields(predicate, filterFields) {
  for (const field of predicateFields(predicate)) {
    if (!filterFields.includes(field)) {
      throw new Error(`filter field is not indexed: ${field}`);
    }
  }
}

function predicateFields(predicate) {
  if (predicate.type === "and") {
    return predicate.predicates.flatMap(predicateFields);
  }
  return [predicate.field];
}

function normalizePredicate(predicate) {
  assertPredicate(predicate);
  return clone(predicate);
}

function assertPredicate(predicate) {
  assertObject(predicate, "predicate");
  if (!["eq", "in", "range", "and"].includes(predicate.type)) {
    throw new Error(`unsupported predicate type: ${predicate.type ?? "<missing>"}`);
  }
}

function normalizeIndex(index) {
  assertObject(index, "index");
  if (index.kind !== "full-text") {
    throw new Error("HOBO-245 only accepts the in-core full-text index contract");
  }
  return index;
}

function normalizeRecord(record) {
  assertObject(record, "record");
  assertObject(record.fields, "record.fields");
  return Object.freeze({
    id: assertNonEmptyString(record.id, "record.id"),
    tenantId: assertNonEmptyString(record.tenantId, "record.tenantId"),
    fields: stableObject(record.fields),
    seq: stableObject(record.seq ?? {}),
  });
}

function tokenize(value) {
  return String(value)
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
}

function mergeSeq(seqValues) {
  const merged = {};
  for (const seq of seqValues) {
    for (const [streamId, value] of Object.entries(seq)) {
      merged[streamId] = Math.max(merged[streamId] ?? 0, value);
    }
  }
  return stableObject(merged);
}

function normalizeStringList(values, field) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${field} must be a non-empty array`);
  }
  return Object.freeze([...new Set(values.map((value) => assertNonEmptyString(value, field)))].sort());
}

function assertObject(value, field) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
}

function assertNonEmptyString(value, field) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value;
}

function stableObject(value) {
  return Object.freeze(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone instanceof Function ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}
