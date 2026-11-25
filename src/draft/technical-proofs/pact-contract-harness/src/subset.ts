import { isJsonString, isJsonNumber, isJsonBoolean, isJsonObject, type JsonValue, type JsonObject } from "./json.js";
/** Recursive subset: every field in `expected` must exist with equal value in `actual`. */
export function isRecursiveSubset(expected: JsonValue, actual: JsonValue, path = "$"): boolean {
  if (expected === actual) {
    return true;
  }

  if (expected === null || expected === undefined) {
    return expected === actual;
  }

  if (jsonKind(expected) !== jsonKind(actual)) {
    return false;
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || expected.length > actual.length) {
      return false;
    }
    return expected.every((item, index) =>
      isRecursiveSubset(item, actual[index], `${path}[${index}]`),
    );
  }

  if (isJsonObject(expected) && expected !== null) {
    if (!isJsonObject(actual)) {
      return false;
    }
    // SAFETY: assertion to `const expectedRecord = expected as JsonObject;` is required at this boundary.
    const expectedRecord = expected as JsonObject;
    // SAFETY: assertion to `const actualRecord = actual as JsonObject;` is required at this boundary.
    const actualRecord = actual as JsonObject;
    return Object.keys(expectedRecord).every((key) =>
      isRecursiveSubset(expectedRecord[key], actualRecord[key], `${path}.${key}`),
    );
  }

  return false;
}

/** Find first path where expected is not a subset of actual. */
export function subsetMismatchPath(
  expected: JsonValue,
  actual: JsonValue,
  path = "$",
): string | undefined {
  if (isRecursiveSubset(expected, actual, path)) {
    return undefined;
  }

  if (
    expected === null ||
    expected === undefined ||
    !isJsonObject(expected)
  ) {
    return path;
  }

  if (!isJsonObject(actual)) {
    return path;
  }

  // SAFETY: assertion to `const expectedRecord = expected as JsonObject;` is required at this boundary.
  const expectedRecord = expected as JsonObject;
  // SAFETY: assertion to `const actualRecord = actual as JsonObject;` is required at this boundary.
  const actualRecord = actual as JsonObject;

  for (const key of Object.keys(expectedRecord)) {
    const childPath = `${path}.${key}`;
    if (!(key in actualRecord)) {
      return childPath;
    }
    const nested = subsetMismatchPath(expectedRecord[key], actualRecord[key], childPath);
    if (nested) {
      return nested;
    }
  }

  return path;
}

function jsonKind(value: JsonValue): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (isJsonObject(value)) {
    return "object";
  }
  if (isJsonString(value)) {
    return "string";
  }
  if (isJsonNumber(value)) {
    return "number";
  }
  if (isJsonBoolean(value)) {
    return "boolean";
  }
  return "other";
}
