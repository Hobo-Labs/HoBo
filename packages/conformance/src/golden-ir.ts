import { isJsonObject, type JsonObject } from "./json.js";

const languageSpecificGoldenIrKeys = new Set([
	"exceptionClass",
	"jsSyntax",
	"language",
	"runtime",
	"runtimeLanguage",
	"tsNodeKind",
	"typescriptNodeKind",
]);

export function findLanguageSpecificGoldenIrField<T>(
	value: T,
	path = "$",
): { path: string } | null {
	if (Array.isArray(value)) {
		for (let index = 0; index < value.length; index += 1) {
			const leak = findLanguageSpecificGoldenIrField(
				value[index] ?? null,
				`${path}[${index}]`,
			);
			if (leak) {
				return leak;
			}
		}

		return null;
	}

	if (!isPlainObject(value)) {
		return null;
	}

	for (const key of Object.keys(value)) {
		const keyPath = joinPath(path, key);
		if (languageSpecificGoldenIrKeys.has(key)) {
			return { path: keyPath };
		}

		const leak = findLanguageSpecificGoldenIrField(value[key] ?? null, keyPath);
		if (leak) {
			return leak;
		}
	}

	return null;
}

function joinPath(path: string, key: string): string {
	return /^[A-Za-z_$][\w$]*$/.test(key)
		? `${path}.${key}`
		: `${path}[${JSON.stringify(key)}]`;
}

function isPlainObject<T>(value: T): value is T & JsonObject {
	return value !== null && isJsonObject(value) && !Array.isArray(value);
}
