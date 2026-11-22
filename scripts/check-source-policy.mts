#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { frontmatterType } from "./check-no-committed-plans.mts";

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
const OTHER_LANGUAGES = new Map([
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
	/^(?:\/\/\/\s*|\/\/\s*|\/\*+\s*(?:\*\s*)?|#\s*|<!--\s*)(?:@ts-(?:check|nocheck|ignore|expect-error)\b|@(?:jsx|jsxFrag|jsxImportSource|jsxRuntime|vitest-environment)\b|(?:eslint|oxlint|biome|prettier|stylelint)-(?:disable|enable|ignore)\b|(?:istanbul|c8|v8)\s+ignore\b|(?:shellcheck|pyright|ruff|fmt|type|pragma):|noqa\b|[#@]__(?:PURE|NO_SIDE_EFFECTS)__|[#@]\s*sourceMappingURL=|<reference\b|@license\b|SPDX-License-Identifier:|copyright\b|domain-view:|parallel-type-allowed:|public-contract:)/iu;
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
	return mode.kind === "worktree"
		? git(["ls-files", "--others", "--exclude-standard", "-z"])
				.split("\0")
				.filter(Boolean)
		: [];
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
	const extensionLanguage = OTHER_LANGUAGES.get(extension);
	const language =
		extensionLanguage ??
		(!CODE_EXTENSIONS.has(extension) && file.startsWith(".githooks/")
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
	const result = spawnSync(
		AST_GREP,
		["run", "--stdin", "--lang", language, "--kind", "comment", "--json"],
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
			(DIRECTIVE.test(comment.text) || comment.text.startsWith("/*!"))
		)
			return [];
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
		if (
			/\.mdx?$/iu.test(file) &&
			parents.every((parent) => parent.files.has(file))
		) {
			const reason = documentViolation(file, contents(mode, file));
			if (reason) violations.push({ file, line: 1, message: reason });
		}
		const extension = extname(file).toLowerCase();
		if (
			!file.startsWith(".githooks/") &&
			!CODE_EXTENSIONS.has(extension) &&
			!OTHER_LANGUAGES.has(extension)
		)
			continue;
		const text = contents(mode, file);
		const source = renamed.get(file);
		const added = untracked.includes(file)
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
