#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseAstro } from "@astrojs/compiler/sync";
import type { Node as AstroNode } from "@astrojs/compiler/types";
import {
	AstBuilder,
	GherkinClassicTokenMatcher,
	Parser,
} from "@cucumber/gherkin";
import { fromMarkdown } from "mdast-util-from-markdown";
import ts from "typescript";
import { z } from "zod";
import { frontmatterType } from "./check-no-committed-plans.mts";
import { type CommentDialect, lexComments } from "./source-comment-lexer.mts";

type Comment = { start: number; end: number; text: string };
type CommentLocation = { first: number; last: number; text: string };
type Violation = { file: string; line: number; message: string };
type Mode =
	| { kind: "staged" }
	| { kind: "worktree" }
	| { kind: "base"; ref: string };

const CODE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".jsonc",
	".json5",
]);
const BATCH_EXTENSIONS = new Set([".bat", ".cmd"]);
const XML_EXTENSIONS = new Set([".svg", ".xml", ".xhtml"]);
const LEXER_LANGUAGES = new Map<string, CommentDialect>([
	[".cue", "cue"],
	[".proto", "proto"],
	[".wit", "wit"],
	[".prisma", "prisma"],
	[".sql", "sql"],
	[".toml", "toml"],
]);
const OTHER_LANGUAGES = new Map([
	[".yaml", "yaml"],
	[".yml", "yaml"],
	[".rs", "rust"],
	[".go", "go"],
	[".c", "c"],
	[".h", "c"],
	[".cpp", "cpp"],
	[".cs", "csharp"],
	[".cc", "cpp"],
	[".hpp", "cpp"],
	[".java", "java"],
	[".kt", "kotlin"],
	[".rb", "ruby"],
	[".lua", "lua"],
	[".swift", "swift"],
	[".sh", "bash"],
	[".bash", "bash"],
	[".py", "python"],
	[".css", "css"],
	[".html", "html"],
	[".hcl", "hcl"],
	[".tf", "hcl"],
	[".tfvars", "hcl"],
]);
const require = createRequire(import.meta.url);
const AST_GREP = join(
	dirname(require.resolve("@ast-grep/cli/package.json")),
	process.platform === "win32" ? "ast-grep.exe" : "ast-grep",
);
const DIRECTIVE =
	/^(?:\/\/\/\s*|\/\/\s*|\/\*+!?\s*(?:\*\s*)?|#\s*|--\s*|<!--\s*|@?rem\s+|::\s*)(?:@ts-(?:check|nocheck|ignore|expect-error)\b|@(?:jsx|jsxFrag|jsxImportSource|jsxRuntime|vitest-environment)\b|(?:eslint|oxlint|biome|prettier|stylelint)-(?:disable|enable|ignore)\b|(?:istanbul|c8|v8)\s+ignore\b|(?:shellcheck|pyright|ruff|fmt|type|pragma|buf|go|atlas):|yaml-language-server:|noqa\b|[#@]__(?:PURE|NO_SIDE_EFFECTS)__|[#@]\s*sourceMappingURL=|<reference\b|@license\b|SPDX-License-Identifier:|copyright\b)/iu;
const TYPESCRIPT_DIRECTIVE =
	/^(?:\/\/\/?\s*|\/\*+!?\s*(?:\*\s*)?)@ts-(?:check|nocheck|ignore|expect-error)\b/iu;
const CONCISE_TYPESCRIPT_DIRECTIVE =
	/^\/\/\s*@ts-(?:check|nocheck|ignore|expect-error)\s*$/iu;
const LINT_DIRECTIVE_EXPLANATION =
	/^(?:\/\/\/?\s*|\/\*+!?\s*(?:\*\s*)?|#\s*|<!--\s*)(?:eslint|oxlint|stylelint)-(?:disable|enable)\b[^\r\n]*\s--(?:\s|$)/iu;
const VITE_DIRECTIVE = /^\/\*\s*@vite-ignore\s*\*\/$/u;
const GENERATED_DIRECTIVE =
	/^\/\/\s*@generated(?:\s+(?:by|from)\s+[^\r\n]+)?\s*$/u;
const DEPRECATED_DIRECTIVE = /^\/\*\*\s*@deprecated\s*\*\/$/u;
const DEFERRED = /\b(?:TODO|FIXME|HACK|XXX|TBD)\b/iu;
const DEFERRED_TYPE_DIRECTIVE =
	/^(?:\/\/\/?\s*|\/\*+!?\s*(?:\*\s*)?|#\s*|--\s*|<!--\s*)parallel-type-allowed:/iu;

function git(args: string[]): string {
	return execFileSync("git", ["--literal-pathspecs", ...args], {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function diffArgs(mode: Mode): string[] {
	if (mode.kind === "staged") return ["diff", "--cached"];
	if (mode.kind === "worktree") return ["diff", "HEAD"];
	const commit = git([
		"rev-parse",
		"--verify",
		"--end-of-options",
		`${mode.ref}^{commit}`,
	]).trim();
	const mergeBase = git(["merge-base", commit, "HEAD"]).trim();
	return ["diff", mergeBase, "HEAD"];
}

function names(args: string[], filter: string): string[] {
	return git([
		...args,
		"--no-renames",
		"--name-only",
		`--diff-filter=${filter}`,
		"-z",
		"--",
	])
		.split("\0")
		.filter(Boolean);
}

function untrackedFiles(mode: Mode): string[] {
	if (mode.kind !== "worktree") return [];
	const untracked = git(["ls-files", "--others", "--exclude-standard", "-z"]);
	const ignoredAgentArtifacts = execFileSync(
		"git",
		[
			"ls-files",
			"--others",
			"--ignored",
			"--exclude-standard",
			"-z",
			"--",
			":(glob)**/.sdlc/**",
			":(glob)**/.impeccable/**",
			":(glob)**/.optimizexp/**",
		],
		{
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	return `${untracked}${ignoredAgentArtifacts}`.split("\0").filter(Boolean);
}

function contents(mode: Mode, file: string): string {
	if (mode.kind === "staged") return git(["show", `:${file}`]);
	if (mode.kind === "base") return git(["show", `HEAD:${file}`]);
	return readFileSync(file, "utf8");
}

function submodules(mode: Mode): Set<string> {
	const entries = git(
		mode.kind === "base"
			? ["ls-tree", "-rz", "HEAD"]
			: ["ls-files", "--stage", "-z"],
	);
	return new Set(
		entries
			.split("\0")
			.filter((entry) => entry.startsWith("160000 "))
			.map((entry) => entry.slice(entry.indexOf("\t") + 1)),
	);
}

export function addedLineNumbers(patch: string): Set<number> {
	const added = new Set<number>();
	let line: number | undefined;
	for (const text of patch.split("\n")) {
		const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(text);
		if (hunk) {
			line = Number(hunk[1]);
		} else if (line !== undefined && text.startsWith("+")) {
			added.add(line++);
		} else if (line !== undefined && text.startsWith(" ")) {
			line++;
		}
	}
	return added;
}

function sourcePath(file: string): string {
	return /\.tpl$/iu.test(file) ? file.slice(0, -4) : file;
}

export function commentsIn(file: string, text: string): Comment[] {
	const kind = /\.[jt]sx$/iu.test(sourcePath(file))
		? ts.ScriptKind.TSX
		: ts.ScriptKind.TS;
	const source = ts.createSourceFile(
		file,
		text,
		ts.ScriptTarget.Latest,
		true,
		kind,
	);
	const found = new Map<number, Comment>();
	function visit(node: ts.Node): void {
		if (ts.isJSDoc(node)) {
			const start = node.getStart(source);
			const end = node.getEnd();
			found.set(start, { start, end, text: text.slice(start, end) });
			return;
		}
		const children = node.getChildren(source);
		if (children.length > 0) {
			for (const child of children) visit(child);
			return;
		}
		const start = node.getFullStart();
		const end = node.getStart(source);
		for (const scan of [
			ts.getLeadingCommentRanges,
			ts.getTrailingCommentRanges,
		]) {
			for (const range of scan(text, start) ?? []) {
				if (range.pos >= start && range.end <= end) {
					found.set(range.pos, {
						start: range.pos,
						end: range.end,
						text: text.slice(range.pos, range.end),
					});
				}
			}
		}
	}
	visit(source);
	return [...found.values()].sort((left, right) => left.start - right.start);
}

function commentLocations(file: string, text: string): CommentLocation[] {
	const extension = extname(sourcePath(file)).toLowerCase();
	if (isDockerfile(sourcePath(file))) return dockerfileComments(file, text);
	if (BATCH_EXTENSIONS.has(extension)) return batchComments(text);
	if (extension === ".astro") return astroComments(file, text);
	if (extension === ".feature") return gherkinComments(file, text);
	if (extension === ".html") return htmlComments(file, text);
	if (XML_EXTENSIONS.has(extension)) return xmlComments(file, text);
	const lexicalLanguage = LEXER_LANGUAGES.get(extension);
	if (lexicalLanguage) {
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
		return lexComments(text, lexicalLanguage).map((comment) => ({
			text: comment.text,
			first: source.getLineAndCharacterOfPosition(comment.start).line + 1,
			last: source.getLineAndCharacterOfPosition(comment.end - 1).line + 1,
		}));
	}
	const extensionLanguage = OTHER_LANGUAGES.get(extension);
	const language =
		extensionLanguage ??
		(!CODE_EXTENSIONS.has(extension) &&
		(file.startsWith(".githooks/") || (!extension && text.startsWith("#!")))
			? /^#![^\n]*\bpython(?:\d+(?:\.\d+)?)?\b/u.test(text)
				? "python"
				: /^#![^\n]*\b(?:node|deno|bun)\b/u.test(text)
					? undefined
					: "bash"
			: undefined);
	if (!language) {
		const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest);
		return commentsIn(file, text).map((comment) => ({
			text: comment.text,
			first: source.getLineAndCharacterOfPosition(comment.start).line + 1,
			last: source.getLineAndCharacterOfPosition(comment.end - 1).line + 1,
		}));
	}
	const kinds =
		language === "kotlin"
			? ["line_comment", "multiline_comment"]
			: ["rust", "java"].includes(language)
				? ["line_comment", "block_comment"]
				: ["comment"];
	return kinds.flatMap((kind) =>
		astGrepMatches(file, text, language, kind).map(matchLocation),
	);
}

function batchComments(text: string): CommentLocation[] {
	const lines = text.split(/\r?\n/u);
	const comments: CommentLocation[] = [];
	let continued = false;
	let commandStart = true;
	let quoted = false;
	let forCommand = false;
	let forSetDepth = 0;
	let forAwaitingBody = false;
	for (let lineNumber = 0; lineNumber < lines.length; lineNumber++) {
		if (!continued) {
			commandStart = forSetDepth === 0;
			quoted = false;
			if (forSetDepth === 0) {
				forCommand = false;
				forAwaitingBody = false;
			}
		}
		continued = false;
		const line = lines[lineNumber] ?? "";
		for (let index = 0; index < line.length; index++) {
			const character = line[index];
			if (commandStart && !quoted) {
				if (character === " " || character === "\t" || character === "@")
					continue;
				const rest = line.slice(index);
				const condition = batchIfPrefix(rest);
				if (condition > 0) {
					index += condition - 1;
					continue;
				}
				if (/^else(?=\s|$)/iu.test(rest)) {
					index += 3;
					continue;
				}
				if (/^for(?=\s)/iu.test(rest)) forCommand = true;
				if (/^(?:rem(?:\s|$)|::)/iu.test(line.slice(index))) {
					const first = lineNumber + 1;
					let comment = line.slice(index);
					while (
						hasBatchContinuation(lines[lineNumber] ?? "") &&
						lineNumber + 1 < lines.length
					) {
						lineNumber++;
						comment += `\n${lines[lineNumber] ?? ""}`;
					}
					comments.push({ first, last: lineNumber + 1, text: comment });
					break;
				}
				commandStart = false;
			}
			if (character === "^" && !quoted) {
				if (index === line.length - 1) continued = true;
				else index++;
				continue;
			}
			if (character === '"') quoted = !quoted;
			else if (!quoted && forCommand && character === "(") {
				forSetDepth++;
				commandStart = false;
			} else if (!quoted && forSetDepth > 0 && character === ")") {
				forSetDepth--;
				forAwaitingBody = forSetDepth === 0;
			} else if (
				!quoted &&
				forAwaitingBody &&
				(index === 0 || /\s/u.test(line[index - 1] ?? "")) &&
				/^do(?=\s|\(|$)/iu.test(line.slice(index))
			) {
				index++;
				forCommand = false;
				forAwaitingBody = false;
				commandStart = true;
			} else if (
				!quoted &&
				forSetDepth === 0 &&
				character &&
				"&|()".includes(character)
			)
				commandStart = true;
		}
	}
	return comments;
}

function batchIfPrefix(text: string): number {
	return (
		/^if\s+(?:\/i\s+)?(?:not\s+)?(?:(?:defined|exist|errorlevel|cmdextversion)\s+(?:"[^"]*"|\S+)|(?:"[^"]*"|\S+?)\s*(?:==|\s(?:equ|neq|lss|leq|gtr|geq)\s)\s*(?:"[^"]*"|\S+))\s+/iu.exec(
			text,
		)?.[0].length ?? 0
	);
}

function hasBatchContinuation(line: string): boolean {
	const carets = /\^+$/u.exec(line)?.[0].length ?? 0;
	return carets % 2 === 1;
}

function isDockerfile(file: string): boolean {
	const name = basename(file).toLowerCase();
	return (
		name === "dockerfile" ||
		name.startsWith("dockerfile.") ||
		name.endsWith(".dockerfile")
	);
}

function dockerfileComments(file: string, text: string): CommentLocation[] {
	const lines = text.split(/\r?\n/u);
	const instructions: string[] = [];
	const directives = new Set<number>();
	let directiveHeader = true;
	let instruction = "";
	let continuation = false;
	let escape = "\\";
	for (const [index, line] of lines.entries()) {
		const trimmed = line.trim();
		if (
			directiveHeader &&
			/^#\s*(?:syntax|escape|check)\s*=\s*[^\s#]+\s*$/iu.test(trimmed)
		) {
			directives.add(index + 1);
			const configuredEscape = /^#\s*escape\s*=\s*([\\`])\s*$/iu.exec(
				trimmed,
			)?.[1];
			if (configuredEscape) escape = configuredEscape;
		} else {
			directiveHeader = false;
		}
		if (trimmed.length > 0 && !trimmed.startsWith("#")) {
			if (!continuation)
				instruction = /^([a-z]+)/iu.exec(trimmed)?.[1]?.toUpperCase() ?? "";
			continuation = trimmed.endsWith(escape);
		}
		instructions[index] = instruction;
	}
	const comments = astGrepMatches(file, text, "bash", "comment")
		.map(matchLocation)
		.filter((comment) => {
			if (directives.has(comment.first)) return false;
			const line = lines[comment.first - 1] ?? "";
			return (
				line.trimStart().startsWith("#") ||
				instructions[comment.first - 1] === "RUN"
			);
		});
	for (const heredoc of astGrepMatches(
		file,
		text,
		"bash",
		"heredoc_redirect",
	)) {
		const start = heredoc.range.start.line;
		const end = heredoc.range.end.line;
		if (instructions[start] !== "RUN" || end <= start + 1) continue;
		let instructionStart = start;
		while (
			instructionStart > 0 &&
			instructions[instructionStart - 1] === "RUN" &&
			(lines[instructionStart - 1] ?? "").trimEnd().endsWith(escape)
		)
			instructionStart--;
		const header = lines.slice(instructionStart, start + 1).join(" ");
		if (!dockerHeredocRunsScript(header)) continue;
		const body = lines.slice(start + 1, end).join("\n");
		const language = dockerScriptExtension(body);
		if (!language) continue;
		for (const comment of commentLocations(`fragment${language}`, body)) {
			if (comment.first === 1 && comment.text.startsWith("#!")) continue;
			comments.push({
				text: comment.text,
				first: start + 1 + comment.first,
				last: start + 1 + comment.last,
			});
		}
	}
	return comments.sort((left, right) => left.first - right.first);
}

function dockerHeredocRunsScript(header: string): boolean {
	const command = header
		.replace(/^\s*RUN\s+/iu, "")
		.replace(/<<-?\s*(?:(["'])([^"']+)\1|[a-z_][a-z0-9_.-]*)/iu, "")
		.replace(/(?:\\|`)\s+/gu, " ")
		.replace(/(?:^|\s)--[a-z][a-z0-9-]*=(?:"[^"]*"|'[^']*'|[^\s]+)/giu, " ")
		.trim();
	return (
		command.length === 0 ||
		/^(?:(?:\/usr\/bin\/env\s+)?(?:\/bin\/|\/usr\/bin\/)?(?:ba)?sh)(?:\s+-[a-z]+)*$/iu.test(
			command,
		)
	);
}

function dockerScriptExtension(body: string): string | undefined {
	const first = body.split(/\r?\n/u)[0]?.trim() ?? "";
	if (!first.startsWith("#!")) return ".sh";
	if (/\bpython(?:\d+(?:\.\d+)?)?\b/iu.test(first)) return ".py";
	if (/\b(?:node|deno|bun)\b/iu.test(first)) return ".js";
	if (/(?:^|[\s/])(?:ba)?sh(?:\s|$)/iu.test(first)) return ".sh";
	return undefined;
}

function gherkinComments(file: string, text: string): CommentLocation[] {
	let id = 0;
	const parser = new Parser(
		new AstBuilder(() => String(id++)),
		new GherkinClassicTokenMatcher(),
	);
	try {
		return parser.parse(text).comments.map((comment) => ({
			text: comment.text,
			first: comment.location.line,
			last: comment.location.line,
		}));
	} catch (error) {
		throw new Error(
			`cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

type AstGrepMatch = {
	text: string;
	range: {
		byteOffset: { start: number; end: number };
		start: { line: number };
		end: { line: number; column: number };
	};
};

function astGrepMatches(
	file: string,
	text: string,
	language: string,
	kind: string,
): AstGrepMatch[] {
	const result = spawnSync(
		AST_GREP,
		["run", "--stdin", "--lang", language, "--kind", kind, "--json"],
		{ input: text, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
	);
	if (result.error || (result.status !== 0 && result.status !== 1)) {
		throw new Error(
			`cannot parse ${file}: ${result.error?.message ?? result.stderr}`,
		);
	}
	return JSON.parse(result.stdout);
}

function matchLocation(match: AstGrepMatch): CommentLocation {
	return {
		text: match.text,
		first: match.range.start.line + 1,
		last: match.range.end.line + (match.range.end.column === 0 ? 0 : 1),
	};
}

function htmlAttribute(
	text: string,
): { name: string; value: string } | undefined {
	const match =
		/^([^\s=/>]+)\s*=\s*(?:"([\s\S]*?)"|'([\s\S]*?)'|([^\s>]+))/u.exec(text);
	const name = match?.[1]?.toLowerCase();
	return name
		? { name, value: match?.[2] ?? match?.[3] ?? match?.[4] ?? "" }
		: undefined;
}

function xmlComments(file: string, text: string): CommentLocation[] {
	const masked = text.split("");
	let rawElement: { name: "script" | "style"; start: number } | undefined;
	const embedded: CommentLocation[] = [];
	const hide = (start: number, end: number) => {
		for (let index = start; index < end; index += 1) {
			if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " ";
		}
	};
	for (let index = 0; index < text.length; ) {
		if (text.startsWith("<!--", index)) {
			const end = text.indexOf("-->", index + 4);
			if (end < 0) throw new Error(`unterminated XML comment in ${file}`);
			index = end + 3;
		} else if (text.startsWith("<![CDATA[", index)) {
			const end = text.indexOf("]]>", index + 9);
			if (end < 0) throw new Error(`unterminated XML CDATA in ${file}`);
			if (rawElement) {
				hide(index, index + 9);
				hide(end, end + 3);
			} else hide(index, end + 3);
			index = end + 3;
		} else if (text.startsWith("<?", index)) {
			const end = text.indexOf("?>", index + 2);
			if (end < 0) throw new Error(`unterminated XML instruction in ${file}`);
			hide(index, end + 2);
			index = end + 2;
		} else if (text[index] === "<") {
			const end = xmlTagEnd(file, text, index);
			const tag = text.slice(index, end);
			const match = /^<\s*(\/?)\s*(?:[\w.-]+:)?(script|style)(?=[\s/>])/iu.exec(
				tag,
			);
			if (match) {
				const name = match[2]?.toLowerCase();
				if (match[1] === "/" && rawElement?.name === name) {
					const first = text.slice(0, rawElement.start).split("\n").length;
					const fragment = masked.slice(rawElement.start, index).join("");
					const extension = name === "script" ? ".ts" : ".css";
					for (const comment of commentLocations(
						`fragment${extension}`,
						fragment,
					)) {
						embedded.push({
							...comment,
							first: first + comment.first - 1,
							last: first + comment.last - 1,
						});
					}
					hide(rawElement.start, index);
					rawElement = undefined;
				} else if (
					match[1] !== "/" &&
					!tag.endsWith("/>") &&
					(name === "script" || name === "style")
				) {
					rawElement = { name, start: end };
				}
			}
			index = end;
		} else index += 1;
	}
	return [...htmlComments(file, masked.join("")), ...embedded].sort(
		(left, right) => left.first - right.first,
	);
}

function xmlTagEnd(file: string, text: string, start: number): number {
	let quote = "";
	let subsetDepth = 0;
	for (let index = start + 1; index < text.length; index += 1) {
		const character = text[index];
		if (quote) {
			if (character === quote) quote = "";
		} else if (character === '"' || character === "'") quote = character;
		else if (character === "[") subsetDepth += 1;
		else if (character === "]") subsetDepth -= 1;
		else if (character === ">" && subsetDepth <= 0) return index + 1;
	}
	throw new Error(`unterminated XML tag in ${file}`);
}

function htmlComments(file: string, text: string): CommentLocation[] {
	const attributes = astGrepMatches(file, text, "html", "attribute");
	const found = astGrepMatches(file, text, "html", "comment")
		.filter(
			(comment) =>
				!attributes.some(
					(attribute) =>
						attribute.range.byteOffset.start <=
							comment.range.byteOffset.start &&
						attribute.range.byteOffset.end >= comment.range.byteOffset.end,
				),
		)
		.map(matchLocation);
	function inspect(
		fragment: string,
		extension: ".ts" | ".tsx" | ".css",
		first: number,
	) {
		for (const comment of commentLocations(`fragment${extension}`, fragment)) {
			found.push({
				...comment,
				first: first + comment.first - 1,
				last: first + comment.last - 1,
			});
		}
	}
	for (const [kind, extension] of [
		["script_element", ".ts"],
		["style_element", ".css"],
	] as const) {
		for (const match of astGrepMatches(file, text, "html", kind)) {
			let fragmentExtension: ".ts" | ".tsx" | ".css" = extension;
			const opening =
				/^<\s*(?:script|style)\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/iu.exec(
					match.text,
				);
			if (!opening)
				throw new Error(`cannot locate an embedded block in ${file}`);
			if (kind === "script_element") {
				const openingEnd =
					match.range.byteOffset.start + Buffer.byteLength(opening[0]);
				const type = attributes.find(
					(attribute) =>
						attribute.range.byteOffset.start >= match.range.byteOffset.start &&
						attribute.range.byteOffset.end <= openingEnd &&
						htmlAttribute(attribute.text)?.name === "type",
				);
				const value =
					(type ? htmlAttribute(type.text)?.value : "")?.trim() ?? "";
				if (
					value &&
					!/^(?:module|(?:text|application)\/(?:x-)?(?:(?:java|ecma)script(?:1\.\d)?|typescript|jsx|babel)(?:\s*;.*)?)$/iu.test(
						value,
					)
				)
					continue;
				if (/\/(?:jsx|babel)(?:\s*;|$)/iu.test(value))
					fragmentExtension = ".tsx";
			}
			const closing = /<\/\s*(?:script|style)\s*>\s*$/iu.exec(match.text);
			const fragment = match.text.slice(opening[0].length, closing?.index);
			const first = match.range.start.line + opening[0].split("\n").length;
			inspect(fragment, fragmentExtension, first);
		}
	}
	for (const match of attributes) {
		const attribute = htmlAttribute(match.text);
		if (!attribute) continue;
		const { name, value } = attribute;
		const extension =
			name === "style" ? ".css" : name.startsWith("on") ? ".ts" : undefined;
		if (!extension || (!value.includes("/*") && !value.includes("//")))
			continue;
		const first =
			match.range.start.line +
			match.text.slice(0, match.text.indexOf(value)).split("\n").length;
		inspect(value, extension, first);
	}
	return found.sort(
		(left, right) => left.first - right.first || left.last - right.last,
	);
}

function astroComments(file: string, text: string): CommentLocation[] {
	const result = parseAstro(text, { position: true });
	const error = result.diagnostics.find(
		(diagnostic) => diagnostic.severity === 1,
	);
	if (error) throw new Error(`cannot parse ${file}: ${error.text}`);
	const found: CommentLocation[] = [];
	const bytes = Buffer.from(text);

	function inspect(fragment: string, language: ".ts" | ".css", first: number) {
		for (const comment of commentLocations(`fragment${language}`, fragment)) {
			found.push({
				...comment,
				first: first + comment.first - 1,
				last: first + comment.last - 1,
			});
		}
	}

	function visit(node: AstroNode, context?: "expression" | "script" | "style") {
		const line = node.position?.start.line;
		if (node.type === "comment" && line !== undefined) {
			found.push({
				text: `<!--${node.value}-->`,
				first: line,
				last: line + node.value.split("\n").length - 1,
			});
		} else if (node.type === "frontmatter" && line !== undefined) {
			inspect(node.value, ".ts", line);
		} else if (node.type === "text" && context && line !== undefined) {
			inspect(node.value, context === "style" ? ".css" : ".ts", line);
		}

		if ("attributes" in node) {
			for (const attribute of node.attributes) {
				const value =
					attribute.kind === "expression"
						? attribute.value
						: attribute.kind === "spread" || attribute.kind === "shorthand"
							? attribute.name
							: attribute.kind === "template-literal"
								? attribute.raw
								: undefined;
				if (!value) continue;
				const start = attribute.position?.start;
				if (!start) throw new Error(`cannot locate an attribute in ${file}`);
				const offset = bytes.subarray(0, start.offset).toString("utf8").length;
				const valueStart = text.indexOf(value, offset);
				if (valueStart < 0)
					throw new Error(`cannot locate an attribute in ${file}`);
				const first = text.slice(0, valueStart).split("\n").length;
				inspect(value, ".ts", first);
			}
		}

		if ("children" in node) {
			const next =
				node.type === "expression"
					? "expression"
					: node.type === "element" && node.name === "script"
						? "script"
						: node.type === "element" && node.name === "style"
							? "style"
							: undefined;
			for (const child of node.children) visit(child, next);
		}
	}

	visit(result.ast);
	return found;
}

export function commentViolations(
	file: string,
	text: string,
	added: Set<number>,
): Violation[] {
	return commentLocations(file, text).flatMap((comment) => {
		const { first, last } = comment;
		let intersects = false;
		for (let line = first; line <= last; line++) {
			if (added.has(line)) {
				intersects = true;
				break;
			}
		}
		if (!intersects) return [];
		const message = commentMessage(comment.text, first);
		return message ? [{ file, line: first, message }] : [];
	});
}

function commentMessage(text: string, first: number): string | undefined {
	if (first === 1 && text.startsWith("#!")) return undefined;
	const deferred = DEFERRED.test(text) || DEFERRED_TYPE_DIRECTIVE.test(text);
	const concise =
		(!TYPESCRIPT_DIRECTIVE.test(text) ||
			CONCISE_TYPESCRIPT_DIRECTIVE.test(text)) &&
		!LINT_DIRECTIVE_EXPLANATION.test(text);
	if (
		!deferred &&
		concise &&
		(DIRECTIVE.test(text) ||
			VITE_DIRECTIVE.test(text) ||
			GENERATED_DIRECTIVE.test(text) ||
			DEPRECATED_DIRECTIVE.test(text))
	)
		return undefined;
	return deferred
		? "finish deferred work instead of adding a marker"
		: "make the code self-documenting instead of adding a comment";
}

const notebookSchema = z
	.object({
		cells: z.array(
			z
				.object({
					cell_type: z.string(),
					source: z.union([z.string(), z.array(z.string())]).optional(),
				})
				.passthrough(),
		),
		metadata: z
			.object({
				language_info: z
					.object({ name: z.string().optional() })
					.passthrough()
					.optional(),
				kernelspec: z
					.object({ language: z.string().optional() })
					.passthrough()
					.optional(),
			})
			.passthrough()
			.optional(),
	})
	.passthrough();

const sourceLanguageExtensions = new Map([
	["typescript", ".ts"],
	["ts", ".ts"],
	["javascript", ".js"],
	["js", ".js"],
	["tsx", ".tsx"],
	["jsx", ".jsx"],
	["python", ".py"],
	["python3", ".py"],
	["py", ".py"],
	["bash", ".sh"],
	["shell", ".sh"],
	["sh", ".sh"],
	["batch", ".cmd"],
	["bat", ".bat"],
	["cmd", ".cmd"],
	["rust", ".rs"],
	["rs", ".rs"],
	["go", ".go"],
	["golang", ".go"],
	["sql", ".sql"],
	["yaml", ".yaml"],
	["yml", ".yaml"],
	["gherkin", ".feature"],
	["feature", ".feature"],
	["json", ".js"],
	["jsonc", ".js"],
	["css", ".css"],
	["html", ".html"],
	["svg", ".svg"],
	["xml", ".xml"],
	["xhtml", ".xhtml"],
	["astro", ".astro"],
	["cue", ".cue"],
	["proto", ".proto"],
	["protobuf", ".proto"],
	["wit", ".wit"],
	["prisma", ".prisma"],
	["toml", ".toml"],
	["hcl", ".hcl"],
	["terraform", ".tf"],
	["dockerfile", ".dockerfile"],
	["c", ".c"],
	["cpp", ".cpp"],
	["c++", ".cpp"],
	["csharp", ".cs"],
	["cs", ".cs"],
	["java", ".java"],
	["kotlin", ".kt"],
	["ruby", ".rb"],
	["lua", ".lua"],
	["swift", ".swift"],
]);

type NotebookComment = {
	key: string;
	cell: number;
	line: number;
	message: string;
};

function notebookComments(text: string): NotebookComment[] | undefined {
	let json: ReturnType<typeof JSON.parse>;
	try {
		json = JSON.parse(text);
	} catch {
		return undefined;
	}
	const parsed = notebookSchema.safeParse(json);
	if (!parsed.success) return undefined;
	const notebook = parsed.data;
	const code = notebook.cells.filter((cell) => cell.cell_type === "code");
	if (code.length === 0) return [];
	const language =
		notebook.metadata?.language_info?.name ??
		notebook.metadata?.kernelspec?.language;
	const extension =
		language === undefined
			? undefined
			: sourceLanguageExtensions.get(language.toLowerCase());
	if (!extension) return undefined;
	const found: NotebookComment[] = [];
	for (const [index, cell] of notebook.cells.entries()) {
		if (cell.cell_type !== "code") continue;
		if (cell.source === undefined) return undefined;
		const source = Array.isArray(cell.source)
			? cell.source.join("")
			: cell.source;
		for (const comment of commentLocations(`cell${extension}`, source)) {
			const message = commentMessage(comment.text, comment.first);
			if (message)
				found.push({
					key: `${index}:${comment.text}`,
					cell: index + 1,
					line: comment.first,
					message,
				});
		}
	}
	return found;
}

const textualMarkdownLanguages = new Set([
	"text",
	"txt",
	"plaintext",
	"console",
	"shell-session",
	"http",
	"diff",
	"mermaid",
	"markdown",
	"md",
]);

type MarkdownNode = {
	type: string;
	children?: readonly MarkdownNode[] | undefined;
	value?: string | undefined;
	lang?: string | null | undefined;
	position?: { start: { line: number }; end: { line: number } } | undefined;
};

function markdownCodeViolations(
	file: string,
	text: string,
	added: Set<number>,
): Violation[] {
	const lines = text.split(/\r?\n/u);
	const problems: Violation[] = [];
	function visit(node: MarkdownNode): void {
		if (node.type === "code" && node.position && node.value !== undefined) {
			const start = node.position.start.line;
			const end = node.position.end.line;
			const language = (node.lang ?? "").toLowerCase();
			const extension = sourceLanguageExtensions.get(language);
			const changed = [...added].some((line) => line >= start && line <= end);
			if (changed && !extension && !textualMarkdownLanguages.has(language)) {
				problems.push({
					file,
					line: start,
					message:
						"label code examples with a supported language, or text for non-code",
				});
			} else if (extension && changed) {
				const fenced =
					/^\s*(?:(?:>\s*)|(?:(?:[-+*]|\d+[.)])\s+))*(?:`{3,}|~{3,})/u.test(
						lines[start - 1] ?? "",
					);
				const first = start + (fenced ? 1 : 0);
				const localLines =
					added.has(start) && fenced
						? new Set(node.value.split(/\r?\n/u).map((_, index) => index + 1))
						: new Set(
								[...added]
									.map((line) => line - first + 1)
									.filter((line) => line > 0),
							);
				for (const problem of commentViolations(
					`${file}#example${extension}`,
					node.value,
					localLines,
				)) {
					problems.push({ ...problem, file, line: first + problem.line - 1 });
				}
			}
		}
		for (const child of node.children ?? []) visit(child);
	}
	visit(fromMarkdown(text));
	return problems;
}

function priorContents(mode: Mode, file: string): string | undefined {
	try {
		const revision =
			mode.kind === "base"
				? git(["merge-base", mode.ref, "HEAD"]).trim()
				: "HEAD";
		return git(["show", `${revision}:${file}`]);
	} catch {
		return undefined;
	}
}

function notebookViolations(
	file: string,
	current: string,
	previous: string | undefined,
): Violation[] {
	const comments = notebookComments(current);
	if (!comments)
		return [
			{
				file,
				line: 1,
				message: "parse the notebook and use a supported code-cell language",
			},
		];
	const old = previous === undefined ? [] : (notebookComments(previous) ?? []);
	const counts = new Map<string, number>();
	for (const item of old) counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
	return comments.flatMap((comment) => {
		const count = counts.get(comment.key) ?? 0;
		if (count > 0) {
			counts.set(comment.key, count - 1);
			return [];
		}
		return [
			{
				file,
				line: 1,
				message: `${comment.message} (code cell ${comment.cell}, line ${comment.line})`,
			},
		];
	});
}

function isExperiencePlanningArtifact(file: string): boolean {
	return /(?:^|\/)\.optimizexp\/(?:backlog\/|(?:INIT\.md|init-report\.json|experience-catalog\.json)$|personas\/[^/]+\.md$|features\/[^/]+\/(?:EXPERIENCE|SEED|README)\.md$|runs\/[^/]+\/(?:INCOMPLETE\.md|backlog\.json)$)/iu.test(
		file,
	);
}

type MarkdownTextNode = {
	readonly type: string;
	readonly value?: string;
	readonly alt?: string | null;
	readonly children?: readonly MarkdownTextNode[];
};

function markdownText(node: MarkdownTextNode): string {
	return (
		node.value ?? node.alt ?? node.children?.map(markdownText).join("") ?? ""
	);
}

function planningDocumentTitle(text: string): string | undefined {
	const heading = fromMarkdown(text).children.find(
		(node) => node.type === "heading" && node.depth === 1,
	);
	if (!heading) return undefined;
	const title = markdownText(heading).replace(/\s+/gu, " ").trim();
	if (
		/^(?:implementation plan|technical design|design document|design brief|architecture document|architecture decision record|roadmap|proposal|adr\b|rfc\b)(?:\s|:|-|$)/iu.test(
			title,
		) ||
		/\b(?:implementation plan|technical design|design document|design brief|architecture document|architecture decision record|project roadmap|delivery roadmap)\b/iu.test(
			title,
		)
	)
		return title;
	return undefined;
}

export function documentViolation(
	file: string,
	text: string,
): string | undefined {
	const sourceFile = sourcePath(file);
	if (
		isExperiencePlanningArtifact(sourceFile) ||
		/(?:^|\/)\.impeccable\/(?:design\.json|surfaces\/|.*\.md(?:x|c)?$)/iu.test(
			sourceFile,
		) ||
		/(?:^|\/)\.sdlc\/.*\.md(?:x|c)?$/iu.test(sourceFile)
	)
		return "planning, architecture, and design documents are not allowed";
	if (!/\.md(?:x|c)?$/iu.test(sourceFile)) return undefined;
	const title = planningDocumentTitle(text);
	if (title) return `document title "${title}" describes prohibited planning`;
	if (/^src\/draft\/(?:[^/]+\/)*_registry\.md(?:x|c)?$/iu.test(sourceFile))
		return "planning, architecture, and design documents are not allowed";
	if (
		/(?:^|\/)(?:design|designs|plans|roadmaps|architecture|architectures|adr|adrs|rfc|rfcs|proposals|architecture-decision-records)\//iu.test(
			sourceFile,
		)
	)
		return "planning, architecture, and design documents are not allowed";
	if (
		/(?:^|\/)(?:design|architecture|roadmap|proposal|(?:implementation[-_])?plan|(?:architecture[-_])?decision[-_]records?|(?:adr|rfc)(?:[-_][^/]+)?)\.md(?:x|c)?$/iu.test(
			sourceFile,
		) ||
		/(?:^|\/)[^/]+[-_](?:design|architecture|roadmap|plan|proposal|adr|rfc)\.md(?:x|c)?$/iu.test(
			sourceFile,
		) ||
		/(?:^|\/)(?:gaps?|gap[-_](?:analysis|register)|backlog|poc[-_]rollup[-_]ledger|scope[-_]review|(?:implementation[-_])?handoff(?:[-_]notes)?)\.md(?:x|c)?$/iu.test(
			sourceFile,
		) ||
		/(?:^|\/)[^/]+[-_]handoff(?:[-_]notes)?\.md(?:x|c)?$/iu.test(sourceFile)
	)
		return "planning, architecture, and design documents are not allowed";
	const type = frontmatterType(text);
	return type &&
		/\b(?:plan|design|roadmap|architecture|adr|rfc|proposal)\b/iu.test(type)
		? `document type "${type}" is not allowed`
		: undefined;
}

function changedLines(
	args: string[],
	file: string,
	text: string,
	untracked: boolean,
): Set<number> {
	if (untracked)
		return new Set(text.split(/\r?\n/u).map((_, index) => index + 1));
	return addedLineNumbers(
		git([
			...args,
			"--no-renames",
			"--no-color",
			"--no-ext-diff",
			"--unified=0",
			"--",
			file,
		]),
	);
}

export function proofArtifactViolations(
	file: string,
	text: string,
	added: Set<number>,
): Violation[] {
	if (!file.startsWith("src/draft/")) return [];
	const placeholder =
		/\b(?:proof-identity:\s*ok|identity\s+noop|Hardened notebook scaffold)\b/iu;
	return text.split(/\r?\n/u).flatMap((line, index) =>
		added.has(index + 1) && placeholder.test(line)
			? [
					{
						file,
						line: index + 1,
						message:
							"replace synthetic proof scaffolding with executable behavior",
					},
				]
			: [],
	);
}

export function checkSourcePolicy(mode: Mode): Violation[] {
	const args = diffArgs(mode);
	const untracked = untrackedFiles(mode);
	const files = [...new Set([...names(args, "ACMRT"), ...untracked])];
	const violations: Violation[] = [];
	const gitlinks = submodules(mode);
	for (const file of files) {
		if (gitlinks.has(file)) continue;
		const sourceFile = sourcePath(file);
		if (
			isExperiencePlanningArtifact(sourceFile) ||
			/\.md(?:x|c)?$/iu.test(sourceFile) ||
			/(?:^|\/)\.impeccable\/(?:design\.json$|surfaces\/)/iu.test(sourceFile)
		) {
			const text = contents(mode, file);
			const added = changedLines(args, file, text, untracked.includes(file));
			const reason = documentViolation(file, text);
			if (reason && (untracked.includes(file) || added.size > 0)) {
				violations.push({ file, line: 1, message: reason });
			}
		}
		if (
			file.startsWith("src/draft/") &&
			(/\/(?:examples|bench)\/.*\.[cm]?[jt]sx?$/u.test(sourceFile) ||
				sourceFile.endsWith(".ipynb"))
		) {
			const text = contents(mode, file);
			const added = changedLines(args, file, text, untracked.includes(file));
			violations.push(...proofArtifactViolations(file, text, added));
		}
		if (/\.md(?:x|c)?$/iu.test(sourceFile)) {
			const text = contents(mode, file);
			const added = changedLines(args, file, text, untracked.includes(file));
			violations.push(...markdownCodeViolations(file, text, added));
		}
		const extension = extname(sourceFile).toLowerCase();
		const dockerfile = isDockerfile(sourceFile);
		if (extension === ".ipynb") {
			violations.push(
				...notebookViolations(
					file,
					contents(mode, file),
					priorContents(mode, file),
				),
			);
			continue;
		}
		if (
			extension &&
			!file.startsWith(".githooks/") &&
			extension !== ".astro" &&
			extension !== ".feature" &&
			!BATCH_EXTENSIONS.has(extension) &&
			!XML_EXTENSIONS.has(extension) &&
			!CODE_EXTENSIONS.has(extension) &&
			!LEXER_LANGUAGES.has(extension) &&
			!OTHER_LANGUAGES.has(extension) &&
			!dockerfile
		)
			continue;
		const text = contents(mode, file);
		if (
			!extension &&
			!dockerfile &&
			!file.startsWith(".githooks/") &&
			!text.startsWith("#!")
		)
			continue;
		const added = changedLines(args, file, text, untracked.includes(file));
		violations.push(...commentViolations(file, text, added));
	}
	return violations;
}

function main(args: string[]): number {
	const base = args.find((arg) => arg.startsWith("--base="));
	const mode: Mode = args.includes("--staged")
		? { kind: "staged" }
		: args.includes("--worktree")
			? { kind: "worktree" }
			: { kind: "base", ref: base?.slice("--base=".length) ?? "HEAD~1" };
	try {
		const violations = checkSourcePolicy(mode);
		for (const violation of violations)
			console.error(
				`${violation.file}:${violation.line}: ${violation.message}`,
			);
		if (violations.length > 0) return 1;
		console.log(
			"source:guard: no new comment, planning-document, or synthetic-proof violations",
		);
		return 0;
	} catch (error) {
		console.error(
			`source:guard: unable to inspect changes: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 2;
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	process.exitCode = main(process.argv.slice(2));
