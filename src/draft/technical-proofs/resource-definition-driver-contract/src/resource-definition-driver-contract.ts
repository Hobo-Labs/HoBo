import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const RESOURCE_DEFINITION_VERSION = "hobo.resource-definition/v1";
export const CATALOG_SNAPSHOT_VERSION = "hobo.resource-definition-catalog/v1";

export const DRIVER_IDS = Object.freeze([
  "terraform",
  "template",
  "echo",
  "container",
  "custom-webhook"
]);

const DRIVER_CONTRACTS = Object.freeze({
  terraform: Object.freeze({ id: "terraform", mutability: "managed" }),
  template: Object.freeze({ id: "template", mutability: "managed" }),
  echo: Object.freeze({ id: "echo", mutability: "read-only" }),
  container: Object.freeze({ id: "container", mutability: "managed" }),
  "custom-webhook": Object.freeze({ id: "custom-webhook", mutability: "managed" })
});

const DRIVER_ID_SET = new Set(DRIVER_IDS);
const MATCH_DIMENSIONS = new Set([
  "tenant",
  "app",
  "env",
  "envType",
  "resourceType",
  "resourceClass",
  "resourceId"
]);

export function defineResource(input) {
  const errors = [];
  const provider = normalizeProviderRef(input?.provider);

  if (!isNonEmptyString(input?.type)) errors.push("type is required");
  if (!isNonEmptyString(provider)) errors.push("provider is required");
  if (!isNonEmptyString(input?.driver)) {
    errors.push("driver is required");
  } else if (!DRIVER_ID_SET.has(input.driver)) {
    errors.push(`unknown driver id ${input.driver}`);
  }

  const match = input?.match ?? {};
  for (const key of Object.keys(match)) {
    if (!MATCH_DIMENSIONS.has(key)) {
      errors.push(`unknown match dimension ${key}`);
    }
  }

  if (input?.type === "projection-sink" && !input.paradigm) {
    errors.push("projection-sink definitions require a paradigm");
  }

  if (input?.type === "projection-sink" && !isValidMapping(input.mapping)) {
    errors.push("projection-sink definitions require a non-empty mapping");
  }

  if (errors.length > 0) {
    throw new Error(errors.join("; "));
  }

  const className = input.className ?? input.class ?? undefined;
  const normalized = {
    apiVersion: RESOURCE_DEFINITION_VERSION,
    id: input.id ?? resourceDefinitionId(input),
    type: input.type,
    provider,
    driver: input.driver,
    with: sortKeys(input.with ?? {}),
    match: sortKeys(match),
    priority: input.priority ?? 0,
    coProvisioned: [...(input.coProvisioned ?? [])]
  };

  if (input.engine) normalized.engine = input.engine;
  if (className) normalized.className = className;
  if (input.paradigm) normalized.paradigm = input.paradigm;
  if (input.mapping !== undefined) normalized.mapping = input.mapping;

  return normalized;
}

export function createResourceCatalog({ id = "default" } = {}) {
  const definitions = [];

  return {
    register(providerOrDefinition) {
      const toRegister = Array.isArray(providerOrDefinition?.defaultDefinitions)
        ? providerOrDefinition.defaultDefinitions.map((definition) => ({
            ...definition,
            provider: providerOrDefinition.id
          }))
        : [providerOrDefinition];

      const normalized = toRegister.map(defineResource);
      definitions.push(...normalized);
      return normalized;
    },

    definitionsForType(type) {
      return sortedDefinitions(definitions.filter((definition) => definition.type === type));
    },

    snapshot() {
      return createCatalogSnapshot(id, definitions);
    },

    contentHash() {
      return createCatalogSnapshot(id, definitions).contentHash;
    },

    ambiguities() {
      return findCatalogAmbiguities(definitions);
    }
  };
}

export function createCatalogSnapshot(id, definitions) {
  const normalized = sortedDefinitions(definitions).map((definition) => sortKeys(definition));
  return {
    apiVersion: CATALOG_SNAPSHOT_VERSION,
    id,
    definitions: normalized,
    contentHash: stableDigest(normalized),
    ambiguities: findCatalogAmbiguities(normalized)
  };
}

export function createDriver(driver) {
  if (!DRIVER_ID_SET.has(driver?.id)) {
    throw new Error(`unknown driver id ${driver?.id ?? "<missing>"}`);
  }
  if (!(driver.provision instanceof Function)) {
    throw new Error(`driver ${driver.id} must implement provision`);
  }
  if (!(driver.destroy instanceof Function)) {
    throw new Error(`driver ${driver.id} must implement destroy`);
  }
  if (driver.refresh !== undefined && !(driver.refresh instanceof Function)) {
    throw new Error(`driver ${driver.id} refresh must be a function when present`);
  }
  return Object.freeze({ ...driver });
}

export function driverContractFor(driverId) {
  const contract = DRIVER_CONTRACTS[driverId];
  if (!contract) {
    throw new Error(`unknown driver id ${driverId ?? "<missing>"}`);
  }
  return contract;
}

export function stableDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

export function findCatalogAmbiguities(definitions) {
  const groups = new Map();
  for (const definition of definitions) {
    const key = ambiguityKey(definition);
    const group = groups.get(key) ?? [];
    group.push(definition);
    groups.set(key, group);
  }

  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([key, group]) => ({
      key,
      definitionIds: group.map((definition) => definition.id).sort(),
      reason: "same resource shape and match criteria; Matching must resolve by priority/objective/tiebreak"
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
}

function resourceDefinitionId(input) {
  const provider = normalizeProviderRef(input.provider);
  const parts = [
    provider,
    input.type,
    input.engine,
    input.className ?? input.class,
    input.paradigm,
    input.driver,
    stableDigest(input.match ?? {}).slice(0, 8)
  ].filter(Boolean);
  return parts.join(".");
}

function ambiguityKey(definition) {
  return JSON.stringify(sortKeys({
    type: definition.type,
    engine: definition.engine,
    className: definition.className,
    paradigm: definition.paradigm,
    match: definition.match
  }));
}

function sortedDefinitions(definitions) {
  return [...definitions].sort((left, right) => left.id.localeCompare(right.id));
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}

function normalizeProviderRef(provider) {
  if (isNonEmptyString(provider)) return provider;
  if (provider && isJsonObject(provider) && isNonEmptyString(provider.id)) return provider.id;
  return undefined;
}

function isValidMapping(mapping) {
  if (isNonEmptyString(mapping)) return true;
  return Boolean(
    mapping &&
      isJsonObject(mapping) &&
      !Array.isArray(mapping) &&
      Object.keys(mapping).length > 0
  );
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
