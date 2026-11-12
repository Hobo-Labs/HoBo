/**
 * The values a libSQL result cell can hold, as `@libsql/client` hands them
 * back (`Value` in `@libsql/core/api`), and tag-based guards for them. The
 * guards read `Object.prototype.toString`, the same way `@hobo/kv-redis-compatible`
 * reads a reply, so a cell is classified by what it is, not by a `typeof`
 * that a boxed value could fool.
 */

export type LibsqlCell = null | string | number | bigint | ArrayBuffer;

const tagOf = Object.prototype.toString;

export function isCellText<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isCellNumber<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]";
}

export function isCellBigInt<T>(value: T): value is T & bigint {
	return tagOf.call(value) === "[object BigInt]";
}

export function isCellBytes<T>(
	value: T,
): value is T & (ArrayBuffer | Uint8Array) {
	const tag = tagOf.call(value);
	return tag === "[object ArrayBuffer]" || tag === "[object Uint8Array]";
}
