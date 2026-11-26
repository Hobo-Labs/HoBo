/**
 * Regression guard: a package's tests may only reach workspace packages turbo
 * builds before the task that runs them.
 *
 * `@hobo/runtime`'s `test/authoring/actor.test.ts` imported
 * `../../../runtimes/runtime-local/dist/actor-host/in-memory.js`, and nothing
 * ordered `@hobo/runtime-local#build` before `@hobo/runtime#test`. So
 * `turbo run test --filter=@hobo/runtime` never built it, and the test failed on
 * any checkout where nothing else had. The fixtures below hold the checker to
 * turbo's own graph: which dependency fields it orders, which task an
 * override names, which files a task runs, and every way a test file names a
 * module. The last test holds the repository to zero.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
	checkTestWorkspaceDeps,
	scanTestWorkspaceDeps,
} from "../check-test-workspace-deps.mts";
import { importSpecifiersOf } from "../lib/test-import-specifiers.mts";
import { catalogValues } from "../lib/turbo-task-graph.mts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

function workspace(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-test-deps-"));
	for (const [path, text] of Object.entries(files)) {
		mkdirSync(dirname(join(dir, path)), { recursive: true });
		writeFileSync(join(dir, path), text);
	}
	return dir;
}

function within<T>(files: Record<string, string>, run: (dir: string) => T): T {
	const dir = workspace(files);
	try {
		return run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

interface ManifestFields {
	readonly scripts?: Record<string, string>;
	readonly dependencies?: Record<string, string>;
	readonly devDependencies?: Record<string, string>;
	readonly peerDependencies?: Record<string, string>;
}

const manifest = (name: string, fields: ManifestFields = {}) =>
	JSON.stringify({
		name,
		version: "0.0.0",
		scripts: { build: "tsc", test: "vitest run" },
		...fields,
	});

const turbo = (tasks: Record<string, { dependsOn?: string[] }> = {}) =>
	JSON.stringify({
		tasks: {
			build: { dependsOn: ["^build"] },
			test: { dependsOn: ["build"] },
			"test:contract:consumer": { dependsOn: ["^build"] },
			lint: {},
			...tasks,
		},
	});

const base = {
	"pnpm-workspace.yaml":
		'packages:\n  - "packages/*"\n  - "examples/*"\n  - "src/draft/technical-proofs/*"\n',
	"turbo.json": turbo(),
	"packages/lib/package.json": manifest("@s/lib"),
	"packages/lib/src/index.ts": "export const x = 1;\n",
};

/** git in `cwd`, unsigned, as a throwaway identity; its trimmed output. */
function git(cwd: string, ...args: string[]): string {
	return execFileSync(
		"git",
		[
			"-c",
			"commit.gpgsign=false",
			"-c",
			"user.name=t",
			"-c",
			"user.email=t@t",
			...args,
		],
		{ cwd, stdio: "pipe" },
	)
		.toString()
		.trim();
}

/** The check's CLI on `dir`, with `CI` unset unless given. */
function cli(dir: string, args: readonly string[], ci?: string) {
	const env = { ...process.env };
	delete env.CI;
	if (ci !== undefined) env.CI = ci;
	return spawnSync(
		process.execPath,
		[
			"--import",
			"tsx",
			join(root, "scripts/check-test-workspace-deps.mts"),
			"--root",
			dir,
			...args,
		],
		{ cwd: root, encoding: "utf8", env },
	);
}

const REGISTRY = "scripts/test-deps-runtime-reaches.json";

const found = (dir: string) =>
	checkTestWorkspaceDeps(dir).map(
		(item) => `${item.file} [${item.task}] -> ${item.imports}`,
	);

/** The report's unmodelled entries, as `<file>: <reason>`. */
const unmodelledIn = (dir: string) =>
	scanTestWorkspaceDeps(dir).unmodelled.map(
		(item) => `${item.file}: ${item.reason}`,
	);

/** The unmodelled entry for an undeclared runtime reach. */
const reaching = (file: string, names: string, text: string) =>
	`${file}: reaches ${names} at run time through a path it assembles ("${text}"), which this check cannot follow; declare what it needs in ${REGISTRY}`;

/** A workspace with `packages/runtimes/*`, `@s/rt` in it, and `@s/app` holding `files`. */
const grouped = (files: Record<string, string>) => ({
	...base,
	"pnpm-workspace.yaml": `${base["pnpm-workspace.yaml"]}  - "packages/runtimes/*"\n`,
	"packages/runtimes/rt/package.json": manifest("@s/rt"),
	"packages/app/package.json": manifest("@s/app"),
	...files,
});

const SPAWN = 'import { spawn } from "node:child_process";\n';
const JOIN = 'import { join } from "node:path";\n';

describe("importSpecifiersOf", () => {
	it("reads every literal way a file names a module", () => {
		const source = [
			'import { a } from "@s/static";',
			'import "@s/side-effect";',
			'export { b } from "@s/reexport";',
			'import c = require("@s/import-equals");',
			'const d = await import("@s/dynamic");',
			"const e = await import(`@s/no-substitution`);",
			'const f = require("@s/require");',
			'const g = require.resolve("@s/require-resolve");',
			'const h = createRequire(import.meta.url)("@s/create-require-call");',
			"const req = createRequire(import.meta.url);",
			'req("@s/bound-require");',
			'req.resolve("@s/bound-require-resolve");',
			'const i = import.meta.resolve("@s/meta-resolve");',
			'vi.mock("@s/vi-mock");',
			'const j = await vi.importActual("@s/vi-import-actual");',
		].join("\n");
		assert.deepEqual(
			importSpecifiersOf(source, "a.test.ts").map((item) => item.specifier),
			[
				"@s/static",
				"@s/side-effect",
				"@s/reexport",
				"@s/import-equals",
				"@s/dynamic",
				"@s/no-substitution",
				"@s/require",
				"@s/require-resolve",
				"@s/create-require-call",
				"@s/bound-require",
				"@s/bound-require-resolve",
				"@s/meta-resolve",
				"@s/vi-mock",
				"@s/vi-import-actual",
			],
		);
	});

	it("reads a require bound by a later assignment, and vitest's vi under another name", () => {
		const source = [
			"let req;",
			"req = createRequire(import.meta.url);",
			'req("@s/assigned-require");',
			'req.resolve("@s/assigned-require-resolve");',
			'import { vi as v } from "vitest";',
			'v.mock("@s/aliased-vi-mock");',
			'await v.importActual("@s/aliased-vi-import-actual");',
			'other.mock("@s/not-vi");',
			'notRequire("@s/not-require");',
		].join("\n");
		assert.deepEqual(
			importSpecifiersOf(source, "a.test.ts").map((item) => item.specifier),
			[
				"@s/assigned-require",
				"@s/assigned-require-resolve",
				"vitest",
				"@s/aliased-vi-mock",
				"@s/aliased-vi-import-actual",
			],
		);
	});

	it("reads nothing out of strings, comments or a test's source text, and nothing computed", () => {
		// runtime-local's link-table and capability-grant-gate tests hold a
		// Bindle's source as a string, `import { api, kv } from "@hobo/bindles"`
		// included; they never load @hobo/bindles.
		const source = [
			"throw new Error('run: import { x } from \"@s/quoted\"');",
			'// import { y } from "@s/line-comment";',
			'/* import { w } from "@s/block-comment"; */',
			"const sourceText = `",
			'  import { api, kv } from "@s/in-template";',
			'  ${`nested ${"x"}`}',
			"`;",
			"const name = 'computed';",
			"await import(`@s/${name}`);",
			'require("@s/" + name);',
		].join("\n");
		assert.deepEqual(importSpecifiersOf(source, "a.test.ts"), []);
	});

	it("is not misled by a regular expression that holds a backtick", () => {
		const source = [
			"const quotes = /[\"'`]/u;",
			'import { after } from "@s/after-regex";',
			"const fence = /```/u;",
			'const later = await import("@s/after-second-regex");',
		].join("\n");
		assert.deepEqual(
			importSpecifiersOf(source, "a.test.ts").map((item) => item.specifier),
			["@s/after-regex", "@s/after-second-regex"],
		);
	});

	it("marks the imports a compiler erases as type-only", () => {
		const source = [
			'import type { A } from "@s/import-type";',
			'import { type B } from "@s/inline-types";',
			'import { type C, d } from "@s/mixed";',
			'export type { E } from "@s/export-type";',
			'type F = typeof import("@s/import-type-node");',
		].join("\n");
		assert.deepEqual(
			importSpecifiersOf(source, "a.test.ts").map(
				(item) => `${item.specifier} ${item.typeOnly}`,
			),
			[
				"@s/import-type true",
				"@s/inline-types true",
				"@s/mixed false",
				"@s/export-type true",
				"@s/import-type-node true",
			],
		);
	});
});

describe("catalogValues", () => {
	it("reads a block catalog, and named catalogs a level deeper", () => {
		assert.deepEqual(
			catalogValues(
				"catalog:\n  left-pad: \"workspace:*\"\n  react: ^18.3.1\ncatalogs:\n  tools:\n    x: 'workspace:^' # named\n",
			),
			["workspace:*", "^18.3.1", "workspace:^"],
		);
		assert.deepEqual(catalogValues("catalog:\r\n  a: workspace:*\r\n"), [
			"workspace:*",
		]);
	});

	it("reads a flow catalog, on one line or several", () => {
		assert.deepEqual(
			catalogValues('catalog: { left-pad: "workspace:*", react: ^18.3.1 }\n'),
			["workspace:*", "^18.3.1"],
		);
		assert.deepEqual(
			catalogValues(
				'catalog: {\n  left-pad: "workspace:*",\n  react: ^18.3.1\n}\nonlyBuiltDependencies:\n  - esbuild\n',
			),
			["workspace:*", "^18.3.1"],
		);
	});

	it("reads named catalogs in flow form, whole or under a block key", () => {
		assert.deepEqual(
			catalogValues('catalogs: { tools: { left-pad: "workspace:*" } }\n'),
			["workspace:*"],
		);
		assert.deepEqual(
			catalogValues(
				"catalogs:\n  tools: { left-pad: workspace:* }\n  web: { react: ^18.3.1 }\n",
			),
			["workspace:*", "^18.3.1"],
		);
	});

	it("reads a quoted catalog or catalogs key", () => {
		assert.deepEqual(
			catalogValues(
				'"catalog":\n  left-pad: workspace:*\n\'catalogs\':\n  tools:\n    "@s/x": "workspace:^"\n',
			),
			["workspace:*", "workspace:^"],
		);
	});

	it("keeps a # inside quotes, and reads nothing under another key", () => {
		assert.deepEqual(
			catalogValues(
				'overrides:\n  "@s/lib": "workspace:*"\npackages:\n  - "packages/*"\ncatalog:\n  left-pad: "1.3.0 #not a comment" # a comment\n  x: npm:left-pad@1.3.0\n',
			),
			["1.3.0 #not a comment", "npm:left-pad@1.3.0"],
		);
	});

	it("stops on each YAML construct it does not read, naming it", () => {
		const hostile: [string, string, RegExp][] = [
			[
				"an anchor",
				"catalog: &c\n  left-pad: workspace:*\n",
				/an anchor \(&c\)/u,
			],
			[
				"an alias",
				"defs: &d\n  left-pad: workspace:*\ncatalog: *d\n",
				/an anchor \(&d\)/u,
			],
			["an alias alone", "catalog: *d\n", /an alias \(\*d\)/u],
			[
				"a merge key",
				"catalog:\n  <<: *d\n  x: workspace:*\n",
				/a merge key \(<<\)/u,
			],
			[
				"a folded block scalar",
				"catalog:\n  left-pad: >-\n    workspace:*\n",
				/a block scalar \(>-\)/u,
			],
			[
				"a literal block scalar",
				"catalog:\n  left-pad: |\n    workspace:*\n",
				/a block scalar \(\|\)/u,
			],
			[
				"a plain value on the next line",
				"catalog:\n  left-pad:\n    workspace:*\n",
				/a value on the line after its key \(workspace:\*\)/u,
			],
			[
				"a document in flow style",
				'{ catalog: { left-pad: "workspace:*" } }\n',
				/a document in flow style/u,
			],
			[
				"an explicit key",
				'? catalog\n: { left-pad: "workspace:*" }\n',
				/an explicit key \(\?\)/u,
			],
			[
				"a tag other than !!str",
				"catalog:\n  left-pad: !custom workspace:*\n",
				/a tag \(!custom\)/u,
			],
			["a directive", "%YAML 1.2\n---\ncatalog: {}\n", /a directive/u],
			[
				"a second document",
				"catalog: {}\n---\ncatalog:\n  x: workspace:*\n",
				/a second document/u,
			],
		];
		for (const [label, text, construct] of hostile)
			assert.throws(() => catalogValues(text), construct, label);
	});

	it("reads !!str, a double-quoted value over two lines, a leading ---, and this repository's file", () => {
		assert.deepEqual(
			catalogValues(
				'---\ncatalog:\n  a: !!str workspace:*\n  b: "workspace:\n    ^"\npackages:\n  - "packages/*"\n',
			),
			["workspace:*", "workspace: ^"],
		);
		assert.deepEqual(
			catalogValues(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8")),
			[],
		);
	});
});

describe("checkTestWorkspaceDeps", () => {
	it("fails on a pnpm-workspace.yaml it cannot read, naming the construct", () => {
		within(
			{
				...base,
				"pnpm-workspace.yaml": `${base["pnpm-workspace.yaml"]}defs: &d\n  left-pad: workspace:*\ncatalog: *d\n`,
			},
			(dir) =>
				assert.deepEqual(unmodelledIn(dir), [
					"pnpm-workspace.yaml: uses an anchor (&d), which this check does not read, so it cannot tell whether a catalog names a workspace package",
				]),
		);
	});

	it("refuses a test that reaches an undeclared sibling by name or by a relative path into its build output", () => {
		within(
			{
				...base,
				"packages/app/package.json": manifest("@s/app"),
				"packages/app/test/by-name.test.ts": 'import { x } from "@s/lib";\n',
				"packages/app/test/by-path.test.ts":
					'import { x } from "../../lib/dist/index.js";\n',
				"packages/app/src/own.test.ts": 'import { y } from "./own.js";\n',
			},
			(dir) =>
				assert.deepEqual(found(dir), [
					"packages/app/test/by-name.test.ts [test] -> @s/lib",
					"packages/app/test/by-path.test.ts [test] -> @s/lib",
				]),
		);
	});

	it("accepts a declared devDependency, and the build an override of the test task names", () => {
		within(
			{
				...base,
				"turbo.json": turbo({
					"@s/ordered#test": { dependsOn: ["build", "@s/lib#build"] },
				}),
				"packages/declared/package.json": manifest("@s/declared", {
					devDependencies: { "@s/lib": "workspace:*" },
				}),
				"packages/declared/test/a.test.ts": 'import { x } from "@s/lib";\n',
				"packages/ordered/package.json": manifest("@s/ordered"),
				"packages/ordered/test/a.test.ts":
					'import { x } from "../../lib/dist/index.js";\n',
			},
			(dir) => assert.deepEqual(found(dir), []),
		);
	});

	it("does not count a peerDependency: turbo orders no build for one", () => {
		within(
			{
				...base,
				"packages/app/package.json": manifest("@s/app", {
					peerDependencies: { "@s/lib": "workspace:*" },
				}),
				"packages/app/test/a.test.ts": 'import { x } from "@s/lib";\n',
			},
			(dir) =>
				assert.deepEqual(found(dir), [
					"packages/app/test/a.test.ts [test] -> @s/lib",
				]),
		);
	});

	it("counts a declaration only with a workspace: specifier, as pnpm 9 leaves link-workspace-packages off", () => {
		// turbo 2.11.10 on a scratch workspace: `"a": "1.0.0"`, `"^1.0.0"`, `"*"`
		// and `"link:../a"` schedule no a#build; `"workspace:*"`,
		// `"workspace:^1.0.0"`, `"workspace:a@*"` and `"workspace:../a"` do.
		const loads = 'import "../../lib/dist/index.js";\n';
		const declares = (
			name: string,
			devDependencies: Record<string, string>,
		) => ({
			[`packages/${name}/package.json`]: manifest(`@s/${name}`, {
				devDependencies,
			}),
			[`packages/${name}/test/a.test.ts`]: loads,
		});
		within(
			{
				...base,
				...declares("plain", { "@s/lib": "0.0.0" }),
				...declares("star", { "@s/lib": "*" }),
				...declares("ranged", { "@s/lib": "workspace:^0.0.0" }),
				...declares("aliased", { "lib-alias": "workspace:@s/lib@*" }),
				...declares("pathed", { anything: "workspace:../lib" }),
			},
			(dir) => {
				const violations = checkTestWorkspaceDeps(dir);
				assert.deepEqual(
					violations.map((item) => `${item.file} -> ${item.imports}`),
					[
						"packages/plain/test/a.test.ts -> @s/lib",
						"packages/star/test/a.test.ts -> @s/lib",
					],
				);
				assert.deepEqual(
					violations.map((item) => item.declared),
					[
						'"0.0.0", and turbo orders only a workspace: specifier: link-workspace-packages is off (the default from pnpm 9; neither pnpm-workspace.yaml nor .npmrc sets it)',
						'"*", and turbo orders only a workspace: specifier: link-workspace-packages is off (the default from pnpm 9; neither pnpm-workspace.yaml nor .npmrc sets it)',
					],
				);
			},
		);
	});

	it("counts a plain version where link-workspace-packages is on, pnpm-workspace.yaml over .npmrc", () => {
		const fixture = {
			...base,
			"packages/app/package.json": manifest("@s/app", {
				devDependencies: { "@s/lib": "0.0.0" },
			}),
			"packages/app/test/a.test.ts": 'import "../../lib/dist/index.js";\n',
			"packages/git/package.json": manifest("@s/git", {
				devDependencies: { "@s/lib": "github:s/lib" },
			}),
			"packages/git/test/a.test.ts": 'import "../../lib/dist/index.js";\n',
		};
		const yaml = `${base["pnpm-workspace.yaml"]}linkWorkspacePackages: `;
		const reported = (files: Record<string, string>) =>
			within({ ...fixture, ...files }, (dir) =>
				checkTestWorkspaceDeps(dir).map(
					(item) => `${item.imports} <- ${item.package}: ${item.declared}`,
				),
			);
		const git = (setting: string) =>
			`@s/lib <- @s/git: "github:s/lib", and turbo orders no github: specifier although link-workspace-packages is on (${setting})`;
		assert.deepEqual(reported({ ".npmrc": "link-workspace-packages=true\n" }), [
			git(".npmrc sets it"),
		]);
		assert.deepEqual(reported({ "pnpm-workspace.yaml": `${yaml}deep\n` }), [
			git("pnpm-workspace.yaml sets it"),
		]);
		assert.deepEqual(
			reported({
				".npmrc": "link-workspace-packages=true\n",
				"pnpm-workspace.yaml": `${yaml}false\n`,
			}),
			[
				'@s/lib <- @s/app: "0.0.0", and turbo orders only a workspace: specifier: link-workspace-packages is off (pnpm-workspace.yaml sets it)',
				'@s/lib <- @s/git: "github:s/lib", and turbo orders only a workspace: specifier: link-workspace-packages is off (pnpm-workspace.yaml sets it)',
			],
		);
		assert.deepEqual(
			reported({
				"package.json": JSON.stringify({ packageManager: "pnpm@8.15.0" }),
				"pnpm-workspace.yaml": `${yaml}false\n`,
			}),
			[git("the default before pnpm 9, which reads it from .npmrc only")],
		);
	});

	it("accepts a sibling the declared dependencies already build", () => {
		within(
			{
				...base,
				"packages/mid/package.json": manifest("@s/mid", {
					dependencies: { "@s/lib": "workspace:*" },
				}),
				"packages/app/package.json": manifest("@s/app", {
					devDependencies: { "@s/mid": "workspace:*" },
				}),
				"packages/app/test/a.test.ts":
					'import { x } from "../../lib/dist/index.js";\n',
			},
			(dir) => assert.deepEqual(found(dir), []),
		);
	});

	it("counts an override only for the task that runs the file", () => {
		within(
			{
				...base,
				"turbo.json": turbo({
					"@s/app#lint": { dependsOn: ["@s/lib#build"] },
					"@s/both#test": { dependsOn: ["build", "@s/lib#build"] },
				}),
				"packages/app/package.json": manifest("@s/app"),
				"packages/app/test/a.test.ts":
					'import { x } from "../../lib/dist/index.js";\n',
				"packages/both/package.json": manifest("@s/both", {
					scripts: {
						build: "tsc",
						test: "vitest run",
						"test:contract:consumer": "vitest run contracts/consumer",
					},
				}),
				// `vitest run` runs this file too, so it needs the build before both tasks.
				"packages/both/contracts/consumer/a.consumer.pact.test.ts":
					'import { x } from "../../../lib/dist/index.js";\n',
			},
			(dir) =>
				assert.deepEqual(found(dir), [
					"packages/app/test/a.test.ts [test] -> @s/lib",
					"packages/both/contracts/consumer/a.consumer.pact.test.ts [test:contract:consumer] -> @s/lib",
				]),
		);
	});

	it("appends the inherited dependsOn where a package's turbo.json names $TURBO_EXTENDS$, and replaces it where not", () => {
		// turbo 2.11.10 on a scratch workspace: with the root's `test` on
		// ["build", "c#build"], a package's `["$TURBO_EXTENDS$", "a#build"]`
		// schedules a, c and the package's own build, and `["a#build"]` only a.
		// The inherited list is the root's `<pkg>#test` where it has one.
		const extend = (dependsOn: string[]) =>
			JSON.stringify({ extends: ["//"], tasks: { test: { dependsOn } } });
		const app = (name: string) =>
			manifest(name, { devDependencies: { "@s/mid": "workspace:*" } });
		// mid's build is the package's own build's ^build; lib, x and y are named outright.
		const loads = [
			'import "../../mid/dist/index.js";',
			'import "../../lib/dist/index.js";',
			'import "../../x/dist/index.js";',
			'import "../../y/dist/index.js";',
		].join("\n");
		within(
			{
				...base,
				"turbo.json": turbo({
					test: { dependsOn: ["build", "@s/x#build"] },
					"@s/over#test": { dependsOn: ["build", "@s/y#build"] },
				}),
				"packages/mid/package.json": manifest("@s/mid"),
				"packages/x/package.json": manifest("@s/x"),
				"packages/y/package.json": manifest("@s/y"),
				"packages/extends/package.json": app("@s/extends"),
				"packages/extends/turbo.json": extend([
					"$TURBO_EXTENDS$",
					"@s/lib#build",
					"@s/y#build",
				]),
				"packages/extends/test/a.test.ts": loads,
				"packages/over/package.json": app("@s/over"),
				"packages/over/turbo.json": extend([
					"@s/lib#build",
					"@s/x#build",
					"$TURBO_EXTENDS$",
				]),
				"packages/over/test/a.test.ts": loads,
				"packages/replaces/package.json": app("@s/replaces"),
				"packages/replaces/turbo.json": extend([
					"@s/lib#build",
					"@s/x#build",
					"@s/y#build",
				]),
				"packages/replaces/test/a.test.ts": loads,
			},
			(dir) =>
				assert.deepEqual(found(dir), [
					"packages/replaces/test/a.test.ts [test] -> @s/mid",
				]),
		);
	});

	it("reads fixture helpers, __tests__ helpers and vitest configs", () => {
		within(
			{
				...base,
				"packages/app/package.json": manifest("@s/app"),
				"packages/app/test/fixtures/helper.ts":
					'export { x } from "../../../lib/dist/index.js";\n',
				"packages/app/src/__tests__/setup.ts": 'import "@s/lib";\n',
				"packages/app/vitest.config.ts":
					'import { x } from "../lib/dist/index.js";\nexport default {};\n',
			},
			(dir) =>
				assert.deepEqual(found(dir), [
					"packages/app/src/__tests__/setup.ts [test] -> @s/lib",
					"packages/app/test/fixtures/helper.ts [test] -> @s/lib",
					"packages/app/vitest.config.ts [test] -> @s/lib",
				]),
		);
	});

	it("checks a helper under every task of the test files that import it", () => {
		within(
			{
				...base,
				"turbo.json": turbo({
					"@s/app#test": { dependsOn: ["build", "@s/lib#build"] },
				}),
				"packages/app/package.json": manifest("@s/app", {
					scripts: {
						build: "tsc",
						test: "vitest run",
						"test:contract:consumer": "vitest run contracts/consumer",
					},
				}),
				// The contract test reaches lib through two test/ helpers.
				"packages/app/contracts/consumer/a.consumer.test.ts":
					'import { x } from "../../test/helpers/outer.js";\n',
				"packages/app/test/helpers/outer.ts": 'export * from "./inner";\n',
				"packages/app/test/helpers/inner.ts":
					'export { x } from "../../../lib/dist/index.js";\n',
				// No contract test imports this one, so it runs under test only.
				"packages/app/test/unit-helper.ts":
					'export { x } from "../../lib/dist/index.js";\n',
			},
			(dir) =>
				assert.deepEqual(found(dir), [
					"packages/app/test/helpers/inner.ts [test:contract:consumer] -> @s/lib",
				]),
		);
	});

	it("counts a type-only import only where the package's tsconfig compiles the test", () => {
		const types = 'import type { X } from "../../lib/dist/index.js";\n';
		within(
			{
				...base,
				"packages/erased/package.json": manifest("@s/erased"),
				"packages/erased/tsconfig.json": JSON.stringify({ include: ["src"] }),
				"packages/erased/test/a.test.ts": types,
				"packages/compiled/package.json": manifest("@s/compiled"),
				"packages/compiled/tsconfig.json": JSON.stringify({
					include: ["src", "test"],
				}),
				"packages/compiled/test/a.test.ts": types,
			},
			(dir) =>
				assert.deepEqual(found(dir), [
					"packages/compiled/test/a.test.ts [test] -> @s/lib",
				]),
		);
	});

	it("covers examples and draft proofs, and only packages turbo runs the task for", () => {
		const reaches = 'import { x } from "@s/lib";\n';
		within(
			{
				...base,
				"examples/demo/package.json": manifest("@s/demo"),
				"examples/demo/test/a.test.ts": reaches,
				"src/draft/technical-proofs/p/package.json": manifest("@s/p"),
				"src/draft/technical-proofs/p/test/a.test.ts": reaches,
				"packages/untested/package.json": JSON.stringify({
					name: "@s/untested",
					scripts: { build: "tsc" },
				}),
				"packages/untested/test/a.test.ts": reaches,
			},
			(dir) =>
				assert.deepEqual(found(dir), [
					"examples/demo/test/a.test.ts [test] -> @s/lib",
					"src/draft/technical-proofs/p/test/a.test.ts [test] -> @s/lib",
				]),
		);
	});

	it("reads a git repository's tracked files, not whatever is in the tree", () => {
		within(
			{
				...base,
				"packages/app/package.json": manifest("@s/app"),
				"packages/app/test/tracked.test.ts": 'import { x } from "@s/lib";\n',
			},
			(dir) => {
				execFileSync("git", ["init", "-q"], { cwd: dir });
				execFileSync("git", ["add", "."], { cwd: dir });
				writeFileSync(
					join(dir, "packages/app/test/untracked.test.ts"),
					'import { x } from "@s/lib";\n',
				);
				assert.deepEqual(found(dir), [
					"packages/app/test/tracked.test.ts [test] -> @s/lib",
				]);
			},
		);
	});

	it("follows a test's imports into the package's other files, transitively", () => {
		within(
			{
				...base,
				"packages/app/package.json": manifest("@s/app"),
				"packages/app/test/a.test.ts": 'import "../src/util.js";\n',
				"packages/app/src/util.ts": 'export * from "./deeper";\n',
				"packages/app/src/deeper.ts":
					'export { x } from "../../lib/dist/index.js";\n',
				"packages/app/test/b.test.ts": 'import "../services/svc.js";\n',
				"packages/app/services/svc.ts": 'import "../../lib/dist/index.js";\n',
				// No test imports this one.
				"packages/app/src/unused.ts": 'import "../../lib/dist/index.js";\n',
			},
			(dir) =>
				assert.deepEqual(found(dir), [
					"packages/app/services/svc.ts [test] -> @s/lib",
					"packages/app/src/deeper.ts [test] -> @s/lib",
				]),
		);
	});

	it("classifies a relative reach into a sibling's source by what that source loads", () => {
		// The sibling's source runs as written, so its own build is not needed:
		// what it loads is. The draft proof foundations-build-conformance-harness
		// reaches hobo-monorepo-skeleton-contract's src this way.
		within(
			{
				...base,
				"packages/dep/package.json": manifest("@s/dep"),
				"packages/sib/package.json": manifest("@s/sib", {
					dependencies: { "@s/dep": "workspace:*" },
				}),
				"packages/sib/tsconfig.json": JSON.stringify({ include: ["src"] }),
				"packages/sib/src/plain.ts": 'export * from "./more.js";\n',
				"packages/sib/src/more.ts": "export const p = 1;\n",
				"packages/sib/src/needs-dep.ts": 'export * from "@s/dep";\n',
				// Erased when app's test loads it, whatever sib's tsconfig compiles.
				"packages/sib/src/types.ts":
					'import type { D } from "@s/dep";\nexport type E = D;\n',
				"packages/app/package.json": manifest("@s/app"),
				"packages/app/test/source.test.ts":
					'import "../../sib/src/plain.js";\nimport "../../sib/src/types.js";\n',
				"packages/app/test/dep.test.ts":
					'import "../../sib/src/needs-dep.js";\n',
				"packages/app/test/built.test.ts":
					'import "../../sib/dist/plain.js";\n',
			},
			(dir) =>
				assert.deepEqual(
					checkTestWorkspaceDeps(dir).map(
						(item) =>
							`${item.file} [${item.package}#${item.task}] -> ${item.imports}`,
					),
					[
						"packages/app/test/built.test.ts [@s/app#test] -> @s/sib",
						"packages/sib/src/needs-dep.ts [@s/app#test] -> @s/dep",
					],
				),
		);
	});

	it("refuses a catalog: specifier it cannot resolve, naming the manifest", () => {
		const fixture = (yaml: string) => ({
			...base,
			"pnpm-workspace.yaml": `${base["pnpm-workspace.yaml"]}${yaml}`,
			"packages/app/package.json": manifest("@s/app", {
				devDependencies: { "@s/lib": "catalog:", "left-pad": "catalog:" },
			}),
		});
		const unmodelled = (yaml: string) =>
			within(fixture(yaml), (dir) =>
				scanTestWorkspaceDeps(dir).unmodelled.map(
					(item) => `${item.file}: ${item.reason}`,
				),
			);
		const lib =
			'packages/app/package.json: "@s/lib": "catalog:", a catalog this check does not resolve; turbo may order the build it names';
		// left-pad names no workspace package, so its catalog entry orders nothing,
		// unless the catalog itself names a workspace package.
		assert.deepEqual(unmodelled("catalog:\n  left-pad: 1.3.0\n"), [lib]);
		assert.deepEqual(unmodelled('catalog:\n  left-pad: "workspace:*"\n'), [
			lib,
			'packages/app/package.json: "left-pad": "catalog:", a catalog this check does not resolve; turbo may order the build it names',
		]);
	});

	it("refuses a version range on a workspace sibling where link-workspace-packages is on", () => {
		within(
			{
				...base,
				".npmrc": "link-workspace-packages=true\n",
				"packages/lib/package.json": JSON.stringify({
					name: "@s/lib",
					version: "1.2.3",
					scripts: { build: "tsc" },
				}),
				"packages/exact/package.json": manifest("@s/exact", {
					devDependencies: { "@s/lib": "1.2.3" },
				}),
				"packages/exact/test/a.test.ts": 'import "@s/lib";\n',
				"packages/other/package.json": manifest("@s/other", {
					devDependencies: { "@s/lib": "1.2.4" },
				}),
				"packages/other/test/a.test.ts": 'import "@s/lib";\n',
				"packages/ranged/package.json": manifest("@s/ranged", {
					devDependencies: { "@s/lib": "^1.2.0" },
				}),
				"packages/tagged/package.json": manifest("@s/tagged", {
					devDependencies: { "@s/lib": "npm:latest" },
				}),
			},
			(dir) => {
				const report = scanTestWorkspaceDeps(dir);
				// turbo orders "1.2.3" against 1.2.3 and not "1.2.4"; a range or a tag
				// it decides with a semver parser this check does not have.
				assert.deepEqual(
					report.violations.map((item) => `${item.package}: ${item.declared}`),
					[
						'@s/other: "1.2.4", and turbo orders no version other than the workspace package\'s 1.2.3',
					],
				);
				assert.deepEqual(
					report.unmodelled.map((item) => `${item.file}: ${item.reason}`),
					[
						'packages/ranged/package.json: "@s/lib": "^1.2.0", a range or tag this check does not compare with the workspace package\'s 1.2.3 (link-workspace-packages is on: .npmrc sets it)',
						'packages/tagged/package.json: "@s/lib": "npm:latest", a range or tag this check does not compare with the workspace package\'s 1.2.3 (link-workspace-packages is on: .npmrc sets it)',
					],
				);
			},
		);
	});

	it("refuses a submodule inside a submodule, naming its path", () => {
		within(
			{
				...base,
				"packages/app/package.json": manifest("@s/app"),
				"external/sub/README.md": "sub\n",
			},
			(dir) => {
				const git = (cwd: string, ...args: string[]) =>
					execFileSync(
						"git",
						[
							"-c",
							"commit.gpgsign=false",
							"-c",
							"user.name=t",
							"-c",
							"user.email=t@t",
							...args,
						],
						{ cwd, stdio: "pipe" },
					)
						.toString()
						.trim();
				const sub = join(dir, "external/sub");
				git(sub, "init", "-q");
				git(sub, "add", ".");
				git(sub, "commit", "-qm", "sub");
				const subHead = git(sub, "rev-parse", "HEAD");
				// A gitlink inside the submodule: a submodule of the submodule.
				git(
					sub,
					"update-index",
					"--add",
					"--cacheinfo",
					`160000,${subHead},vendor/nested`,
				);
				git(sub, "commit", "-qm", "nested");
				git(dir, "init", "-q");
				git(dir, "add", "pnpm-workspace.yaml", "turbo.json", "packages");
				git(
					dir,
					"update-index",
					"--add",
					"--cacheinfo",
					`160000,${git(sub, "rev-parse", "HEAD")},external/sub`,
				);
				assert.deepEqual(
					scanTestWorkspaceDeps(dir).unmodelled.map(
						(item) => `${item.file}: ${item.reason}`,
					),
					[
						"external/sub/vendor/nested: a submodule inside the submodule external/sub, which this check does not model",
					],
				);
			},
		);
	});

	it("resolves a .js specifier to a .tsx source, and .jsx to .tsx, as vite and TypeScript do", () => {
		within(
			{
				...base,
				"packages/app/package.json": manifest("@s/app"),
				"packages/app/test/a.test.ts":
					'import "../src/view.js";\nimport "../src/widget.jsx";\n',
				"packages/app/src/view.tsx":
					'export { x } from "../../lib/dist/index.js";\n',
				"packages/app/src/widget.tsx":
					'export { x } from "../../lib/dist/widget.js";\n',
			},
			(dir) =>
				assert.deepEqual(found(dir), [
					"packages/app/src/view.tsx [test] -> @s/lib",
					"packages/app/src/widget.tsx [test] -> @s/lib",
				]),
		);
	});

	it("refuses a path to a workspace package's dist/, or into its directory for a computed load, that no declaration covers", () => {
		within(
			{
				...base,
				"packages/app/package.json": manifest("@s/app"),
				"packages/app/test/a.test.ts": [
					'import "../src/run.js";',
					'import "../src/link.js";',
					'import "../src/quiet.js";',
					"",
				].join("\n"),
				// Spawns lib's built CLI by a path it assembles.
				"packages/app/src/run.ts": [
					'import { spawn } from "node:child_process";',
					'import { join } from "node:path";',
					"export const run = (root: string) =>",
					'\tspawn(process.execPath, [join(root, "packages", "lib", "dist", "cli.js")]);',
					"",
				].join("\n"),
				// Links lib's directory into a generated app, which then loads it.
				"packages/app/src/link.ts": [
					'import { symlinkSync } from "node:fs";',
					'import { join } from "node:path";',
					"export const link = (root: string, to: string) =>",
					'\tsymlinkSync(join(root, "packages", "lib"), to, "dir");',
					"",
				].join("\n"),
				// Names lib's directory, its own dist/, and loads nothing by a computed path.
				"packages/app/src/quiet.ts": [
					'export const docs = "see packages/lib for the API";',
					'export const own = "packages/app/dist/index.js";',
					"",
				].join("\n"),
			},
			(dir) => {
				const report = scanTestWorkspaceDeps(dir);
				assert.deepEqual(report.violations, []);
				assert.deepEqual(
					report.unmodelled.map((item) => `${item.file}: ${item.reason}`),
					[
						`packages/app/src/link.ts: reaches @s/lib at run time through a path it assembles ("*/packages/lib"), which this check cannot follow; declare what it needs in ${REGISTRY}`,
						`packages/app/src/run.ts: reaches @s/lib at run time through a path it assembles ("*/packages/lib/dist/cli.js"), which this check cannot follow; declare what it needs in ${REGISTRY}`,
					],
				);
			},
		);
	});

	it("names a grouped package after `..` or a computed root by its directory's trailing segments", () => {
		within(
			grouped({
				"packages/app/test/url.test.ts": `${SPAWN}spawn(process.execPath, [new URL("../../runtimes/rt/dist/x.js", import.meta.url).pathname]);\n`,
				"packages/app/test/join.test.ts": `${SPAWN}${JOIN}const packagesDir = join(process.cwd(), "packages");\nspawn(process.execPath, [join(packagesDir, "runtimes", "rt", "dist", "x.js")]);\n`,
				// Its directory's last segment alone still names it.
				"packages/app/test/last.test.ts": `${SPAWN}${JOIN}spawn(process.execPath, [join(process.cwd(), "rt", "dist", "x.js")]);\n`,
				// A segment between the anchor and the package is not part of its directory.
				"packages/app/test/other.test.ts": `${SPAWN}spawn(process.execPath, ["../../vendor/runtimes/rt/dist/x.js"]);\n`,
			}),
			(dir) =>
				assert.deepEqual(unmodelledIn(dir), [
					reaching(
						"packages/app/test/join.test.ts",
						"@s/rt",
						"*/runtimes/rt/dist/x.js",
					),
					reaching("packages/app/test/last.test.ts", "@s/rt", "*/rt/dist/x.js"),
					reaching(
						"packages/app/test/url.test.ts",
						"@s/rt",
						"../../runtimes/rt/dist/x.js",
					),
				]),
		);
	});

	it("counts a path that ends at another package's directory after `..` or a computed root, where the file links or loads by a computed path", () => {
		const symlink = 'import { symlinkSync } from "node:fs";\n';
		within(
			grouped({
				"packages/app/test/link.test.ts": `${symlink}import { fileURLToPath } from "node:url";\nsymlinkSync(fileURLToPath(new URL("../../lib", import.meta.url)), "/tmp/x/lib", "dir");\n`,
				"packages/app/test/grouped.test.ts": `${symlink}${JOIN}symlinkSync(join(process.cwd(), "..", "runtimes", "rt"), "/tmp/x/rt", "dir");\n`,
				// A bare segment that happens to be a package's directory name is
				// not a path to it, nor is one segment after a computed root.
				"packages/app/test/bare.test.ts": `${symlink}${JOIN}symlinkSync("lib", "/tmp/x/lib", "dir");\nsymlinkSync(join(process.cwd(), "lib"), "/tmp/x/lib", "dir");\n`,
				// Nothing here links or loads, so naming the directory reaches nothing.
				"packages/app/test/quiet.test.ts":
					'export const lib = new URL("../../lib", import.meta.url);\n',
			}),
			(dir) =>
				assert.deepEqual(unmodelledIn(dir), [
					reaching(
						"packages/app/test/grouped.test.ts",
						"@s/rt",
						"*/../runtimes/rt",
					),
					reaching("packages/app/test/link.test.ts", "@s/lib", "../../lib"),
				]),
		);
	});

	it("fails closed on a path that names a package by a computed segment after a packages directory or a scope", () => {
		const symlink =
			'import { symlinkSync } from "node:fs";\nimport { fileURLToPath } from "node:url";\n';
		const computed = "a package it names by a computed segment";
		within(
			grouped({
				"packages/app/test/join.test.ts": `${SPAWN}${JOIN}const name = "lib";\nspawn(process.execPath, [join(process.cwd(), "packages", name, "dist", "bin.js")]);\n`,
				"packages/app/test/template.test.ts": `${SPAWN}${JOIN}const name = "lib";\nspawn(process.execPath, [join(process.cwd(), \`packages/\${name}/dist/bin.js\`)]);\n`,
				"packages/app/test/group.test.ts": `${SPAWN}${JOIN}const name = "rt";\nspawn(process.execPath, [join(process.cwd(), "..", "runtimes", name, "dist", "x.js")]);\n`,
				// The scope a workspace package's name is under is a group of packages.
				"packages/app/test/scope.test.ts": `${symlink}${JOIN}export const link = (from: string, name: string) => symlinkSync(from, join("/tmp/x", \`node_modules/@s/\${name}\`), "dir");\n`,
				// Relative to the file, ../../ is packages/.
				"packages/app/test/climb.test.ts": `${symlink}for (const name of ["lib"]) symlinkSync(fileURLToPath(new URL(\`../../\${name}\`, import.meta.url)), "/tmp/x", "dir");\n`,
				// A named package followed by a computed segment may be its dist/.
				"packages/app/test/sub.test.ts": `${SPAWN}${JOIN}export const run = (file: string) => spawn(process.execPath, [join(process.cwd(), "packages", "lib", file)]);\n`,
				// A computed package's tracked file needs no build.
				"packages/app/test/manifest.test.ts": `${SPAWN}${JOIN}spawn("true");\nexport const manifest = (name: string) => join(process.cwd(), "packages", name, "package.json");\n`,
				// A glob's literal * is not a computed segment, nor a computed root.
				"packages/app/test/glob.test.ts": `${SPAWN}spawn("true");\nexport const globs = ["packages/*/dist/**", "*/lib/dist/x.js"];\n`,
				// Nothing here links or loads, so a directory it computes reaches nothing.
				"packages/app/test/quiet.test.ts": `${JOIN}export const dir = (name: string) => join(process.cwd(), "packages", name);\n`,
			}),
			(dir) =>
				assert.deepEqual(unmodelledIn(dir), [
					reaching("packages/app/test/climb.test.ts", computed, "../../*"),
					reaching(
						"packages/app/test/group.test.ts",
						computed,
						"*/../runtimes/*/dist/x.js",
					),
					reaching(
						"packages/app/test/join.test.ts",
						computed,
						"*/packages/*/dist/bin.js",
					),
					reaching(
						"packages/app/test/scope.test.ts",
						computed,
						"/tmp/x/node_modules/@s/*",
					),
					reaching(
						"packages/app/test/sub.test.ts",
						"@s/lib",
						"*/packages/lib/*",
					),
					reaching(
						"packages/app/test/template.test.ts",
						computed,
						"*/packages/*/dist/bin.js",
					),
				]),
		);
	});

	it("knows a child process or a copy by a method, an alias, promisify, cpSync and fs.promises.cp", () => {
		// A sibling's directory, which counts only in a file that runs or loads.
		const lib = `${JOIN}const libDir = join(process.cwd(), "packages", "lib");\n`;
		const ns = 'import * as cp from "node:child_process";\n';
		const files = {
			"a-method": `${ns}${lib}cp.exec(\`ls \${libDir}\`);\n`,
			"b-alias": `${ns}${lib}const run = cp.exec;\nrun(\`ls \${libDir}\`);\n`,
			"c-named": `import { exec as run } from "node:child_process";\n${lib}run(\`ls \${libDir}\`);\n`,
			"d-dynamic": `${lib}const proc = await import("node:child_process");\nproc.exec(\`ls \${libDir}\`);\n`,
			"e-destructured": `${ns}${lib}const { exec: run } = cp;\nrun(\`ls \${libDir}\`);\n`,
			"f-promisify": `import { exec } from "node:child_process";\nimport { promisify } from "node:util";\n${lib}const execAsync = promisify(exec);\nawait execAsync(\`ls \${libDir}\`);\n`,
			"g-promisify-file": `${ns}import * as util from "node:util";\n${lib}export const sh = util.promisify(cp.execFile);\n`,
			"h-cp-sync": `import { cpSync } from "node:fs";\n${lib}cpSync(libDir, "/tmp/x", { recursive: true });\n`,
			"i-fs-promises": `import * as fs from "node:fs";\n${lib}await fs.promises.cp(libDir, "/tmp/x", { recursive: true });\n`,
			"j-fsp": `import { cp } from "node:fs/promises";\n${lib}await cp(libDir, "/tmp/x", { recursive: true });\n`,
			// RegExp's exec runs nothing.
			"k-regexp": `${lib}export const match = /lib/u.exec(libDir);\nconst re = /x/u;\nre.exec(libDir);\n`,
			// A package name, or a scope and a computed name, at a string's start
			// is a module name, not a path, though the file copies.
			"l-names": `import { cpSync } from "node:fs";\ncpSync("/a", "/b", { recursive: true });\nexport const pkg = (app: string) => ({ name: \`@s/app-\${app}\`, dependencies: { "@s/lib": "workspace:*" } });\n`,
		};
		within(
			grouped(
				Object.fromEntries(
					Object.entries(files).map(([name, text]) => [
						`packages/app/test/${name}.test.ts`,
						text,
					]),
				),
			),
			(dir) =>
				assert.deepEqual(
					unmodelledIn(dir),
					Object.keys(files)
						.filter((name) => name !== "k-regexp" && name !== "l-names")
						.map((name) =>
							reaching(
								`packages/app/test/${name}.test.ts`,
								"@s/lib",
								"*/packages/lib",
							),
						),
				),
		);
	});

	it("reads an absolute path, a concatenation and a spread of segments", () => {
		const run = (path: string) =>
			`${SPAWN}${JOIN}const root = process.cwd();\nconst name = "lib";\nspawn(process.execPath, [${path}]);\n`;
		const files = {
			"a-absolute": run('"/repo/packages/lib/dist/bin.js"'),
			"b-concat": run('root + "/packages/" + "lib" + "/dist/bin.js"'),
			"c-concat-computed": run('"packages/" + name + "/dist/x.js"'),
			"d-spread": `${SPAWN}${JOIN}const segs = ["packages", "lib", "dist", "bin.js"];\nspawn(process.execPath, [join(process.cwd(), ...segs)]);\n`,
			"e-spread-computed": `${SPAWN}${JOIN}export const run = (rest: string[]) => spawn(process.execPath, [join(process.cwd(), "packages", ...rest)]);\n`,
			"f-file-url": run(
				'new URL("file:///repo/packages/lib/dist/x.js").pathname',
			),
			// Anywhere in an absolute path only a package's whole directory names
			// it: a stub tree under a temporary root is not lib.
			"g-stub": run('"/tmp/stub/lib/dist/bin.js"'),
		};
		const computed = "a package it names by a computed segment";
		within(
			grouped(
				Object.fromEntries(
					Object.entries(files).map(([name, text]) => [
						`packages/app/test/${name}.test.ts`,
						text,
					]),
				),
			),
			(dir) =>
				assert.deepEqual(unmodelledIn(dir), [
					reaching(
						"packages/app/test/a-absolute.test.ts",
						"@s/lib",
						"/repo/packages/lib/dist/bin.js",
					),
					reaching(
						"packages/app/test/b-concat.test.ts",
						"@s/lib",
						"*/packages/lib/dist/bin.js",
					),
					reaching(
						"packages/app/test/c-concat-computed.test.ts",
						computed,
						"packages/*/dist/x.js",
					),
					reaching(
						"packages/app/test/d-spread.test.ts",
						"@s/lib",
						"*/packages/lib/dist/bin.js",
					),
					reaching(
						"packages/app/test/e-spread-computed.test.ts",
						computed,
						"*/packages/*",
					),
					reaching(
						"packages/app/test/f-file-url.test.ts",
						"@s/lib",
						"file:///repo/packages/lib/dist/x.js",
					),
				]),
		);
	});

	it("reads a package's build output directory from the tsconfig its build compiles with, else dist", () => {
		const reach = (path: string) =>
			`${SPAWN}${JOIN}spawn(process.execPath, [join(process.cwd(), ${path})]);\n`;
		within(
			grouped({
				// web compiles to build/, so its build/ is a reach and its dist/ is not.
				"packages/web/package.json": manifest("@s/web"),
				"packages/web/tsconfig.json": JSON.stringify({
					compilerOptions: { outDir: "build" },
				}),
				// wk's build names a project, which extends a base that sets outDir.
				"packages/wk/package.json": manifest("@s/wk", {
					scripts: { build: "tsc -p tsconfig.build.json", test: "vitest run" },
				}),
				"packages/wk/tsconfig.base.json": JSON.stringify({
					compilerOptions: { outDir: "out/esm" },
				}),
				"packages/wk/tsconfig.build.json": JSON.stringify({
					extends: "./tsconfig.base.json",
				}),
				"packages/wk/tsconfig.json": JSON.stringify({
					compilerOptions: { outDir: "dist" },
				}),
				"packages/app/test/a-build.test.ts": reach(
					'"packages", "web", "build", "x.js"',
				),
				"packages/app/test/b-dist.test.ts": reach(
					'"packages", "web", "dist", "x.js"',
				),
				"packages/app/test/c-project.test.ts": reach(
					'"packages", "wk", "out", "esm", "x.js"',
				),
				"packages/app/test/d-default.test.ts": reach(
					'"packages", "lib", "dist", "x.js"',
				),
			}),
			(dir) =>
				assert.deepEqual(unmodelledIn(dir), [
					reaching(
						"packages/app/test/a-build.test.ts",
						"@s/web",
						"*/packages/web/build/x.js",
					),
					reaching(
						"packages/app/test/c-project.test.ts",
						"@s/wk",
						"*/packages/wk/out/esm/x.js",
					),
					reaching(
						"packages/app/test/d-default.test.ts",
						"@s/lib",
						"*/packages/lib/dist/x.js",
					),
				]),
		);
	});

	it("checks a declared runtime reach: each need must be ordered for every test task that loads it", () => {
		const run = [
			'import { spawn } from "node:child_process";',
			'import { join } from "node:path";',
			"export const run = (root: string) =>",
			'\tspawn(process.execPath, [join(root, "packages", "lib", "dist", "cli.js")]);',
			"",
		].join("\n");
		within(
			{
				...base,
				"turbo.json": turbo({
					"@s/ordered#test": { dependsOn: ["build", "@s/lib#build"] },
				}),
				[REGISTRY]: JSON.stringify({
					reaches: [
						{
							from: "packages/ordered/src/run.ts",
							needs: ["@s/lib#build"],
							why: "spawns lib's CLI",
						},
						{
							from: "packages/unordered/src/run.ts",
							needs: ["@s/lib#build"],
							why: "spawns lib's CLI",
						},
					],
				}),
				"packages/ordered/package.json": manifest("@s/ordered"),
				"packages/ordered/test/a.test.ts": 'import "../src/run.js";\n',
				"packages/ordered/src/run.ts": run,
				"packages/unordered/package.json": manifest("@s/unordered"),
				"packages/unordered/test/a.test.ts": 'import "../src/run.js";\n',
				"packages/unordered/src/run.ts": run,
			},
			(dir) => {
				const report = scanTestWorkspaceDeps(dir);
				assert.deepEqual(
					report.violations.map(
						(item) =>
							`${item.file} [${item.package}#${item.task}] -> ${item.imports} (${item.specifier})`,
					),
					[
						`packages/unordered/src/run.ts [@s/unordered#test] -> @s/lib (declared in ${REGISTRY})`,
					],
				);
				assert.deepEqual(report.unmodelled, []);
				assert.deepEqual(report.stale, []);
			},
		);
	});

	it("refuses a declaration that names no build of another package, and exits non-zero on it", () => {
		const declared = (needs: string[]) => ({
			...base,
			[REGISTRY]: JSON.stringify({
				reaches: [
					{ from: "packages/app/src/run.ts", needs, why: "spawns lib" },
				],
			}),
			"packages/app/package.json": manifest("@s/app"),
			"packages/app/test/a.test.ts": 'import "../src/run.js";\n',
			"packages/app/src/run.ts": `${SPAWN}${JOIN}spawn(process.execPath, [join(process.cwd(), "packages", "lib", "dist", "cli.js")]);\n`,
		});
		const empty = `${REGISTRY}: "packages/app/src/run.ts" names no build of another package it needs; name one as "<package>#build", or remove the entry`;
		const staleIn = (needs: string[]) =>
			within(declared(needs), (dir) =>
				scanTestWorkspaceDeps(dir).stale.map(
					(item) => `${item.file}: ${item.reason}`,
				),
			);
		// An empty list, or one naming only the file's own package, silences
		// the reach it declares.
		const uncovered = `${REGISTRY}: "packages/app/src/run.ts" reaches @s/lib ("*/packages/lib/dist/cli.js"), and its entry does not name "@s/lib#build"`;
		assert.deepEqual(staleIn([]), [empty, uncovered]);
		assert.deepEqual(staleIn(["@s/app#build"]), [empty, uncovered]);
		assert.deepEqual(staleIn(["@s/app#build", "@s/lib#build"]), []);
		within(declared([]), (dir) => {
			const run = cli(dir, []);
			assert.equal(run.status, 1);
			assert.match(run.stderr, /names no build of another package/u);
		});
	});

	it("refuses a declaration whose needs leave out a package the reader sees it reach", () => {
		// run.ts reaches hobo's dist/ and its own package's; app's test orders
		// lib and hobo, so only what the entry names can fail it.
		const declared = (needs: string[]) => ({
			...base,
			"turbo.json": turbo({
				"@s/app#test": {
					dependsOn: ["build", "@s/lib#build", "@s/hobo#build"],
				},
			}),
			[REGISTRY]: JSON.stringify({
				reaches: [
					{ from: "packages/app/src/run.ts", needs, why: "spawns hobo" },
				],
			}),
			"packages/hobo/package.json": manifest("@s/hobo"),
			"packages/app/package.json": manifest("@s/app"),
			"packages/app/test/a.test.ts": 'import "../src/run.js";\n',
			"packages/app/src/run.ts": `${SPAWN}${JOIN}spawn(process.execPath, [join(process.cwd(), "packages", "hobo", "dist", "bin.js")]);\nexport const own = new URL("../dist/x.js", import.meta.url);\n`,
		});
		const problems = (needs: string[]) =>
			within(declared(needs), (dir) => {
				const report = scanTestWorkspaceDeps(dir);
				return [
					...report.violations.map((item) => `violation ${item.imports}`),
					...report.stale.map((item) => `${item.file}: ${item.reason}`),
				];
			});
		// The review's R2: a need is named, but not the package reached.
		assert.deepEqual(problems(["@s/lib#build"]), [
			`${REGISTRY}: "packages/app/src/run.ts" reaches @s/hobo ("*/packages/hobo/dist/bin.js"), and its entry does not name "@s/hobo#build"`,
		]);
		assert.deepEqual(problems(["@s/hobo#build"]), []);
		// A need with no reach the reader can see stays allowed.
		assert.deepEqual(problems(["@s/hobo#build", "@s/lib#build"]), []);
		within(declared(["@s/lib#build"]), (dir) => {
			const run = cli(dir, []);
			assert.equal(run.status, 1);
			assert.match(run.stderr, /does not name "@s\/hobo#build"/u);
		});
	});

	it("reads a path that climbs out of its temporary root, or a temporary directory made outside one, as a real reach", () => {
		// The review's fixtures: each hides a real reach of hobo behind a stub.
		const head =
			'import { spawn } from "node:child_process";\nimport { mkdtempSync, symlinkSync } from "node:fs";\nimport { tmpdir } from "node:os";\nimport { join } from "node:path";\nimport { fileURLToPath } from "node:url";\nconst repoRoot = fileURLToPath(new URL("../../..", import.meta.url));\n';
		const stubOnly = [
			{
				from: "packages/app/test/a.test.ts",
				stubOnly: true,
				reason: "writes stub trees",
			},
		];
		const needsLib = [
			{
				from: "packages/app/test/a.test.ts",
				needs: ["@s/lib#build"],
				why: "x",
			},
		];
		const problems = (body: string, reaches: readonly object[] | undefined) =>
			within(
				{
					...base,
					"packages/hobo/package.json": manifest("@s/hobo"),
					"packages/app/package.json": manifest("@s/app", {
						devDependencies: { "@s/lib": "workspace:*" },
					}),
					"packages/app/test/a.test.ts": `${head}${body}`,
					// An empty registry declares nothing, as no registry does.
					[REGISTRY]: JSON.stringify({ reaches: reaches ?? [] }),
				},
				(dir) => {
					const report = scanTestWorkspaceDeps(dir);
					return [
						...report.violations.map((item) => `violation ${item.imports}`),
						...[...report.unmodelled, ...report.stale].map(
							(item) => item.reason,
						),
					];
				},
			);
		const spawnOf = (path: string) => `spawn(process.execPath, [${path}]);\n`;
		const tmp = 'const tmp = mkdtempSync(join(tmpdir(), "x-"));\n';
		const S1 = spawnOf('"/tmp/../repo/packages/hobo/dist/bin.js"');
		const S2 = spawnOf(
			'join(tmpdir(), "..", "home", "user", "HoBo", "packages", "hobo", "dist", "bin.js")',
		);
		const S4 = `const tmp = mkdtempSync(join(repoRoot, "x-"));\n${spawnOf('join(tmp, "..", "packages", "hobo", "dist", "bin.js")')}`;
		const hidden: [string, string, readonly object[] | undefined][] = [
			["S1 a /tmp/ literal that climbs out", S1, stubOnly],
			["S1n the same, an entry for lib only", S1, needsLib],
			["S0 the same, no entry", S1, undefined],
			["S2 tmpdir() then .. into the repository", S2, stubOnly],
			["S2b the same, an entry for lib only", S2, needsLib],
			[
				"S3 a link in a temporary directory to hobo's dist/",
				`${tmp}symlinkSync(join(repoRoot, "packages", "hobo", "dist"), join(tmp, "hobo"));\n${spawnOf('join(tmp, "hobo", "bin.js")')}`,
				stubOnly,
			],
			[
				"S3b the same, to a literal ../../hobo/dist",
				`${tmp}symlinkSync("../../hobo/dist", join(tmp, "hobo"));\n${spawnOf('join(tmp, "hobo", "bin.js")')}`,
				stubOnly,
			],
			["S4 mkdtempSync under the repository, then ..", S4, stubOnly],
			["S4n the same, an entry for lib only", S4, needsLib],
			[
				"S4b mkdtempSync inside hobo's dist/",
				`const tmp = mkdtempSync(join(repoRoot, "packages", "hobo", "dist", "t-"));\n${spawnOf('join(tmp, "..", "bin.js")')}`,
				stubOnly,
			],
			[
				"S4c mkdtempSync under process.cwd(), then ..",
				`const tmp = mkdtempSync(join(process.cwd(), "x-"));\n${spawnOf('join(tmp, "..", "packages", "hobo", "dist", "bin.js")')}`,
				stubOnly,
			],
			[
				"S4t a template that climbs out of a temporary directory",
				`${tmp}${spawnOf("`${tmp}/../../packages/hobo/dist/bin.js`")}`,
				stubOnly,
			],
			[
				"S5 a name rebound from a temporary directory into the repository",
				`let dir = mkdtempSync(join(tmpdir(), "x-"));\ndir = join(dir, "..", "..", "packages", "hobo");\n${spawnOf('join(dir, "dist", "bin.js")')}`,
				stubOnly,
			],
			[
				"S6 any .. in a temporary path, even one that resolves under it",
				`${tmp}${spawnOf('join(tmp, "x", "..", "packages", "hobo", "dist", "bin.js")')}`,
				stubOnly,
			],
			[
				"CTRL a real reach",
				spawnOf('join(repoRoot, "packages", "hobo", "dist", "bin.js")'),
				stubOnly,
			],
		];
		for (const [label, body, reaches] of hidden)
			assert.ok(
				problems(body, reaches).some((problem) => problem.includes("@s/hobo")),
				`${label}: the reach of @s/hobo is not seen`,
			);
		// What stays under a temporary root is still a stub.
		const stubs: [string, string][] = [
			[
				"CTRL a true stub tree",
				`${tmp}${spawnOf('join(tmp, "packages", "hobo", "dist", "bin.js")')}`,
			],
			[
				"S1b a /tmp/ literal that stays under /tmp",
				spawnOf('"/tmp/packages/hobo/dist/bin.js"'),
			],
		];
		for (const [label, body] of stubs)
			assert.deepEqual(problems(body, stubOnly), [], label);
	});

	it("accepts a stubOnly entry for a file whose only reaches are stub trees under a temporary root", () => {
		const fs =
			'import { mkdtempSync, writeFileSync } from "node:fs";\nimport { mkdtemp } from "node:fs/promises";\nimport { tmpdir } from "node:os";\n';
		// Four ways to root a path at a temporary directory, all stubs of lib: a
		// name bound to mkdtempSync, tmpdir() in a template, an awaited mkdtemp,
		// and a /tmp/ literal.
		const stub = `${fs}${JOIN}const root = mkdtempSync(join(tmpdir(), "x-"));\nwriteFileSync(join(root, "packages", "lib", "dist", "bin.js"), "");\nwriteFileSync(\`\${tmpdir()}/packages/lib/dist/x.js\`, "");\nwriteFileSync(join(await mkdtemp("/tmp/y-"), "packages", "lib", "dist", "y.js"), "");\nwriteFileSync("/tmp/z/packages/lib/dist/z.js", "");\n`;
		const entry = (fields: {
			readonly stubOnly: boolean;
			readonly reason?: string | undefined;
			readonly needs?: readonly string[] | undefined;
		}) => ({
			[REGISTRY]: JSON.stringify({
				reaches: [{ from: "packages/app/test/stub.test.ts", ...fields }],
			}),
		});
		const reason = {
			stubOnly: true,
			reason: "writes a stub lib under a temp root",
		};
		const report = (files: Record<string, string>) =>
			within(
				{
					...base,
					"packages/app/package.json": manifest("@s/app"),
					...files,
				},
				(dir) => {
					const found = scanTestWorkspaceDeps(dir);
					return [
						...found.violations.map((item) => `violation ${item.imports}`),
						...[...found.unmodelled, ...found.stale].map(
							(item) => `${item.file}: ${item.reason}`,
						),
					];
				},
			);
		// Undeclared, a stub reach still fails: the reader may misjudge a root.
		assert.deepEqual(report({ "packages/app/test/stub.test.ts": stub }), [
			reaching(
				"packages/app/test/stub.test.ts",
				"@s/lib",
				"*/packages/lib/dist/bin.js",
			),
		]);
		assert.deepEqual(
			report({ "packages/app/test/stub.test.ts": stub, ...entry(reason) }),
			[],
		);
		// A real reach beside the stubs refuses the entry.
		assert.deepEqual(
			report({
				"packages/app/test/stub.test.ts": `${stub}export const real = join(process.cwd(), "packages", "lib", "dist", "cli.js");\n`,
				...entry(reason),
			}),
			[
				`${REGISTRY}: "packages/app/test/stub.test.ts" is marked stubOnly, but reaches @s/lib ("*/packages/lib/dist/cli.js") outside a temporary root`,
			],
		);
		// So does a name bound to a temporary directory in one place and to
		// another directory in another: it is not visibly a stub.
		assert.deepEqual(
			report({
				"packages/app/test/stub.test.ts": `${fs}${JOIN}export function a() {\n\tconst root = mkdtempSync(join(tmpdir(), "x-"));\n\treturn join(root, "packages", "lib", "dist", "a.js");\n}\nexport function b() {\n\tconst root = process.cwd();\n\treturn root;\n}\n`,
				...entry(reason),
			}),
			[
				`${REGISTRY}: "packages/app/test/stub.test.ts" is marked stubOnly, but reaches @s/lib ("*/packages/lib/dist/a.js") outside a temporary root`,
			],
		);
		// A reason is required, and needs are not allowed.
		// A refused entry declares nothing, so the reach is undeclared too.
		for (const [fields, problem] of [
			[{ stubOnly: true }, 'is stubOnly and needs a non-empty "reason"'],
			[
				{ stubOnly: true, reason: " " },
				'is stubOnly and needs a non-empty "reason"',
			],
			[
				{ ...reason, needs: ["@s/lib#build"] },
				'is stubOnly and cannot carry "needs"',
			],
		] as const)
			assert.deepEqual(
				report({ "packages/app/test/stub.test.ts": stub, ...entry(fields) }),
				[
					reaching(
						"packages/app/test/stub.test.ts",
						"@s/lib",
						"*/packages/lib/dist/bin.js",
					),
					`${REGISTRY}: entry 0 ("packages/app/test/stub.test.ts") ${problem}`,
				],
			);
	});

	it("does not hold an entry's needs to the stub trees a file writes", () => {
		within(
			{
				...base,
				"turbo.json": turbo({
					"@s/app#test": { dependsOn: ["build", "@s/hobo#build"] },
				}),
				[REGISTRY]: JSON.stringify({
					reaches: [
						{
							from: "packages/app/test/a.test.ts",
							needs: ["@s/hobo#build"],
							why: "spawns hobo; stubs lib",
						},
					],
				}),
				"packages/hobo/package.json": manifest("@s/hobo"),
				"packages/app/package.json": manifest("@s/app"),
				"packages/app/test/a.test.ts": `${SPAWN}${JOIN}import { mkdtempSync } from "node:fs";\nimport { tmpdir } from "node:os";\nspawn(process.execPath, [join(process.cwd(), "packages", "hobo", "dist", "bin.js")]);\nconst root = mkdtempSync(join(tmpdir(), "x-"));\nexport const stub = join(root, "packages", "lib", "dist", "bin.js");\n`,
			},
			(dir) => {
				const report = scanTestWorkspaceDeps(dir);
				assert.deepEqual(
					[...report.violations, ...report.unmodelled, ...report.stale],
					[],
				);
			},
		);
	});

	it("counts a need on a file's own package where another package's test loads the file", () => {
		// packages/a/test/helpers.ts, which a#test and b#test both load.
		const helper = (
			target: string,
			needs: string[] | undefined,
			tasks: Record<string, { dependsOn?: string[] }>,
		) => {
			const files = {
				...base,
				"turbo.json": turbo(tasks),
				"packages/a/package.json": manifest("@s/a"),
				"packages/b/package.json": manifest("@s/b"),
				"packages/hobo/package.json": manifest("@s/hobo"),
				"packages/a/test/helpers.ts": `${SPAWN}${JOIN}export const run = (root: string) => spawn(process.execPath, [join(root, "packages", "${target}", "dist", "x.js")]);\n`,
				"packages/a/test/a.test.ts": 'import "./helpers.js";\n',
				"packages/b/test/b.test.ts": 'import "../../a/test/helpers.js";\n',
				// An empty registry declares nothing, as no registry does.
				[REGISTRY]: JSON.stringify({
					reaches:
						needs === undefined
							? []
							: [{ from: "packages/a/test/helpers.ts", needs, why: "spawns" }],
				}),
			};
			return within(files, (dir) => {
				const report = scanTestWorkspaceDeps(dir);
				return [
					...report.violations.map(
						(item) =>
							`violation ${item.package}#${item.task} -> ${item.imports}`,
					),
					...[...report.unmodelled, ...report.stale].map((item) => item.reason),
				];
			});
		};
		const bOnA = { "@s/b#test": { dependsOn: ["build", "@s/a#build"] } };
		// H1: a's own build is another package's for b#test, so it counts.
		assert.deepEqual(helper("a", ["@s/a#build"], bOnA), []);
		// H1b: undeclared, the reach fails.
		assert.deepEqual(helper("a", undefined, bOnA), [
			`reaches @s/a at run time through a path it assembles ("*/packages/a/dist/x.js"), which this check cannot follow; declare what it needs in ${REGISTRY}`,
		]);
		// H2: a#test is not ordered on hobo's build.
		assert.deepEqual(
			helper("hobo", ["@s/hobo#build"], {
				"@s/b#test": { dependsOn: ["build", "@s/hobo#build"] },
			}),
			["violation @s/a#test -> @s/hobo"],
		);
		// H3: hobo is ordered for both, but the entry names lib only.
		const both = { dependsOn: ["build", "@s/hobo#build", "@s/lib#build"] };
		assert.deepEqual(
			helper("hobo", ["@s/lib#build"], {
				"@s/a#test": both,
				"@s/b#test": both,
			}),
			[
				'"packages/a/test/helpers.ts" reaches @s/hobo ("*/packages/hobo/dist/x.js"), and its entry does not name "@s/hobo#build"',
			],
		);
	});

	it("refuses a file the registry declares more than once", () => {
		const entry = (needs: string[]) => ({
			from: "packages/app/src/run.ts",
			needs,
			why: "spawns lib",
		});
		within(
			{
				...base,
				[REGISTRY]: JSON.stringify({
					reaches: [entry(["@s/lib#build"]), entry(["@s/lib#build"])],
				}),
				"packages/app/package.json": manifest("@s/app"),
				"packages/app/test/a.test.ts": 'import "../src/run.js";\n',
				"packages/app/src/run.ts": `${SPAWN}${JOIN}spawn(process.execPath, [join(process.cwd(), "packages", "lib", "dist", "cli.js")]);\n`,
			},
			(dir) =>
				assert.deepEqual(
					scanTestWorkspaceDeps(dir).stale.map(
						(item) => `${item.file}: ${item.reason}`,
					),
					[
						`${REGISTRY}: "packages/app/src/run.ts" is declared 2 times; keep one entry`,
					],
				),
		);
	});

	it("refuses a declaration that no test task reaches any more, or that names no workspace package", () => {
		const reaches = [
			'import { spawn } from "node:child_process";',
			'spawn(process.execPath, ["../../lib/dist/cli.js"]);',
			"",
		].join("\n");
		within(
			{
				...base,
				[REGISTRY]: JSON.stringify({
					reaches: [
						{ from: "packages/app/src/gone.ts", needs: [], why: "deleted" },
						{
							from: "packages/app/src/quiet.ts",
							needs: ["@s/lib#build"],
							why: "used to spawn lib",
						},
						{
							from: "packages/app/src/unloaded.ts",
							needs: ["@s/lib#build"],
							why: "no test imports it",
						},
						{
							from: "packages/app/src/run.ts",
							needs: ["@s/nope#build", "@s/lib"],
							why: "spawns lib",
						},
					],
				}),
				"packages/app/package.json": manifest("@s/app"),
				"packages/app/test/a.test.ts":
					'import "../src/quiet.js";\nimport "../src/run.js";\n',
				"packages/app/src/quiet.ts": "export const q = 1;\n",
				"packages/app/src/unloaded.ts": reaches,
				"packages/app/src/run.ts": reaches,
			},
			(dir) =>
				assert.deepEqual(
					scanTestWorkspaceDeps(dir).stale.map(
						(item) => `${item.file}: ${item.reason}`,
					),
					[
						`${REGISTRY}: "packages/app/src/gone.ts" is not a tracked file`,
						`${REGISTRY}: "packages/app/src/gone.ts" names no build of another package it needs; name one as "<package>#build", or remove the entry`,
						`${REGISTRY}: "packages/app/src/quiet.ts" no longer reaches another package at run time`,
						`${REGISTRY}: "packages/app/src/run.ts" names no build of another package it needs; name one as "<package>#build", or remove the entry`,
						`${REGISTRY}: "packages/app/src/run.ts" needs "@s/lib", which is not "<package>#build"`,
						`${REGISTRY}: "packages/app/src/run.ts" needs "@s/nope#build", and @s/nope is not a workspace package`,
						`${REGISTRY}: "packages/app/src/run.ts" reaches @s/lib ("../../lib/dist/cli.js"), and its entry does not name "@s/lib#build"`,
						`${REGISTRY}: "packages/app/src/unloaded.ts" is loaded by no test task`,
					],
				),
		);
	});

	it("does not take a pnpm-workspace.yaml override for a catalog entry", () => {
		const unmodelled = (yaml: string, specifier: string) =>
			within(
				{
					...base,
					"pnpm-workspace.yaml": `${base["pnpm-workspace.yaml"]}${yaml}`,
					"packages/app/package.json": manifest("@s/app", {
						devDependencies: { "left-pad": specifier },
					}),
				},
				(dir) => scanTestWorkspaceDeps(dir).unmodelled.map((item) => item.file),
			);
		// pnpm 10 reads overrides from pnpm-workspace.yaml; they are not a catalog.
		assert.deepEqual(
			unmodelled(
				'catalog:\n  left-pad: 1.3.0\noverrides:\n  "@s/lib": "workspace:*"\n',
				"catalog:",
			),
			[],
		);
		assert.deepEqual(
			unmodelled(
				'catalogs:\n  tools:\n    left-pad: "workspace:*" # a named catalog\n',
				"catalog:tools",
			),
			["packages/app/package.json"],
		);
	});

	it("refuses a submodule git cannot list", () => {
		within(
			{
				...base,
				"packages/app/package.json": manifest("@s/app"),
				// A checkout whose .git points at nothing.
				"external/sub/.git": "gitdir: /nonexistent/hobo-test-deps\n",
			},
			(dir) => {
				git(dir, "init", "-q");
				git(dir, "add", "pnpm-workspace.yaml", "turbo.json", "packages");
				const head = git(dir, "hash-object", "-w", "turbo.json");
				git(
					dir,
					"update-index",
					"--add",
					"--cacheinfo",
					`160000,${head},external/sub`,
				);
				assert.deepEqual(
					scanTestWorkspaceDeps(dir).unmodelled.map(
						(item) => `${item.file}: ${item.reason}`,
					),
					[
						"external/sub: a submodule git cannot list, so this check cannot tell what is inside it",
					],
				);
			},
		);
	});

	it("counts a followed source file a sparse checkout left out, and fails on it under --strict or in CI", () => {
		within(
			{
				...base,
				"packages/other/package.json": manifest("@s/other"),
				"packages/sib/package.json": manifest("@s/sib", {
					dependencies: { "@s/other": "workspace:*" },
				}),
				"packages/sib/src/x.ts": 'export * from "@s/other";\n',
				"packages/app/package.json": manifest("@s/app"),
				"packages/app/test/a.test.ts": 'import "../../sib/src/x.js";\n',
			},
			(dir) => {
				git(dir, "init", "-q");
				git(dir, "add", ".");
				git(dir, "commit", "-qm", "t");
				git(
					dir,
					"sparse-checkout",
					"set",
					"--no-cone",
					"/*",
					"!/packages/sib/src/",
				);
				for (const [args, ci] of [
					[["--strict"], undefined],
					[[], "1"],
				] as const) {
					const run = cli(dir, args, ci);
					assert.equal(
						run.status,
						1,
						`${args.join(" ")} CI=${ci}: ${run.stderr}`,
					);
					assert.match(
						run.stderr,
						/error: 1 tracked file this check reads is not checked out, so it skipped it: packages\/sib\/src\/x\.ts/u,
					);
				}
			},
		);
	});

	it("warns about tracked files a sparse checkout left out, and fails on them under --strict or in CI", () => {
		const reaches = 'import { x } from "@s/lib";\n';
		within(
			{
				...base,
				"packages/app/package.json": manifest("@s/app", {
					devDependencies: { "@s/lib": "workspace:*" },
				}),
				"packages/app/test/kept.test.ts": reaches,
				"packages/app/test/left-out-1.test.ts": reaches,
				"packages/app/test/left-out-2.test.ts": reaches,
			},
			(dir) => {
				const git = (...args: string[]) =>
					execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
						cwd: dir,
						stdio: "pipe",
					});
				git("init", "-q");
				git("add", ".");
				git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "t");
				git(
					"sparse-checkout",
					"set",
					"--no-cone",
					"/*",
					"!/packages/app/test/left-out-*",
				);
				// A gitlink with no checkout behind it: a submodule never initialised.
				const head = git("rev-parse", "HEAD").toString().trim();
				git(
					"update-index",
					"--add",
					"--cacheinfo",
					`160000,${head},external/sub`,
				);
				const run = (args: string[], ci: string | undefined) => {
					const env = { ...process.env };
					delete env.CI;
					if (ci !== undefined) env.CI = ci;
					return spawnSync(
						process.execPath,
						[
							"--import",
							"tsx",
							join(root, "scripts/check-test-workspace-deps.mts"),
							"--root",
							dir,
							...args,
						],
						{ cwd: root, encoding: "utf8", env },
					);
				};
				const files =
					/2 tracked files this check reads are not checked out, so it skipped them: packages\/app\/test\/left-out-1\.test\.ts, packages\/app\/test\/left-out-2\.test\.ts/u;
				const submodule =
					/1 submodule is not checked out, so none of its files were read: external\/sub/u;
				const quiet = run([], undefined);
				assert.equal(quiet.status, 0, quiet.stderr);
				assert.match(quiet.stderr, new RegExp(`warning: ${files.source}`, "u"));
				assert.match(
					quiet.stderr,
					new RegExp(`warning: ${submodule.source}`, "u"),
				);
				assert.equal(run([], "0").status, 0);
				for (const [args, ci] of [
					[["--strict"], undefined],
					[[], "1"],
					[[], "true"],
				] as const) {
					const loud = run([...args], ci);
					assert.equal(loud.status, 1, `${args.join(" ")} CI=${ci}`);
					assert.match(loud.stderr, new RegExp(`error: ${files.source}`, "u"));
					assert.match(
						loud.stderr,
						new RegExp(`error: ${submodule.source}`, "u"),
					);
				}
			},
		);
	});

	it("finds no such test in this repository", () => {
		const { violations, unmodelled, stale } = scanTestWorkspaceDeps(root);
		assert.deepEqual(
			[
				...violations.map(
					(item) =>
						`${item.file} [${item.task}]: ${item.package} -> ${item.imports}`,
				),
				...[...unmodelled, ...stale].map(
					(item) => `${item.file}: ${item.reason}`,
				),
			],
			[],
		);
	});
});
