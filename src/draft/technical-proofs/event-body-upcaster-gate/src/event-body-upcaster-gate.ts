import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const EVENT_BODY_UPCASTER_GATE_SCHEMA = "hobo.event-body-upcaster-gate/v1";

export function createTicketOpenedEvolutionContract() {
  const type = "ticket.Opened";
  const schemas = [
    eventSchema(type, 1, [
      stringField("ticketId", 1),
      stringField("summary", 2),
      u32Field("priority", 3),
      stringField("requesterEmail", 4)
    ]),
    eventSchema(type, 2, [
      stringField("ticketId", 1),
      stringField("title", 2),
      u32Field("priority", 3),
      stringField("requesterEmail", 4),
      stringField("source", 5, { required: false })
    ]),
    eventSchema(type, 3, [
      stringField("ticketId", 1),
      stringField("title", 2),
      u32Field("priority", 3),
      stringField("source", 5, { required: false }),
      stringField("requesterRef", 6)
    ])
  ];

  return {
    schema: EVENT_BODY_UPCASTER_GATE_SCHEMA,
    type,
    currentVersion: 3,
    schemas,
    upcasters: [
      {
        type,
        from: 1,
        to: 2,
        reason: "summary was renamed to title; semantic change requires an upcaster",
        upcast: (body) => ({
          ticketId: body.ticketId,
          title: body.summary,
          priority: body.priority,
          requesterEmail: body.requesterEmail,
          source: "legacy-v1"
        })
      },
      {
        type,
        from: 2,
        to: 3,
        reason: "requesterEmail became requesterRef so retained audit facts no longer carry raw PII",
        upcast: (body) => ({
          ticketId: body.ticketId,
          title: body.title,
          priority: body.priority,
          requesterRef: `email:${body.requesterEmail}`,
          source: body.source
        })
      }
    ],
    goldenCorpus: [
      corpusEntry(schemas[0], "ticket-opened-v1", {
        ticketId: "ticket_123",
        summary: "checkout fails",
        priority: 3,
        requesterEmail: "user@example.test"
      }),
      corpusEntry(schemas[1], "ticket-opened-v2", {
        ticketId: "ticket_456",
        title: "login fails",
        priority: 2,
        requesterEmail: "admin@example.test",
        source: "native-v2"
      }),
      corpusEntry(schemas[2], "ticket-opened-v3", {
        ticketId: "ticket_789",
        title: "search slow",
        priority: 4,
        requesterRef: "principal:user_789",
        source: "native-v3"
      })
    ]
  };
}

export function createCorpusBaseline(goldenCorpus) {
  return {
    schema: "hobo.golden-replay-corpus-baseline/v1",
    entries: goldenCorpus.map((entry) => ({
      key: corpusKey(entry),
      bodyDigest: entry.bodyDigest
    }))
  };
}

export function runCanDeployUpcasterGate(contract, options = {}) {
  const errors = [];
  const replays = [];
  const schemas = [...contract.schemas].sort((left, right) => left.version - right.version);
  const schemasByVersion = new Map(schemas.map((schema) => [schema.version, schema]));
  const upcastersByFrom = new Map(contract.upcasters.map((upcaster) => [upcaster.from, upcaster]));
  const corpus = contract.goldenCorpus ?? [];

  validateCorpusCoverage({ contract, schemas, corpus, errors });
  validateAppendOnlyCorpus({ currentCorpus: corpus, baselineCorpus: options.baselineCorpus, errors });
  validateTotalChain({ contract, schemas, upcastersByFrom, errors });
  validateUpcasterPurity({ contract, schemasByVersion, upcastersByFrom, corpus, errors });

  for (const entry of corpus) {
    try {
      replays.push(replayCorpusEntry({ contract, schemasByVersion, upcastersByFrom, entry }));
    } catch (error) {
      errors.push(`${entry.type}@v${entry.version}#${entry.id} replay failed: ${error.message}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    replays
  };
}

function validateCorpusCoverage({ contract, schemas, corpus, errors }) {
  for (const schema of schemas) {
    const hasEntry = corpus.some((entry) => (
      entry.type === contract.type && entry.version === schema.version
    ));
    if (!hasEntry) {
      errors.push(`missing golden corpus entry for ${contract.type}@v${schema.version}`);
    }
  }
}

function validateAppendOnlyCorpus({ currentCorpus, baselineCorpus, errors }) {
  if (!baselineCorpus) return;

  const current = new Map(currentCorpus.map((entry) => [corpusKey(entry), entry.bodyDigest]));

  for (const baselineEntry of baselineCorpus.entries) {
    const currentDigest = current.get(baselineEntry.key);
    if (!currentDigest) {
      errors.push(`append-only corpus deletion detected: ${baselineEntry.key}`);
      continue;
    }
    if (currentDigest !== baselineEntry.bodyDigest) {
      errors.push(`append-only corpus digest changed for ${baselineEntry.key}`);
    }
  }
}

function validateTotalChain({ contract, schemas, upcastersByFrom, errors }) {
  for (const schema of schemas) {
    if (schema.version >= contract.currentVersion) continue;

    const expectedTo = schema.version + 1;
    const upcaster = upcastersByFrom.get(schema.version);
    if (!upcaster || upcaster.to !== expectedTo) {
      errors.push(`non-total upcaster chain for ${contract.type}@v${schema.version}: missing ${schema.version}->${expectedTo}`);
    }
  }
}

function validateUpcasterPurity({ contract, schemasByVersion, upcastersByFrom, corpus, errors }) {
  for (const upcaster of upcastersByFrom.values()) {
    const sourceSchema = schemasByVersion.get(upcaster.from);
    const targetSchema = schemasByVersion.get(upcaster.to);
    const sourceEntry = corpus.find((entry) => (
      entry.type === contract.type && entry.version === upcaster.from
    ));

    if (!sourceSchema || !targetSchema || !sourceEntry) continue;

    let sourceBody;
    try {
      sourceBody = decodeCorpusEntry(sourceSchema, sourceEntry);
    } catch (error) {
      errors.push(`${contract.type}@v${upcaster.from} corpus decode failed: ${error.message}`);
      continue;
    }

    let first;
    let second;
    try {
      first = upcaster.upcast(deepFreeze(deepClone(sourceBody)));
      second = upcaster.upcast(deepFreeze(deepClone(sourceBody)));
    } catch (error) {
      errors.push(`${contract.type}@v${upcaster.from} upcaster ${upcaster.from}->${upcaster.to} purity check threw: ${error.message}`);
      continue;
    }

    if (canonicalJson(first) !== canonicalJson(second)) {
      errors.push(`impure upcaster for ${contract.type}@v${upcaster.from}: identical input produced different output`);
    }

    const validation = validateBody(targetSchema, first);
    if (!validation.ok) {
      errors.push(`${contract.type}@v${upcaster.from} upcaster ${upcaster.from}->${upcaster.to} produced invalid v${upcaster.to} body: ${validation.errors.join("; ")}`);
    }
  }
}

function replayCorpusEntry({ contract, schemasByVersion, upcastersByFrom, entry }) {
  let schema = schemasByVersion.get(entry.version);
  if (!schema) {
    throw new Error(`no schema registered for v${entry.version}`);
  }

  let body = decodeCorpusEntry(schema, entry);
  let version = entry.version;

  while (version < contract.currentVersion) {
    const upcaster = upcastersByFrom.get(version);
    if (!upcaster || upcaster.to !== version + 1) {
      throw new Error(`non-total upcaster chain for ${entry.type}@v${version}: missing ${version}->${version + 1}`);
    }

    body = upcaster.upcast(deepFreeze(deepClone(body)));
    version = upcaster.to;
    schema = schemasByVersion.get(version);

    const validation = validateBody(schema, body);
    if (!validation.ok) {
      throw new Error(`upcaster ${upcaster.from}->${upcaster.to} produced invalid v${version} body: ${validation.errors.join("; ")}`);
    }
  }

  const currentSchema = schemasByVersion.get(contract.currentVersion);
  const currentWire = encodeBody(currentSchema, body);

  return {
    key: corpusKey(entry),
    sourceVersion: entry.version,
    currentVersion: contract.currentVersion,
    currentBody: body,
    currentDigest: sha256(currentWire)
  };
}

function decodeCorpusEntry(schema, entry) {
  if (entry.encoding !== "protobuf-lite") {
    throw new Error(`unsupported corpus encoding ${entry.encoding}`);
  }

  const bytes = Buffer.from(entry.bodyBase64, "base64");
  const digest = sha256(bytes);
  if (digest !== entry.bodyDigest) {
    throw new Error(`digest mismatch for ${corpusKey(entry)}`);
  }

  const body = decodeBody(schema, bytes);
  const validation = validateBody(schema, body);
  if (!validation.ok) {
    throw new Error(validation.errors.join("; "));
  }
  return body;
}

function corpusEntry(schema, id, body) {
  const bytes = encodeBody(schema, body);
  return {
    schema: "hobo.golden-replay-corpus-entry/v1",
    id,
    type: schema.type,
    version: schema.version,
    encoding: "protobuf-lite",
    bodyBase64: bytes.toString("base64"),
    bodyDigest: sha256(bytes)
  };
}

function eventSchema(type, version, fields) {
  return Object.freeze({
    type,
    version,
    fields: Object.freeze(fields)
  });
}

function stringField(name, tag, options = {}) {
  return { name, tag, type: "string", required: options.required !== false };
}

function u32Field(name, tag, options = {}) {
  return { name, tag, type: "u32", required: options.required !== false };
}

function validateBody(schema, body) {
  const errors = [];
  const declared = new Set(schema.fields.map((field) => field.name));

  if (!body || !isJsonObject(body) || Array.isArray(body)) {
    return { ok: false, errors: ["event body must be an object"] };
  }

  for (const field of schema.fields) {
    const value = body[field.name];
    if (value === undefined && field.required === false) continue;

    if (field.type === "string" && !isJsonString(value)) {
      errors.push(`${field.name} must be a string`);
      continue;
    }
    if (field.type === "u32" && (!Number.isInteger(value) || value < 0)) {
      errors.push(`${field.name} must be a non-negative integer`);
    }
  }

  for (const key of Object.keys(body)) {
    if (!declared.has(key)) {
      errors.push(`${key} is not declared in ${schema.type}@v${schema.version}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

function encodeBody(schema, body) {
  const validation = validateBody(schema, body);
  if (!validation.ok) {
    throw new Error(validation.errors.join("; "));
  }

  const chunks = [];
  for (const field of [...schema.fields].sort((left, right) => left.tag - right.tag)) {
    const value = body[field.name];
    if (value === undefined) continue;

    if (field.type === "string") {
      const bytes = Buffer.from(value, "utf8");
      chunks.push(encodeVarint((field.tag << 3) | 2), encodeVarint(bytes.length), bytes);
      continue;
    }
    if (field.type === "u32") {
      chunks.push(encodeVarint(field.tag << 3), encodeVarint(value));
      continue;
    }
    throw new Error(`unsupported field type ${field.type}`);
  }

  return Buffer.concat(chunks);
}

function decodeBody(schema, bytes) {
  const fieldsByTag = new Map(schema.fields.map((field) => [field.tag, field]));
  const decoded = {};
  let offset = 0;

  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    offset = key.offset;
    const tag = key.value >> 3;
    const wireType = key.value & 7;
    const field = fieldsByTag.get(tag);
    if (!field) {
      throw new Error(`unknown protobuf field tag ${tag}`);
    }

    if (wireType === 2 && field.type === "string") {
      const length = readVarint(bytes, offset);
      offset = length.offset;
      decoded[field.name] = Buffer.from(bytes.subarray(offset, offset + length.value)).toString("utf8");
      offset += length.value;
      continue;
    }

    if (wireType === 0 && field.type === "u32") {
      const value = readVarint(bytes, offset);
      offset = value.offset;
      decoded[field.name] = value.value;
      continue;
    }

    throw new Error(`protobuf wire type ${wireType} does not match ${field.name}`);
  }

  return decoded;
}

function encodeVarint(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`protobuf varint must be a non-negative integer: ${String(value)}`);
  }

  const bytes = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);

  return Buffer.from(bytes);
}

function readVarint(bytes, startOffset) {
  let value = 0;
  let shift = 0;

  for (let offset = startOffset; offset < bytes.length; offset += 1) {
    const byte = bytes[offset];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      return { value, offset: offset + 1 };
    }
    shift += 7;
  }

  throw new Error("unterminated protobuf varint");
}

function corpusKey(entry) {
  return `${entry.type}@v${entry.version}#${entry.id}`;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value && isJsonObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
