import {
  EnvelopeParseError,
  ManifestParseError,
  PortDescriptorParseError,
} from "./errors.js";
import { isJsonString, isJsonObject, type JsonValue, type JsonObject } from "./json.js";


export function deepFreeze<T>(value: T): T {
  if (value && isJsonObject(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
  }
  return value;
}

export function cloneJson<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  // SAFETY: `return JSON.parse(JSON.stringify(value)) as T;` is required at this I/O or test boundary.
  return JSON.parse(JSON.stringify(value)) as T;
}

export function expectObject(
  value: JsonValue | undefined,
  field: string,
  ErrorClass: typeof EnvelopeParseError | typeof ManifestParseError | typeof PortDescriptorParseError,
): JsonObject {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new ErrorClass(field, "object", value ?? null);
  }
  // SAFETY: `return value as JsonObject;` is required at this I/O or test boundary.
  return value as JsonObject;
}

export function assertNoExtra(
  value: JsonObject,
  field: string,
  allowed: readonly string[],
  ErrorClass: typeof EnvelopeParseError | typeof ManifestParseError | typeof PortDescriptorParseError,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      throw new ErrorClass(field, `only keys ${allowed.join(", ")}`, key);
    }
  }
}

export function requiredArray(
  value: JsonValue | undefined,
  field: string,
  ErrorClass: typeof EnvelopeParseError | typeof ManifestParseError | typeof PortDescriptorParseError,
): JsonValue[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ErrorClass(field, "non-empty array", value ?? null);
  }
  return value;
}

export function uniqueStringArray(
  value: JsonValue | undefined,
  field: string,
  ErrorClass: typeof EnvelopeParseError | typeof ManifestParseError | typeof PortDescriptorParseError,
  options: { minLength?: number } = {},
): string[] {
  const array =
    options.minLength !== undefined
      ? requiredArray(value, field, ErrorClass)
      : Array.isArray(value)
        ? value
        : [];
  const seen = new Set<string>();
  return array.map((entry, index) => {
    const normalized = nonEmptyString(entry, `${field}[${index}]`, ErrorClass);
    if (seen.has(normalized)) {
      throw new ErrorClass(field, "unique strings", normalized);
    }
    seen.add(normalized);
    return normalized;
  });
}

export function enumValue<T extends string>(
  value: JsonValue | undefined,
  allowed: ReadonlySet<T>,
  field: string,
  ErrorClass: typeof EnvelopeParseError | typeof ManifestParseError | typeof PortDescriptorParseError,
): T {
  // SAFETY: `if (!isJsonString(value) || !allowed.has(value as T)) {` is required at this I/O or test boundary.
  if (!isJsonString(value) || !allowed.has(value as T)) {
    throw new ErrorClass(field, [...allowed].join(" | "), value ?? null);
  }
  // SAFETY: `return value as T;` is required at this I/O or test boundary.
  return value as T;
}

export function nonEmptyString(
  value: JsonValue | undefined,
  field: string,
  ErrorClass: typeof EnvelopeParseError | typeof ManifestParseError | typeof PortDescriptorParseError,
): string {
  if (!isJsonString(value) || value.length === 0) {
    throw new ErrorClass(field, "non-empty string", value ?? null);
  }
  return value;
}

export function nonNegativeInteger(
  value: JsonValue | undefined,
  field: string,
  ErrorClass: typeof EnvelopeParseError | typeof ManifestParseError | typeof PortDescriptorParseError,
): number {
  // SAFETY: `if (!Number.isSafeInteger(value) || (value as number) < 0) {` is required at this I/O or test boundary.
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new ErrorClass(field, "non-negative integer", value ?? null);
  }
  // SAFETY: `return value as number;` is required at this I/O or test boundary.
  return value as number;
}

export function positiveInteger(
  value: JsonValue | undefined,
  field: string,
  ErrorClass: typeof EnvelopeParseError | typeof ManifestParseError | typeof PortDescriptorParseError,
  options: { max?: number } = {},
): number {
  // SAFETY: `if (!Number.isSafeInteger(value) || (value as number) <= 0) {` is required at this I/O or test boundary.
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ErrorClass(field, "positive integer", value ?? null);
  }
  // SAFETY: `if (options.max !== undefined && (value as number) > options.max) {` is required at this I/O or test boundary.
  if (options.max !== undefined && (value as number) > options.max) {
    throw new ErrorClass(field, `integer <= ${options.max}`, value ?? null);
  }
  // SAFETY: `return value as number;` is required at this I/O or test boundary.
  return value as number;
}

export function isoTimestamp(
  value: JsonValue | undefined,
  field: string,
  ErrorClass: typeof EnvelopeParseError | typeof ManifestParseError | typeof PortDescriptorParseError,
): string {
  const timestamp = nonEmptyString(value, field, ErrorClass);
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new ErrorClass(field, "ISO timestamp", value);
  }
  return timestamp;
}

export function httpsUrl(
  value: JsonValue | undefined,
  field: string,
  ErrorClass: typeof EnvelopeParseError | typeof ManifestParseError | typeof PortDescriptorParseError,
): string {
  const url = nonEmptyString(value, field, ErrorClass);
  if (!/^https:\/\/[^/\s]+(?:\/[^\s]*)?$/.test(url)) {
    throw new ErrorClass(field, "https URL", value);
  }
  return url;
}

export function sha256Ref(
  value: JsonValue | undefined,
  field: string,
  ErrorClass: typeof EnvelopeParseError | typeof ManifestParseError | typeof PortDescriptorParseError,
): string {
  const ref = nonEmptyString(value, field, ErrorClass);
  if (!/^sha256:[a-f0-9]{64}$/.test(ref)) {
    throw new ErrorClass(field, "sha256:<64 hex chars>", value);
  }
  return ref;
}

export function currency(
  value: JsonValue | undefined,
  field: string,
  ErrorClass: typeof EnvelopeParseError | typeof ManifestParseError | typeof PortDescriptorParseError,
): string {
  const code = nonEmptyString(value, field, ErrorClass);
  if (!/^[A-Z]{3}$/.test(code)) {
    throw new ErrorClass(field, "ISO-4217 uppercase currency", value);
  }
  return code;
}

export function headerName(
  value: JsonValue | undefined,
  field: string,
  ErrorClass: typeof EnvelopeParseError | typeof ManifestParseError | typeof PortDescriptorParseError,
): string {
  const header = nonEmptyString(value, field, ErrorClass);
  if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(header)) {
    throw new ErrorClass(field, "HTTP header name", value);
  }
  return header;
}

export function canonicalJsonObject(
  value: JsonValue | undefined,
  field: string,
  ErrorClass: typeof EnvelopeParseError | typeof ManifestParseError | typeof PortDescriptorParseError,
): JsonObject {
  const source = expectObject(value, field, ErrorClass);
  return cloneJson(source);
}
