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
export function stableJson(value: unknown): string {
	if (value === undefined) return "null";
	if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value).sort(([a], [b]) =>
			a < b ? -1 : a > b ? 1 : 0,
		);
		return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
	}
	return JSON.stringify(value);
}
