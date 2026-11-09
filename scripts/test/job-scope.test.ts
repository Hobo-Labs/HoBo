import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	jobScope,
	reach,
	readWorkspaces,
	type Tree,
} from "../ci/job-scope.mts";

function memoryTree(files: Record<string, string>): Tree {
	const contents = new Map(Object.entries(files));
	return {
		read: (path) => contents.get(path),
		isFile: (path) => contents.has(path),
		workspaces: [
			{ dir: "packages/core", name: "@hobo/core", dependencies: [] },
			{
				dir: "packages/cli",
				name: "@hobo/cli",
				dependencies: ["@hobo/core", "zod"],
			},
			{ dir: "packages/other", name: "@hobo/other", dependencies: [] },
			{
				dir: "packages/providers/provider-x",
				name: "@hobo/provider-x",
				dependencies: [],
			},
			{
				dir: "src/draft/technical-proofs/p",
				name: "@hobo/p",
				dependencies: [],
			},
		],
	};
}

const tree = memoryTree({
	"scripts/ci/entry.mts": [
		'import { a } from "./helper.ts";',
		'import { run } from "../../packages/cli/src/run.js";',
		'export * from "@hobo/p/sub";',
		'const lazy = await import("node:fs");',
	].join("\n"),
	"scripts/ci/helper.ts":
		'export type { X } from "./types.js";\nexport const a = 1;',
	"scripts/ci/types.ts": "export type X = string;",
	"packages/cli/package.json": "{}",
	"packages/cli/src/run.ts":
		'import "@hobo/core";\nconst t = `import x from "./_generated/index.js"`;',
	"packages/core/package.json": "{}",
	"packages/other/package.json": "{}",
	"src/draft/technical-proofs/p/package.json": "{}",
});
const entry = ["scripts/ci/entry.mts"];

describe("job-scope", () => {
	it("walks relative imports and the workspace packages they enter or name", () => {
		const reached = reach(entry, tree);
		assert.ok(!("unscoped" in reached));
		assert.deepEqual([...reached.files].sort(), [
			"scripts/ci/entry.mts",
			"scripts/ci/helper.ts",
			"scripts/ci/types.ts",
		]);
		assert.deepEqual([...reached.dirs].sort(), [
			"packages/cli",
			"packages/core",
			"src/draft/technical-proofs/p",
		]);
	});

	it("runs for any reached file or package, including dependencies", () => {
		for (const path of [
			"scripts/ci/entry.mts",
			"scripts/ci/types.ts",
			"packages/cli/README.md",
			"packages/core/src/index.ts",
			"src/draft/technical-proofs/p/src/sub.ts",
		])
			assert.equal(jobScope([path], entry, tree).run, true, path);
	});

	it("skips when nothing the entries reach changed", () => {
		const scope = jobScope(
			[
				"docs/a.md",
				"packages/other/src/x.ts",
				"packages/providers/provider-x/src/x.ts",
				"scripts/run-tests.ts",
			],
			entry,
			tree,
		);
		assert.equal(scope.run, false, scope.reason);
	});

	it("runs for workspace-wide, CI, pin and submodule inputs", () => {
		for (const path of [
			"pnpm-lock.yaml",
			"tsconfig.base.json",
			".github/workflows/hobo-ci.yml",
			".github/actions/ci-trace/action.yml",
			"mise.lock",
			".gitmodules",
			"external/ts-autocode",
			"tools/pins/siblings.json",
			"vitest.config.ts",
			"scripts/ci/job-scope.mts",
			"scripts/ci/affected-lanes.mts",
			"scripts/lib/read-stdin.mts",
			"packages/ci-gh-actions/deploy/ci-runner/Dockerfile.base",
			"scripts/ci-runner-preflight.mts",
		])
			assert.equal(jobScope([path], entry, tree).run, true, path);
		assert.equal(jobScope([], entry, tree).run, true, "empty diff");
		assert.equal(
			jobScope(["packages/gone/src/a.ts"], entry, tree).run,
			true,
			"removed package",
		);
	});

	it("runs when the walk cannot follow an import", () => {
		const cases = {
			"computed import()": "const m = await import(`./${name}.js`);",
			"unresolvable relative import": 'import { x } from "./missing.js";',
			"import outside the repository": 'import { x } from "../../../x.js";',
		};
		for (const [label, source] of Object.entries(cases)) {
			const scope = jobScope(
				["docs/a.md"],
				entry,
				memoryTree({ "scripts/ci/entry.mts": source }),
			);
			assert.equal(scope.run, true, label);
		}
		assert.equal(
			jobScope(["docs/a.md"], ["scripts/ci/absent.mts"], tree).run,
			true,
			"missing entry",
		);
	});

	it("scopes the repository's own PR job entries without giving up", () => {
		const fs: Tree = {
			read: (path) => {
				try {
					return readFileSync(path, "utf8");
				} catch {
					return undefined;
				}
			},
			isFile: (path) => {
				try {
					readFileSync(path);
					return true;
				} catch {
					return false;
				}
			},
			workspaces: readWorkspaces(),
		};
		const workflow = readFileSync(".github/workflows/hobo-ci.yml", "utf8");
		const jobs = [
			...workflow.matchAll(
				/scripts\/ci\/job-scope\.mts \\\n((?:\s+\S+ \\\n)+)\s+>> "\$GITHUB_OUTPUT"/g,
			),
		].map((match) =>
			(match[1] ?? "")
				.split("\\")
				.map((line) => line.trim())
				.filter((line) => line !== ""),
		);
		assert.deepEqual(jobs, [
			[
				"vitest.config.ts",
				"src/draft/technical-proofs/componentize-artifact-trust-contract/test/publish-verify.test.ts",
			],
			["scripts/ci/dev-cold-loop-timing.mts"],
		]);
		const own = [
			"src/draft/technical-proofs/componentize-artifact-trust-contract/src/index.ts",
			"packages/cli/src/index.ts",
		];
		for (const [index, entries] of jobs.entries()) {
			const skip = jobScope(["docs/a.md"], entries, fs);
			assert.equal(skip.run, false, skip.reason);
			assert.equal(jobScope([own[index] ?? ""], entries, fs).run, true);
			assert.equal(
				jobScope(["test/setup/isolate-hobo-home.ts"], entries, fs).run,
				index === 0,
				"the root vitest setup is an input of the vitest-run job only",
			);
		}
	});

	it("imports node builtins only, so it runs before pnpm install", () => {
		const source = readFileSync("scripts/ci/job-scope.mts", "utf8");
		const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map(
			(match) => match[1],
		);
		const local = ["./affected-lanes.mts", "../lib/read-stdin.mts"];
		assert.deepEqual(
			imports.filter(
				(name) => !name?.startsWith("node:") && !local.includes(name ?? ""),
			),
			[],
		);
		for (const path of [
			"scripts/ci/affected-lanes.mts",
			"scripts/lib/read-stdin.mts",
		]) {
			const text = readFileSync(path, "utf8");
			for (const match of text.matchAll(/^import .* from "([^"]+)";$/gm))
				assert.ok(match[1]?.startsWith("node:"), `${path}: ${match[1]}`);
		}
	});

	it("prints a GITHUB_OUTPUT line from the CLI", () => {
		const output = execFileSync(
			process.execPath,
			[
				"--experimental-strip-types",
				"--no-warnings",
				"scripts/ci/job-scope.mts",
				"scripts/ci/dev-cold-loop-timing.mts",
			],
			{
				input: "docs/a.md\n",
				encoding: "utf8",
				stdio: ["pipe", "pipe", "ignore"],
			},
		);
		assert.equal(output, "run=false\n");
	});
});
