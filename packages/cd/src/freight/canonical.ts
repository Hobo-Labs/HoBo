// Canonical JSON: object keys sorted by code unit, no whitespace, arrays in
// order. Values here are protobuf-JSON (strings, numbers, booleans, null,
// arrays, objects), so this is the RFC 8785 subset the ids need.
import type { JsonValue } from "@bufbuild/protobuf";
import { isJsonArray, isJsonObject } from "./json.js";

export function canonicalJson(value: JsonValue): string {
	if (isJsonArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isJsonObject(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
