import { REDACTED } from "../core/secret-value.js";
import { isJsonString, isJsonObject, type JsonValue, type JsonObject, type JsonBag } from "../json.js";


const secretRegistry = new Set<string>();

export function registerSecretForRedaction(value: string): void {
  if (isJsonString(value) && value.length > 0) {
    secretRegistry.add(value);
  }
}

export function clearSecretRegistry(): void {
  secretRegistry.clear();
}

export function scrubAtCapture<T>(payload: T): T {
  if (secretRegistry.size === 0) {
    return payload;
  }

  if (isJsonString(payload)) {
    // SAFETY: assertion to `return scrubString(payload) as T;` is required at this boundary.
    return scrubString(payload) as T;
  }

  if (payload === null || payload === undefined || !isJsonObject(payload)) {
    return payload;
  }

  if (Array.isArray(payload)) {
    // SAFETY: assertion to `return payload.map((item) => scrubAtCapture(item)) as T;` is required at this boundary.
    return payload.map((item) => scrubAtCapture(item)) as T;
  }

  const result: JsonBag = {};
  // SAFETY: assertion to `for (const [key, value] of Object.entries(payload as JsonObject)) {` is required at this boundary.
  for (const [key, value] of Object.entries(payload as JsonObject)) {
    if (key === "value" && isJsonString(value) && secretRegistry.has(value)) {
      continue;
    }
    result[key] = scrubAtCapture(value);
  }
  // SAFETY: assertion to `return result as T;` is required at this boundary.
  return result as T;
}

export type ConformanceSurfaces = {
  readonly bindle?: JsonValue;
  readonly camp?: JsonValue;
  readonly events?: JsonValue;
  readonly logs?: JsonValue;
  readonly spans?: JsonValue;
  readonly streams?: JsonValue;
};

export function assertNoPlaintextConformance(
  surfaces: ConformanceSurfaces,
  secretValues: readonly string[],
): PlaintextConformanceResult {
  const secrets = [...new Set(secretValues.filter((value) => value.length > 0))];
  const leaks: string[] = [];

  for (const [name, surface] of Object.entries(surfaces)) {
    if (surface === undefined || surface === null) continue;
    const serialized = serializeSurface(surface);
    for (const secret of secrets) {
      if (serialized.includes(secret)) {
        leaks.push(`${name} contains plaintext secret`);
      }
    }
  }

  if (leaks.length > 0) {
    throw new Error(`no-plaintext conformance failed: ${[...new Set(leaks)].join("; ")}`);
  }

  return { ok: true } satisfies PlaintextConformanceResult;
}

export interface PlaintextConformanceResult {
  readonly ok: true;
}

function scrubString(input: string): string {
  let output = input;
  for (const secret of secretRegistry) {
    if (output.includes(secret)) {
      output = output.split(secret).join(REDACTED);
    }
  }
  return output;
}

function serializeSurface(surface: JsonValue): string {
  if (isJsonString(surface)) {
    return surface;
  }
  return JSON.stringify(surface);
}
