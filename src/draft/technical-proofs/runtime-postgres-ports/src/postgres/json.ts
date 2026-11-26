import { isJsonString } from "../json.js";

export function clone<T>(value: T): T {
  if (value === undefined) {
    return value;
  }
  return structuredClone instanceof Function
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

export function requireNonEmptyString<T>(value: T, fieldName: string): string {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

export function optionalString<T>(value: T, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireNonEmptyString(value, fieldName);
}
