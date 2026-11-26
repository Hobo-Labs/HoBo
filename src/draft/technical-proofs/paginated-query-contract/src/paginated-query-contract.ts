import { isJsonString, isJsonObject } from "./json.js";
export function createPaginatedStore({ name, indexKeys = [], rows = [] } = {}) {
  if (!isJsonString(name) || name.length === 0) {
    throw new TypeError("store name is required");
  }

  return new PaginatedStore(name, indexKeys, rows);
}

export function view(store, name) {
  if (!(store instanceof PaginatedStore)) {
    throw new TypeError("view requires a PaginatedStore");
  }
  if (name !== store.name) {
    throw new TypeError(`unknown view: ${name}`);
  }

  return {
    order(orderBy) {
      store.assertIndex(orderBy);
      return new OrderedView(store, orderBy);
    },
  };
}

export function decodeCursor(cursor) {
  if (cursor === null || cursor === undefined) {
    return null;
  }
  if (!isJsonString(cursor) || cursor.length === 0) {
    throw new TypeError("cursor must be an encoded string");
  }

  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
}

export function usePaginatedQuery(orderedView, options) {
  if (!(orderedView instanceof OrderedView)) {
    throw new TypeError("usePaginatedQuery requires an ordered view");
  }
  const { cursor = null, limit, onPush } = options ?? {};
  assertPositiveInteger(limit, "limit");
  if (onPush !== undefined && !(onPush instanceof Function)) {
    throw new TypeError("onPush must be a function");
  }

  const lower = orderedView.lowerBound(cursor);
  let windowLimit = limit;
  let current = orderedView.paginate({ cursor, limit });
  let upper = current.items.length > 0 ? positionFor(current.items.at(-1), orderedView.orderBy) : lower;

  onPush?.(current);

  const unsubscribe = orderedView.store.subscribe((change) => {
    if (!changeTouchesWindow(change, lower, upper, orderedView.orderBy)) {
      return;
    }

    const next = orderedView.pageBetween({ lower, upper, limit: windowLimit });
    if (stableStringify(next) === stableStringify(current)) {
      return;
    }

    current = next;
    onPush?.(current);
  });

  return {
    current: () => clone(current),
    loadMore() {
      if (!current.nextCursor) {
        return clone(current);
      }

      const nextPage = orderedView.paginate({ cursor: current.nextCursor, limit });
      if (nextPage.items.length === 0) {
        return clone(current);
      }

      windowLimit += limit;
      upper = positionFor(nextPage.items.at(-1), orderedView.orderBy);
      current = orderedView.pageBetween({ lower, upper, limit: windowLimit });
      onPush?.(current);
      return clone(current);
    },
    unsubscribe,
  };
}

class PaginatedStore {
  #rows = new Map();
  #tombstones = new Map();
  #indexKeys;
  #listeners = new Set();

  constructor(name, indexKeys, rows) {
    this.name = name;
    this.#indexKeys = new Set(indexKeys);
    for (const row of rows) {
      this.upsert(row);
    }
  }

  upsert(row) {
    const normalized = normalizeRow(row);
    const previous = this.#rows.get(normalized.id);
    if (previous && normalized.seq <= previous.seq) {
      throw new TypeError(`seq must advance for ${normalized.streamId}`);
    }
    const tombstone = this.#tombstones.get(normalized.id);
    if (tombstone && normalized.seq <= tombstone.seq) {
      throw new TypeError(`seq must advance for ${normalized.streamId}`);
    }

    this.#rows.set(normalized.id, normalized);
    this.#tombstones.delete(normalized.id);
    this.#emit({ type: "data.Changed", previous: clone(previous), current: clone(normalized) });
    return clone(normalized);
  }

  delete(id, { seq } = {}) {
    requiredString(id, "row id");
    assertPositiveInteger(seq, "delete seq");

    const previous = this.#rows.get(id);
    if (!previous) {
      throw new TypeError(`cannot delete unknown row: ${id}`);
    }
    if (seq <= previous.seq) {
      throw new TypeError(`seq must advance for ${previous.streamId}`);
    }

    const tombstone = { ...previous, seq, deleted: true };
    this.#rows.delete(id);
    this.#tombstones.set(id, tombstone);
    this.#emit({ type: "data.Changed", previous: clone(previous), current: null, tombstone: clone(tombstone) });
    return clone(tombstone);
  }

  rows() {
    return [...this.#rows.values()].map(clone);
  }

  tombstones() {
    return [...this.#tombstones.values()].map(clone);
  }

  assertIndex(orderBy) {
    if (!this.#indexKeys.has(orderBy)) {
      throw new TypeError(`sort key is not indexable in this sink: ${orderBy}`);
    }
  }

  subscribe(listener) {
    if (!(listener instanceof Function)) {
      throw new TypeError("listener must be a function");
    }
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(change) {
    for (const listener of this.#listeners) {
      listener(clone(change));
    }
  }
}

class OrderedView {
  constructor(store, orderBy) {
    this.store = store;
    this.orderBy = orderBy;
  }

  paginate({ cursor = null, limit } = {}) {
    assertPositiveInteger(limit, "limit");
    return this.pageBetween({ lower: this.lowerBound(cursor), upper: null, limit });
  }

  lowerBound(cursor) {
    const decoded = decodeCursor(cursor);
    if (!decoded) {
      return null;
    }
    if (decoded.orderBy !== this.orderBy) {
      throw new TypeError(`cursor order ${decoded.orderBy} does not match ${this.orderBy}`);
    }

    return decoded.after;
  }

  pageBetween({ lower, upper, limit }) {
    const orderedRows = this.store.rows().sort((left, right) => compareRows(left, right, this.orderBy));
    const items = orderedRows
      .filter((row) => positionIsWithin(row, { lower, upper }, this.orderBy))
      .slice(0, limit);
    const last = items.at(-1);
    const tombstones = this.store
      .tombstones()
      .filter((row) => positionIsWithin(row, { lower, upper: upper ?? (last ? positionFor(last, this.orderBy) : null) }, this.orderBy));

    return freezePage({
      items,
      nextCursor: last ? encodeCursor({ orderBy: this.orderBy, after: positionFor(last, this.orderBy) }) : null,
      seq: seqVector([...items, ...tombstones]),
    });
  }
}

function changeTouchesWindow(change, lower, upper, orderBy) {
  return (
    (change.previous && positionIsWithin(change.previous, { lower, upper }, orderBy)) ||
    (change.current && positionIsWithin(change.current, { lower, upper }, orderBy)) ||
    (change.tombstone && positionIsWithin(change.tombstone, { lower, upper }, orderBy))
  );
}

function positionIsWithin(row, { lower, upper }, orderBy) {
  return (
    (!lower || compareRowToPosition(row, lower, orderBy) > 0) &&
    (!upper || compareRowToPosition(row, upper, orderBy) <= 0)
  );
}

function encodeCursor(cursor) {
  return Buffer.from(stableStringify(cursor), "utf8").toString("base64url");
}

function positionFor(row, orderBy) {
  return { key: row[orderBy], id: row.id };
}

function compareRows(left, right, orderBy) {
  return compareValue(left[orderBy], right[orderBy]) || left.id.localeCompare(right.id);
}

function compareRowToPosition(row, position, orderBy) {
  return compareValue(row[orderBy], position.key) || row.id.localeCompare(position.id);
}

function compareValue(left, right) {
  if (left < right) {
    return -1;
  }
  if (left > right) {
    return 1;
  }
  return 0;
}

function normalizeRow(row) {
  if (!row || !isJsonObject(row)) {
    throw new TypeError("row must be an object");
  }
  requiredString(row.id, "row.id");
  requiredString(row.streamId, "row.streamId");
  assertPositiveInteger(row.seq, "row.seq");
  return clone(row);
}

function seqVector(rows) {
  return stableObject(
    rows.reduce((seq, row) => {
      seq[row.streamId] = Math.max(seq[row.streamId] ?? 0, row.seq);
      return seq;
    }, {}),
  );
}

function freezePage(page) {
  return Object.freeze({
    items: Object.freeze(page.items.map((item) => Object.freeze(clone(item)))),
    nextCursor: page.nextCursor,
    seq: Object.freeze(page.seq),
  });
}

function requiredString(value, label) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${label} is required`);
  }
}

function assertPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
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
