import { cloneJson, deepFreeze, expectObject } from "./parse-utils.js";
import { EnvelopeParseError } from "./errors.js";
import { type JsonValue } from "./json.js";


export const CORE_SCHEMA_VERSION = "hobo.core/v1";

export const CORE_API_SNAPSHOT = deepFreeze({
  schemaVersion: CORE_SCHEMA_VERSION,
  packageName: "@hobo/core",
  exports: [
    "CapabilityManifestBundle",
    "Container",
    "EventEnvelope",
    "PortDescriptor",
    "ProviderPort",
    "RuntimePort",
    "parseEventEnvelope",
    "createEventEnvelope",
    "toCloudEvent",
    "fromCloudEvent",
    "parseCapabilityManifestBundle",
    "createPortDescriptor",
    "createContainer",
    "assertCoreApiSnapshot",
    "validatePublicTypeSurface",
    "CORE_API_SNAPSHOT",
    "CoreParseError",
    "EnvelopeParseError",
    "ManifestParseError",
    "PortDescriptorParseError",
  ],
});

const PROVIDER_LEAK_PATTERN =
  /(Aws|AWS|Azure|Gcp|GCP|GoogleCloud|Cloudflare|Hetzner|Fly|Vercel)/;

export interface PublicTypeSurfaceResult {
  ok: boolean;
  errors: string[];
}

export function assertCoreApiSnapshot(snapshot: JsonValue): typeof CORE_API_SNAPSHOT {
  const source = expectObject(snapshot, "API snapshot", EnvelopeParseError);
  const expected = JSON.stringify(CORE_API_SNAPSHOT.exports);
  const actual = JSON.stringify(source.exports);
  if (source.schemaVersion !== CORE_API_SNAPSHOT.schemaVersion || actual !== expected) {
    throw new Error(
      "public API snapshot drift: update snapshot deliberately with a breaking-change note",
    );
  }
  // SAFETY: `return deepFreeze(cloneJson(source)) as typeof CORE_API_SNAPSHOT;` is required at this I/O or test boundary.
  return deepFreeze(cloneJson(source)) as typeof CORE_API_SNAPSHOT;
}

export function validatePublicTypeSurface(declarationText: JsonValue): PublicTypeSurfaceResult {
  const errors: string[] = [];
  const text = String(declarationText ?? "");
  if (PROVIDER_LEAK_PATTERN.test(text)) {
    errors.push("provider-specific symbol leak in @hobo/core public type surface");
  }
  for (const forbidden of ["accessKeyId", "secretAccessKey", "subscriptionId", "serviceAccountJson"]) {
    if (text.includes(forbidden)) {
      errors.push(`provider credential field leak: ${forbidden}`);
    }
  }
  for (const exported of CORE_API_SNAPSHOT.exports) {
    if (!text.includes(exported)) {
      errors.push(`missing public export declaration: ${exported}`);
    }
  }
  return { ok: errors.length === 0, errors };
}
