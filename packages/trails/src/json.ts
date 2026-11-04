/** JSON values crossing the Trails persistence and event boundaries. */
export type JsonValue =
	| undefined
	| null
	| boolean
	| number
	| string
	| readonly JsonValue[]
	| JsonObject;

export type JsonObject = { readonly [key: string]: JsonValue };

export function isJsonObject(
	value: JsonValue | undefined,
): value is JsonObject {
	return value !== null && Object(value) === value && !Array.isArray(value);
}

export function isJsonString(value: JsonValue | undefined): value is string {
	return (
		value !== undefined &&
		Object.prototype.toString.call(value) === "[object String]"
	);
}
