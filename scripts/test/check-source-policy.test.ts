import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdtempSync,
	mkdirSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	addedLineNumbers,
	commentViolations,
	commentsIn,
	documentViolation,
} from "../check-source-policy.mts";

const script = resolve("scripts/check-source-policy.mts");
const scratch: string[] = [];
const env = {
	...process.env,
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
};

afterEach(() => {
	for (const directory of scratch.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function git(repo: string, ...args: string[]): string {
	return execFileSync("git", ["-C", repo, ...args], {
		encoding: "utf8",
		env,
	}).trim();
}

function fixture(): string {
	const repo = mkdtempSync(join(tmpdir(), "hobo-source-policy-"));
	scratch.push(repo);
	git(repo, "init", "--quiet");
	writeFileSync(
		join(repo, "existing.ts"),
		"// existing comment\nexport const value = 1;\n",
	);
	git(repo, "add", "existing.ts");
	git(
		repo,
		"-c",
		"user.name=fixture",
		"-c",
		"user.email=fixture@example.invalid",
		"commit",
		"--quiet",
		"-m",
		"fixture",
	);
	return repo;
}

function write(repo: string, file: string, text: string): void {
	mkdirSync(dirname(join(repo, file)), { recursive: true });
	writeFileSync(join(repo, file), text);
}

function guard(repo: string, ...args: string[]) {
	return spawnSync(
		process.execPath,
		["--import", resolve("node_modules/tsx/dist/loader.mjs"), script, ...args],
		{
			cwd: repo,
			env,
			encoding: "utf8",
		},
	);
}

describe("source policy", () => {
	it("finds actual comments without mistaking strings, regexes, templates, or JSX text for comments", () => {
		const text = [
			'const url = "https://example.test/path";',
			"const pattern = /https?:\\/\\/example/;",
			"const literal = `// text /* text */`; ",
			"const view = <div>// text{/* actual */}</div>;",
			"const value = 1; // actual",
		].join("\n");
		assert.deepEqual(
			commentsIn("example.tsx", text).map((comment) => comment.text),
			["/* actual */", "// actual"],
		);
	});

	it("allows required tool directives but rejects deferred markers, including inside directives", () => {
		const text = [
			"// @ts-expect-error required by the compiler test",
			"const x = 1;",
			"// eslint-disable-next-line no-alert -- TODO implement alternative",
			"alert(x);",
		].join("\n");
		assert.deepEqual(
			commentViolations("x.ts", text, new Set([1, 3])).map((item) => item.line),
			[3],
		);
	});

	it("checks added lines inside an existing multiline comment", () => {
		const text = "/* existing\nnew explanation\n*/\nexport const value = 1;\n";
		assert.equal(commentViolations("x.ts", text, new Set([2])).length, 1);
		assert.equal(commentViolations("x.ts", text, new Set([4])).length, 0);
	});

	it("parses shell, Python, CSS, and HTML without confusing strings or heredocs with comments", () => {
		const shell =
			"#!/usr/bin/env sh\ncat <<'EOF'\n# data\nEOF\necho ok # explanation\n";
		assert.deepEqual(
			commentViolations(".githooks/pre-commit", shell, new Set([1, 3, 5])).map(
				(item) => item.line,
			),
			[5],
		);
		assert.equal(
			commentViolations(
				"example.py",
				'value = "# data"  # explanation\n',
				new Set([1]),
			).length,
			1,
		);
		assert.equal(
			commentViolations(
				"example.css",
				"a { color: red; /* explanation */ }",
				new Set([1]),
			).length,
			1,
		);
		assert.equal(
			commentViolations(
				"example.html",
				"<div><!-- explanation --></div>",
				new Set([1]),
			).length,
			1,
		);
	});

	it("checks contract and configuration comments without treating string contents as comments", () => {
		const cue = String.raw`a: "https://example.test" // outside
b: #"literal // and \(not interpolation)"#
c: """
  // multiline string
  """
d: "value: \(1 + // interpolation
  2)"
e: ##"raw \##(2 + // raw interpolation
  3) // literal"##`;
		assert.deepEqual(
			commentViolations("x.cue", cue, new Set([1, 3, 6, 8, 9])).map(
				(item) => item.line,
			),
			[1, 6, 8],
		);
		const proto =
			'option x = "https://example.test/* data */"; /* explanation */\n// todo: implement';
		assert.deepEqual(
			commentViolations("x.proto", proto, new Set([1, 2])).map(
				(item) => item.line,
			),
			[1, 2],
		);
		const wit = "/* outer /* inner */ outer */\n/// explanation";
		assert.deepEqual(
			commentViolations("x.wit", wit, new Set([1, 2])).map((item) => item.line),
			[1, 2],
		);
		const sql =
			"SELECT 'it''s -- data', $$-- data$$; -- explanation\n/* explanation */";
		assert.deepEqual(
			commentViolations("x.sql", sql, new Set([1, 2])).map((item) => item.line),
			[1, 2],
		);
		const toml = `a = '# data' # explanation\nb = """\n# data\n""" # explanation`;
		assert.deepEqual(
			commentViolations("x.toml", toml, new Set([1, 3, 4])).map(
				(item) => item.line,
			),
			[1, 4],
		);
		assert.equal(
			commentViolations(
				"x.yaml",
				'url: "https://host/#data" # explanation',
				new Set([1]),
			).length,
			1,
		);
		assert.equal(
			commentViolations(
				"x.prisma",
				'url = "https://example.test" // explanation',
				new Set([1]),
			).length,
			1,
		);
	});

	it("handles Rust and Kotlin line and block comments", () => {
		for (const file of ["example.rs", "example.kt"]) {
			assert.deepEqual(
				commentViolations(file, "// line\n/* block */", new Set([1, 2])).map(
					(item) => item.line,
				),
				[1, 2],
			);
		}
	});

	it("preserves actual licensing and tool directives without exempting arbitrary banner comments", () => {
		assert.equal(
			commentViolations("x.ts", "/*! @license MIT */\n", new Set([1])).length,
			0,
		);
		assert.equal(
			commentViolations("x.ts", "/*! explanation */\n", new Set([1])).length,
			1,
		);
		assert.equal(
			commentViolations(
				"x.proto",
				"// buf:lint:ignore FIELD_NOT_REQUIRED\n",
				new Set([1]),
			).length,
			0,
		);
	});

	it("recognizes additions in zero-context patches", () => {
		const patch =
			"@@ -1,2 +1,3 @@\n-old\n+one\n+two\n@@ -8,0 +10,1 @@\n+three\n";
		assert.deepEqual([...addedLineNumbers(patch)], [1, 2, 10]);
	});

	it("rejects new planning and design documents by location, name, or declared type", () => {
		for (const [file, text] of [
			["docs/design/new.md", "# New"],
			["packages/example/DESIGN.md", "# New"],
			["notes/implementation-plan.md", "# New"],
			["notes/new.md", "---\ntype: Design\n---\n"],
			[".impeccable/design.json", "{}"],
			["site/.impeccable/surfaces/example.md", "# Example"],
		] as const)
			assert.ok(documentViolation(file, text), file);
		assert.equal(documentViolation("docs/usage.md", "# Usage"), undefined);
	});

	it("checks the staged snapshot rather than the working tree", () => {
		const repo = fixture();
		write(
			repo,
			"existing.ts",
			"// existing comment\nexport const value = 2; // new comment\n",
		);
		git(repo, "add", "existing.ts");
		write(repo, "existing.ts", "export const value = 2;\n");
		const result = guard(repo, "--staged");
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /existing\.ts:2/u);
	});

	it("allows existing comments and rejects newly added documents in the staged snapshot", () => {
		const repo = fixture();
		write(
			repo,
			"existing.ts",
			"// existing comment\nexport const value = 2;\n",
		);
		git(repo, "add", "existing.ts");
		assert.equal(guard(repo, "--staged").status, 0);
		write(repo, "docs/design/new.md", "# Design\n");
		git(repo, "add", "docs/design/new.md");
		const result = guard(repo, "--staged");
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /docs\/design\/new\.md/u);
	});

	it("enforces contract and design artifact rules on staged files", () => {
		const repo = fixture();
		write(
			repo,
			"schema.cue",
			'endpoint: "https://example.test" // explanation\n',
		);
		write(repo, ".impeccable/design.json", "{}\n");
		git(repo, "add", "--all");
		const result = guard(repo, "--staged");
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /schema\.cue:1/u);
		assert.match(result.stderr, /\.impeccable\/design\.json:1/u);
	});

	it("checks filenames containing Git pathspec metacharacters literally", () => {
		const repo = fixture();
		write(repo, "literal[1].ts", "export const value = 1; // explanation\n");
		git(repo, "add", "--all");
		const result = guard(repo, "--staged");
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /literal\[1\]\.ts:1/u);
	});

	it("rejects changes that retain an existing design document", () => {
		const repo = fixture();
		write(repo, "docs/design/existing.md", "# Existing\n");
		git(repo, "add", "--all");
		git(
			repo,
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--quiet",
			"-m",
			"add design",
		);
		write(repo, "docs/design/existing.md", "# Changed\n");
		git(repo, "add", "--all");
		assert.equal(guard(repo, "--staged").status, 1);
		unlinkSync(join(repo, "docs/design/existing.md"));
		git(repo, "add", "--all");
		assert.equal(guard(repo, "--staged").status, 0);
	});

	it("allows tracked planning documents to be removed before staging", () => {
		const repo = fixture();
		write(repo, "old.md", "# Existing reference\n");
		git(repo, "add", "old.md");
		git(
			repo,
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--quiet",
			"-m",
			"add reference",
		);
		unlinkSync(join(repo, "old.md"));
		const result = spawnSync(
			process.execPath,
			[
				"--experimental-strip-types",
				resolve("scripts/check-no-committed-plans.mts"),
			],
			{ cwd: repo, env, encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
	});

	it("checks all commits since the merge base and fails closed for an unknown base", () => {
		const repo = fixture();
		const base = git(repo, "rev-parse", "HEAD");
		write(repo, "new.ts", "export const value = 1; // explain\n");
		git(repo, "add", "new.ts");
		git(
			repo,
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--quiet",
			"-m",
			"change",
		);
		assert.equal(guard(repo, `--base=${base}`).status, 1);
		assert.equal(guard(repo, "--base=no-such-base").status, 2);
	});
});
