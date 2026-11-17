const tagOf = Object.prototype.toString;

export type JsonObject = { readonly [key: string]: JsonValue };
export interface JsonBag {
	[key: string]: JsonValue;
}
export interface StringBag {
	[key: string]: string;
}
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;

export function isJsonString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]" && Object(value) !== value;
}

export function isJsonBigInt<T>(value: T): value is T & bigint {
	return tagOf.call(value) === "[object BigInt]" && Object(value) !== value;
}

export function isJsonNumber<T>(value: T): value is T & number {
	return Number.isFinite(value);
}

export function isJsonBoolean<T>(value: T): value is T & boolean {
	return value === true || value === false;
}

export function isJsonObject<T>(value: T): value is T & JsonObject {
	return (
		value !== undefined &&
		value !== null &&
		!Array.isArray(value) &&
		tagOf.call(value) === "[object Object]"
	);
}

export function isJsonArray<T>(value: T): value is T & JsonValue[] {
	return tagOf.call(value) === "[object Array]";
}

export function cloneAsJson<T>(value: T): JsonValue {
	try {
		const encoded = JSON.stringify(value ?? null, (_key, entry) => {
			const tag = tagOf.call(entry);
			if (
				tag === "[object BigInt]" ||
				(tag === "[object Number]" && !Number.isFinite(entry))
			)
				throw new TypeError("value cannot be represented as JSON");
			return entry;
		});
		return parseJsonValue(encoded);
	} catch {
		throw new TypeError("value cannot be represented as JSON");
	}
}

export function parseJsonObject(text: string): JsonObject {
	const value = parseJsonValue(text);
	return isJsonObject(value) ? value : {};
}

export function asJsonObject<T>(value: T): JsonObject {
	const json = cloneAsJson(value);
	return isJsonObject(json) ? json : {};
}

export function parseJsonValue(text: string): JsonValue {
	try {
		return JSON.parse(text, (_key, value) => {
			if (tagOf.call(value) === "[object Number]" && !Number.isFinite(value))
				throw new TypeError("value cannot be represented as JSON");
			return value;
		}) as JsonValue;
	} catch {
		return null;
	}
}
