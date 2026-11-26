import { isJsonString, isJsonNumber, isJsonBoolean, isJsonObject } from "./json.js";
export class ProjectionSinkMappingError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "ProjectionSinkMappingError";
    this.details = clone(details);
  }
}

export function defineDocumentProjection(input) {
  assertObject(input, "projection");
  assertFunction(input.key, "projection.key");

  const handlers = normalizeHandlers(input.on);
  const projection = Object.freeze({
    name: assertNonEmptyString(input.name, "projection.name"),
    readModel: assertNonEmptyString(input.readModel, "projection.readModel"),
    collection: assertDocumentIdentifier(input.collection, "projection.collection"),
    key: input.key,
    initialState: clone(input.initialState ?? {}),
    rowContract: normalizeRowContract(input.rowContract),
    indexes: normalizeIndexes(input.indexes ?? []),
    readSet: Object.freeze(Object.keys(handlers).sort()),
    on: handlers,
    sink: Object.freeze({
      kind: "mongo-change-streams",
      paradigm: "document",
      capabilities: Object.freeze(["change-feed", "point-read", "query"]),
      consistency: "bounded-staleness",
    }),
  });

  mapRecordToMongoDocumentSchema(projection);
  return projection;
}

export function mapRecordToMongoDocumentSchema(projection) {
  assertObject(projection, "projection");
  const collection = assertDocumentIdentifier(projection.collection, "projection.collection");
  const fields = projection.rowContract?.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new ProjectionSinkMappingError("rowContract.fields must contain at least one field");
  }

  const documentKeys = fields.filter((field) => field.primaryKey);
  if (documentKeys.length !== 1) {
    throw new ProjectionSinkMappingError("document projection requires exactly one top-level primary-key field");
  }

  return deepFreeze({
    collection,
    documentKey: documentKeys[0].name,
    fields: fields.map((field) => mapFieldToDocumentField(field)).sort(compareNamed),
    indexes: (projection.indexes ?? []).map((index) => ({
      fields: normalizeFieldList(index.fields, "index.fields"),
      name: assertDocumentIdentifier(index.name ?? `${collection}_${index.fields.join("_")}_idx`, "index.name"),
    })),
  });
}

export function realizeDocumentProjectionOverWasiKeyvalue(projection) {
  const schema = mapRecordToMongoDocumentSchema(projection);
  return deepFreeze({
    collection: schema.collection,
    imports: ["wasi:keyvalue/store@0.2.0"],
    indexes: schema.indexes,
  });
}

export function createDocumentProjectionSink(projection) {
  return new DocumentProjectionSink(projection);
}

export function normalizeMongoChangeStream(changes) {
  if (!Array.isArray(changes)) {
    throw new ProjectionSinkMappingError("change stream must be an array");
  }

  return deepFreeze(
    changes
      .map((change) => normalizeMongoChange(change))
      .sort(
        (left, right) =>
          left.seq - right.seq || left.resumeToken.localeCompare(right.resumeToken) || left.key.localeCompare(right.key),
      ),
  );
}

export function runDocumentSinkConformance({ projection, events }) {
  const sink = createDocumentProjectionSink(projection);
  sink.replay(events);

  const rebuilt = createDocumentProjectionSink(projection);
  rebuilt.replay(events);
  rebuilt.drop();
  rebuilt.replay(events);

  const documentKey = sink.schema().documentKey;
  const orderedRows = sink.query({ orderBy: [{ field: documentKey }] }).rows;
  const firstRow = orderedRows[0];
  const pointFindPass =
    !firstRow ||
    (deepEqual(sink.read(firstRow[documentKey]).value, firstRow) &&
      deepEqual(sink.find({ [documentKey]: firstRow[documentKey] }).rows, [firstRow]));

  const pass =
    deepEqual(sink.schema(), rebuilt.schema()) &&
    deepEqual(sink.documents(), rebuilt.documents()) &&
    sink.changeFeed().every((change, index, all) => index === 0 || all[index - 1].seq <= change.seq) &&
    sink.rows().every((row) => sink.read(row[documentKey]).consistency === "bounded-staleness") &&
    pointFindPass &&
    realizeDocumentProjectionOverWasiKeyvalue(projection).imports.includes("wasi:keyvalue/store@0.2.0");

  return Object.freeze({
    pass,
    suite: "@hobo/conformance/projection-sink/document-mongo",
    assertions: Object.freeze([
      "wit-record-mapped-to-documents",
      "wasi-keyvalue-document-realization",
      "ordered-data-changed-emitted",
      "bounded-staleness-labeled",
      "cached-point-find-order-reads",
      "drop-and-replay-rebuilds-identical-state",
    ]),
  });
}

class DocumentProjectionSink {
  #projection;
  #schema;
  #rows = new Map();
  #documents = new Map();
  #changes = [];
  #streamSeq = {};
  #nextResumeToken = 1;

  constructor(projection) {
    this.#projection = projection;
    this.#schema = mapRecordToMongoDocumentSchema(projection);
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
    this.#documents = new Map();
    this.#changes = [];
    this.#streamSeq = {};
    this.#nextResumeToken = 1;
    return this;
  }

  rows() {
    return deepFreeze([...this.#rows.values()].sort(compareRows).map(clone));
  }

  documents() {
    return deepFreeze([...this.#documents.values()].sort(compareDocuments).map(clone));
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

  query({ where = {}, orderBy = [], join, $lookup } = {}) {
    if (join || $lookup) {
      throw new ProjectionSinkMappingError("document projection queries cannot perform cross-document joins");
    }
    assertObject(where, "query.where");

    const orders = normalizeOrderBy(orderBy);
    const readableFields = collectReadableFields(this.#schema);

    for (const field of [...Object.keys(where), ...orders.map((order) => order.field)]) {
      if (!readableFields.has(field)) {
        throw new ProjectionSinkMappingError(`unknown query field: ${field}`);
      }
    }

    const rows = [...this.#rows.values()]
      .filter((row) => Object.entries(where).every(([field, value]) => deepEqual(getPath(row, field), value)))
      .sort((left, right) => compareByOrder(left, right, orders));

    return deepFreeze({
      consistency: "bounded-staleness",
      rows: rows.map(clone),
      seq: this.#highWaterSeq(),
    });
  }

  changeFeed() {
    return normalizeMongoChangeStream(this.#changes);
  }

  #apply(event) {
    const key = assertNonEmptyString(this.#projection.key(clone(event)), "projection key");
    const previous = this.#rows.get(key);
    const prior = previous ? clone(previous) : clone(this.#projection.initialState);
    const handler = this.#projection.on[event.type];
    const row = this.#validateRow(handler(prior, clone(event)), event);
    const document = rowToDocument(row, this.#schema);
    const op = previous ? "update" : "insert";

    this.#rows.set(key, row);
    this.#documents.set(key, document);
    this.#streamSeq[event.streamId] = Math.max(this.#streamSeq[event.streamId] ?? 0, event.seq);
    this.#changes.push({
      key,
      op,
      resource: `mongo.projection.${this.#schema.collection}`,
      resumeToken: formatResumeToken(this.#nextResumeToken++),
      seq: event.seq,
    });
  }

  #validateRow(candidate, event) {
    assertObject(candidate, "projection row");
    const row = {};

    for (const field of this.#schema.fields) {
      row[field.name] = validateFieldValue(field, candidate[field.name], event);
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
    fields: rowContract.fields.map((field) => normalizeField(field, "rowContract field", true)),
  });
}

function normalizeField(field, label, topLevel) {
  assertObject(field, label);
  const normalized = {
    ...field,
    name: assertWitFieldName(field.name, `${label} name`),
    type: assertNonEmptyString(field.type, `${label}.${field.name}.type`),
  };

  if (normalized.type === "record") {
    if (!Array.isArray(field.fields) || field.fields.length === 0) {
      throw new ProjectionSinkMappingError(`record field ${field.name} must declare fields`);
    }
    if (field.primaryKey && !topLevel) {
      throw new ProjectionSinkMappingError("document projection primary key must be top-level");
    }
    normalized.fields = field.fields.map((nested) => normalizeField(nested, `record ${field.name} field`, false));
  }

  return normalized;
}

function normalizeIndexes(indexes) {
  if (!Array.isArray(indexes)) {
    throw new ProjectionSinkMappingError("indexes must be an array");
  }

  return deepFreeze(
    indexes.map((index) => {
      assertObject(index, "index");
      return {
        fields: normalizeFieldList(index.fields, "index.fields"),
        name: index.name,
      };
    }),
  );
}

function mapFieldToDocumentField(field, prefix = "") {
  const path = field.primaryKey ? "_id" : prefix ? `${prefix}.${field.name}` : field.name;
  const mapped = {
    name: assertWitFieldName(field.name, "field.name"),
    path,
    required: field.nullable !== true,
    type: mongoTypeFor(field),
  };

  if (field.primaryKey) {
    mapped.documentKey = true;
  }

  if (field.type === "enum") {
    if (!Array.isArray(field.values) || field.values.length === 0) {
      throw new ProjectionSinkMappingError(`enum field ${field.name} must declare values`);
    }
    mapped.enum = normalizeStringSet(field.values, `enum ${field.name} values`);
  }

  if (field.type === "record") {
    mapped.fields = field.fields.map((nested) => mapFieldToDocumentField(nested, path)).sort(compareNamed);
  }

  return Object.freeze(mapped);
}

function mongoTypeFor(field) {
  switch (field.type) {
    case "string":
    case "enum":
      return "string";
    case "u8":
    case "u16":
    case "u32":
    case "u64":
    case "s8":
    case "s16":
    case "s32":
    case "s64":
    case "float32":
    case "float64":
      return "number";
    case "bool":
      return "boolean";
    case "record":
      return "document";
    default:
      throw new ProjectionSinkMappingError(`unsupported WIT field type: ${field.type}`, { field });
  }
}

function normalizeMongoChange(change) {
  assertObject(change, "change");
  const rawOp = change.op ?? change.operationType;
  const op = mongoOperationToDataChangedOp(assertNonEmptyString(rawOp, "change.operationType"));

  return Object.freeze({
    type: "data.Changed",
    resource: assertNonEmptyString(change.resource, "change.resource"),
    key: assertNonEmptyString(change.key, "change.key"),
    op,
    seq: assertSeq(change.seq, "change.seq"),
    resumeToken: assertNonEmptyString(change.resumeToken, "change.resumeToken"),
  });
}

function mongoOperationToDataChangedOp(operationType) {
  switch (operationType) {
    case "insert":
    case "delete":
      return operationType;
    case "replace":
    case "update":
      return "update";
    default:
      throw new ProjectionSinkMappingError(`unsupported Mongo change operation: ${operationType}`);
  }
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
        field: assertPath(entry.field, "query.orderBy field"),
        direction,
      };
    }),
  );
}

function compareByOrder(left, right, orderBy) {
  for (const order of orderBy) {
    const direction = order.direction === "desc" ? -1 : 1;
    const compared = compareValues(getPath(left, order.field), getPath(right, order.field));
    if (compared !== 0) {
      return compared * direction;
    }
  }
  return compareRows(left, right);
}

function collectReadableFields(schema) {
  const fields = new Set();
  for (const field of schema.fields) {
    collectDocumentField(field, fields, true);
  }
  return fields;
}

function collectDocumentField(field, fields, topLevel) {
  fields.add(topLevel ? field.name : field.path);
  if (field.type !== "document") {
    return;
  }
  for (const nested of field.fields) {
    collectDocumentField(nested, fields, false);
  }
}

function validateFieldValue(field, value, event) {
  if (value === undefined || value === null) {
    if (field.required) {
      throw new ProjectionSinkMappingError(`field ${field.name} is required`, { event });
    }
    return null;
  }

  if (field.enum && !field.enum.includes(value)) {
    throw new ProjectionSinkMappingError(`field ${field.name} value is outside WIT enum`, {
      event,
      value,
      allowed: field.enum,
    });
  }

  switch (field.type) {
    case "number":
      if (!isJsonNumber(value) || !Number.isFinite(value)) {
        throw new ProjectionSinkMappingError(`field ${field.name} must be finite number`, { event, value });
      }
      return value;
    case "boolean":
      if (!isJsonBoolean(value)) {
        throw new ProjectionSinkMappingError(`field ${field.name} must be boolean`, { event, value });
      }
      return value;
    case "string":
      if (!isJsonString(value)) {
        throw new ProjectionSinkMappingError(`field ${field.name} must be string`, { event, value });
      }
      return value;
    case "document":
      assertObject(value, `field ${field.name}`);
      return deepFreeze(
        Object.fromEntries(field.fields.map((nested) => [nested.name, validateFieldValue(nested, value[nested.name], event)])),
      );
    default:
      throw new ProjectionSinkMappingError(`unsupported document field type: ${field.type}`, { field });
  }
}

function rowToDocument(row, schema) {
  const document = {};
  for (const field of schema.fields) {
    setPath(document, field.path, clone(row[field.name]));
  }
  return deepFreeze(document);
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

function compareDocuments(left, right) {
  return String(left._id ?? JSON.stringify(left)).localeCompare(String(right._id ?? JSON.stringify(right)));
}

function compareNamed(left, right) {
  return left.name.localeCompare(right.name);
}

function compareValues(left, right) {
  if (isJsonNumber(left) && isJsonNumber(right)) {
    return left - right;
  }
  return String(left).localeCompare(String(right));
}

function getPath(value, path) {
  return path.split(".").reduce((current, part) => (current == null ? undefined : current[part]), value);
}

function setPath(target, path, value) {
  if (path === "_id") {
    target._id = value;
    return target;
  }

  const parts = path.split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    current[part] ??= {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
  return target;
}

function formatResumeToken(value) {
  return String(value).padStart(10, "0");
}

function normalizeFieldList(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new ProjectionSinkMappingError(`${label} must contain at least one field`);
  }
  return Object.freeze(values.map((value) => assertPath(value, label)));
}

function normalizeStringSet(values, label) {
  return Object.freeze([...new Set(values.map((value) => assertNonEmptyString(value, label)))].sort());
}

function assertPath(value, field) {
  const text = assertNonEmptyString(value, field);
  for (const part of text.split(".")) {
    assertWitFieldName(part, field);
  }
  return text;
}

function assertWitFieldName(value, field) {
  const text = assertNonEmptyString(value, field);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    throw new ProjectionSinkMappingError(`${field} must be a WIT record field identifier`, { value: text });
  }
  return text;
}

function assertDocumentIdentifier(value, field) {
  const text = assertNonEmptyString(value, field);
  if (!/^[a-z][a-z0-9_]*$/.test(text)) {
    throw new ProjectionSinkMappingError(`${field} must be a lower-case document identifier`, { value: text });
  }
  return text;
}

function assertObject(value, field) {
  if (!value || !isJsonObject(value)) {
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
