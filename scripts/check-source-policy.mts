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
	/^(?:external\/|tools\/oxlint\/anti-slop\/|packages\/(?:hobo|runtimes\/runtime-wasm)\/wit\/wasi-http\/|packages\/wit\/src\/generated\/.*\.d\.ts$)|(?:^|\/)(?:_generated|_generated-assets|dist|node_modules|vendor)\/|(?:^|\/)wit\/deps\//u;
const DIRECTIVE =
	/^(?:\/\/go:[A-Za-z][A-Za-z0-9_]*\b|\/\/(?:line|export|extern)\s|\/\/ (?:#cgo|\+build)\s|(?:\/\/\/\s*|\/\/\s*|\/\*+!?\s*(?:\*\s*)?|#\s*|--\s*|<!--\s*)(?:@ts-(?:check|nocheck|ignore|expect-error)\b|@(?:jsx|jsxFrag|jsxImportSource|jsxRuntime|vitest-environment|generated)\b|(?:eslint|oxlint|biome|prettier|stylelint)-(?:disable|enable|ignore)\b|(?:istanbul|c8|v8)\s+ignore\b|(?:shellcheck|yamllint|yaml-language-server|actionlint|zizmor|renovate)\b|(?:pyright|ruff|fmt|type|pragma):|buf:(?:lint|breaking):|atlas:(?:nolint|lint|txmode|delimiter|assert)\b|cue:generate\b|noqa\b|[#@]__(?:PURE|NO_SIDE_EFFECTS)__|[#@]\s*sourceMappingURL=|<reference\b|@license\b|SPDX-License-Identifier:|copyright\b|domain-view:|parallel-type-allowed:|public-contract:))/iu;
const VITE_DIRECTIVE = /^\/\*\s*@vite-ignore\s*\*\/$/u;
const DEFERRED = /\b(?:TODO|FIXME|HACK|XXX|TBD)\b/iu;
const LINT_EXPLANATION =
	/^(?:\/\/|\/\*+)\s*(?:eslint|oxlint)-(?:disable|enable)(?:-next-line|-line)?\b[^\r\n]*?\s--\s*\S/iu;

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

function mergeParentDiffs(mode: Mode): string[][] {
	if (mode.kind !== "staged") return [];
	const path = git(["rev-parse", "--git-path", "MERGE_HEAD"]).trim();
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT")
			return [];
		throw error;
	}
	const heads = contents.split("\n").filter(Boolean);
	if (heads.length === 0) throw new Error("MERGE_HEAD is empty");
	return heads.map((head) => {
		const commit = git([
			"rev-parse",
			"--verify",
			"--end-of-options",
			`${head}^{commit}`,
		]).trim();
		return ["diff", "--cached", commit];
	});
}

function names(args: string[], filter: string): string[] {
	return git([
		...args,
		"--find-renames",
		"--name-only",
		`--diff-filter=${filter}`,
		"-z",
		"--",
	])
		.split("\0")
		.filter(Boolean);
}

function addedLineCounts(args: string[]): Map<string, number> {
	const entries = git([...args, "--no-renames", "--numstat", "-z", "--"]).split(
		"\0",
	);
	const counts = new Map<string, number>();
	for (const entry of entries) {
		const firstTab = entry.indexOf("\t");
		const secondTab = entry.indexOf("\t", firstTab + 1);
		if (firstTab < 0 || secondTab < 0) continue;
		const added = entry.slice(0, firstTab);
		if (/^\d+$/u.test(added))
			counts.set(entry.slice(secondTab + 1), Number(added));
	}
	return counts;
}

function relocationRelink(before: string, after: string): boolean {
	const links = /\]\(([^)]+)\)/gu;
	const previous = [...before.matchAll(links)].map((match) => match[1]);
	const next = [...after.matchAll(links)].map((match) => match[1]);
	if (
		previous.length !== next.length ||
		before.replace(links, "]()") !== after.replace(links, "]()")
	)
		return false;
	let changed = false;
	for (let index = 0; index < previous.length; index++) {
		const target = next[index];
		if (previous[index] === target) continue;
		if (
			!target ||
			(!/^https:\/\/(?:linear\.app\/|github\.com\/Hobo-Labs\/HoBo\/blob\/[\da-f]{40}\/)/u.test(
				target,
			) &&
				!/^(?:\.{1,2}\/)+(?:[^/#?]+\/)*[^/#?]+\.mdx?(?:#[^ ]*)?$/u.test(target))
		)
			return false;
		changed = true;
	}
	return changed;
}

function removalOrRelocationRelink(args: string[], file: string): boolean {
	const patch = git([
		...args,
		"--no-color",
		"--no-ext-diff",
		"--unified=0",
		"--",
		file,
	]);
	const removed: string[] = [];
	const added: string[] = [];
	for (const line of patch.split("\n")) {
		if (line.startsWith("--- ") || line.startsWith("+++ ")) continue;
		if (line.startsWith("-")) removed.push(line.slice(1));
		if (line.startsWith("+")) added.push(line.slice(1));
	}
	for (const line of added) {
		const index = removed.findIndex((previous) =>
			relocationRelink(previous, line),
		);
		if (index < 0) return false;
		removed.splice(index, 1);
	}
	return true;
}

function renameSources(args: string[]): Map<string, string> {
	const entries = git([
		...args,
		"--find-renames",
		"--name-status",
		"--diff-filter=R",
		"-z",
		"--",
	]).split("\0");
	const sources = new Map<string, string>();
	for (let index = 0; index + 2 < entries.length; index += 3) {
		const source = entries[index + 1];
		const destination = entries[index + 2];
		if (source !== undefined && destination !== undefined)
			sources.set(destination, source);
	}
	return sources;
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

function trainingRanges(file: string, text: string): Array<[number, number]> {
	if (!CODE_EXTENSIONS.has(extname(sourcePath(file)).toLowerCase())) return [];
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
	const ranges: Array<[number, number]> = [];
	function visit(node: ts.Node): void {
		if (
			(ts.isFunctionDeclaration(node) ||
				ts.isFunctionExpression(node) ||
				ts.isArrowFunction(node) ||
				ts.isMethodDeclaration(node)) &&
			node.body &&
			ts.isBlock(node.body)
		) {
			const body = node.body;
			const first = body.statements[0];
			const directive =
				first &&
				ts.isExpressionStatement(first) &&
				ts.isStringLiteral(first.expression) &&
				first.expression.text === "use training"
					? first
					: undefined;
			const decorated =
				ts.isMethodDeclaration(node) &&
				ts.getDecorators(node)?.some((decorator) => {
					const expression = ts.isCallExpression(decorator.expression)
						? decorator.expression.expression
						: decorator.expression;
					return ts.isIdentifier(expression) && expression.text === "trainable";
				});
			if (directive || decorated)
				ranges.push([
					directive?.end ?? body.getStart(source) + 1,
					body.end - 1,
				]);
		}
		ts.forEachChild(node, visit);
	}
	visit(source);
	return ranges;
}

function commentLocations(file: string, text: string): CommentLocation[] {
	const extension = extname(sourcePath(file)).toLowerCase();
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
		const training = trainingRanges(file, text);
		return commentsIn(file, text)
			.filter(
				(comment) =>
					!training.some(
						([start, end]) => start <= comment.start && comment.end <= end,
					),
			)
			.map((comment) => ({
				text: comment.text,
				first: source.getLineAndCharacterOfPosition(comment.start).line + 1,
				last: source.getLineAndCharacterOfPosition(comment.end - 1).line + 1,
			}));
	}
	const kinds =
		language === "kotlin"
			? ["line_comment", "multiline_comment"]
			: language === "swift"
				? ["comment", "multiline_comment"]
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
	parentAdditions: readonly Set<number>[] = [],
): Violation[] {
	return commentLocations(file, text).flatMap((comment) => {
		const { first, last } = comment;
		const intersects = (lines: Set<number>) => {
			for (let line = first; line <= last; line++) {
				if (lines.has(line)) return true;
			}
			return false;
		};
		if (!intersects(added) || !parentAdditions.every(intersects)) return [];
		if (first === 1 && comment.text.startsWith("#!")) return [];
		if (
			!DEFERRED.test(comment.text) &&
			!LINT_EXPLANATION.test(comment.text) &&
			(DIRECTIVE.test(comment.text) || VITE_DIRECTIVE.test(comment.text))
		)
			return [];
		return [
			{
				file,
				line: first,
				message: DEFERRED.test(comment.text)
					? "resolve the work or track it in Linear instead of adding a marker"
					: "make the code self-documenting instead of adding a comment",
			},
		];
	});
}

function isExperiencePlanningArtifact(file: string): boolean {
	return /(?:^|\/)\.optimizexp\/(?:backlog\/|(?:INIT\.md|init-report\.json|experience-catalog\.json)$|personas\/[^/]+\.md$|features\/[^/]+\/(?:EXPERIENCE|SEED|README)\.md$|runs\/[^/]+\/(?:INCOMPLETE\.md|backlog\.json)$)/iu.test(
		file,
	);
}

export function documentViolation(
	file: string,
	text: string,
): string | undefined {
	const sourceFile = sourcePath(file);
	if (
		isExperiencePlanningArtifact(sourceFile) ||
		/(?:^|\/)\.impeccable\/(?:design\.json|surfaces\/|.*\.mdx?$)/iu.test(
			sourceFile,
		) ||
		/(?:^|\/)\.sdlc\/.*\.mdx?$/iu.test(sourceFile)
	)
		return "planning and design documents are not allowed";
	if (!/\.mdx?$/iu.test(sourceFile)) return undefined;
	if (
		/(?:^|\/)(?:design|designs|plans|roadmaps|adr|adrs|rfc|rfcs|proposals)\//iu.test(
			sourceFile,
		)
	)
		return "planning and design documents are not allowed";
	if (
		/(?:^|\/)(?:design|roadmap|(?:implementation[-_])?plan)\.mdx?$/iu.test(
			sourceFile,
		) ||
		/(?:^|\/)[^/]+[-_](?:design|roadmap|plan|adr|rfc|proposal)\.mdx?$/iu.test(
			sourceFile,
		) ||
		/(?:^|\/)(?:adr|rfc|proposal)(?:[-_][^/]*)?\.mdx?$/iu.test(sourceFile)
	)
		return "planning and design documents are not allowed";
	const type = frontmatterType(text);
	return type &&
		/\b(?:plan|design|roadmap|architecture decision record|rfc|proposal)\b/iu.test(
			type,
		)
		? `document type "${type}" is not allowed`
		: undefined;
}

export function checkSourcePolicy(mode: Mode): Violation[] {
	const args = diffArgs(mode);
	const untracked = untrackedFiles(mode);
	const untrackedSet = new Set(untracked);
	const modified = new Set(names(args, "M"));
	const addedCounts = addedLineCounts(args);
	const renamed = renameSources(args);
	const parents = mergeParentDiffs(mode).map((parentArgs) => ({
		args: parentArgs,
		files: new Set(names(parentArgs, "ACMRT")),
		renamed: renameSources(parentArgs),
	}));
	const files = [...new Set([...names(args, "ACMRT"), ...untracked])];
	const violations: Violation[] = [];
	for (const file of files) {
		if (GENERATED_OR_VENDOR.test(file)) continue;
		const sourceFile = sourcePath(file);
		const deletionOnly = !untrackedSet.has(file) && addedCounts.get(file) === 0;
		if (
			((isExperiencePlanningArtifact(sourceFile) ||
				/\.mdx?$/iu.test(sourceFile)) &&
				!(
					modified.has(file) &&
					(deletionOnly || removalOrRelocationRelink(args, file))
				) &&
				parents.every((parent) => parent.files.has(file))) ||
			/(?:^|\/)\.impeccable\/(?:design\.json$|surfaces\/)/iu.test(sourceFile)
		) {
			const reason = documentViolation(file, contents(mode, file));
			if (reason) violations.push({ file, line: 1, message: reason });
		}
		const extension = extname(sourceFile).toLowerCase();
		if (
			extension &&
			!file.startsWith(".githooks/") &&
			extension !== ".astro" &&
			!CODE_EXTENSIONS.has(extension) &&
			!LEXER_LANGUAGES.has(extension) &&
			!OTHER_LANGUAGES.has(extension)
		)
			continue;
		if (deletionOnly) continue;
		const text = contents(mode, file);
		if (!extension && !file.startsWith(".githooks/") && !text.startsWith("#!"))
			continue;
		const source = renamed.get(file);
		const added = untrackedSet.has(file)
			? new Set(text.split(/\r?\n/u).map((_, index) => index + 1))
			: addedLineNumbers(
					git([
						...args,
						"--find-renames",
						"--no-color",
						"--no-ext-diff",
						"--unified=0",
						"--",
						...(source === undefined ? [file] : [source, file]),
					]),
				);
		const parentAdditions = parents.map((parent) => {
			if (!parent.files.has(file)) return new Set<number>();
			const parentSource = parent.renamed.get(file);
			return addedLineNumbers(
				git([
					...parent.args,
					"--find-renames",
					"--no-color",
					"--no-ext-diff",
					"--unified=0",
					"--",
					...(parentSource === undefined ? [file] : [parentSource, file]),
				]),
			);
		});
		violations.push(...commentViolations(file, text, added, parentAdditions));
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
