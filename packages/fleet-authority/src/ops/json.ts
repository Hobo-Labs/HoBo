// JSON guards for the operations' own stored values, without runtime `typeof`
// (the same tag check as `@hobo/core`'s json.ts, which the core barrel does
// not export). Private to L27.
import type { JsonObject, JsonValue } from "@hobo/core";

const tagOf = Object.prototype.toString;

export function isJsonString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonNumber<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]";
}

export function isJsonArray<T>(value: T): value is T & JsonValue[] {
	return Array.isArray(value);
}

export function isJsonObject<T>(value: T): value is T & JsonObject {
	return (
		value !== undefined &&
		value !== null &&
		!Array.isArray(value) &&
		tagOf.call(value) === "[object Object]"
	);
}

/** Parses JSON text; undefined when it is not JSON. */
export function parseJson(text: string): JsonValue | undefined {
	try {
		const value: JsonValue = JSON.parse(text);
		return value;
	} catch {
		return undefined;
	}
}

export function stringField(
	object: JsonObject,
	key: string,
): string | undefined {
	const value = object[key];
	return isJsonString(value) ? value : undefined;
}

export function numberField(
	object: JsonObject,
	key: string,
): number | undefined {
	const value = object[key];
	return isJsonNumber(value) ? value : undefined;
}
