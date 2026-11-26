import { isJsonString, isJsonNumber, isJsonBoolean, isJsonObject } from "./json.js";
export const CONFIG_SCHEMA_VERSION = "hobo.config/v1";

const VALID_KEY = /^[A-Z][A-Z0-9_]*$/;

export function fromBinding(name, options = {}) {
  requireNonEmptyString(name, "binding name");
  return {
    kind: "from-binding",
    type: "string",
    required: options.required ?? true,
    sensitivity: "secretless",
    source: {
      kind: "binding",
      ref: name,
      devOnly: options.devOnly === true
    }
  };
}

export function secretRef(ref, options = {}) {
  requireNonEmptyString(ref, "secret ref");
  return {
    kind: "secret-ref",
    type: "string",
    required: options.required ?? true,
    sensitivity: "secret",
    source: {
      kind: "secret-ref",
      ref,
      devOnly: options.devOnly === true
    }
  };
}

export function env(defaultValue, options = {}) {
  return {
    kind: "env",
    type: primitiveTypeOf(defaultValue),
    required: options.required ?? false,
    sensitivity: "config",
    source: {
      kind: "camp-env",
      ref: options.ref,
      devOnly: options.devOnly === true
    },
    defaultType: primitiveTypeOf(defaultValue)
  };
}

export function secret(name) {
  requireNonEmptyString(name, "secret store name");
  return {
    kind: "managed-secret-store",
    name,
    portRef: "hobo:secrets"
  };
}

export function config(entries) {
  if (!entries || !isJsonObject(entries) || Array.isArray(entries)) {
    throw new TypeError("config() expects an object of config declarations");
  }

  const normalized = {};
  for (const [key, entry] of Object.entries(entries)) {
    if (!VALID_KEY.test(key)) {
      throw new TypeError(`config key ${key} must be SCREAMING_SNAKE_CASE`);
    }
    normalized[key] = normalizeEntry(key, entry);
  }

  return {
    schema: CONFIG_SCHEMA_VERSION,
    entries: normalized
  };
}

export function emitConfigManifest(contract) {
  if (contract?.schema !== CONFIG_SCHEMA_VERSION) {
    throw new TypeError(`expected ${CONFIG_SCHEMA_VERSION} contract`);
  }

  const entries = {};
  for (const [key, entry] of Object.entries(contract.entries)) {
    entries[key] = manifestEntry(key, entry);
  }

  return {
    schema: CONFIG_SCHEMA_VERSION,
    entries
  };
}

export function createConfigContext(contract, resolver = defaultResolver) {
  if (contract?.schema !== CONFIG_SCHEMA_VERSION) {
    throw new TypeError(`expected ${CONFIG_SCHEMA_VERSION} contract`);
  }

  const accessors = {};
  for (const [key, entry] of Object.entries(contract.entries)) {
    accessors[key] = async () => resolver(key, entry);
  }
  return { config: accessors };
}

export function serializeConfigManifest(manifest) {
  return canonicalJson(manifest);
}

export function scanSerializedManifestForValues(manifest, values) {
  const serialized = serializeConfigManifest(manifest);
  return values.filter((value) => value && serialized.includes(String(value)));
}

export function canonicalJson(value) {
  return JSON.stringify(sortObject(value));
}

function normalizeEntry(key, entry) {
  if (!entry || !isJsonObject(entry)) {
    throw new TypeError(`config entry ${key} must be created by a config builder`);
  }
  if (!entry.source?.kind || (entry.kind !== "env" && !entry.source?.ref)) {
    throw new TypeError(`config entry ${key} is missing a source ref`);
  }
  return { ...entry, source: { ...entry.source, ref: entry.source.ref ?? key } };
}

function manifestEntry(key, entry) {
  const source = {
    kind: entry.source.kind,
    ref: entry.source.ref ?? key,
    devOnly: entry.source.devOnly === true
  };
  const manifest = {
    type: entry.type,
    required: entry.required === true,
    sensitivity: entry.sensitivity,
    source
  };

  if (entry.kind === "env") {
    manifest.source.ref = key;
    manifest.defaultType = entry.defaultType;
  }
  if (source.devOnly) {
    manifest.productionDeployable = false;
  }

  return manifest;
}

function primitiveTypeOf(value) {
  if (isJsonString(value)) return "string";
  if (isJsonNumber(value)) return "number";
  if (isJsonBoolean(value)) return "boolean";
  throw new TypeError("env(default) supports string, number, or boolean defaults");
}

function requireNonEmptyString(value, label) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

async function defaultResolver(key) {
  throw new Error(`no config resolver provided for ${key}`);
}

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortObject(nested)])
  );
}
