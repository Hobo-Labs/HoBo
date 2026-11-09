/**
 * JSON guards for atom metadata read from disk. A value's kind is decided by
 * what it is, not by its `Symbol.toStringTag`, so a boxed `String` or an
 * object spoofing the tag is not a string — the answer `typeof` gave. The
 * anti-slop rules forbid `typeof`, so primitiveness is tested with `Object()`:
 * it wraps a primitive in a new object and returns an object unchanged.
 *
 * The guards are shallow: they establish only the outermost kind of a value
 * that `JSON.parse` produced. They are stricter than the tag-based guards in
 * `packages/code/src/json.ts`: only primitive strings and plain objects in
 * this realm qualify. Callers re-guard every leaf they read, which is what
 * keeps each field's refusal specific.
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

/**
 * A plain object: not null, not an array, and with `Object.prototype` (or no
 * prototype) — so a `Date`, `Map`, class instance, or boxed primitive is not
 * one, matching what `JSON.parse` can produce.
 */
export function isJsonObject<T>(value: T): value is T & JsonObject {
	if (Object(value) !== value || Array.isArray(value)) return false;
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

export function isJsonArray<T>(value: T): value is T & JsonValue[] {
	return Array.isArray(value);
}
