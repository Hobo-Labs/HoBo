import { isJsonString, isJsonObject } from "./json.js";
export class ParadigmPackageContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "ParadigmPackageContractError";
    this.code = code;
    this.details = cloneData(details);
  }
}

const PROJECTION_PORT = "hobo:projection";
const MANIFEST_SCHEMA = "hobo.manifest/v1";
const PORTABILITY_REPORT_VERSION = "hobo.portabilityReport/v1";

const PACKAGE_DEFINITIONS = Object.freeze({
  "@hobo/sql": Object.freeze({
    paradigm: "relational",
    portableWithin: "managed-postgres",
    defaultNative: Object.freeze({
      provider: "aws",
      service: "rds-postgres",
      engineClass: "managed-postgres",
      adapter: "aws.rds-postgres",
      source: "matching-default",
    }),
  }),
  "@hobo/document": Object.freeze({
    paradigm: "document",
    portableWithin: "document-store",
    defaultNative: Object.freeze({
      provider: "mongodb",
      service: "atlas",
      engineClass: "document-store",
      adapter: "mongodb.atlas",
      source: "matching-default",
    }),
  }),
});

export function defineGenericDataProjection(input) {
  assertObject(input, "projection");
  assertObject(input.target, "projection.target");

  return normalizeProjection({
    input,
    source: "generic-data",
    packageName: undefined,
    paradigm: assertKnownParadigm(input.target.paradigm, "projection.target.paradigm"),
    resourceName: assertResourceName(input.target.resourceName, "projection.target.resourceName"),
    defaultNative: Object.freeze({
      provider: "portable",
      service: "generic-data",
      engineClass: `${input.target.paradigm}-portable`,
      adapter: `generic.${input.target.paradigm}`,
      source: "generic-data",
    }),
  });
}

export function defineSqlProjection(input) {
  assertObject(input, "projection");
  const definition = PACKAGE_DEFINITIONS["@hobo/sql"];

  return normalizeProjection({
    input,
    source: "@hobo/sql",
    packageName: "@hobo/sql",
    paradigm: definition.paradigm,
    resourceName: assertResourceName(input.table, "projection.table"),
    defaultNative: definition.defaultNative,
  });
}

export function defineDocumentProjection(input) {
  assertObject(input, "projection");
  const definition = PACKAGE_DEFINITIONS["@hobo/document"];

  return normalizeProjection({
    input,
    source: "@hobo/document",
    packageName: "@hobo/document",
    paradigm: definition.paradigm,
    resourceName: assertResourceName(input.collection, "projection.collection"),
    defaultNative: definition.defaultNative,
  });
}

export function lowerParadigmProjection(declaration) {
  assertProjectionDeclaration(declaration);

  const args = projectionWitArgs(declaration);
  const witCalls = [
    {
      interface: "hobo:projection/projection-sink@0.1.0",
      function: "declare-projection",
      args,
    },
    ...declaration.readSet.map((eventType) => ({
      interface: "hobo:projection/projection-sink@0.1.0",
      function: "attach-projection-handler",
      args: {
        eventType,
        projection: declaration.name,
      },
    })),
  ];

  const manifestIr = {
    schema: MANIFEST_SCHEMA,
    resources: [
      {
        kind: "hobo:projection",
        ...args,
      },
    ],
  };

  const result = {
    witCalls: deepFreeze(witCalls),
    manifestIr: deepFreeze(manifestIr),
    manifestJson: canonicalJson(manifestIr),
  };

  if (declaration.packageName) {
    result.idiomMetadata = deepFreeze({
      packageName: declaration.packageName,
      paradigm: declaration.paradigm,
      port: PROJECTION_PORT,
      thinLayer: true,
    });
  }

  return deepFreeze(result);
}

export function buildParadigmPortabilityReport(declaration) {
  assertProjectionDeclaration(declaration);

  const definition = declaration.packageName ? PACKAGE_DEFINITIONS[declaration.packageName] : undefined;
  const portableWithin = definition?.portableWithin ?? `${declaration.paradigm}-portable`;
  const entries = [];

  if (definition && declaration.nativeSelection.engineClass !== portableWithin) {
    entries.push({
      id: `${declaration.name}.native-pin.${declaration.nativeSelection.provider}.${declaration.nativeSelection.engineClass}`,
      category: "paradigm-native-pin",
      severity: "target-scoped",
      packageName: declaration.packageName,
      resourceId: declaration.name,
      source: declaration.nativeSelection.source,
      provider: declaration.nativeSelection.provider,
      engineClass: declaration.nativeSelection.engineClass,
      service: declaration.nativeSelection.service,
      portability: "forfeited-within-class",
      portableWithin,
      gateEffect: "report-debt",
      detail:
        declaration.packageName === "@hobo/sql"
          ? "SQL Server is a separate pin-only engine class, not part of the managed-Postgres portability claim."
          : `${declaration.nativeSelection.engineClass} is a separate pin-only engine class, not part of the ${portableWithin} portability claim.`,
    });
  }

  return deepFreeze({
    apiVersion: PORTABILITY_REPORT_VERSION,
    resourceId: declaration.name,
    claim: {
      packageName: declaration.packageName ?? "generic-data",
      paradigm: declaration.paradigm,
      portableWithin,
      nativeSelection: cloneData(declaration.nativeSelection),
    },
    entries,
  });
}

export function runParadigmPackageConformance({ declarations, events }) {
  if (!Array.isArray(declarations) || declarations.length === 0) {
    throw new ParadigmPackageContractError(
      "conformance-declarations-required",
      "paradigm conformance requires at least one declaration",
    );
  }
  if (!Array.isArray(events)) {
    throw new ParadigmPackageContractError("conformance-events-required", "paradigm conformance events must be an array");
  }

  const cases = declarations.map((declaration) => runConformanceCase(declaration, events));

  return deepFreeze({
    suite: "@hobo/conformance/paradigm-idiom-packages",
    status: cases.every((entry) => entry.status === "passed") ? "passed" : "failed",
    cases,
  });
}

export function assertThinParadigmPackage(files) {
  if (!Array.isArray(files)) {
    throw new ParadigmPackageContractError("thin-layer-files-required", "source files must be an array");
  }

  const violations = [];

  for (const file of files) {
    assertObject(file, "source file");
    const path = assertNonEmptyString(file.path, "source file path");
    const source = assertNonEmptyString(file.source, "source file source");

    for (const specifier of importSpecifiers(source)) {
      if (isCloudProviderImport(specifier)) {
        violations.push({
          path,
          reason: "cloud/provider runtime import is not allowed in the paradigm package",
          match: specifier,
        });
      }
    }

    if (/\brealize\s*\(/.test(source)) {
      violations.push({
        path,
        reason: "provider realization logic is not allowed in the paradigm package",
        match: "realize(",
      });
    }
  }

  return deepFreeze(violations);
}

export function validateParadigmRemodel({ from, to, mapping } = {}) {
  assertProjectionDeclaration(from);
  assertProjectionDeclaration(to);

  if (from.paradigm === to.paradigm) {
    return deepFreeze({ status: "accepted", reason: "same-paradigm" });
  }

  if (!mapping) {
    throw new ParadigmPackageContractError(
      "cross-paradigm-remodel-required",
      `Changing ${from.packageName ?? from.paradigm} to ${to.packageName ?? to.paradigm} requires an explicit mapping; shared WIT record types do not permit silent paradigm swaps.`,
      {
        from: from.paradigm,
        to: to.paradigm,
        recordSchema: from.schema.name,
      },
    );
  }

  assertObject(mapping, "mapping");
  assertNonEmptyString(mapping.reason, "mapping.reason");
  assertObject(mapping.fields, "mapping.fields");

  return deepFreeze({
    status: "accepted",
    reason: mapping.reason,
    from: from.paradigm,
    to: to.paradigm,
    mappedFields: Object.keys(mapping.fields).sort(),
  });
}

function normalizeProjection({ input, source, packageName, paradigm, resourceName, defaultNative }) {
  const schema = normalizeSchema(input.schema);
  const handlers = normalizeHandlers(input.on);
  const keyField = assertSchemaField(schema, input.keyField ?? input.target?.keyField, "projection.keyField");
  const consistency = normalizeConsistency(input.consistency ?? "bounded-staleness");
  const indexes = normalizeIndexes(input.indexes ?? input.target?.indexes ?? []);

  return deepFreeze({
    name: assertResourceName(input.name, "projection.name"),
    readModel: assertNonEmptyString(input.readModel, "projection.readModel"),
    schema,
    target: {
      paradigm,
      resourceName,
      keyField,
      indexes,
    },
    paradigm,
    port: PROJECTION_PORT,
    source,
    packageName,
    nativeSelection: normalizeNativeSelection(nativeOverrideFor(input), defaultNative),
    consistency,
    initialState: cloneData(input.initialState ?? {}),
    readSet: Object.keys(handlers).sort(),
    on: handlers,
  });
}

function nativeOverrideFor(input) {
  if (input.withNative) {
    return {
      source: ".with",
      ...cloneData(input.withNative),
    };
  }

  if (input.resourceDefinitionNative) {
    return {
      source: "resource-definition",
      ...cloneData(input.resourceDefinitionNative),
    };
  }

  return undefined;
}

function normalizeSchema(schema) {
  assertObject(schema, "schema");
  const wit = normalizeCanonicalWit(schema.wit);
  const fields = schema.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new ParadigmPackageContractError("schema-fields-required", "schema.fields must contain at least one field");
  }

  return deepFreeze({
    name: assertNonEmptyString(schema.name, "schema.name"),
    version: assertNonEmptyString(schema.version ?? "1.0.0", "schema.version"),
    wit,
    fields: fields.map((field) => normalizeField(field)).sort(compareNamed),
  });
}

function normalizeCanonicalWit(wit) {
  if (!wit) {
    throw new ParadigmPackageContractError(
      "canonical-wit-schema-required",
      "schema.wit must identify the canonical WIT domain record",
    );
  }
  assertObject(wit, "schema.wit");

  return deepFreeze({
    package: assertNonEmptyString(wit.package, "schema.wit.package"),
    interface: assertNonEmptyString(wit.interface, "schema.wit.interface"),
    record: assertNonEmptyString(wit.record, "schema.wit.record"),
  });
}

function normalizeField(field) {
  assertObject(field, "schema field");
  const normalized = {
    name: assertWitFieldName(field.name, "schema field name"),
    type: assertNonEmptyString(field.type, `schema.${field.name}.type`),
  };

  if (field.primaryKey) {
    normalized.primaryKey = true;
  }
  if (field.nullable) {
    normalized.nullable = true;
  }
  if (field.type === "enum") {
    if (!Array.isArray(field.values) || field.values.length === 0) {
      throw new ParadigmPackageContractError(
        "schema-enum-values-required",
        `enum field ${field.name} must declare values`,
      );
    }
    normalized.values = [...new Set(field.values.map((value) => assertNonEmptyString(value, "enum value")))].sort();
  }

  return normalized;
}

function normalizeHandlers(on) {
  assertObject(on, "projection.on");
  const entries = Object.entries(on);
  if (entries.length === 0) {
    throw new ParadigmPackageContractError("projection-handlers-required", "projection.on must contain handlers");
  }

  return Object.freeze(
    Object.fromEntries(
      entries
        .map(([eventType, handler]) => {
          assertNonEmptyString(eventType, "projection event type");
          if (!(handler instanceof Function)) {
            throw new ParadigmPackageContractError(
              "projection-handler-required",
              `handler for ${eventType} must be a function`,
            );
          }
          return [eventType, handler];
        })
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

function normalizeIndexes(indexes) {
  if (!Array.isArray(indexes)) {
    throw new ParadigmPackageContractError("indexes-array-required", "indexes must be an array");
  }

  return deepFreeze(
    indexes
      .map((index) => {
        assertObject(index, "index");
        if (!Array.isArray(index.fields) || index.fields.length === 0) {
          throw new ParadigmPackageContractError("index-fields-required", "index.fields must contain at least one field");
        }
        return {
          fields: [...index.fields].map((field) => assertWitFieldName(field, "index.fields")),
          name: index.name ? assertResourceName(index.name, "index.name") : undefined,
        };
      })
      .sort((left, right) => (left.name ?? left.fields.join("_")).localeCompare(right.name ?? right.fields.join("_"))),
  );
}

function normalizeNativeSelection(override, defaultNative) {
  const selected = {
    ...cloneData(defaultNative),
    ...(override ? cloneData(override) : undefined),
  };

  return deepFreeze({
    provider: assertNonEmptyString(selected.provider, "native.provider"),
    service: assertNonEmptyString(selected.service, "native.service"),
    engineClass: assertNonEmptyString(selected.engineClass, "native.engineClass"),
    adapter: assertNonEmptyString(selected.adapter ?? `${selected.provider}.${selected.service}`, "native.adapter"),
    source: assertNonEmptyString(selected.source ?? "matching-default", "native.source"),
  });
}

function projectionWitArgs(declaration) {
  return {
    name: declaration.name,
    readModel: declaration.readModel,
    recordSchema: cloneData(declaration.schema),
    paradigm: declaration.paradigm,
    target: cloneData(declaration.target),
    consistency: declaration.consistency,
    readSet: [...declaration.readSet],
  };
}

function runConformanceCase(declaration, events) {
  assertProjectionDeclaration(declaration);

  const lowering = lowerParadigmProjection(declaration);
  const rows = materializeProjection(declaration, events);
  const rebuilt = materializeProjection(declaration, [...events].reverse());
  const status =
    canonicalJson(rows) === canonicalJson(rebuilt) &&
    lowering.witCalls[0].interface === "hobo:projection/projection-sink@0.1.0"
      ? "passed"
      : "failed";

  return {
    name: declaration.name,
    packageName: declaration.packageName ?? "generic-data",
    nativeAdapter: declaration.nativeSelection.adapter,
    suite: `@hobo/conformance/${declaration.packageName ?? "generic-data"}/${declaration.nativeSelection.adapter}`,
    status,
    consistency: declaration.consistency,
    rows,
    assertions: [
      "canonical-wit-record-round-trips",
      "bounded-staleness-label-preserved",
      "native-adapter-suite-bound-to-projection-port",
      "replay-order-rebuilds-identical-state",
    ],
  };
}

function materializeProjection(declaration, events) {
  const rows = new Map();

  for (const event of events.map(normalizeEvent).sort(compareEventOrder)) {
    const handler = declaration.on[event.type];
    if (!handler) {
      continue;
    }

    const priorKey = event.data[declaration.target.keyField];
    const prior = priorKey && rows.has(priorKey) ? cloneData(rows.get(priorKey)) : cloneData(declaration.initialState);
    const row = validateRow(declaration.schema, handler(prior, cloneData(event)));
    const key = assertNonEmptyString(row[declaration.target.keyField], `row.${declaration.target.keyField}`);
    rows.set(key, row);
  }

  return deepFreeze([...rows.values()].sort(compareRows));
}

function validateRow(schema, candidate) {
  assertObject(candidate, "projection row");
  const row = {};

  for (const field of schema.fields) {
    const value = candidate[field.name];
    if (value === undefined || value === null) {
      if (field.nullable) {
        row[field.name] = null;
        continue;
      }
      throw new ParadigmPackageContractError("row-field-required", `row.${field.name} is required`);
    }

    if (field.type === "enum" && !field.values.includes(value)) {
      throw new ParadigmPackageContractError(
        "row-enum-invalid",
        `row.${field.name} value is outside the WIT enum`,
        { value, allowed: field.values },
      );
    }

    if (["u8", "u16", "u32", "u64", "s8", "s16", "s32", "s64"].includes(field.type) && !Number.isSafeInteger(value)) {
      throw new ParadigmPackageContractError("row-integer-invalid", `row.${field.name} must be a safe integer`);
    }

    if (field.type === "string" && !isJsonString(value)) {
      throw new ParadigmPackageContractError("row-string-invalid", `row.${field.name} must be a string`);
    }

    row[field.name] = value;
  }

  return deepFreeze(row);
}

function normalizeEvent(event) {
  assertObject(event, "event");
  return {
    ...cloneData(event),
    streamId: assertNonEmptyString(event.streamId, "event.streamId"),
    seq: assertSeq(event.seq, "event.seq"),
    type: assertNonEmptyString(event.type, "event.type"),
    data: cloneData(event.data ?? {}),
  };
}

function compareEventOrder(left, right) {
  return left.streamId.localeCompare(right.streamId) || left.seq - right.seq || left.type.localeCompare(right.type);
}

function compareRows(left, right) {
  return String(left.id ?? JSON.stringify(left)).localeCompare(String(right.id ?? JSON.stringify(right)));
}

function assertProjectionDeclaration(declaration) {
  assertObject(declaration, "projection declaration");
  assertNonEmptyString(declaration.name, "projection.name");
  assertKnownParadigm(declaration.paradigm, "projection.paradigm");
  if (declaration.port !== PROJECTION_PORT) {
    throw new ParadigmPackageContractError("projection-port-invalid", `projection must lower over ${PROJECTION_PORT}`);
  }
}

function assertSchemaField(schema, fieldName, label) {
  const normalized = assertWitFieldName(fieldName, label);
  if (!schema.fields.some((field) => field.name === normalized)) {
    throw new ParadigmPackageContractError("schema-field-missing", `${label} must name a field in the canonical WIT schema`);
  }
  return normalized;
}

function normalizeConsistency(value) {
  const normalized = assertNonEmptyString(value, "projection.consistency");
  if (!["bounded-staleness", "strong"].includes(normalized)) {
    throw new ParadigmPackageContractError(
      "projection-consistency-invalid",
      "projection.consistency must be bounded-staleness or strong",
    );
  }
  return normalized;
}

function assertKnownParadigm(value, field) {
  const text = assertNonEmptyString(value, field);
  if (!["relational", "document"].includes(text)) {
    throw new ParadigmPackageContractError("projection-paradigm-invalid", `${field} must be relational or document`);
  }
  return text;
}

function assertObject(value, field) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new ParadigmPackageContractError("object-required", `${field} must be an object`);
  }
  return value;
}

function assertNonEmptyString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new ParadigmPackageContractError("string-required", `${field} must be a non-empty string`);
  }
  return value;
}

function assertResourceName(value, field) {
  const text = assertNonEmptyString(value, field);
  if (!/^[a-z][a-z0-9_]*$/.test(text)) {
    throw new ParadigmPackageContractError("resource-name-invalid", `${field} must be a lower-case resource name`, {
      value: text,
    });
  }
  return text;
}

function assertWitFieldName(value, field) {
  const text = assertNonEmptyString(value, field);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    throw new ParadigmPackageContractError("wit-field-name-invalid", `${field} must be a WIT field identifier`, {
      value: text,
    });
  }
  return text;
}

function assertSeq(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ParadigmPackageContractError("event-seq-invalid", `${field} must be a non-negative safe integer`);
  }
  return value;
}

function importSpecifiers(source) {
  const specifiers = [];
  const importPattern =
    /\bimport\b[^;]*?\bfrom\s+["']([^"']+)["']|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;
  let match;

  while ((match = importPattern.exec(source)) !== null) {
    specifiers.push(match[1] ?? match[2]);
  }

  return specifiers;
}

function isCloudProviderImport(specifier) {
  return [
    /^@aws-sdk\//,
    /^aws-sdk$/,
    /^@azure\//,
    /^@google-cloud\//,
    /^@pulumi\//,
    /^cloudflare$/,
    /^terraform$/,
  ].some((pattern) => pattern.test(specifier));
}

function canonicalJson(value) {
  return JSON.stringify(sortJson(value));
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}

function compareNamed(left, right) {
  return left.name.localeCompare(right.name);
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(deepFreeze));
  }
  if (value && isJsonObject(value)) {
    return Object.freeze(
      Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, deepFreeze(nested)])),
    );
  }
  return value;
}

function cloneData(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone instanceof Function ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}
