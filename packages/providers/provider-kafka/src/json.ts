const tagOf = Object.prototype.toString;

export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;

export function isJsonString(value: JsonValue | undefined): value is string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonNumber(value: JsonValue | undefined): value is number {
	return tagOf.call(value) === "[object Number]";
}

export function isJsonObject(
	value: JsonValue | undefined,
): value is JsonObject {
	return (
		value !== undefined &&
		value !== null &&
		!Array.isArray(value) &&
		tagOf.call(value) === "[object Object]"
	);
}

export function isJsonArray(
	value: JsonValue | undefined,
): value is JsonValue[] {
	return tagOf.call(value) === "[object Array]";
}

export function parseJsonValue(text: string): JsonValue {
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		return JSON.parse(text) as JsonValue;
	} catch {
		return null;
	}
}
