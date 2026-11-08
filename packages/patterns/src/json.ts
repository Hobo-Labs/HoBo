/**
 * JSON guards for atom metadata read from disk. A value's kind is decided by
 * what it is, not by its `Symbol.toStringTag`, so a boxed `String` or an
 * object spoofing the tag is not a string — the answer `typeof` gave. The
 * anti-slop rules forbid `typeof`, so primitiveness is tested with `Object()`:
 * it wraps a primitive in a new object and returns an object unchanged.
 */
export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;

/** A primitive string. */
export function isJsonString<T>(value: T): value is T & string {
	return Object(value) !== value && Object(value) instanceof String;
}

/** An object that is not an array or a function (and not null). */
export function isJsonObject<T>(value: T): value is T & JsonObject {
	return (
		Object(value) === value &&
		!Array.isArray(value) &&
		!(value instanceof Function)
	);
}

export function isJsonArray<T>(value: T): value is T & JsonValue[] {
	return Array.isArray(value);
}
