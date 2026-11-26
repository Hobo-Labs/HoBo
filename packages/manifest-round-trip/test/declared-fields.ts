/**
 * A small reader for TypeScript field declarations, used to compare a shape
 * that moved against the declaration it left behind.
 *
 * Both sides are read from disk with this same reader. Asserting a declaration
 * against a field list written out in a test file only proves the list can be
 * copied; asserting the two *files* against each other is what notices the day
 * one of them changes.
 *
 * It reads the two forms this repo uses — `export interface X {` and
 * `export type X = {` — and nothing else, on purpose: a reader that silently
 * handles a form nobody writes is a reader whose failures are hard to read.
 */

export class DeclarationNotFoundError extends Error {
	constructor(name: string) {
		super(`no exported declaration named ${name}`);
		this.name = "DeclarationNotFoundError";
	}
}

export type DeclaredField = {
	readonly name: string;
	readonly optional: boolean;
	/** The declared type, whitespace-collapsed. `readonly` modifiers kept. */
	readonly type: string;
};

function body(source: string, name: string): string {
	const opener = new RegExp(
		`export (?:interface ${name} \\{|type ${name} = \\{)`,
		"u",
	);
	const match = opener.exec(source);
	if (match === null) throw new DeclarationNotFoundError(name);
	let depth = 0;
	const start = match.index + match[0].length;
	for (let i = start - 1; i < source.length; i += 1) {
		const char = source[i];
		if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(start, i);
		}
	}
	throw new Error(`unterminated declaration body for ${name}`);
}

/** Strips comments and string/template contents that could hide a brace. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/[^\n]*/gu, "");
}

export function declaredFields(
	source: string,
	name: string,
): readonly DeclaredField[] {
	const text = stripComments(body(stripComments(source), name));
	const fields: DeclaredField[] = [];
	let depth = 0;
	let buffer = "";
	const flush = (): void => {
		const line = buffer.trim();
		buffer = "";
		if (line.length === 0) return;
		const match =
			/^(readonly\s+)?(\[[^\]]*\]|[A-Za-z_$][\w$]*)(\?)?\s*:\s*([\s\S]+)$/u.exec(
				line,
			);
		if (match === null) return;
		fields.push({
			name: match[2] as string,
			optional: match[3] === "?",
			type: (match[4] as string).replace(/\s+/gu, " ").trim(),
		});
	};
	for (const char of text) {
		if (char === "{" || char === "(" || char === "[") depth += 1;
		if (char === "}" || char === ")" || char === "]") depth -= 1;
		if (char === ";" && depth === 0) {
			flush();
			continue;
		}
		buffer += char;
	}
	flush();
	return fields;
}

export const fieldNames = (
	fields: readonly DeclaredField[],
): readonly string[] => fields.map((field) => field.name);
