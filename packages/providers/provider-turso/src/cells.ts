
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
