/**
 * A JSON document as it arrives at a parser boundary, and the guards that
 * narrow one node of it. The guards read the value's own tag, so a parser
 * branches on what a node is without trusting what it claims to be.
 */
const tagOf = Object.prototype.toString;

export type JsonObject = { readonly [key: string]: JsonValue };
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| readonly JsonValue[]
	| JsonObject;

export function isJsonString<T>(value: T): value is T & string {
	return tagOf.call(value) === "[object String]";
}

export function isJsonNumber<T>(value: T): value is T & number {
	return tagOf.call(value) === "[object Number]";
}

export function isJsonInteger<T>(value: T): value is T & number {
	return isJsonNumber(value) && Number.isInteger(value);
}

export function isJsonBoolean<T>(value: T): value is T & boolean {
	return tagOf.call(value) === "[object Boolean]";
}

export function isJsonArray<T>(value: T): value is T & readonly JsonValue[] {
	return Array.isArray(value);
}

export function isJsonObject<T>(value: T): value is T & JsonObject {
	return (
		value !== undefined &&
		value !== null &&
		!Array.isArray(value) &&
		tagOf.call(value) === "[object Object]"
	);
}

/** Read a JSON document; text that is not JSON is `undefined`. */
export function parseJsonText(text: string): JsonValue | undefined {
	try {
		// SAFETY: JSON.parse returns a JSON value; every node is narrowed by the guards above before use.
		return JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
}

/**
 * The first key that appears twice in one object of a JSON text, or
 * `undefined`. JSON.parse keeps the last of the two silently, so a document
 * whose meaning depends on which one a reader takes is refused before it is
 * read. Call it on text JSON.parse accepted: the scan assumes valid JSON.
 */
export function duplicateKeyIn(text: string): string | undefined {
	// One entry per open container: the keys of an object, or "array".
	const open: (Set<string> | "array")[] = [];
	let expectingKey = false;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (char === '"') {
			let end = index + 1;
			while (end < text.length && text[end] !== '"') {
				end += text[end] === "\\" ? 2 : 1;
			}
			const keys = open.at(-1);
			if (expectingKey && keys instanceof Set) {
				const key = parseJsonText(text.slice(index, end + 1));
				const name = isJsonString(key) ? key : "";
				if (keys.has(name)) return name;
				keys.add(name);
				expectingKey = false;
			}
			index = end;
		} else if (char === "{") {
			open.push(new Set());
			expectingKey = true;
		} else if (char === "[") {
			open.push("array");
			expectingKey = false;
		} else if (char === "}" || char === "]") {
			open.pop();
			expectingKey = false;
		} else if (char === ",") {
			expectingKey = open.at(-1) instanceof Set;
		}
	}
	return undefined;
}
