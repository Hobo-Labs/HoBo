import { isJsonString, isJsonNumber, isJsonBoolean, isJsonObject } from "./json.js";
export class ProjectionSinkMappingError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProjectionSinkMappingError";
    this.details = clone(details);
  }
}

export function defineRelationalProjection(input) {
  assertObject(input, "projection");
  assertFunction(input.key, "projection.key");

  const handlers = normalizeHandlers(input.on);
  const projection = Object.freeze({
    name: assertNonEmptyString(input.name, "projection.name"),
    readModel: assertNonEmptyString(input.readModel, "projection.readModel"),
    table: assertSqlIdentifier(input.table, "projection.table"),
    key: input.key,
    initialState: clone(input.initialState ?? {}),
    rowContract: normalizeRowContract(input.rowContract),
    indexes: normalizeIndexes(input.indexes ?? []),
    readSet: Object.freeze(Object.keys(handlers).sort()),
    on: handlers,
    sink: Object.freeze({
      kind: "postgres",
      paradigm: "relational",
      capabilities: Object.freeze(["change-feed", "point-read", "query"]),
      consistency: "bounded-staleness",
    }),
  });

  mapRecordToPostgresSchema(projection);
  return projection;
}

export function mapRecordToPostgresSchema(projection) {
  assertObject(projection, "projection");
  const table = assertSqlIdentifier(projection.table, "projection.table");
  const fields = projection.rowContract?.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new ProjectionSinkMappingError("rowContract.fields must contain at least one field");
  }

  const columns = fields
    .map((field) => mapFieldToColumn(field))
    .sort((left, right) => left.name.localeCompare(right.name));

  if (!columns.some((column) => column.primaryKey)) {
    throw new ProjectionSinkMappingError("relational projection requires one primary-key field");
  }

  return Object.freeze({
    table,
    columns: deepFreeze(columns),
    indexes: deepFreeze(
      (projection.indexes ?? []).map((index) => ({
        columns: normalizeColumnList(index.columns, "index.columns"),
        name: assertSqlIdentifier(index.name ?? `${table}_${index.columns.join("_")}_idx`, "index.name"),
      })),
    ),
  });
}

export function realizeRelationalProjectionOverWasiSql(projection) {
  const schema = mapRecordToPostgresSchema(projection);
  return deepFreeze({
    imports: ["wasi:sql/query@0.2.0"],
    statements: [
      `create table if not exists ${schema.table} (${schema.columns.map(columnDefinition).join(", ")})`,
      ...schema.indexes.map(
        (index) => `create index if not exists ${index.name} on ${schema.table} (${index.columns.join(", ")})`,
      ),
    ],
  });
}

export function createRelationalProjectionSink(projection) {
  return new RelationalProjectionSink(projection);
}

export function normalizePostgresChangeFeed(changes) {
  if (!Array.isArray(changes)) {
    throw new ProjectionSinkMappingError("change feed must be an array");
  }

  return deepFreeze(
    changes
      .map((change) => normalizeChange(change))
      .sort((left, right) => left.seq - right.seq || compareLsn(left.lsn, right.lsn) || left.key.localeCompare(right.key)),
  );
}

export function runRelationalSinkConformance({ projection, events }) {
  const sink = createRelationalProjectionSink(projection);
  sink.replay(events);

  const rebuilt = createRelationalProjectionSink(projection);
  rebuilt.replay(events);
  rebuilt.drop();
  rebuilt.replay(events);

  const primaryKey = sink.schema().columns.find((column) => column.primaryKey);
  const orderedRows = sink.query({ orderBy: [{ column: primaryKey.name }] }).rows;
  const firstRow = orderedRows[0];
  const pointFindPass =
    !firstRow ||
    (deepEqual(sink.read(firstRow[primaryKey.name]).value, firstRow) &&
      deepEqual(sink.find({ [primaryKey.name]: firstRow[primaryKey.name] }).rows, [firstRow]));

  const pass =
    deepEqual(sink.schema(), rebuilt.schema()) &&
    deepEqual(sink.rows(), rebuilt.rows()) &&
    sink.changeFeed().every((change, index, all) => index === 0 || all[index - 1].seq <= change.seq) &&
    sink.rows().every((row) => sink.read(row[primaryKey.name]).consistency === "bounded-staleness") &&
    pointFindPass &&
    realizeRelationalProjectionOverWasiSql(projection).imports.includes("wasi:sql/query@0.2.0");

  return Object.freeze({
    pass,
    suite: "@hobo/conformance/projection-sink/relational-postgres",
    assertions: Object.freeze([
      "wit-record-mapped-to-columns",
      "wasi-sql-query-realization",
      "ordered-data-changed-emitted",
      "bounded-staleness-labeled",
      "cached-point-find-order-reads",
      "drop-and-replay-rebuilds-identical-state",
    ]),
  });
}

class RelationalProjectionSink {
  #projection;
  #schema;
  #rows = new Map();
  #changes = [];
  #streamSeq = {};
  #nextLsn = 1;

  constructor(projection) {
    this.#projection = projection;
    this.#schema = mapRecordToPostgresSchema(projection);
  }

  schema() {
    return clone(this.#schema);
  }

  replay(events) {
    if (!Array.isArray(events)) {
      throw new ProjectionSinkMappingError("events must be an array");
    }

    for (const event of events.map(normalizeEvent).sort(compareEventOrder)) {
      if (!this.#projection.readSet.includes(event.type)) {
        continue;
      }
      this.#apply(event);
    }
    return this;
  }

  drop() {
    this.#rows = new Map();
    this.#changes = [];
    this.#streamSeq = {};
    this.#nextLsn = 1;
    return this;
  }

  rows() {
    return deepFreeze([...this.#rows.values()].sort(compareRows).map(clone));
  }

  read(key) {
    const normalizedKey = assertNonEmptyString(key, "read key");
    const value = this.#rows.get(normalizedKey);
    return deepFreeze({
      consistency: "bounded-staleness",
      key: normalizedKey,
      seq: this.#highWaterSeq(),
      value: value ? clone(value) : null,
    });
  }

  find(where, options = {}) {
    return this.query({ ...options, where });
  }

  query({ where = {}, orderBy = [] } = {}) {
    assertObject(where, "query.where");
    const orders = normalizeOrderBy(orderBy);
    const columns = new Set(this.#schema.columns.map((column) => column.name));

    for (const column of [...Object.keys(where), ...orders.map((order) => order.column)]) {
      if (!columns.has(column)) {
        throw new ProjectionSinkMappingError(`unknown query column: ${column}`);
      }
    }

    const rows = [...this.#rows.values()]
      .filter((row) => Object.entries(where).every(([column, value]) => row[column] === value))
      .sort((left, right) => compareByOrder(left, right, orders));

    return deepFreeze({
      consistency: "bounded-staleness",
      rows: rows.map(clone),
      seq: this.#highWaterSeq(),
    });
  }

  changeFeed() {
    return normalizePostgresChangeFeed(this.#changes);
  }

  #apply(event) {
    const key = assertNonEmptyString(this.#projection.key(clone(event)), "projection key");
    const previous = this.#rows.get(key);
    const prior = previous ? clone(previous) : clone(this.#projection.initialState);
    const handler = this.#projection.on[event.type];
    const row = this.#validateRow(handler(prior, clone(event)), event);
    const op = previous ? "update" : "insert";

    this.#rows.set(key, row);
    this.#streamSeq[event.streamId] = Math.max(this.#streamSeq[event.streamId] ?? 0, event.seq);
    this.#changes.push({
      key,
      lsn: formatLsn(this.#nextLsn++),
      op,
      resource: `postgres.projection.${this.#projection.table}`,
      seq: event.seq,
    });
  }

  #validateRow(candidate, event) {
    assertObject(candidate, "projection row");
    const row = {};

    for (const column of this.#schema.columns) {
      const value = candidate[column.name];
      if (value === undefined || value === null) {
        if (column.nullable === false) {
          throw new ProjectionSinkMappingError(`column ${column.name} is required`, { event });
        }
        row[column.name] = null;
        continue;
      }

      if (column.check && !column.check.includes(value)) {
        throw new ProjectionSinkMappingError(`column ${column.name} value is outside WIT enum`, {
          event,
          value,
          allowed: column.check,
        });
      }

      if (column.type === "integer" && !Number.isSafeInteger(value)) {
        throw new ProjectionSinkMappingError(`column ${column.name} must be an integer`, { event, value });
      }

      if (column.type === "bigint" && !Number.isSafeInteger(value)) {
        throw new ProjectionSinkMappingError(`column ${column.name} must be a bigint-compatible integer`, {
          event,
          value,
        });
      }

      if (column.type === "boolean" && !isJsonBoolean(value)) {
        throw new ProjectionSinkMappingError(`column ${column.name} must be boolean`, { event, value });
      }

      if (column.type === "double precision" && (!isJsonNumber(value) || !Number.isFinite(value))) {
        throw new ProjectionSinkMappingError(`column ${column.name} must be finite double precision`, {
          event,
          value,
        });
      }

      if (column.type === "text" && !isJsonString(value)) {
        throw new ProjectionSinkMappingError(`column ${column.name} must be text`, { event, value });
      }

      row[column.name] = value;
    }

    return deepFreeze(row);
  }

  #highWaterSeq() {
    return Math.max(0, ...Object.values(this.#streamSeq));
  }
}

function normalizeHandlers(on) {
  assertObject(on, "projection.on");
  const entries = Object.entries(on);
  if (entries.length === 0) {
    throw new ProjectionSinkMappingError("projection.on must contain at least one handler");
  }

  return Object.freeze(
    Object.fromEntries(
      entries
        .map(([type, handler]) => {
          assertNonEmptyString(type, "event type");
          assertFunction(handler, `handler for ${type}`);
          return [type, handler];
        })
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function normalizeRowContract(rowContract) {
  assertObject(rowContract, "rowContract");
  if (!Array.isArray(rowContract.fields) || rowContract.fields.length === 0) {
    throw new ProjectionSinkMappingError("rowContract.fields must contain at least one field");
  }

  return deepFreeze({
    fields: rowContract.fields.map((field) => {
      assertObject(field, "rowContract field");
      return {
        ...field,
        name: assertSqlIdentifier(field.name, "rowContract field name"),
        type: assertNonEmptyString(field.type, `rowContract.${field.name}.type`),
      };
    }),
  });
}

function normalizeIndexes(indexes) {
  if (!Array.isArray(indexes)) {
    throw new ProjectionSinkMappingError("indexes must be an array");
  }

  return deepFreeze(
    indexes.map((index) => {
      assertObject(index, "index");
      return {
        columns: normalizeColumnList(index.columns, "index.columns"),
        name: index.name,
      };
    }),
  );
}

function mapFieldToColumn(field) {
  const base = {
    name: assertSqlIdentifier(field.name, "field.name"),
    type: postgresTypeFor(field),
    nullable: field.nullable === true,
  };

  if (field.primaryKey) {
    base.primaryKey = true;
  }

  if (field.type === "enum") {
    if (!Array.isArray(field.values) || field.values.length === 0) {
      throw new ProjectionSinkMappingError(`enum field ${field.name} must declare values`);
    }
    base.check = normalizeStringSet(field.values, `enum ${field.name} values`);
  }

  return Object.freeze(base);
}

function columnDefinition(column) {
  const parts = [column.name, column.type];
  if (column.nullable === false) {
    parts.push("not null");
  }
  if (column.primaryKey) {
    parts.push("primary key");
  }
  if (column.check) {
    parts.push(`check (${column.name} in (${column.check.map(sqlStringLiteral).join(", ")}))`);
  }
  return parts.join(" ");
}

function sqlStringLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function postgresTypeFor(field) {
  switch (field.type) {
    case "string":
    case "enum":
      return "text";
    case "u8":
    case "u16":
    case "u32":
    case "s8":
    case "s16":
    case "s32":
      return "integer";
    case "u64":
    case "s64":
      return "bigint";
    case "bool":
      return "boolean";
    case "float32":
    case "float64":
      return "double precision";
    default:
      throw new ProjectionSinkMappingError(`unsupported WIT field type: ${field.type}`, { field });
  }
}

function normalizeChange(change) {
  assertObject(change, "change");
  const op = assertNonEmptyString(change.op, "change.op");
  if (!["insert", "update", "delete"].includes(op)) {
    throw new ProjectionSinkMappingError(`unsupported data.Changed op: ${op}`);
  }

  return Object.freeze({
    type: "data.Changed",
    resource: assertNonEmptyString(change.resource, "change.resource"),
    key: assertNonEmptyString(change.key, "change.key"),
    op,
    seq: assertSeq(change.seq, "change.seq"),
    lsn: assertNonEmptyString(change.lsn, "change.lsn"),
  });
}

function normalizeOrderBy(orderBy) {
  if (!Array.isArray(orderBy)) {
    throw new ProjectionSinkMappingError("query.orderBy must be an array");
  }

  return deepFreeze(
    orderBy.map((entry) => {
      assertObject(entry, "query.orderBy entry");
      const direction = entry.direction ?? "asc";
      if (!["asc", "desc"].includes(direction)) {
        throw new ProjectionSinkMappingError("query.orderBy direction must be asc or desc");
      }
      return {
        column: assertSqlIdentifier(entry.column, "query.orderBy column"),
        direction,
      };
    }),
  );
}

function compareByOrder(left, right, orderBy) {
  for (const order of orderBy) {
    const direction = order.direction === "desc" ? -1 : 1;
    const compared = compareValues(left[order.column], right[order.column]);
    if (compared !== 0) {
      return compared * direction;
    }
  }
  return compareRows(left, right);
}

function compareValues(left, right) {
  if (isJsonNumber(left) && isJsonNumber(right)) {
    return left - right;
  }
  return String(left).localeCompare(String(right));
}

function normalizeEvent(event) {
  assertObject(event, "event");
  return Object.freeze({
    ...clone(event),
    streamId: assertNonEmptyString(event.streamId, "event.streamId"),
    seq: assertSeq(event.seq, "event.seq"),
    type: assertNonEmptyString(event.type, "event.type"),
    data: clone(event.data ?? {}),
  });
}

function compareEventOrder(left, right) {
  return left.streamId.localeCompare(right.streamId) || left.seq - right.seq || left.type.localeCompare(right.type);
}

function compareRows(left, right) {
  return String(left.id ?? JSON.stringify(left)).localeCompare(String(right.id ?? JSON.stringify(right)));
}

function compareLsn(left, right) {
  return lsnToBigInt(left) < lsnToBigInt(right) ? -1 : lsnToBigInt(left) > lsnToBigInt(right) ? 1 : 0;
}

function lsnToBigInt(lsn) {
  const [high, low] = lsn.split("/");
  return (BigInt(`0x${high}`) << 32n) + BigInt(`0x${low}`);
}

function formatLsn(value) {
  return `0/${value.toString(16).toUpperCase().padStart(8, "0")}`;
}

function normalizeColumnList(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new ProjectionSinkMappingError(`${label} must contain at least one column`);
  }
  return Object.freeze(values.map((value) => assertSqlIdentifier(value, label)));
}

function normalizeStringSet(values, label) {
  return Object.freeze([...new Set(values.map((value) => assertNonEmptyString(value, label)))].sort());
}

function assertSqlIdentifier(value, field) {
  const text = assertNonEmptyString(value, field);
  if (!/^[a-z][a-z0-9_]*$/.test(text)) {
    throw new ProjectionSinkMappingError(`${field} must be a lower-case SQL identifier`, { value: text });
  }
  return text;
}

function assertObject(value, field) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new ProjectionSinkMappingError(`${field} must be an object`);
  }
  return value;
}

function assertFunction(value, field) {
  if (!(value instanceof Function)) {
    throw new ProjectionSinkMappingError(`${field} must be a function`);
  }
}

function assertNonEmptyString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new ProjectionSinkMappingError(`${field} must be a non-empty string`);
  }
  return value;
}

function assertSeq(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ProjectionSinkMappingError(`${field} must be a non-negative safe integer`);
  }
  return value;
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(deepFreeze));
  }

  if (value && isJsonObject(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, deepFreeze(entry)])));
  }

  return value;
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
