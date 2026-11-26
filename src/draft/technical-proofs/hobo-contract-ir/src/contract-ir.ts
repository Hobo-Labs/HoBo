import { isJsonString, isJsonNumber, isJsonObject } from "./json.js";
export const CONTRACT_SCHEMA = "contract.ir/v1";

export const CONTRACT_MODES = Object.freeze([
  "declared",
  "inferred",
  "observed",
  "promoted"
]);

export const CONTRACT_EDGE_KINDS = Object.freeze([
  "http",
  "event",
  "message",
  "topic",
  "resource-binding",
  "capability-scope",
  "runtime-slo",
  "semantic-function",
  "agent-tool",
  "provider-interface",
  "service",
  "actor",
  "workflow"
]);

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const CONTRACT_KEYS = new Set([
  "schema",
  "id",
  "version",
  "mode",
  "edge",
  "requiredRecord",
  "provenance",
  "consumerRequirements",
  "interop"
]);

export function createContractFixture({
  edgeKind = "http",
  mode = "declared",
  consumerRequirements
} = {}) {
  const safeEdgeKind = String(edgeKind).replace(/[^a-z0-9-]/g, "-");

  return {
    schema: CONTRACT_SCHEMA,
    id: `contract-${safeEdgeKind}-${mode}`,
    version: "1.0.0",
    mode,
    edge: {
      kind: edgeKind,
      producer: "orders-api@1.8.0",
      consumer: "worker@1.4.2",
      operation: edgeKind === "http" ? "GET /orders/{id}" : "order.created"
    },
    requiredRecord: {
      format: "json-schema",
      schemaVersion: "2020-12",
      requiredFields: ["id", "tenantId"],
      schema: {
        type: "object",
        required: ["id", "tenantId"],
        properties: {
          id: { type: "string" },
          tenantId: { type: "string" }
        }
      }
    },
    provenance: createProvenance(mode),
    consumerRequirements:
      consumerRequirements ??
      [
        {
          consumer: "worker@1.4.2",
          requiredFields: ["id", "tenantId"]
        }
      ],
    interop: {
      importTargets: ["openapi", "pact", "asyncapi", "protobuf"],
      exportTargets: ["openapi", "pact", "asyncapi", "protobuf"]
    }
  };
}

export function parseContract(candidate) {
  const errors = [];

  if (!candidate || !isJsonObject(candidate)) {
    return { ok: false, errors: ["contract must be an object"], contract: null };
  }

  if (candidate.schema !== CONTRACT_SCHEMA) {
    errors.push(`schema must be ${CONTRACT_SCHEMA}`);
  }
  validateAllowedKeys(candidate, CONTRACT_KEYS, "", errors);
  if (!isNonEmptyString(candidate.id)) {
    errors.push("id must be a non-empty string");
  }
  if (!isSemver(candidate.version)) {
    errors.push(`version must be semver: ${String(candidate.version)}`);
  }
  if (!CONTRACT_MODES.includes(candidate.mode)) {
    errors.push(`unknown mode ${String(candidate.mode)}`);
  }

  validateEdge(candidate.edge, errors);
  validateRequiredRecord(candidate.requiredRecord, errors);
  validateProvenance(candidate.mode, candidate.provenance, errors);
  validateConsumerRequirements(candidate.consumerRequirements, errors);

  return {
    ok: errors.length === 0,
    errors,
    contract: errors.length === 0 ? normalizeContract(candidate) : null
  };
}

export function serializeContract(contract) {
  const parsed = parseContract(contract);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }

  return canonicalJson(parsed.contract);
}

export function deserializeContract(text) {
  return parseContract(JSON.parse(text));
}

export function importOpenApiContract(openApi, {
  id,
  producer,
  consumer
} = {}) {
  assertExternalAdapterIsNotSourceOfTruth(openApi);

  const firstOperation = findFirstOpenApiOperation(openApi);
  const responseSchema =
    firstOperation?.operation?.responses?.["200"]?.content?.["application/json"]?.schema ??
    firstOperation?.operation?.responses?.["201"]?.content?.["application/json"]?.schema ??
    firstOperation?.operation?.responses?.["202"]?.content?.["application/json"]?.schema ??
    {};
  const requiredFields = normalizeStringArray(responseSchema.required ?? []);
  const contract = createContractFixture({ edgeKind: "http", mode: "declared" });

  contract.id = id ?? `contract-openapi-${producer ?? "producer"}`;
  contract.edge.producer = producer ?? openApi?.info?.title ?? "openapi-producer";
  contract.edge.consumer = consumer ?? "openapi-consumer";
  contract.edge.operation = firstOperation
    ? `${firstOperation.method.toUpperCase()} ${firstOperation.path}`
    : "OPENAPI unknown";
  contract.requiredRecord = {
    format: "openapi",
    schemaVersion: openApi?.openapi ?? "unknown",
    requiredFields,
    schema: sortKeys(responseSchema)
  };
  contract.consumerRequirements = [
    {
      consumer: contract.edge.consumer,
      requiredFields
    }
  ];

  return normalizeContract(contract);
}

export function importPactContract(pact, {
  id,
  eventType
} = {}) {
  assertExternalAdapterIsNotSourceOfTruth(pact);

  const interaction = pact?.interactions?.[0] ?? {};
  const responseBody = interaction?.response?.body;
  const requiredFields =
    responseBody && isJsonObject(responseBody) && !Array.isArray(responseBody)
      ? normalizeStringArray(Object.keys(responseBody))
      : [];
  const contract = createContractFixture({ edgeKind: eventType ? "event" : "http", mode: "declared" });

  contract.id = id ?? `contract-pact-${eventType ?? "interaction"}`;
  contract.edge.producer = pact?.provider?.name ?? "pact-provider";
  contract.edge.consumer = pact?.consumer?.name ?? "pact-consumer";
  contract.edge.operation = eventType ?? interaction.description ?? interaction?.request?.path ?? "PACT interaction";
  contract.requiredRecord = {
    format: "pact",
    schemaVersion: "pact-v3-compatible",
    requiredFields,
    schema: {
      body: sortKeys(responseBody ?? {}),
      matchingRules: sortKeys(interaction?.response?.matchingRules ?? {})
    }
  };
  contract.consumerRequirements = [
    {
      consumer: contract.edge.consumer,
      requiredFields
    }
  ];

  return normalizeContract(contract);
}

export function exportOpenApiContract(contract) {
  const parsed = parseContract(contract);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }

  return {
    source: "hobo-contract-ir",
    id: parsed.contract.id,
    edgeKind: parsed.contract.edge.kind,
    producer: parsed.contract.edge.producer,
    consumer: parsed.contract.edge.consumer,
    requiredFields: parsed.contract.requiredRecord.requiredFields
  };
}

export function exportPactContract(contract) {
  const parsed = parseContract(contract);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }

  return {
    source: "hobo-contract-ir",
    id: parsed.contract.id,
    consumer: parsed.contract.edge.consumer,
    provider: parsed.contract.edge.producer,
    requiredFields: parsed.contract.requiredRecord.requiredFields
  };
}

export function importAsyncApiContract(asyncApi, {
  id,
  eventType
} = {}) {
  assertExternalAdapterIsNotSourceOfTruth(asyncApi);

  const firstMessage = findFirstAsyncApiMessage(asyncApi);
  const payloadSchema = firstMessage?.message?.payload ?? {};
  const requiredFields = normalizeStringArray(payloadSchema.required ?? []);
  const contract = createContractFixture({ edgeKind: "event", mode: "declared" });

  contract.id = id ?? `contract-asyncapi-${eventType ?? firstMessage?.channel ?? "channel"}`;
  contract.edge.producer = asyncApi?.info?.title ?? "asyncapi-producer";
  contract.edge.consumer = "asyncapi-consumer";
  contract.edge.operation = eventType ?? firstMessage?.channel ?? "ASYNCAPI unknown";
  contract.requiredRecord = {
    format: "asyncapi",
    schemaVersion: asyncApi?.asyncapi ?? "unknown",
    requiredFields,
    schema: sortKeys(payloadSchema)
  };
  contract.consumerRequirements = [
    {
      consumer: contract.edge.consumer,
      requiredFields
    }
  ];

  return normalizeContract(contract);
}

export function exportAsyncApiContract(contract) {
  const parsed = parseContract(contract);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }

  return {
    source: "hobo-contract-ir",
    id: parsed.contract.id,
    channel: parsed.contract.edge.operation,
    producer: parsed.contract.edge.producer,
    requiredFields: parsed.contract.requiredRecord.requiredFields
  };
}

export function importProtobufContract(proto, {
  id,
  producer,
  consumer
} = {}) {
  assertExternalAdapterIsNotSourceOfTruth(proto);

  const message = findFirstProtobufMessage(proto);
  const fields = Array.isArray(message?.fields) ? message.fields : [];
  const explicitlyRequired = fields
    .filter((field) => field && field.required === true)
    .map((field) => field.name);
  const requiredFields = normalizeStringArray(
    explicitlyRequired.length > 0 ? explicitlyRequired : fields.map((field) => field?.name)
  );
  const contract = createContractFixture({ edgeKind: "message", mode: "declared" });

  contract.id = id ?? `contract-protobuf-${message?.name ?? "message"}`;
  contract.edge.producer = producer ?? proto?.package ?? "protobuf-producer";
  contract.edge.consumer = consumer ?? "protobuf-consumer";
  contract.edge.operation = message?.name ?? "PROTOBUF message";
  contract.requiredRecord = {
    format: "protobuf",
    schemaVersion: proto?.syntax ?? "proto3",
    requiredFields,
    schema: sortKeys(message ?? {})
  };
  contract.consumerRequirements = [
    {
      consumer: contract.edge.consumer,
      requiredFields
    }
  ];

  return normalizeContract(contract);
}

export function exportProtobufContract(contract) {
  const parsed = parseContract(contract);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }

  return {
    source: "hobo-contract-ir",
    id: parsed.contract.id,
    message: parsed.contract.edge.operation,
    producer: parsed.contract.edge.producer,
    consumer: parsed.contract.edge.consumer,
    requiredFields: parsed.contract.requiredRecord.requiredFields
  };
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function createProvenance(mode) {
  if (mode === "declared") {
    return {
      source: "wit-zod",
      verifiedByConstruction: true
    };
  }
  if (mode === "inferred") {
    return {
      source: "graph-compile",
      verifiedByConstruction: true
    };
  }
  if (mode === "observed") {
    return {
      source: "trace-mined",
      verifiedByConstruction: false,
      sampleCoverage: {
        samples: 42000,
        coveragePct: 99.8,
        traceWindow: "P14D"
      }
    };
  }
  if (mode === "promoted") {
    return {
      source: "promotion-gate",
      verifiedByConstruction: false,
      sampleCoverage: {
        samples: 42000,
        coveragePct: 99.8,
        traceWindow: "P14D"
      },
      migrationWindow: {
        days: 14,
        startedAt: "2026-06-25T00:00:00.000Z"
      }
    };
  }

  return {
    source: "unknown",
    verifiedByConstruction: false
  };
}

function validateEdge(edge, errors) {
  if (!edge || !isJsonObject(edge)) {
    errors.push("edge must be an object");
    return;
  }
  if (!CONTRACT_EDGE_KINDS.includes(edge.kind)) {
    errors.push(`unknown edge.kind ${String(edge.kind)}`);
  }
  if (!isNonEmptyString(edge.producer)) {
    errors.push("edge.producer must be a non-empty string");
  }
  if (!isNonEmptyString(edge.consumer)) {
    errors.push("edge.consumer must be a non-empty string");
  }
  if (!isNonEmptyString(edge.operation)) {
    errors.push("edge.operation must be a non-empty string");
  }
}

function validateRequiredRecord(requiredRecord, errors) {
  if (!requiredRecord || !isJsonObject(requiredRecord)) {
    errors.push("requiredRecord must be an object");
    return;
  }
  if (!isNonEmptyString(requiredRecord.format)) {
    errors.push("requiredRecord.format must be a non-empty string");
  }
  if (!Array.isArray(requiredRecord.requiredFields)) {
    errors.push("requiredRecord.requiredFields must be an array");
  } else {
    requiredRecord.requiredFields.forEach((field, index) => {
      if (!isNonEmptyString(field)) {
        errors.push(`requiredRecord.requiredFields.${index} must be a non-empty string`);
      }
    });
  }
}

function validateProvenance(mode, provenance, errors) {
  if (!provenance || !isJsonObject(provenance)) {
    errors.push("provenance must be an object");
    return;
  }
  if (!isNonEmptyString(provenance.source)) {
    errors.push("provenance.source must be a non-empty string");
  }

  if (mode === "declared" || mode === "inferred") {
    if (provenance.verifiedByConstruction !== true) {
      errors.push(`${mode} contracts must be verified by construction`);
    }
    if ("sampleCoverage" in provenance) {
      errors.push(`${mode} contracts must not carry sampleCoverage`);
    }
    return;
  }

  if (mode === "observed" || mode === "promoted") {
    if (provenance.verifiedByConstruction !== false) {
      errors.push(`${mode} contracts are confidence-bounded, not verified by construction`);
    }
    validateSampleCoverage(provenance.sampleCoverage, mode, errors);
  }

  if (mode === "promoted") {
    if (!provenance.migrationWindow || !isJsonObject(provenance.migrationWindow)) {
      errors.push("promoted contracts must carry migrationWindow");
    } else if (!Number.isInteger(provenance.migrationWindow.days) || provenance.migrationWindow.days <= 0) {
      errors.push("migrationWindow.days must be a positive integer");
    }
  }
}

function validateSampleCoverage(sampleCoverage, mode, errors) {
  if (!sampleCoverage || !isJsonObject(sampleCoverage)) {
    errors.push(`${mode} contracts must carry sampleCoverage`);
    return;
  }
  if (!Number.isInteger(sampleCoverage.samples) || sampleCoverage.samples <= 0) {
    errors.push("sampleCoverage.samples must be > 0");
  }
  if (
    !isJsonNumber(sampleCoverage.coveragePct) ||
    sampleCoverage.coveragePct < 0 ||
    sampleCoverage.coveragePct > 100
  ) {
    errors.push("sampleCoverage.coveragePct must be between 0 and 100");
  }
}

function validateConsumerRequirements(requirements, errors) {
  if (!Array.isArray(requirements)) {
    errors.push("consumerRequirements must be an array");
    return;
  }

  requirements.forEach((requirement, index) => {
    if (!requirement || !isJsonObject(requirement)) {
      errors.push(`consumerRequirements.${index} must be an object`);
      return;
    }
    if (!isNonEmptyString(requirement.consumer)) {
      errors.push(`consumerRequirements.${index}.consumer must be a non-empty string`);
    }
    if (!Array.isArray(requirement.requiredFields)) {
      errors.push(`consumerRequirements.${index}.requiredFields must be an array`);
    }
  });
}

function validateAllowedKeys(candidate, allowedKeys, prefix, errors) {
  for (const key of Object.keys(candidate)) {
    if (!allowedKeys.has(key)) {
      errors.push(`${prefix}${key} is not allowed`);
    }
  }
}

function assertExternalAdapterIsNotSourceOfTruth(document) {
  if (
    document &&
    isJsonObject(document) &&
    ("x-hobo-mode" in document || "x-hobo-provenance" in document || "x-hobo-contract" in document)
  ) {
    throw new Error("external adapters cannot set Contract IR mode or provenance");
  }
}

function findFirstOpenApiOperation(openApi) {
  const paths = openApi?.paths;
  if (!paths || !isJsonObject(paths)) {
    return null;
  }

  for (const path of Object.keys(paths).sort()) {
    const pathItem = paths[path];
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      if (pathItem?.[method]) {
        return { path, method, operation: pathItem[method] };
      }
    }
  }

  return null;
}

function findFirstAsyncApiMessage(asyncApi) {
  const channels = asyncApi?.channels;
  if (!channels || !isJsonObject(channels)) {
    return null;
  }

  for (const channel of Object.keys(channels).sort()) {
    const channelItem = channels[channel];
    for (const operation of ["subscribe", "publish"]) {
      const message = channelItem?.[operation]?.message;
      if (message) {
        return { channel, operation, message };
      }
    }
  }

  return null;
}

function findFirstProtobufMessage(proto) {
  const messages = proto?.messages;
  if (Array.isArray(messages) && messages.length > 0) {
    return messages[0];
  }

  return null;
}

function normalizeContract(contract) {
  return sortKeys({
    ...contract,
    requiredRecord: {
      ...contract.requiredRecord,
      requiredFields: normalizeStringArray(contract.requiredRecord.requiredFields)
    },
    consumerRequirements: normalizeConsumerRequirements(contract.consumerRequirements)
  });
}

function normalizeConsumerRequirements(requirements) {
  return requirements
    .map((requirement) => ({
      consumer: requirement.consumer,
      requiredFields: normalizeStringArray(requirement.requiredFields)
    }))
    .sort((left, right) => left.consumer.localeCompare(right.consumer));
}

function normalizeStringArray(values) {
  return [...new Set((values ?? []).filter(isNonEmptyString))].sort();
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}

function isSemver(value) {
  return isJsonString(value) && SEMVER_RE.test(value);
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
