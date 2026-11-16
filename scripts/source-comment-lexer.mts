export type LexedComment = { start: number; end: number; text: string };
export type CommentDialect =
	| "cue"
	| "proto"
	| "wit"
	| "prisma"
	| "sql"
	| "toml";

export function lexComments(
	text: string,
	dialect: CommentDialect,
): LexedComment[] {
	const comments: LexedComment[] = [];
	const line = dialect === "sql" ? "--" : dialect === "toml" ? "#" : "//";
	const blocks = dialect === "proto" || dialect === "wit" || dialect === "sql";

	function quoted(
		start: number,
		quote: string,
		hashes: number,
		cue: boolean,
	): number {
		const triple =
			(dialect === "cue" || dialect === "toml") &&
			text.startsWith(quote.repeat(3), start);
		const delimiter = quote.repeat(triple ? 3 : 1);
		const closer = delimiter + "#".repeat(hashes);
		let index = start + delimiter.length;
		const escapes =
			dialect === "cue" ||
			dialect === "proto" ||
			dialect === "wit" ||
			dialect === "prisma" ||
			(dialect === "toml" && quote === '"') ||
			(dialect === "sql" &&
				quote === "'" &&
				/(?:^|[^a-zA-Z0-9_])[eE]$/.test(
					text.slice(Math.max(0, start - 2), start),
				));
		while (index < text.length) {
			if (
				dialect === "sql" &&
				text[index] === quote &&
				text[index + 1] === quote
			) {
				index += 2;
				continue;
			}
			if (text.startsWith(closer, index)) return index + closer.length;
			if (text[index] === "\\") {
				const prefix = "\\" + "#".repeat(hashes);
				if (cue && text.startsWith(prefix + "(", index)) {
					index = scan(index + prefix.length + 1, true);
					continue;
				}
				if (escapes && (hashes === 0 || text.startsWith(prefix, index))) {
					index += prefix.length + 1;
					continue;
				}
			}
			index++;
		}
		return index;
	}

	function scan(start: number, interpolation: boolean): number {
		let index = start;
		let parentheses = interpolation ? 1 : 0;
		while (index < text.length) {
			if (text.startsWith(line, index)) {
				const end = text.indexOf("\n", index);
				const stop = end < 0 ? text.length : end;
				comments.push({
					start: index,
					end: stop,
					text: text.slice(index, stop),
				});
				index = stop;
				continue;
			}
			if (blocks && text.startsWith("/*", index)) {
				const begin = index;
				index += 2;
				let nesting = 1;
				while (index < text.length && nesting > 0) {
					if (dialect !== "proto" && text.startsWith("/*", index)) {
						nesting++;
						index += 2;
					} else if (text.startsWith("*/", index)) {
						nesting--;
						index += 2;
					} else index++;
				}
				comments.push({
					start: begin,
					end: index,
					text: text.slice(begin, index),
				});
				continue;
			}
			if (dialect === "sql" && text[index] === "$") {
				const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(
					text.slice(index),
				)?.[0];
				if (tag) {
					const end = text.indexOf(tag, index + tag.length);
					index = end < 0 ? text.length : end + tag.length;
					continue;
				}
			}
			if (dialect === "cue" && text[index] === "#") {
				let quote = index;
				while (text[quote] === "#") quote++;
				const quoteCharacter = text[quote];
				if (quoteCharacter === '"' || quoteCharacter === "'") {
					index = quoted(quote, quoteCharacter, quote - index, true);
					continue;
				}
			}
			const character = text[index];
			if (character === '"' || character === "'") {
				index = quoted(index, character, 0, dialect === "cue");
				continue;
			}
			if (interpolation && text[index] === "(") parentheses++;
			if (interpolation && text[index] === ")" && --parentheses === 0)
				return index + 1;
			index++;
		}
		return index;
	}

	scan(0, false);
	return comments.sort((left, right) => left.start - right.start);
}
