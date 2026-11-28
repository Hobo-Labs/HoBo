import type { JsonObject, JsonValue } from "@hobo/core";

export function parseJournalJson(text: string): JsonValue {
	// SAFETY: JSON.parse can only return JSON values and throws for malformed text.
	return JSON.parse(text) as JsonValue;
}

export function isJournalString<T>(value: T): value is T & string {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: this is the primitive check at the journal's untrusted input boundary.
	return typeof value === "string";
}

export function isJournalNumber<T>(value: T): value is T & number {
	// oxlint-disable-next-line anti-slop/no-runtime-typeof -- SAFETY: this is the primitive check at the journal's untrusted input boundary.
	return typeof value === "number";
}

export function isJournalObject(
	value: JsonValue | undefined,
): value is JsonObject {
	return (
		value !== null &&
		value !== undefined &&
		!Array.isArray(value) &&
		Object.prototype.toString.call(value) === "[object Object]"
	);
}
