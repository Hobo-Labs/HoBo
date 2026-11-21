import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	addedLineNumbers,
	commentsIn,
	commentViolations,
	documentViolation,
} from "../check-source-policy.mts";
import { lexComments } from "../source-comment-lexer.mts";

const script = resolve("scripts/check-source-policy.mts");
const scratch: string[] = [];
const env: NodeJS.ProcessEnv = { ...process.env };
for (const name of Object.keys(env))
	if (name.startsWith("GIT_")) delete env[name];
env.GIT_CONFIG_NOSYSTEM = "1";
env.GIT_CONFIG_GLOBAL = "/dev/null";

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
  3) // literal"##
f: /* TODO: remove block */`;
		assert.deepEqual(
			commentViolations("x.cue", cue, new Set([1, 3, 6, 8, 9, 10])).map(
				(item) => item.line,
			),
			[1, 6, 8, 10],
		);
		assert.deepEqual(
			commentViolations(
				"x.cue",
				"g: /* see http://inside.example.test */",
				new Set([1]),
			).map((item) => item.message),
			["make the code self-documenting instead of adding a comment"],
		);
		assert.deepEqual(
			commentViolations(
				"x.cue",
				"a: /* glob: pkg/* */\n// TODO: follow up\n",
				new Set([1, 2]),
			).map((item) => ({ line: item.line, message: item.message })),
			[
				{
					line: 1,
					message: "make the code self-documenting instead of adding a comment",
				},
				{
					line: 2,
					message: "finish deferred work instead of adding a marker",
				},
			],
		);
		const proto =
			'option x = "https://example.test/* data */"; /* explanation */\n// todo: implement';
		assert.deepEqual(
			commentViolations("x.proto", proto, new Set([1, 2])).map(
				(item) => item.line,
			),
			[1, 2],
		);
		assert.deepEqual(
			commentViolations(
				"schema.prisma",
				"/* TODO: inside */\n/* relation pkg/* */ TODO: outside */\n",
				new Set([1, 2]),
			).map((item) => ({ line: item.line, message: item.message })),
			[
				{
					line: 1,
					message: "finish deferred work instead of adding a marker",
				},
				{
					line: 2,
					message: "make the code self-documenting instead of adding a comment",
				},
			],
		);
		const wit = "/* outer /* inner */ outer */\n/// explanation";
		assert.deepEqual(
			commentViolations("x.wit", wit, new Set([1, 2])).map((item) => item.line),
			[1, 2],
		);
		const sql =
			"SELECT 'it''s -- data # data', $$-- data # data$$; -- explanation\n/* explanation */";
		assert.deepEqual(
			commentViolations("x.sql", sql, new Set([1, 2])).map((item) => item.line),
			[1, 2],
		);
		assert.deepEqual(
			commentViolations(
				"x.sql",
				"/* relation pkg/* nested */ TODO: follow up */\n-- explanation\n",
				new Set([1, 2]),
			).map((item) => ({ line: item.line, message: item.message })),
			[
				{
					line: 1,
					message: "finish deferred work instead of adding a marker",
				},
				{
					line: 2,
					message: "make the code self-documenting instead of adding a comment",
				},
			],
		);
		assert.deepEqual(
			commentViolations(
				"x.sql",
				"SELECT payload #>> '{a}' FROM events;",
				new Set([1]),
			),
			[],
		);
		const toml = `a = '# data' # explanation\nb = """\n# data\n""" # explanation`;
		assert.deepEqual(
			commentViolations("x.toml", toml, new Set([1, 3, 4])).map(
				(item) => item.line,
			),
			[1, 4],
		);
		for (const text of [
			'a = """# data"""" # explanation',
			'a = """# data""""" # explanation',
			"a = '''# data'''' # explanation",
			"a = '''# data''''' # explanation",
		])
			assert.deepEqual(
				commentViolations("x.toml", text, new Set([1])).map(
					(item) => item.line,
				),
				[1],
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

	it("handles MySQL backslash escapes in strings and quoted identifiers", () => {
		const sql = [
			"SELECT 'it\\'s -- not a comment', `column\\` -- still an identifier`; -- explanation",
			'SELECT "a\\" -- still a string"; -- explanation',
		].join("\n");
		assert.deepEqual(
			lexComments(sql, "sql").map((comment) => comment.text),
			["-- explanation", "-- explanation"],
		);
	});

	it("requires whitespace or a control character after MySQL line comment delimiters", () => {
		const sql = [
			"SELECT 1--2;",
			"SELECT 3--4;",
			"SELECT 5 -- explanation",
			"SELECT 6 --\tcontrolled",
			"SELECT 7 --",
		].join("\n");
		assert.deepEqual(
			lexComments(sql, "sql").map((comment) => comment.text),
			["-- explanation", "--\tcontrolled"],
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

	it("checks Astro frontmatter, markup, expressions, attributes, scripts, and styles", () => {
		const text = [
			"---",
			'const url = "https://example.test/*literal*/";',
			"const count = 1; // frontmatter",
			"---",
			'<section title="<!-- literal -->">你好',
			"<!-- markup",
			"more markup -->",
			"<div data-count={",
			"  /* attribute */ count",
			"} {...( /* spread */ props )} title=`literal ${/* template */ count}`>",
			"{count ? <strong>{/* nested */ count}</strong> : /* alternate */ 0}",
			'<script>const url = "https://example.test"; // script',
			"</script>",
			'<style>.x::after { content: "/* literal */" } /* style */</style>',
			"</div></section>",
		].join("\n");
		assert.deepEqual(
			commentViolations(
				"example.astro",
				text,
				new Set(text.split("\n").map((_, index) => index + 1)),
			).map((item) => item.line),
			[3, 6, 9, 10, 10, 11, 11, 12, 14],
		);
		assert.deepEqual(
			commentViolations("example.astro", text, new Set([7])).map(
				(item) => item.line,
			),
			[6],
		);
	});

	it("reports Swift line and block comments", () => {
		assert.deepEqual(
			commentViolations(
				"example.swift",
				"// line\n/* block */",
				new Set([1, 2]),
			).map((item) => item.line),
			[1, 2],
		);
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
		assert.equal(
			commentViolations("x.proto", "// buf: retry later\n", new Set([1]))
				.length,
			1,
		);
		assert.equal(
			commentViolations("x.ts", "//go:embed schema.json\n", new Set([1]))
				.length,
			0,
		);
		assert.equal(
			commentViolations("x.ts", "// go: retry later\n", new Set([1])).length,
			1,
		);
		assert.equal(
			commentViolations("x.cue", "//cue:generate cue get go\n", new Set([1]))
				.length,
			0,
		);
		assert.equal(
			commentViolations("x.sql", "-- atlas:nolint DS101\n", new Set([1]))
				.length,
			0,
		);
		assert.equal(
			commentViolations("x.sql", "-- atlas: retry later\n", new Set([1]))
				.length,
			1,
		);
	});

	it("allows Go compiler directives without exempting lookalike comments", () => {
		const directives = [
			"//go:generate stringer -type=Value",
			"//line parser.go:10",
			"// #cgo CFLAGS: -DNDEBUG",
			"//export Run",
			"//extern run",
			"// +build linux,amd64",
		];
		for (const directive of directives)
			assert.equal(
				commentViolations("x.go", `${directive}\n`, new Set([1])).length,
				0,
				directive,
			);

		const comments = [
			"// go:generate stringer -type=Value",
			"// line parser.go:10",
			"//#cgo CFLAGS: -DNDEBUG",
			"// export Run",
			"// extern run",
			"//+build linux,amd64",
		];
		assert.deepEqual(
			commentViolations(
				"x.go",
				comments.join("\n"),
				new Set(comments.map((_, index) => index + 1)),
			).map((item) => item.line),
			comments.map((_, index) => index + 1),
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
			[".impeccable/surfaces/example.json", "{}"],
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
		write(repo, ".impeccable/surfaces/example.json", "{}\n");
		write(repo, "site/.impeccable/surfaces/nested/widget.txt", "notes\n");
		git(repo, "add", "--all");
		const result = guard(repo, "--staged");
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /schema\.cue:1/u);
		assert.match(result.stderr, /\.impeccable\/design\.json:1/u);
		assert.match(result.stderr, /\.impeccable\/surfaces\/example\.json:1/u);
		assert.match(
			result.stderr,
			/site\/\.impeccable\/surfaces\/nested\/widget\.txt:1/u,
		);
	});

	it("allows unchanged comments in renamed files but rejects new ones", () => {
		const repo = fixture();
		git(repo, "mv", "existing.ts", "renamed.ts");
		const moved = guard(repo, "--staged");
		assert.equal(moved.status, 0, moved.stderr);
		write(
			repo,
			"renamed.ts",
			"// existing comment\nexport const value = 1;\n// new comment\n",
		);
		git(repo, "add", "renamed.ts");
		const changed = guard(repo, "--staged");
		assert.equal(changed.status, 1, changed.stderr);
		assert.match(changed.stderr, /renamed\.ts:3/u);
		assert.doesNotMatch(changed.stderr, /renamed\.ts:1/u);
	});

	it("accepts existing incoming content during a merge but rejects new merge edits", () => {
		const repo = fixture();
		const originalBranch = git(repo, "symbolic-ref", "--short", "HEAD");
		git(repo, "switch", "--quiet", "-c", "incoming");
		const incoming = "// already on incoming\nexport const incoming = 1;\n";
		write(repo, "incoming.ts", incoming);
		write(repo, "docs/design/existing.md", "# Existing design\n");
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
			"incoming",
		);
		git(repo, "switch", "--quiet", originalBranch);
		write(repo, "local.ts", "export const local = 1;\n");
		git(repo, "add", "local.ts");
		git(
			repo,
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--quiet",
			"-m",
			"local",
		);
		git(
			repo,
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"merge",
			"--no-commit",
			"--no-ff",
			"incoming",
		);
		const inherited = guard(repo, "--staged");
		assert.equal(inherited.status, 0, inherited.stderr);

		write(repo, "incoming.ts", `${incoming}// added during merge\n`);
		git(repo, "add", "incoming.ts");
		const comment = guard(repo, "--staged");
		assert.equal(comment.status, 1, comment.stderr);
		assert.match(comment.stderr, /incoming\.ts:3/u);

		write(repo, "incoming.ts", incoming);
		write(repo, "docs/design/existing.md", "# Changed during merge\n");
		git(repo, "add", "--all");
		const design = guard(repo, "--staged");
		assert.equal(design.status, 1, design.stderr);
		assert.match(design.stderr, /docs\/design\/existing\.md/u);
	});

	it("rejects a new multiline comment assembled from both merge parents", () => {
		const repo = fixture();
		write(repo, "combined.ts", "/*\n base\n*/\nexport const value = 1;\n");
		git(repo, "add", "combined.ts");
		git(
			repo,
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--quiet",
			"-m",
			"base comment",
		);
		const originalBranch = git(repo, "symbolic-ref", "--short", "HEAD");
		git(repo, "switch", "--quiet", "-c", "incoming");
		write(repo, "combined.ts", "/*\n incoming\n*/\nexport const value = 1;\n");
		git(repo, "add", "combined.ts");
		git(
			repo,
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--quiet",
			"-m",
			"incoming comment",
		);
		git(repo, "switch", "--quiet", originalBranch);
		write(repo, "combined.ts", "/*\n local\n*/\nexport const value = 1;\n");
		git(repo, "add", "combined.ts");
		git(
			repo,
			"-c",
			"user.name=fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"--quiet",
			"-m",
			"local comment",
		);
		const merge = spawnSync(
			"git",
			[
				"-C",
				repo,
				"-c",
				"user.name=fixture",
				"-c",
				"user.email=fixture@example.invalid",
				"merge",
				"--no-commit",
				"--no-ff",
				"incoming",
			],
			{ env, encoding: "utf8" },
		);
		assert.equal(merge.status, 1);
		write(
			repo,
			"combined.ts",
			"/*\n local\n incoming\n*/\nexport const value = 1;\n",
		);
		git(repo, "add", "combined.ts");
		const result = guard(repo, "--staged");
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /combined\.ts:1/u);
	});

	it("rejects new Astro comments in the staged snapshot", () => {
		const repo = fixture();
		write(
			repo,
			"page.astro",
			"---\nconst x = 1;\n---\n<p>{x}</p>\n<!-- explanation -->\n",
		);
		git(repo, "add", "page.astro");
		const result = guard(repo, "--staged");
		assert.equal(result.status, 1, result.stderr);
		assert.match(result.stderr, /page\.astro:5/u);
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
