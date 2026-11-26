import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import {
	classifyImpact,
	loadTokenizer,
	type ReadVersions,
	shadowLanes,
} from "../ci/impact-classifier.mts";

type Versions = Readonly<Record<string, { base?: string; head?: string }>>;

function reader(files: Versions): ReadVersions {
	return (path, side) => files[path]?.[side];
}

const tokenize = loadTokenizer();

function classify(files: Versions, withTokenizer = true) {
	return classifyImpact(
		Object.keys(files),
		reader(files),
		withTokenizer ? tokenize : undefined,
	);
}

const code = (base: string, head: string) =>
	({
		"packages/core/src/a.ts": { base, head },
	}) satisfies Versions;

describe("impact-classifier inert rules", () => {
	it("needs the typescript tokenizer for the code-trivia rule", () => {
		assert.ok(tokenize, "typescript must load from the repo root");
	});

	it("keeps code meaningful without a tokenizer (pre-install fail-closed)", () => {
		const result = classify(
			code("export const a = 1;\n", "// c\nexport const a = 1;\n"),
			false,
		);
		assert.deepEqual(result.meaningfulPaths, ["packages/core/src/a.ts"]);
		assert.equal(result.tokenizer, false);
	});

	it("treats comment-only and whitespace-only code changes as inert", () => {
		for (const head of [
			"// note\nexport const a = 1;\n",
			"export  const   a=1 ;\n",
			"export const a = 1; /* block */\n",
		]) {
			const result = classify(code("export const a = 1;\n", head));
			assert.deepEqual(result.meaningfulPaths, [], head);
			assert.equal(result.inert[0]?.rule, "code-trivia");
		}
	});

	it("does not strip comment markers inside strings, templates or regexes", () => {
		const pairs: readonly (readonly [string, string])[] = [
			['export const s = "a//b";\n', 'export const s = "a//c";\n'],
			["export const t = `x/*y*/${1}`;\n", "export const t = `x/*z*/${1}`;\n"],
			["export const r = /a\\/b/;\n", "export const r = /a\\/c/;\n"],
		];
		for (const [base, head] of pairs) {
			const result = classify(code(base, head));
			assert.deepEqual(
				result.meaningfulPaths,
				["packages/core/src/a.ts"],
				head,
			);
		}
	});

	it("keeps directive comments, JSDoc and shebangs meaningful", () => {
		for (const head of [
			"// @ts-expect-error next line\nexport const a = 1;\n",
			"// biome-ignore lint: because\nexport const a = 1;\n",
			"export const a = /* @__PURE__ */ 1;\n",
			"/** docs */\nexport const a = 1;\n",
			"#!/usr/bin/env node\nexport const a = 1;\n",
		]) {
			const result = classify(code("export const a = 1;\n", head));
			assert.deepEqual(
				result.meaningfulPaths,
				["packages/core/src/a.ts"],
				head,
			);
		}
	});

	it("treats an ASI-significant newline as meaningful", () => {
		const result = classify(
			code(
				"export function f() {\n return\n 1;\n}\n",
				"export function f() {\n return 1;\n}\n",
			),
		);
		assert.deepEqual(result.meaningfulPaths, ["packages/core/src/a.ts"]);
	});

	it("keeps renames, quote-style changes and unparsable heads meaningful", () => {
		for (const head of [
			"export const b = 1;\n",
			"export const a = 'x';\n",
			"export const a = ;\n",
		]) {
			const base = head.includes("'x'")
				? 'export const a = "x";\n'
				: "export const a = 1;\n";
			const result = classify(code(base, head));
			assert.deepEqual(
				result.meaningfulPaths,
				["packages/core/src/a.ts"],
				head,
			);
		}
	});

	it("treats format-only JSON as inert; key reorder stays meaningful", () => {
		const inert = classify({
			"packages/core/package.json": {
				base: '{"name":"x","scripts":{"a":"1"}}',
				head: '{\n  "name": "x",\n  "scripts": { "a": "1" }\n}',
			},
		});
		assert.deepEqual(inert.meaningfulPaths, []);
		assert.equal(inert.inert[0]?.rule, "json-canonical");
		// Key order is observable (exports conditions, goldens): never inert.
		const reordered = classify({
			"packages/core/package.json": {
				base: '{"name":"x","scripts":{"a":"1"}}',
				head: '{"scripts":{"a":"1"},"name":"x"}',
			},
		});
		assert.deepEqual(reordered.meaningfulPaths, ["packages/core/package.json"]);
		const changed = classify({
			"packages/core/package.json": {
				base: '{"name":"x"}',
				head: '{"name":"y"}',
			},
		});
		assert.deepEqual(changed.meaningfulPaths, ["packages/core/package.json"]);
		const broken = classify({
			"packages/core/package.json": { base: '{"name":"x"}', head: "{" },
		});
		assert.deepEqual(broken.meaningfulPaths, ["packages/core/package.json"]);
	});

	it("treats whitespace-only markdown as inert and word changes as meaningful", () => {
		const inert = classify({
			"docs/a.md": { base: "# Title\n\ntext\n", head: "# Title\ntext  \n" },
		});
		assert.deepEqual(inert.meaningfulPaths, []);
		const changed = classify({
			"docs/a.md": { base: "# Title\n", head: "# Other\n" },
		});
		assert.deepEqual(changed.meaningfulPaths, ["docs/a.md"]);
	});

	it("keeps added, deleted and other-extension files meaningful", () => {
		const result = classify({
			"packages/core/src/new.ts": { head: "export {};\n" },
			"packages/core/src/gone.ts": { base: "export {};\n" },
			"packages/core/data.txt": { base: "a", head: " b " },
		});
		assert.deepEqual([...result.meaningfulPaths].sort(), [
			"packages/core/data.txt",
			"packages/core/src/gone.ts",
			"packages/core/src/new.ts",
		]);
	});

	it("widens when the diff is too large to classify", () => {
		const paths = Array.from({ length: 301 }, (_, i) => `docs/${i}.md`);
		const result = classifyImpact(paths, () => "same", tokenize);
		assert.equal(result.meaningfulPaths.length, 301);
		assert.match(result.reason ?? "", /too large/);
	});

	it("widens when the classifier or its wiring changes", () => {
		const result = classify({
			"scripts/ci/impact-classifier.mts": {
				base: "export const a = 1;\n",
				head: "// harmless-looking\nexport const a = 1;\n",
			},
			"packages/core/src/a.ts": {
				base: "export const a = 1;\n",
				head: "// c\nexport const a = 1;\n",
			},
		});
		assert.equal(result.meaningfulPaths.length, 2);
		assert.match(result.reason ?? "", /self-change/);
	});

	it("flags byte-level scripts/test changes for the format gate", () => {
		const result = classify({
			"scripts/ci/x.mts": {
				base: "export const a = 1;\n",
				head: "// c\nexport const a = 1;\n",
			},
		});
		assert.deepEqual(result.meaningfulPaths, []);
		assert.equal(result.formatCheck, true);
	});
});

describe("impact-classifier shadow comparison", () => {
	it("proposes skip for a comment-only package change, fully explained", () => {
		const files = code(
			"export const a = 1;\n",
			"// only a comment\nexport const a = 1;\n",
		);
		const classification = classify(files);
		// Default lanes read the real tree: packages/core exists.
		const shadow = shadowLanes(Object.keys(files), classification);
		assert.equal(shadow.current.mode, "filtered");
		assert.equal(shadow.proposed.mode, "skip");
		assert.deepEqual(shadow.unexplained, []);
		assert.equal(shadow.dropped[0]?.rule, "code-trivia");
	});

	it("keeps the real package when an inert sibling drops", () => {
		const files = {
			"packages/core/src/a.ts": {
				base: "export const a = 1;\n",
				head: "// c\nexport const a = 1;\n",
			},
			"packages/cli/src/b.ts": {
				base: "export const b = 1;\n",
				head: "export const b = 2;\n",
			},
		} satisfies Versions;
		const classification = classify(files);
		assert.deepEqual(classification.meaningfulPaths, ["packages/cli/src/b.ts"]);
		const shadow = shadowLanes(Object.keys(files), classification);
		assert.deepEqual(shadow.unexplained, []);
	});

	it("stays fail-closed for an empty diff", () => {
		const classification = classifyImpact([], reader({}), tokenize);
		const shadow = shadowLanes([], classification);
		assert.equal(shadow.proposed.mode, "all");
	});

	it("CLI without --base reports every path meaningful", () => {
		const out = execFileSync(
			"node",
			[
				"--experimental-strip-types",
				"--no-warnings",
				"scripts/ci/impact-classifier.mts",
			],
			{
				encoding: "utf8",
				input: "packages/core/src/a.ts\n",
				stdio: ["pipe", "pipe", "ignore"],
			},
		);
		// SAFETY: the CLI's own output contract, asserted right below.
		const parsed = JSON.parse(out) as { meaningfulPaths: string[] };
		assert.deepEqual(parsed.meaningfulPaths, ["packages/core/src/a.ts"]);
	});
});
