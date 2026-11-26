import { cloneAsJson, isJsonObject, type JsonValue } from "./json.js";
import type { ValueDiff } from "./types.js";

export function firstDiff<T, U>(
	expected: T,
	actual: U,
	path = "$",
): ValueDiff | null {
	return firstDiffJson(cloneAsJson(expected), cloneAsJson(actual), path);
}

function firstDiffJson(
	expected: JsonValue,
	actual: JsonValue,
	path: string,
): ValueDiff | null {
	if (Object.is(expected, actual)) {
		return null;
	}

	if (
		Object.prototype.toString.call(expected) !==
			Object.prototype.toString.call(actual) ||
		expected === null ||
		actual === null
	) {
		return { path, expected, actual };
	}

	if (Array.isArray(expected) || Array.isArray(actual)) {
		if (!Array.isArray(expected) || !Array.isArray(actual)) {
			return { path, expected, actual };
		}

		const length = Math.max(expected.length, actual.length);
		for (let index = 0; index < length; index += 1) {
			if (index >= expected.length || index >= actual.length) {
				return {
					path: `${path}[${index}]`,
					expected: expected[index] ?? null,
					actual: actual[index] ?? null,
				};
			}

			const diff = firstDiffJson(
				expected[index] ?? null,
				actual[index] ?? null,
				`${path}[${index}]`,
			);
			if (diff) {
				return diff;
			}
		}

		return null;
	}

	if (isJsonObject(expected) && isJsonObject(actual)) {
		const keys = unique([...Object.keys(expected), ...Object.keys(actual)]);
		for (const key of keys) {
			const diff = firstDiffJson(
				expected[key] ?? null,
				actual[key] ?? null,
				joinPath(path, key),
			);
			if (diff) {
				return diff;
			}
		}

		return null;
	}

	return { path, expected, actual };
}

function joinPath(path: string, key: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(key)
		? `${path}.${key}`
		: `${path}[${JSON.stringify(key)}]`;
}

function unique(values: string[]): string[] {
	return [...new Set(values)];
}
