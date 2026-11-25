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

export function parseJsonText(text: string): JsonValue | undefined {
	try {
		return JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
}

export function duplicateKeyIn(text: string): string | undefined {
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
