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

export type ReadonlyJsonValue =
	| string
	| number
	| boolean
	| null
	| readonly ReadonlyJsonValue[]
	| { readonly [key: string]: ReadonlyJsonValue };

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

export function cloneAsJson<T>(value: T): JsonValue {
	return parseJsonValue(JSON.stringify(value ?? null));
}

export function parseJsonObject(text: string): JsonObject {
	let value: JsonValue;
	try {
		value = JSON.parse(text) as JsonValue;
	} catch {
		return {};
	}
	return isJsonObject(value) ? value : {};
}

export function asJsonObject<T>(value: T): JsonObject {
	const json = cloneAsJson(value);
	return isJsonObject(json) ? json : {};
}

export function parseJsonValue(text: string): JsonValue {
	try {
		return JSON.parse(text) as JsonValue;
	} catch {
		return null;
	}
}

export function stableStringify(value: ReadonlyJsonValue): string {
	if (
		value === null ||
		isJsonString(value) ||
		isJsonNumber(value) ||
		isJsonBoolean(value)
	) {
		return JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
	}
	const entries: [string, ReadonlyJsonValue][] = Object.entries(value);
	entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
	return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(",")}}`;
}
