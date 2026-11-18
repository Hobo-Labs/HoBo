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
	return tagOf.call(value) === "[object String]";
}

export function isJsonBigInt<T>(value: T): value is T & bigint {
	return tagOf.call(value) === "[object BigInt]";
}

export function isJsonNumber<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]";
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

export function isJsonValue<T>(value: T): value is T & JsonValue {
	if (
		value === null ||
		isJsonString(value) ||
		isJsonNumber(value) ||
		isJsonBoolean(value)
	) {
		return true;
	}
	if (isJsonArray(value)) return value.every(isJsonValue);
	if (isJsonObject(value)) return Object.values(value).every(isJsonValue);
	return false;
}

export function cloneAsJson<T>(value: T): JsonValue {
	return parseJsonValue(JSON.stringify(value ?? null));
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
		const value: unknown = JSON.parse(text);
		return isJsonValue(value) ? value : null;
	} catch {
		return null;
	}
}
