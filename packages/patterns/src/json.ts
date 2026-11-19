export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;

export function isJsonString<T>(value: T): value is T & string {
	return Object(value) !== value && Object(value) instanceof String;
}

export function isJsonNumber<T>(value: T): value is T & number {
	return Object(value) !== value && Object(value) instanceof Number;
}

export function isJsonBoolean<T>(value: T): value is T & boolean {
	return Object(value) !== value && Object(value) instanceof Boolean;
}

export function isJsonObject<T>(value: T): value is T & JsonObject {
	if (Object(value) !== value || Array.isArray(value)) return false;
	const proto: unknown = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

export function isJsonArray<T>(value: T): value is T & JsonValue[] {
	return Array.isArray(value);
}
