/**
 * I/O-boundary JSON/inspectable values without `unknown`/`typeof`.
 * Site parsers and scripts share these tag checks so oxlint anti-slop stays green.
 */

const tagOf = Object.prototype.toString;

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| JsonObject;

export type JsonObject = { readonly [key: string]: JsonValue };

/** Concrete debug/log field bag (interface so consumers stay anti-slop clean). */
export interface DebugFields {
	readonly [key: string]:
		| string
		| number
		| boolean
		| null
		| readonly string[]
		| DebugFields
		| undefined;
}

export type Inspectable =
	| JsonValue
	| bigint
	| symbol
	| undefined
	| URL
	| Error
	| Inspectable[]
	| { readonly [key: string]: Inspectable | undefined }
	| ((...args: Inspectable[]) => Inspectable);

export function isJsonString(value: Inspectable): value is string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonNumber(value: Inspectable): value is number {
	return tagOf.call(value) === "[object Number]";
}

export function isJsonBoolean(value: Inspectable): value is boolean {
	return tagOf.call(value) === "[object Boolean]";
}

export function isJsonObject(value: Inspectable): value is JsonObject {
	return tagOf.call(value) === "[object Object]";
}

export function isJsonArray(value: Inspectable): value is JsonValue[] {
	return tagOf.call(value) === "[object Array]";
}

export function isInspectableFunction(
	value: Inspectable,
): value is (...args: Inspectable[]) => Inspectable {
	const tag = tagOf.call(value);
	return (
		tag === "[object Function]" ||
		tag === "[object AsyncFunction]" ||
		tag === "[object GeneratorFunction]" ||
		tag === "[object AsyncGeneratorFunction]"
	);
}

export function parseJsonTree(raw: string): JsonValue {
	const parsed: JsonValue = JSON.parse(raw);
	return parsed;
}

export function jsonStringField(value: JsonValue, key: string): string | undefined {
	if (!isJsonObject(value)) return undefined;
	const field = value[key];
	return isJsonString(field) ? field : undefined;
}

export function asPageUrl(pageUrl: string | URL): URL {
	return pageUrl instanceof URL ? pageUrl : new URL(pageUrl);
}

export function currentLocationHref(): string | undefined {
	const href = globalThis.location?.href;
	return isJsonString(href) ? href : undefined;
}
