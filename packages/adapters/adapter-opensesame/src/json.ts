const tagOf = Object.prototype.toString;

export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| JsonObject;

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

export function isJsonArray<T>(value: T): value is T & readonly JsonValue[] {
	return tagOf.call(value) === "[object Array]";
}

/** Read a JSON document at its I/O boundary; a document that is not JSON is `null`. */
export function parseJsonValue(text: string): JsonValue {
	try {
		// SAFETY: JSON.parse yields a JSON value at this document boundary.
		return JSON.parse(text) as JsonValue;
	} catch {
		return null;
	}
}
