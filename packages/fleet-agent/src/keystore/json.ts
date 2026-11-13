// JSON guards for what the key stores read back from disk and from an external
// signer, without runtime `typeof` (the same tag check as `@hobo/core`'s).
import type { JsonObject, JsonValue } from "@hobo/core";

const tagOf = Object.prototype.toString;

export function isJsonString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonNumber<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]";
}

export function isJsonObject<T>(value: T): value is T & JsonObject {
	return (
		value !== undefined &&
		value !== null &&
		!Array.isArray(value) &&
		tagOf.call(value) === "[object Object]"
	);
}

/** Parses JSON text, or answers undefined when it is not JSON. */
export function parseJsonText(text: string): JsonValue | undefined {
	try {
		const value: JsonValue = JSON.parse(text);
		return value;
	} catch {
		return undefined;
	}
}
