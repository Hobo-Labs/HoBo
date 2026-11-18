import { isDeepStrictEqual, types } from "node:util";
import { WorkflowFailure } from "./errors.js";
import {
	cloneAsJson,
	isJsonBoolean,
	isJsonNumber,
	isJsonString,
	type JsonValue,
} from "./json.js";

function isReproducibleJsonValue<T>(value: T, seen: Set<object>): boolean {
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
		if (!isReproducibleJsonValue(descriptor.value, seen)) return false;
	}
	return true;
}

function faithfullyReproduces<T>(
	original: T,
	captured: JsonValue,
): captured is T & JsonValue {
	return isDeepStrictEqual(original, captured);
}

function captureWorkflowValue<T>(value: T): T {
	if (!isReproducibleJsonValue(value, new Set())) throw new TypeError();
	const captured = cloneAsJson(value);
	if (!faithfullyReproduces(value, captured)) throw new TypeError();
	return captured;
}

export function captureWorkflowInput<T>(input: T): T {
	try {
		return captureWorkflowValue(input);
	} catch {
		throw new TypeError("workflow input must be JSON-normalized");
	}
}

export function captureWorkflowResult<T>(result: T, step?: string): T {
	if (result === undefined) return result;
	try {
		return captureWorkflowValue(result);
	} catch {
		throw new WorkflowFailure(
			"workflow result must be JSON-normalized",
			step === undefined ? {} : { step },
		);
	}
}
