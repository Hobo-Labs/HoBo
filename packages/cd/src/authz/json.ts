import type { JsonObject, JsonValue } from "@hobo/core";

const tagOf = Object.prototype.toString;

export function isText(value: JsonValue | undefined): value is string {
	return tagOf.call(value) === "[object String]";
}

export function isFiniteNumber(value: JsonValue | undefined): value is number {
	return tagOf.call(value) === "[object Number]" && Number.isFinite(value);
}

export function isJsonObject(
	value: JsonValue | undefined,
): value is JsonObject {
	return tagOf.call(value) === "[object Object]";
}

export function parseJsonText(text: string): JsonValue | undefined {
	try {
		const parsed: JsonValue = JSON.parse(text);
		return parsed;
	} catch {
		return undefined;
	}
}
