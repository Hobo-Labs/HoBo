import { isJsonArray, isJsonObject, type JsonBag, type JsonValue } from "./json.js";

export function sortKeys(value: JsonValue): JsonValue {
  if (isJsonArray(value)) {
    return value.map(sortKeys);
  }
  if (!isJsonObject(value)) {
    return value;
  }
  const bag: JsonBag = {};
  for (const key of Object.keys(value).sort()) {
    bag[key] = sortKeys(value[key] ?? null);
  }
  return bag;
}
