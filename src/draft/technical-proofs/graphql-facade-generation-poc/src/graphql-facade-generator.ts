import { isJsonString } from "./json.js";
export function parseWitRecords(witSource) {
  return {
    records: parseBlocks(witSource, "record", parseRecordBody),
    enums: parseBlocks(witSource, "enum", parseEnumBody),
  };
}

export function generateGraphqlFacade({ wit, projections }) {
  const model = isJsonString(wit) ? parseWitRecords(wit) : wit;
  const recordsByName = new Map(model.records.map((record) => [record.name, record]));
  const enumsByName = new Map(model.enums.map((entry) => [entry.name, entry]));
  const usedFields = new Map();

  for (const projection of projections) {
    if (!recordsByName.has(projection.readModel)) {
      throw new Error(`unknown read model: ${projection.readModel}`);
    }
    reserveField(usedFields, "Query", projection.queryName, projection.name);

    if (projection.subscriptionName) {
      if (projection.reactive !== true) {
        throw new Error(`cannot generate GraphQL subscription for non-reactive projection: ${projection.name}`);
      }
      reserveField(usedFields, "Subscription", projection.subscriptionName, projection.name);
    }
  }

  const enumSDL = model.enums.map(renderEnum).join("\n\n");
  const typeSDL = model.records.map((record) => renderRecord(record, recordsByName, enumsByName)).join("\n\n");
  const querySDL = renderRootType(
    "Query",
    projections.map((projection) => renderProjectionField(projection.queryName, projection)),
  );
  const subscriptionFields = projections
    .filter((projection) => projection.subscriptionName && projection.reactive === true)
    .map((projection) => renderProjectionField(projection.subscriptionName, projection));
  const subscriptionSDL = subscriptionFields.length > 0 ? `\n\n${renderRootType("Subscription", subscriptionFields)}` : "";

  return {
    sdl: [enumSDL, typeSDL, querySDL].filter(Boolean).join("\n\n") + subscriptionSDL,
    projections: projections.map((projection) => Object.freeze({ ...projection })),
  };
}

export function createMaterializationHarness() {
  const snapshots = new Map();
  const listeners = new Map();
  const readLog = [];

  return {
    readLog,

    seed(name, args, value, seq = 0) {
      snapshots.set(materializationKey(name, args), { value, seq });
    },

    read(name, args) {
      const key = materializationKey(name, args);
      readLog.push({ name, args: stableObject(args) });
      if (!snapshots.has(key)) {
        throw new Error(`materialization not found: ${name}`);
      }
      return snapshots.get(key);
    },

    subscribe(name, args, onPush) {
      const key = materializationKey(name, args);
      const current = listeners.get(key) ?? new Set();
      current.add(onPush);
      listeners.set(key, current);
      return () => current.delete(onPush);
    },

    push(name, args, value, seq) {
      const key = materializationKey(name, args);
      const payload = { value, seq };
      snapshots.set(key, payload);
      for (const listener of listeners.get(key) ?? []) {
        listener(payload);
      }
    },
  };
}

export function createGraphqlFacadeRuntime({ facade, materializations }) {
  const queryByName = new Map(facade.projections.map((projection) => [projection.queryName, projection]));
  const subscriptionByName = new Map(
    facade.projections
      .filter((projection) => projection.subscriptionName)
      .map((projection) => [projection.subscriptionName, projection]),
  );

  return {
    query(fieldName, args = {}) {
      const projection = getProjection(queryByName, fieldName, "query");
      return {
        source: "materialization",
        fieldName,
        ...materializations.read(projection.materialization, args),
      };
    },

    subscribe(fieldName, args = {}, onPush) {
      const projection = getProjection(subscriptionByName, fieldName, "subscription");
      if (projection.reactive !== true) {
        throw new Error(`subscription is not reactive: ${fieldName}`);
      }
      return materializations.subscribe(projection.materialization, args, (payload) =>
        onPush({
          source: "materialization",
          fieldName,
          ...payload,
        }),
      );
    },
  };
}

function parseBlocks(source, kind, parseBody) {
  const blocks = [];
  const expression = new RegExp(`${kind}\\s+([a-zA-Z][\\w-]*)\\s*\\{([\\s\\S]*?)\\}`, "g");
  let match;
  while ((match = expression.exec(source)) !== null) {
    blocks.push({
      name: match[1],
      ...parseBody(match[2]),
    });
  }
  return blocks;
}

function parseRecordBody(body) {
  const fields = body
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/,$/, ""))
    .filter(Boolean)
    .map((line) => {
      const match = /^([a-zA-Z][\w-]*)\s*:\s*(.+)$/.exec(line);
      if (!match) {
        throw new Error(`invalid record field: ${line}`);
      }
      return { name: match[1], type: match[2].trim() };
    });

  return { fields };
}

function parseEnumBody(body) {
  const values = body
    .split(/,|\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);

  return { values };
}

function renderEnum(entry) {
  return [`enum ${typeName(entry.name)} {`, ...entry.values.map((value) => `  ${enumValue(value)}`), "}"].join("\n");
}

function renderRecord(record, recordsByName, enumsByName) {
  return [
    `type ${typeName(record.name)} {`,
    ...record.fields.map((field) => `  ${fieldName(field.name)}: ${graphqlType(field.type, recordsByName, enumsByName)}`),
    "}",
  ].join("\n");
}

function renderRootType(name, fields) {
  return [`type ${name} {`, ...fields.map((field) => `  ${field}`), "}"].join("\n");
}

function renderProjectionField(field, projection) {
  const args = Object.entries(projection.args ?? {})
    .map(([name, type]) => `${fieldName(name)}: ${graphqlScalar(type)}!`)
    .join(", ");
  const suffix = projection.list === true ? `[${typeName(projection.readModel)}!]!` : `${typeName(projection.readModel)}!`;
  return `${fieldName(field)}${args ? `(${args})` : ""}: ${suffix}`;
}

function graphqlType(type, recordsByName, enumsByName) {
  const listMatch = /^list<(.+)>$/.exec(type);
  if (listMatch) {
    return `[${graphqlType(listMatch[1].trim(), recordsByName, enumsByName).replace(/!$/, "")}!]!`;
  }

  if (recordsByName.has(type) || enumsByName.has(type)) {
    return `${typeName(type)}!`;
  }

  return `${graphqlScalar(type)}!`;
}

function graphqlScalar(type) {
  switch (type) {
    case "bool":
      return "Boolean";
    case "u8":
    case "u16":
    case "u32":
    case "s8":
    case "s16":
    case "s32":
      return "Int";
    case "u64":
    case "s64":
    case "float32":
    case "float64":
      return "Float";
    case "timestamp":
      return "DateTime";
    case "string":
      return "String";
    default:
      return typeName(type);
  }
}

function reserveField(usedFields, rootType, field, projectionName) {
  const key = `${rootType}.${fieldName(field)}`;
  const existing = usedFields.get(key);
  if (existing) {
    throw new Error(`GraphQL field collision: ${key} used by ${existing} and ${projectionName}`);
  }
  usedFields.set(key, projectionName);
}

function getProjection(map, name, kind) {
  const projection = map.get(name);
  if (!projection) {
    throw new Error(`unknown GraphQL ${kind}: ${name}`);
  }
  return projection;
}

function materializationKey(name, args) {
  return `${name}:${JSON.stringify(stableObject(args))}`;
}

function stableObject(value) {
  return Object.fromEntries(Object.entries(value ?? {}).sort(([left], [right]) => left.localeCompare(right)));
}

function typeName(value) {
  return value
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

function fieldName(value) {
  const [first, ...rest] = value.split(/[-_]/).filter(Boolean);
  return [first, ...rest.map((part) => part[0].toUpperCase() + part.slice(1))].join("");
}

function enumValue(value) {
  return value.replace(/[-\s]+/g, "_").toUpperCase();
}
