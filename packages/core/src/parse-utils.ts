import type {
	EnvelopeParseError,
	ManifestParseError,
	PortDescriptorParseError,
} from "./errors.js";
import {
	isJsonArray,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

type ParseErrorClass =
	| typeof EnvelopeParseError
	| typeof ManifestParseError
	| typeof PortDescriptorParseError;

export function deepFreeze<T>(value: T): T {
	if (value === null || value === undefined) return value;
	if (Array.isArray(value)) {
		Object.freeze(value);
		for (const nested of value) {
			deepFreeze(nested);
		}
		return value;
	}
	if (isJsonObject(value)) {
		Object.freeze(value);
		for (const nested of Object.values(value)) {
			deepFreeze(nested);
		}
	}
	return value;
}

export function cloneJson<T>(value: T): T {
	if (value === undefined) {
		return value;
	}
	// SAFETY: JSON round-trip clones a JSON-serializable domain value.
	return JSON.parse(JSON.stringify(value)) as T;
}

export function expectObject(
	value: JsonValue | undefined,
	field: string,
	ErrorClass: ParseErrorClass,
): JsonObject {
	if (!isJsonObject(value)) {
		throw new ErrorClass(field, "object", value);
	}
	return value;
}

export function assertNoExtra(
	value: JsonObject,
	field: string,
	allowed: readonly string[],
	ErrorClass: ParseErrorClass,
): void {
	const allowedSet = new Set(allowed);
	for (const key of Object.keys(value)) {
		if (!allowedSet.has(key)) {
			throw new ErrorClass(field, `only keys ${allowed.join(", ")}`, key);
		}
	}
}

export function requiredArray(
	value: JsonValue | undefined,
	field: string,
	ErrorClass: ParseErrorClass,
): JsonValue[] {
	if (!isJsonArray(value) || value.length === 0) {
		throw new ErrorClass(field, "non-empty array", value);
	}
	return value;
}

export function uniqueStringArray(
	value: JsonValue | undefined,
	field: string,
	ErrorClass: ParseErrorClass,
	options: { minLength?: number } = {},
): string[] {
	const array =
		options.minLength !== undefined
			? requiredArray(value, field, ErrorClass)
			: isJsonArray(value)
				? value
				: [];
	const seen = new Set<string>();
	return array.map((entry, index) => {
		const normalized = nonEmptyString(entry, `${field}[${index}]`, ErrorClass);
		if (seen.has(normalized)) {
			throw new ErrorClass(field, "unique strings", normalized);
		}
		seen.add(normalized);
		return normalized;
	});
}

export function enumValue<T extends string>(
	value: JsonValue | undefined,
	allowed: ReadonlySet<T>,
	field: string,
	ErrorClass: ParseErrorClass,
): T {
	if (!isJsonString(value)) {
		throw new ErrorClass(field, [...allowed].join(" | "), value);
	}
	for (const allowedValue of allowed) {
		if (value === allowedValue) {
			return allowedValue;
		}
	}
	throw new ErrorClass(field, [...allowed].join(" | "), value);
}

export function nonEmptyString(
	value: JsonValue | undefined,
	field: string,
	ErrorClass: ParseErrorClass,
): string {
	if (!isJsonString(value) || value.length === 0) {
		throw new ErrorClass(field, "non-empty string", value);
	}
	return value;
}

export function nonNegativeInteger(
	value: JsonValue | undefined,
	field: string,
	ErrorClass: ParseErrorClass,
): number {
	if (!isJsonNumber(value) || !Number.isSafeInteger(value) || value < 0) {
		throw new ErrorClass(field, "non-negative integer", value);
	}
	return value;
}

export function positiveInteger(
	value: JsonValue | undefined,
	field: string,
	ErrorClass: ParseErrorClass,
	options: { max?: number } = {},
): number {
	if (!isJsonNumber(value) || !Number.isSafeInteger(value) || value <= 0) {
		throw new ErrorClass(field, "positive integer", value);
	}
	if (options.max !== undefined && value > options.max) {
		throw new ErrorClass(field, `integer <= ${options.max}`, value);
	}
	return value;
}

export function isoTimestamp(
	value: JsonValue | undefined,
	field: string,
	ErrorClass: ParseErrorClass,
): string {
	const timestamp = nonEmptyString(value, field, ErrorClass);
	if (Number.isNaN(Date.parse(timestamp))) {
		throw new ErrorClass(field, "ISO timestamp", value);
	}
	return timestamp;
}

export function httpsUrl(
	value: JsonValue | undefined,
	field: string,
	ErrorClass: ParseErrorClass,
): string {
	const url = nonEmptyString(value, field, ErrorClass);
	if (!/^https:\/\/[^/\s]+(?:\/[^\s]*)?$/.test(url)) {
		throw new ErrorClass(field, "https URL", value);
	}
	return url;
}

export function sha256Ref(
	value: JsonValue | undefined,
	field: string,
	ErrorClass: ParseErrorClass,
): string {
	const ref = nonEmptyString(value, field, ErrorClass);
	if (!/^sha256:[a-f0-9]{64}$/.test(ref)) {
		throw new ErrorClass(field, "sha256:<64 hex chars>", value);
	}
	return ref;
}

export function currency(
	value: JsonValue | undefined,
	field: string,
	ErrorClass: ParseErrorClass,
): string {
	const code = nonEmptyString(value, field, ErrorClass);
	if (!/^[A-Z]{3}$/.test(code)) {
		throw new ErrorClass(field, "ISO-4217 uppercase currency", value);
	}
	return code;
}

export function headerName(
	value: JsonValue | undefined,
	field: string,
	ErrorClass: ParseErrorClass,
): string {
	const header = nonEmptyString(value, field, ErrorClass);
	if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(header)) {
		throw new ErrorClass(field, "HTTP header name", value);
	}
	return header;
}

export function canonicalJsonObject(
	value: JsonValue | undefined,
	field: string,
	ErrorClass: ParseErrorClass,
): JsonObject {
	const source = expectObject(value, field, ErrorClass);
	const cloned = cloneJson(source);
	return isJsonObject(cloned) ? cloned : {};
}
