#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseAstro } from "@astrojs/compiler/sync";
import type { Node as AstroNode } from "@astrojs/compiler/types";
import ts from "typescript";
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
]);
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
]);
const require = createRequire(import.meta.url);
const AST_GREP = join(
	dirname(require.resolve("@ast-grep/cli/package.json")),
	process.platform === "win32" ? "ast-grep.exe" : "ast-grep",
);
const GENERATED_OR_VENDOR =
	/^(?:external\/|tools\/oxlint\/anti-slop\/)|(?:^|\/)(?:_generated|dist|node_modules)\//u;
const DIRECTIVE =
	/^(?:\/\/\/\s*|\/\/\s*|\/\*+!?\s*(?:\*\s*)?|#\s*|--\s*|<!--\s*)(?:@ts-(?:check|nocheck|ignore|expect-error)\b|@(?:jsx|jsxFrag|jsxImportSource|jsxRuntime|vitest-environment)\b|(?:eslint|oxlint|biome|prettier|stylelint)-(?:disable|enable|ignore)\b|(?:istanbul|c8|v8)\s+ignore\b|(?:shellcheck|pyright|ruff|fmt|type|pragma|buf|go|atlas):|yaml-language-server:|noqa\b|[#@]__(?:PURE|NO_SIDE_EFFECTS)__|[#@]\s*sourceMappingURL=|<reference\b|@license\b|SPDX-License-Identifier:|copyright\b|domain-view:|parallel-type-allowed:|public-contract:)/iu;
const DEFERRED = /\b(?:TODO|FIXME|HACK|XXX|TBD)\b/iu;

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
	const ignoredAgentArtifacts = git([
		"ls-files",
		"--others",
		"--ignored",
		"--exclude-standard",
		"-z",
		"--",
		".sdlc",
		".impeccable",
	]);
	return `${untracked}${ignoredAgentArtifacts}`.split("\0").filter(Boolean);
}

function contents(mode: Mode, file: string): string {
	if (mode.kind === "staged") return git(["show", `:${file}`]);
	if (mode.kind === "base") return git(["show", `HEAD:${file}`]);
	return readFileSync(file, "utf8");
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

export function commentsIn(file: string, text: string): Comment[] {
	const kind = /\.[jt]sx$/iu.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
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
	const extension = extname(file).toLowerCase();
	if (extension === ".astro") return astroComments(file, text);
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
	return kinds.flatMap((kind) => {
		const result = spawnSync(
			AST_GREP,
			["run", "--stdin", "--lang", language, "--kind", kind, "--json"],
			{
				input: text,
				encoding: "utf8",
				maxBuffer: 64 * 1024 * 1024,
			},
		);
		if (result.error || (result.status !== 0 && result.status !== 1)) {
			throw new Error(
				`cannot parse ${file}: ${result.error?.message ?? result.stderr}`,
			);
		}
		const matches: {
			text: string;
			range: { start: { line: number }; end: { line: number; column: number } };
		}[] = JSON.parse(result.stdout);
		return matches.map((match) => ({
			text: match.text,
			first: match.range.start.line + 1,
			last: match.range.end.line + (match.range.end.column === 0 ? 0 : 1),
		}));
	});
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
		if (first === 1 && comment.text.startsWith("#!")) return [];
		if (!DEFERRED.test(comment.text) && DIRECTIVE.test(comment.text)) return [];
		return [
			{
				file,
				line: first,
				message: DEFERRED.test(comment.text)
					? "finish deferred work instead of adding a marker"
					: "make the code self-documenting instead of adding a comment",
			},
		];
	});
}

export function documentViolation(
	file: string,
	text: string,
): string | undefined {
	if (
		/(?:^|\/)\.impeccable\/(?:design\.json|surfaces\/|.*\.mdx?$)/iu.test(
			file,
		) ||
		/(?:^|\/)\.sdlc\/.*\.mdx?$/iu.test(file)
	)
		return "planning and design documents are not allowed";
	if (!/\.mdx?$/iu.test(file)) return undefined;
	if (/(?:^|\/)(?:design|designs|plans|roadmaps)\//iu.test(file))
		return "planning and design documents are not allowed";
	if (
		/(?:^|\/)(?:design|roadmap|(?:implementation[-_])?plan)\.mdx?$/iu.test(
			file,
		) ||
		/(?:^|\/)[^/]+[-_](?:design|roadmap|plan)\.mdx?$/iu.test(file)
	)
		return "planning and design documents are not allowed";
	const type = frontmatterType(text);
	return type && /\b(?:plan|design|roadmap)\b/iu.test(type)
		? `document type "${type}" is not allowed`
		: undefined;
}

export function checkSourcePolicy(mode: Mode): Violation[] {
	const args = diffArgs(mode);
	const untracked = untrackedFiles(mode);
	const files = [...new Set([...names(args, "ACMRT"), ...untracked])];
	const violations: Violation[] = [];
	for (const file of files) {
		if (GENERATED_OR_VENDOR.test(file)) continue;
		if (
			/\.mdx?$/iu.test(file) ||
			/(?:^|\/)\.impeccable\/(?:design\.json$|surfaces\/)/iu.test(file)
		) {
			const reason = documentViolation(file, contents(mode, file));
			if (reason) violations.push({ file, line: 1, message: reason });
		}
		const extension = extname(file).toLowerCase();
		if (
			extension &&
			!file.startsWith(".githooks/") &&
			extension !== ".astro" &&
			!CODE_EXTENSIONS.has(extension) &&
			!LEXER_LANGUAGES.has(extension) &&
			!OTHER_LANGUAGES.has(extension)
		)
			continue;
		const text = contents(mode, file);
		if (!extension && !file.startsWith(".githooks/") && !text.startsWith("#!"))
			continue;
		const added = untracked.includes(file)
			? new Set(text.split(/\r?\n/u).map((_, index) => index + 1))
			: addedLineNumbers(
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
		console.log("source:guard: no new comment or planning-document violations");
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
