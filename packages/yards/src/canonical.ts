/**
 * Canonicalization and credential screening shared by every parse boundary in
 * this package.
 *
 * These helpers live in one module because `yard()` and `parseYardBindings()`
 * must agree byte-for-byte on what "canonical" means: the same dedupe+sort for
 * string lists, the same key-sorted JSON-safe property projection, the same
 * forbidden-key regex, and the same deep freeze. A second copy of any of them
 * would let a Yard and its binding rows disagree about whether an authored
 * value is a credential — which is exactly the kind of divergence the
 * no-credentials-in-records law exists to prevent.
 *
 * Nothing here is exported from the package barrel: these are internal parse
 * mechanics, not part of the authoring surface.
 */
import {
	isJsonArray,
	isJsonBoolean,
	isJsonNumber,
	isJsonObject,
	isJsonString,
	type JsonObject,
	type JsonValue,
} from "./json.js";

/** Property keys that read as a secret value rather than a locator. */
export const CREDENTIAL_KEY_PATTERN =
	/(secret|password|token|credential|private[_-]?key|api[_-]?key)/i;

/** Returns the first credential-shaped property key, or undefined. */
export function findCredentialKey(
	record: Readonly<JsonObject>,
): string | undefined {
	for (const key of Object.keys(record)) {
		if (CREDENTIAL_KEY_PATTERN.test(key)) return key;
	}
	return undefined;
}

export function assertNoCredentials(
	properties: Readonly<Record<string, JsonValue>>,
): void {
	const key = findCredentialKey(properties);
	if (key !== undefined) {
		throw new Error(
			`yard properties must not contain credentials (forbidden key: ${key})`,
		);
	}
}

export function canonicalizeStringList(
	values: readonly string[],
): readonly string[] {
	return Object.freeze(
		[...new Set(values.filter((v) => isJsonString(v) && v.length > 0))].sort(),
	);
}

export function canonicalizeLabels(
	labels: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
	const keys = Object.keys(labels).sort();
	const out: Record<string, string> = {};
	for (const key of keys) {
		const value = labels[key];
		if (!isJsonString(value)) {
			throw new TypeError(`label ${key} must be a string`);
		}
		out[key] = value;
	}
	return Object.freeze(out);
}

export function canonicalizeProperties(
	input: Readonly<JsonObject>,
	subject = "yard properties",
): Readonly<Record<string, JsonValue>> {
	const keys = Object.keys(input).sort();
	const out: Record<string, JsonValue> = {};
	for (const key of keys) {
		out[key] = toJsonValue(input[key], subject);
	}
	return Object.freeze(out);
}

function toJsonValue(value: JsonValue | undefined, subject: string): JsonValue {
	if (
		value === null ||
		isJsonBoolean(value) ||
		isJsonNumber(value) ||
		isJsonString(value)
	) {
		return value;
	}
	if (Array.isArray(value)) {
		return Object.freeze(value.map((entry) => toJsonValue(entry, subject)));
	}
	if (value && isJsonObject(value)) {
		return canonicalizeProperties(value, subject);
	}
	throw new TypeError(`${subject} must be JSON-safe`);
}

export function requireName(label: string, value: string): void {
	if (!isJsonString(value) || value.length === 0) {
		throw new TypeError(`${label} must be a non-empty string`);
	}
}

export function isPlainObject<T>(value: T): value is T & JsonObject {
	return Boolean(value && isJsonObject(value) && !Array.isArray(value));
}

export function deepFreeze<T>(value: T): T {
	if (!value || Object.isFrozen(value)) {
		return value;
	}
	if (!isJsonObject(value) && !isJsonArray(value)) {
		return value;
	}
	for (const child of Object.values(value)) {
		deepFreeze(child);
	}
	return Object.freeze(value);
}
