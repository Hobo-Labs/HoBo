import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const DOMAIN_RECORD_SCHEMA = "hobo.domain-record/v1";

const GENERATED_VIEWS = Object.freeze(["typescript", "protobuf", "zod", "cue"]);

export function createTicketOpenedWitFixture() {
  return {
    schema: DOMAIN_RECORD_SCHEMA,
    authoring: "wit",
    namespace: "ticket",
    recordName: "opened",
    type: "ticket.Opened",
    version: 1,
    fields: [
      {
        name: "ticketId",
        witName: "ticket-id",
        protoName: "ticket_id",
        type: "string",
        tag: 1,
        constraints: { pattern: "^ticket_[a-z0-9]+$" }
      },
      {
        name: "summary",
        witName: "summary",
        protoName: "summary",
        type: "string",
        tag: 2,
        constraints: { minLength: 1 }
      },
      {
        name: "priority",
        witName: "priority",
        protoName: "priority",
        type: "u32",
        tag: 3,
        constraints: { min: 1, max: 5 }
      },
      {
        name: "requesterEmail",
        witName: "requester-email",
        protoName: "requester_email",
        type: "string",
        tag: 4,
        constraints: { pattern: "^[^@]+@[^@]+\\.[^@]+$" }
      }
    ]
  };
}

export function createTicketOpenedZodFixture() {
  return {
    schema: DOMAIN_RECORD_SCHEMA,
    authoring: "zod",
    namespace: "ticket",
    recordName: "opened",
    type: "ticket.Opened",
    version: 1,
    fields: [
      {
        name: "ticketId",
        type: "string",
        tag: 1,
        constraints: { pattern: "^ticket_[a-z0-9]+$" }
      },
      {
        name: "summary",
        type: "string",
        tag: 2,
        constraints: { minLength: 1 }
      },
      {
        name: "priority",
        type: "u32",
        tag: 3,
        constraints: { min: 1, max: 5 }
      },
      {
        name: "requesterEmail",
        type: "string",
        tag: 4,
        constraints: { pattern: "^[^@]+@[^@]+\\.[^@]+$" }
      }
    ]
  };
}

export function compileDomainRecordContract(authoring) {
  const record = normalizeAuthoring(authoring);
  const canonicalWit = renderCanonicalWit(record);
  const canonicalHash = sha256(canonicalWit);

  return {
    record,
    canonicalWit,
    canonicalHash,
    generatedTypescript: renderTypescript(record),
    protobufDescriptor: renderProtobuf(record),
    zodValidatorSource: renderZod(record),
    cueConstraintsSource: renderCue(record),
    declaredContract: {
      schema: DOMAIN_RECORD_SCHEMA,
      type: record.type,
      version: record.version,
      canonicalHash,
      upstream: "canonical-wit-record",
      generatedViews: [...GENERATED_VIEWS]
    }
  };
}

export function assertAuthoringParity(authorings) {
  if (!Array.isArray(authorings) || authorings.length < 2) {
    throw new Error("at least two authoring surfaces are required for parity");
  }

  const compiled = authorings.map((authoring) => ({
    surface: authoring.authoring,
    contract: compileDomainRecordContract(authoring)
  }));
  const baseline = compiled[0];
  const errors = [];

  for (const candidate of compiled.slice(1)) {
    if (candidate.contract.canonicalHash !== baseline.contract.canonicalHash) {
      errors.push(`${candidate.surface} canonical WIT hash differs from ${baseline.surface}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function encodeDomainBodyToProtobuf(contract, body) {
  const validation = validateDomainBody(contract, body);
  if (!validation.ok) {
    throw new Error(validation.errors.join("\n"));
  }

  const chunks = [];

  for (const field of fieldsByTag(contract.record)) {
    const value = body[field.name];
    if (field.type === "string") {
      chunks.push(encodeVarint((field.tag << 3) | 2));
      const bytes = Buffer.from(value, "utf8");
      chunks.push(encodeVarint(bytes.length), bytes);
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

export function decodeDomainBodyFromProtobuf(contract, bytes) {
  const fields = new Map(fieldsByTag(contract.record).map((field) => [field.tag, field]));
  const decoded = {};
  let offset = 0;

  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    offset = key.offset;
    const tag = key.value >> 3;
    const wireType = key.value & 7;
    const field = fields.get(tag);
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

export function validateDomainBody(contract, body) {
  const errors = [];

  if (!body || !isJsonObject(body) || Array.isArray(body)) {
    return { ok: false, errors: ["domain body must be an object"] };
  }

  for (const field of contract.record.fields) {
    const value = body[field.name];
    if (field.type === "string" && !isJsonString(value)) {
      errors.push(`${field.name} must be a string`);
      continue;
    }
    if (field.type === "u32" && (!Number.isInteger(value) || value < 0)) {
      errors.push(`${field.name} must be a non-negative integer`);
      continue;
    }
    if (field.constraints.minLength !== undefined && value.length < field.constraints.minLength) {
      errors.push(`${field.name} length must be >= ${field.constraints.minLength}`);
    }
    if (field.constraints.pattern && !new RegExp(field.constraints.pattern).test(value)) {
      errors.push(`${field.name} must match ${field.constraints.pattern}`);
    }
    if (field.constraints.min !== undefined && value < field.constraints.min) {
      errors.push(`${field.name} must be >= ${field.constraints.min}`);
    }
    if (field.constraints.max !== undefined && value > field.constraints.max) {
      errors.push(`${field.name} must be <= ${field.constraints.max}`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function validateSchemaEvolution(previousAuthoring, nextAuthoring) {
  const previous = normalizeAuthoring(previousAuthoring);
  const next = normalizeAuthoring(nextAuthoring);
  const errors = [];
  const previousByTag = new Map(previous.fields.map((field) => [field.tag, field]));
  const nextByTag = new Map(next.fields.map((field) => [field.tag, field]));
  const versionBumped = next.version > previous.version;

  for (const [tag, previousField] of previousByTag) {
    const nextField = nextByTag.get(tag);
    if (!nextField) {
      errors.push(`field tag ${tag} was removed without version bump`);
      continue;
    }
    if (nextField.name !== previousField.name && !versionBumped) {
      errors.push(`field tag ${tag} was renamed from ${previousField.name} to ${nextField.name} without version bump`);
    }
    if (nextField.type !== previousField.type && !versionBumped) {
      errors.push(`field tag ${tag} changed type from ${previousField.type} to ${nextField.type} without version bump`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function generatedArtifacts() {
  const contract = compileDomainRecordContract(createTicketOpenedWitFixture());

  return {
    "generated/ticket-opened.wit": contract.canonicalWit,
    "generated/ticket-opened.d.ts": contract.generatedTypescript,
    "generated/ticket-opened.proto": contract.protobufDescriptor,
    "generated/ticket-opened.zod.ts": contract.zodValidatorSource,
    "generated/ticket-opened.cue": contract.cueConstraintsSource
  };
}

function normalizeAuthoring(authoring) {
  if (!authoring || !isJsonObject(authoring) || Array.isArray(authoring)) {
    throw new Error("domain record authoring must be an object");
  }
  if (authoring.schema !== DOMAIN_RECORD_SCHEMA) {
    throw new Error(`schema must be ${DOMAIN_RECORD_SCHEMA}`);
  }
  if (!["wit", "zod"].includes(authoring.authoring)) {
    throw new Error(`unsupported authoring surface ${String(authoring.authoring)}`);
  }
  if (!Array.isArray(authoring.fields) || authoring.fields.length === 0) {
    throw new Error("domain record must declare at least one field");
  }

  return {
    ...authoring,
    fields: authoring.fields.map((field) => ({
      ...field,
      witName: field.witName ?? kebab(field.name),
      protoName: field.protoName ?? snake(field.name),
      constraints: { ...(field.constraints) }
    }))
  };
}

function renderCanonicalWit(record) {
  const lines = [
    "package hobo:domain-event-bodies@1.0.0;",
    "",
    `interface ${record.namespace} {`,
    `  record ${record.recordName} {`
  ];

  for (const field of record.fields) {
    lines.push(`    ${field.witName}: ${field.type},`);
  }

  lines.push("  }", "}", "");
  return lines.join("\n");
}

function renderTypescript(record) {
  const typeName = pascal(record.type);
  const lines = [
    `export type ${typeName}EventType = ${JSON.stringify(record.type)};`,
    "",
    `export interface ${typeName} {`
  ];

  for (const field of record.fields) {
    lines.push(`  ${field.name}: ${typescriptType(field.type)};`);
  }

  lines.push("}", "");
  return lines.join("\n");
}

function renderProtobuf(record) {
  const typeName = pascal(record.type);
  const lines = [
    'syntax = "proto3";',
    "",
    `package hobo.domain.${record.namespace}.v${record.version};`,
    "",
    `message ${typeName} {`
  ];

  for (const field of record.fields) {
    lines.push(`  ${protobufType(field.type)} ${field.protoName} = ${field.tag};`);
  }

  lines.push("}", "");
  return lines.join("\n");
}

function renderZod(record) {
  const typeName = pascal(record.type);
  const lines = [
    'import { z } from "zod";',
    "",
    `export const ${typeName}ZodSchema = z.object({`
  ];

  record.fields.forEach((field, index) => {
    const suffix = index === record.fields.length - 1 ? "" : ",";
    lines.push(`  ${field.name}: ${zodExpression(field)}${suffix}`);
  });

  lines.push("}).strict();", "");
  return lines.join("\n");
}

function renderCue(record) {
  const typeName = camel(pascal(record.type));
  const lines = [`${typeName}: {`];

  for (const field of record.fields) {
    lines.push(`  ${field.name}: ${cueExpression(field)}`);
  }

  lines.push("}", "");
  return lines.join("\n");
}

function zodExpression(field) {
  if (field.type === "string") {
    let expression = "z.string()";
    if (field.constraints.minLength !== undefined) {
      expression += `.min(${field.constraints.minLength})`;
    }
    if (field.constraints.pattern) {
      expression += `.regex(/${field.constraints.pattern}/)`;
    }
    return expression;
  }
  if (field.type === "u32") {
    let expression = "z.number().int().nonnegative()";
    if (field.constraints.min !== undefined) {
      expression += `.min(${field.constraints.min})`;
    }
    if (field.constraints.max !== undefined) {
      expression += `.max(${field.constraints.max})`;
    }
    return expression;
  }
  throw new Error(`unsupported field type ${field.type}`);
}

function cueExpression(field) {
  const constraints = [];
  if (field.type === "string") {
    constraints.push("string");
    if (field.constraints.minLength !== undefined) {
      constraints.push(`len(_) >= ${field.constraints.minLength}`);
    }
    if (field.constraints.pattern) {
      constraints.push(`=~"${field.constraints.pattern.replace(/\\/g, "\\\\")}"`);
    }
    return constraints.join(" & ");
  }
  if (field.type === "u32") {
    constraints.push("uint");
    if (field.constraints.min !== undefined) {
      constraints.push(`>=${field.constraints.min}`);
    }
    if (field.constraints.max !== undefined) {
      constraints.push(`<=${field.constraints.max}`);
    }
    return constraints.join(" & ");
  }
  throw new Error(`unsupported field type ${field.type}`);
}

function pascal(value) {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join("");
}

function camel(value) {
  return `${value[0].toLowerCase()}${value.slice(1)}`;
}

function kebab(value) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

function snake(value) {
  return value.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function typescriptType(type) {
  if (type === "string") return "string";
  if (type === "u32") return "number";
  throw new Error(`unsupported field type ${type}`);
}

function protobufType(type) {
  if (type === "string") return "string";
  if (type === "u32") return "uint32";
  throw new Error(`unsupported field type ${type}`);
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fieldsByTag(record) {
  return [...record.fields].sort((left, right) => left.tag - right.tag);
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
