/**
 * A very small TypeScript declaration reader: given source text and the name of
 * an exported `interface` or object-`type`, return its top-level fields and
 * whether each is optional.
 *
 * This exists so the parity and projection tests read the *real* source files
 * from disk rather than a transcription of them. It is deliberately not a
 * general parser — it handles the declaration style these four files are
 * written in, and throws loudly on anything it does not understand, because a
 * reader that silently returns an empty field list would turn every assertion
 * built on it into a tautology.
 */
export type DeclaredField = {
	readonly name: string;
	readonly optional: boolean;
};

export class DeclarationNotFoundError extends Error {
	constructor(name: string) {
		super(`no exported interface or object type named ${name} was found`);
		this.name = "DeclarationNotFoundError";
	}
}

function bodyOf(source: string, name: string): string {
	const header = new RegExp(
		`export\\s+(?:interface\\s+${name}\\s*|type\\s+${name}\\s*=\\s*)\\{`,
		"u",
	);
	const match = header.exec(source);
	if (match === null) throw new DeclarationNotFoundError(name);

	let depth = 0;
	const start = match.index + match[0].length;
	for (let index = start - 1; index < source.length; index += 1) {
		const character = source[index];
		if (character === "{") depth += 1;
		else if (character === "}") {
			depth -= 1;
			if (depth === 0) return source.slice(start, index);
		}
	}
	throw new Error(`declaration ${name} is not brace-balanced`);
}

/** Strip block and line comments so a commented-out field is not read as one. */
function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//gu, "")
		.replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

export function declaredFields(
	source: string,
	name: string,
): readonly DeclaredField[] {
	const body = stripComments(bodyOf(source, name));
	const fields: DeclaredField[] = [];
	let depth = 0;
	let line = "";

	const flush = (): void => {
		const text = line.trim();
		line = "";
		if (text === "") return;
		const match = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)(\??)\s*:/u.exec(text);
		if (match === null) return;
		// SAFETY: the capture group is present because the regex matched this line.
		fields.push({ name: match[1] as string, optional: match[2] === "?" });
	};

	for (const character of body) {
		if (character === "{" || character === "(" || character === "[") depth += 1;
		if (character === "}" || character === ")" || character === "]") depth -= 1;
		if (depth === 0 && (character === ";" || character === "\n")) {
			flush();
			continue;
		}
		line += character;
	}
	flush();

	if (fields.length === 0) {
		throw new Error(`declaration ${name} was found but yielded no fields`);
	}
	return fields;
}

export function fieldNames(
	fields: readonly DeclaredField[],
): readonly string[] {
	return fields.map((field) => field.name);
}
