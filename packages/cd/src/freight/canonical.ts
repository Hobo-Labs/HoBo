// Canonical JSON: object keys sorted by code unit, no whitespace, arrays in
// order. Values here are protobuf-JSON (strings, numbers, booleans, null,
// arrays, objects), so this is the RFC 8785 subset the ids need.
import type { JsonObject, JsonValue } from "@bufbuild/protobuf";

export function isPlainObject(value: JsonValue | undefined): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function canonicalJson(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
	if (isPlainObject(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key] ?? null)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
