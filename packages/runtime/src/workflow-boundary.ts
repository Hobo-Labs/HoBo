import { isDeepStrictEqual, types } from "node:util";
import {
	cloneAsJson,
	isJsonBoolean,
	isJsonNumber,
	isJsonString,
	type JsonValue,
} from "./json.js";

export function isNonEmptyPrimitiveString(
	value: JsonValue | undefined,
): value is string {
	return Object(value) !== value && isJsonString(value) && value.length > 0;
}

export function requireWorkflowRunId(runId: string): string {
	if (!isJsonString(runId) || String(runId) !== runId || runId.length === 0)
		throw new TypeError("workflow runId must be a non-empty string");
	return runId;
}

// JSON cannot preserve aliasing, accessors, prototypes or property attributes.
// Inspect descriptors before serialization so validation does not call getters.
function isReproducibleJsonInput<T>(value: T, seen: Set<object>): boolean {
	if (value === null) return true;
	const object: object = Object(value);
	if (object !== value) {
		return (
			isJsonString(value) ||
			isJsonBoolean(value) ||
			(isJsonNumber(value) && Number.isFinite(value) && !Object.is(value, -0))
		);
	}
	if (types.isProxy(object) || seen.has(object)) return false;
	seen.add(object);
	const array = Array.isArray(value);
	if (
		Object.getPrototypeOf(object) !==
			(array ? Array.prototype : Object.prototype) ||
		!Object.isExtensible(object) ||
		Object.getOwnPropertySymbols(object).length !== 0
	)
		return false;
	const names = Object.getOwnPropertyNames(object);
	if (array && names.length !== value.length + 1) return false;
	for (const name of names) {
		const descriptor = Object.getOwnPropertyDescriptor(object, name);
		if (!descriptor || !("value" in descriptor)) return false;
		if (array && name === "length") {
			if (
				!descriptor.writable ||
				descriptor.enumerable ||
				descriptor.configurable
			)
				return false;
			continue;
		}
		if (array) {
			const index = Number(name);
			if (
				!Number.isSafeInteger(index) ||
				index < 0 ||
				index >= value.length ||
				String(index) !== name
			)
				return false;
		}
		if (
			!descriptor.enumerable ||
			!descriptor.writable ||
			!descriptor.configurable
		)
			return false;
		if (!isReproducibleJsonInput(descriptor.value, seen)) return false;
	}
	return true;
}

export function captureWorkflowInput<A>(args: A): A {
	try {
		if (!isReproducibleJsonInput(args, new Set()))
			throw new TypeError("workflow input must be JSON-normalized");
		const captured = cloneAsJson(args);
		if (!isDeepStrictEqual(args, captured))
			throw new TypeError("workflow input must be JSON-normalized");
		// SAFETY: equality checks the original value against its detached JSON snapshot.
		return captured as A;
	} catch {
		throw new TypeError("workflow input must be JSON-normalized");
	}
}
