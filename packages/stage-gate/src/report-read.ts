/**
 * Readers for one node of an untrusted JSON report. Each takes the parent
 * object, the key and the parent's path, and on a value of the wrong kind
 * records an issue and returns a neutral value, so a parser can report every
 * problem in one pass instead of stopping at the first.
 */
import {
	isJsonArray,
	isJsonInteger,
	isJsonNumber,
	isJsonObject,
	type JsonObject,
	type JsonValue,
} from "./json.js";
import type { ReportObjectKeys } from "./report-keys.js";

/** `a.b` from a parent path and a key; the root has the empty path. */
export function pathOf(parent: string, key: string): string {
	return parent === "" ? key : `${parent}.${key}`;
}

/** Own fields only: a report key named like an Object.prototype member reads as absent. */
export function fieldOf(node: JsonObject, key: string): JsonValue | undefined {
	return Object.hasOwn(node, key) ? node[key] : undefined;
}

export function countOf(
	node: JsonObject,
	key: string,
	path: string,
	issues: string[],
): number {
	const value = fieldOf(node, key);
	if (isJsonInteger(value) && value >= 0) return value;
	issues.push(`${pathOf(path, key)}: expected a non-negative integer`);
	return 0;
}

export function objectOf(
	node: JsonObject,
	key: string,
	path: string,
	issues: string[],
): JsonObject {
	const value = fieldOf(node, key);
	if (isJsonObject(value)) return value;
	issues.push(`${pathOf(path, key)}: expected an object`);
	return {};
}

export function arrayOf(
	node: JsonObject,
	key: string,
	path: string,
	issues: string[],
): readonly JsonValue[] {
	const value = fieldOf(node, key);
	if (isJsonArray(value)) return value;
	issues.push(`${pathOf(path, key)}: expected an array`);
	return [];
}

export function memberOf<T extends string>(
	allowed: readonly T[],
	value: JsonValue | undefined,
): T | undefined {
	return allowed.find((entry) => entry === value);
}

/** Refuse a key the object's schema does not define, and a required key that is absent. */
export function closedKeys(
	node: JsonObject,
	path: string,
	keys: ReportObjectKeys,
	issues: string[],
): void {
	for (const key of Object.keys(node)) {
		if (!keys.allowed.includes(key)) {
			issues.push(`${pathOf(path, key)}: not a field of RunReport v1`);
		}
	}
	for (const key of keys.required) {
		if (!Object.hasOwn(node, key)) {
			issues.push(`${pathOf(path, key)}: required by RunReport v1`);
		}
	}
}

/** `durationMs`, which RunReport v1 bounds at 0. */
export function durationOf(
	node: JsonObject,
	path: string,
	issues: string[],
): void {
	const value = fieldOf(node, "durationMs");
	if (isJsonNumber(value) && Number.isFinite(value) && value >= 0) return;
	issues.push(`${pathOf(path, "durationMs")}: expected a non-negative number`);
}
