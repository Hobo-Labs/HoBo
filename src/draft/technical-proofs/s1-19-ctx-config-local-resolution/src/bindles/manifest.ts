import type { ConfigContract, ConfigEntry, ConfigManifest, ConfigManifestEntry } from "./types.js";
import { CONFIG_SCHEMA_VERSION } from "./types.js";
import { isJsonObject, type JsonValue, type JsonObject } from "../json.js";


export function emitConfigManifest(contract: ConfigContract): ConfigManifest {
  if (contract.schema !== CONFIG_SCHEMA_VERSION) {
    throw new TypeError(`expected ${CONFIG_SCHEMA_VERSION} contract`);
  }

  const entries: Record<string, ConfigManifestEntry> = {};
  for (const [key, entry] of Object.entries(contract.entries)) {
    entries[key] = manifestEntry(key, entry);
  }

  return {
    schema: CONFIG_SCHEMA_VERSION,
    entries,
  };
}

export function serializeConfigManifest(manifest: ConfigManifest): string {
  return canonicalJson(manifest);
}

export function scanSerializedManifestForValues(manifest: JsonValue, values: string[]): string[] {
  // SAFETY: assertion to `const serialized = serializeConfigManifest(manifest as ConfigManifest);` is required at this boundary.
  const serialized = serializeConfigManifest(manifest as ConfigManifest);
  return values.filter((value) => value && serialized.includes(String(value)));
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(sortObject(value));
}

function manifestEntry(key: string, entry: ConfigEntry): ConfigManifestEntry {
  const source = {
    kind: entry.source.kind,
    ref: entry.kind === "env" ? key : (entry.source.ref ?? key),
    devOnly: entry.source.devOnly === true,
  };

  return {
    type: entry.type,
    required: entry.required === true,
    sensitivity: entry.sensitivity,
    source,
    ...(entry.kind === "env" ? { defaultType: entry.defaultType } : undefined),
    ...(source.devOnly ? { productionDeployable: false as const } : undefined),
  };
}

function sortObject(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortObject);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(
    // SAFETY: assertion to `Object.entries(value as JsonObject)` is required at this boundary.
    Object.entries(value as JsonObject)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortObject(nested)]),
  );
}
