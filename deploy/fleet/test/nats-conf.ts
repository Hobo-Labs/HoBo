/**
 * A small reader for the nats-server configuration format, enough for the
 * templates under deploy/fleet/nats: `key: value`, `key = value`, `key value`,
 * `key { … }` blocks, `[ … ]` arrays, quoted and bare strings, `$VARIABLE`
 * references (kept as text), `include "file"` (kept, in order, as the list
 * under the key `include`) and `#` or `//` comments.
 *
 * It parses; it does not validate. The tests assert on the tree it answers.
 */
import { scalar, type Tree } from "./tree.js";

type Punct = "{" | "}" | "[" | "]" | ":" | "=" | ",";
type Token =
	| Readonly<{ kind: "word"; text: string }>
	| Readonly<{ kind: "punct"; text: Punct }>
	| Readonly<{ kind: "newline" }>;

const PUNCT: ReadonlySet<string> = new Set(["{", "}", "[", "]", ":", "=", ","]);

function isPunct(char: string): char is Punct {
	return PUNCT.has(char);
}

function tokenize(source: string): Token[] {
	const tokens: Token[] = [];
	let at = 0;
	while (at < source.length) {
		const char = source[at] ?? "";
		if (char === "\n") {
			tokens.push({ kind: "newline" });
			at += 1;
		} else if (char === " " || char === "\t" || char === "\r") {
			at += 1;
		} else if (char === "#" || (char === "/" && source[at + 1] === "/")) {
			while (at < source.length && source[at] !== "\n") at += 1;
		} else if (isPunct(char)) {
			tokens.push({ kind: "punct", text: char });
			at += 1;
		} else if (char === '"' || char === "'") {
			const end = source.indexOf(char, at + 1);
			if (end < 0) throw new Error(`unterminated string at ${at}`);
			tokens.push({ kind: "word", text: source.slice(at + 1, end) });
			at = end + 1;
		} else {
			let end = at;
			while (end < source.length && !/[\s{}[\],#=]/u.test(source[end] ?? ""))
				end += 1;
			const text = source.slice(at, end);
			at = end;
			// `key:` ends a bare key; a colon inside a word (host:port) is kept.
			if (text.endsWith(":")) {
				tokens.push({ kind: "word", text: text.slice(0, -1) });
				tokens.push({ kind: "punct", text: ":" });
			} else tokens.push({ kind: "word", text });
		}
	}
	return tokens;
}

class Parser {
	private at = 0;
	constructor(private readonly tokens: readonly Token[]) {}

	private skipSeparators(): void {
		for (;;) {
			const token = this.tokens[this.at];
			if (
				token?.kind === "newline" ||
				(token?.kind === "punct" && token.text === ",")
			)
				this.at += 1;
			else return;
		}
	}

	block(closing: boolean): Tree {
		const entries = new Map<string, Tree>();
		const includes: Tree[] = [];
		const done = (): Tree => {
			if (includes.length > 0)
				entries.set("include", { kind: "list", items: includes });
			return { kind: "map", entries };
		};
		for (;;) {
			this.skipSeparators();
			const token = this.tokens[this.at];
			if (token === undefined) {
				if (closing) throw new Error("missing }");
				return done();
			}
			if (token.kind === "punct" && token.text === "}") {
				if (!closing) throw new Error("unexpected }");
				this.at += 1;
				return done();
			}
			if (token.kind !== "word")
				throw new Error(
					`expected a key, got ${token.kind === "punct" ? token.text : "a newline"}`,
				);
			this.at += 1;
			if (token.text === "include") {
				const target = this.tokens[this.at];
				if (target?.kind !== "word") throw new Error("include needs a file");
				this.at += 1;
				includes.push(scalar(target.text));
				continue;
			}
			const next = this.tokens[this.at];
			if (next?.kind === "punct" && (next.text === ":" || next.text === "="))
				this.at += 1;
			entries.set(token.text, this.value());
		}
	}

	private value(): Tree {
		const token = this.tokens[this.at];
		if (token === undefined || token.kind === "newline")
			throw new Error("missing value");
		this.at += 1;
		if (token.kind === "word") return scalar(token.text);
		if (token.text === "{") return this.block(true);
		if (token.text === "[") {
			const list: Tree[] = [];
			for (;;) {
				this.skipSeparators();
				const item = this.tokens[this.at];
				if (item === undefined) throw new Error("missing ]");
				if (item.kind === "punct" && item.text === "]") {
					this.at += 1;
					return { kind: "list", items: list };
				}
				list.push(this.value());
			}
		}
		throw new Error(`unexpected ${token.text}`);
	}
}

export function parseNatsConf(source: string): Tree {
	return new Parser(tokenize(source)).block(false);
}
