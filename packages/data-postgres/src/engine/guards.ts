/**
 * Runtime guards for the engine binding. Tag checks rather than `typeof`, so
 * a boxed value from another realm is classified the same way a primitive is.
 */
import type { JsonObject } from "@hobo/data-core";

const tagOf = Object.prototype.toString;

export function isText<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isPlainObject<T>(value: T): value is T & JsonObject {
	return (
		value !== null &&
		value !== undefined &&
		!Array.isArray(value) &&
		tagOf.call(value) === "[object Object]"
	);
}
