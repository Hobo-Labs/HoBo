import { cloneAsJson, isJsonObject, type JsonValue, type JsonBag } from "../json.js";
export function canonicalJson<T>(value: T): string {
  return JSON.stringify(sortJson(cloneAsJson(value)));
}

export function diffJsonPaths<T, U>(
  expected: T,
  actual: U,
  prefix = "",
): string[] {
  return diffJsonValuePaths(cloneAsJson(expected), cloneAsJson(actual), prefix);
}

function diffJsonValuePaths(
  expected: JsonValue,
  actual: JsonValue,
  prefix = "",
): string[] {
  if (canonicalJson(expected) === canonicalJson(actual)) {
    return [];
  }

  if (
    expected === null ||
    actual === null ||
    !isJsonObject(expected) ||
    !isJsonObject(actual)
  ) {
    return [prefix || "$"];
  }

  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) {
      return [prefix || "$"];
    }

    const paths: string[] = [];
    const max = Math.max(expected.length, actual.length);
    for (let index = 0; index < max; index += 1) {
      const childPrefix = `${prefix}[${index}]`;
      if (index >= expected.length || index >= actual.length) {
        paths.push(childPrefix);
        continue;
      }
      paths.push(...diffJsonValuePaths(expected[index] ?? null, actual[index] ?? null, childPrefix));
    }
    return paths.length > 0 ? paths : [prefix || "$"];
  }

  const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  const paths: string[] = [];

  for (const key of [...keys].sort()) {
    const childPrefix = prefix ? `${prefix}.${key}` : key;
    if (!(key in expected) || !(key in actual)) {
      paths.push(childPrefix);
      continue;
    }
    paths.push(...diffJsonValuePaths(expected[key] ?? null, actual[key] ?? null, childPrefix));
  }

  return paths.length > 0 ? paths : [prefix || "$"];
}

function sortJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (!isJsonObject(value)) {
    return value;
  }

  const sorted: JsonBag = {};
  for (const key of Object.keys(value).sort()) {
    sorted[key] = sortJson(value[key] ?? null);
  }
  return sorted;
}
