// Narrow JSON guards for parse boundaries in the reconcile module.
import type { JsonObject, JsonValue } from "@hobo/core";

export function isJsonString(value: JsonValue | undefined): value is string {
	return typeof value === "string";
}

export function isJsonArray(
	value: JsonValue | undefined,
): value is JsonValue[] {
	return Array.isArray(value);
}

export function isJsonObject(
	value: JsonValue | undefined,
): value is JsonObject {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Deterministic JSON: object keys sorted at every depth. */
export function stableJson(value: JsonValue | undefined): string {
	if (value === undefined) return "null";
	if (isJsonArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (isJsonObject(value)) {
		const keys = Object.keys(value).sort();
		return `{${keys
			.map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}
