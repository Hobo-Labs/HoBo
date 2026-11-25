import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type { Workspace } from "../ci/job-scope.mts";
import {
	BUILT_PACKAGES,
	DRIVERS,
	diskSkillTree,
	type SkillTree,
	stateMachineReach,
	stateMachineScope,
} from "../ci/state-machine-scope.mts";
import { testRunner } from "./support/test-runner.ts";

const { describe, it } = await testRunner();

const builtDirs = new Map([
	["@hobo/hobo", "packages/hobo"],
	["@hobo/dispatcher", "packages/dispatcher"],
	["@hobo/ci", "packages/ci"],
	["@hobo/cd", "packages/cd"],
	["@hobo/identity", "packages/identity"],
	["@hobo/storage-sqlite", "packages/storage-sqlite"],
	["@hobo/runtime", "packages/runtime"],
]);

const baseWorkspaces: readonly Workspace[] = [
	...BUILT_PACKAGES.map((name) => ({
		dir: builtDirs.get(name) ?? name,
		name,
		dependencies: name === "@hobo/cd" ? ["@hobo/events", "zod"] : [],
	})),
	{
		dir: "packages/events",
		name: "@hobo/events",
		dependencies: ["@hobo/wire"],
	},
	{ dir: "packages/wire", name: "@hobo/wire", dependencies: [] },
	{ dir: "packages/pricing", name: "@hobo/pricing", dependencies: [] },
	{ dir: "packages/broker", name: "@hobo/broker", dependencies: [] },
	{ dir: "packages/core", name: "@hobo/core", dependencies: [] },
	{ dir: "packages/site", name: "@hobo/site", dependencies: [] },
	{
		dir: "packages/providers/provider-x",
		name: "@hobo/provider-x",
		dependencies: [],
	},
];

const baseFiles = {
	...Object.fromEntries(DRIVERS.map((path) => [path, "#!/usr/bin/env bash\n"])),
	".agents/skills/verify-a/SKILL.md": [
		"## Covered code",
		"- `packages/pricing/src/{quote,state}.ts`: selection.",
		"- `src/quote.ts` relative to its package.",
		"- `scripts/lib/helper.sh` and `scripts/fixtures/` hold the fixtures.",
	].join("\n"),
	".agents/skills/verify-a/tests/check.mts": [
		"import { spawnSync } from 'node:child_process';",
		"import { load } from './lib/load.mts';",
		"const source = path.resolve('packages/broker/src/budget.ts');",
		"const { x } = await import(pathToFileURL(source).href);",
		"const model = new URL('../models/A.tla', import.meta.url);",
		"spawnSync('bash', ['scripts/run-it.sh']);",
		"// import { gone } from './gone.mts';",
	].join("\n"),
	".agents/skills/verify-a/tests/lib/load.mts":
		'import { y } from "@hobo/core";\nexport const load = y;',
	".agents/skills/verify-a/models/A.tla": "---- MODULE A ----",
	".agents/skills/verify-a/mutations/copy.py":
		"shutil.copy2(repo / 'AGENTS.md', root / 'AGENTS.md')",
	"scripts/run-it.sh": 'source "$ROOT/scripts/lib/run-lib.sh"\n',
	"scripts/lib/run-lib.sh": "echo ok\n",
	"scripts/lib/helper.sh": "echo help\n",
	"scripts/fixtures/a.json": "{}",
	"packages/pricing/src/quote.ts": "export {};",
	"AGENTS.md": "# rules",
} satisfies Record<string, string>;

const baseDirs = [
	"packages",
	"scripts",
	"scripts/lib",
	"scripts/fixtures",
	"src",
	"packages/pricing/src",
];

function memoryTree(
	files: Record<string, string | undefined> = {},
	workspaces: readonly Workspace[] = baseWorkspaces,
): SkillTree {
	const contents = new Map(
		Object.entries({ ...baseFiles, ...files }).filter(
			(entry): entry is [string, string] => entry[1] !== undefined,
		),
	);
	const isPackageFile = (path: string) =>
		workspaces.some((ws) => path === `${ws.dir}/package.json`);
	return {
		read: (path) => contents.get(path),
		isFile: (path) => contents.has(path) || isPackageFile(path),
		isDir: (path) =>
			baseDirs.includes(path) ||
			workspaces.some((ws) => ws.dir === path) ||
			[...contents.keys()].some((file) => file.startsWith(`${path}/`)),
		list: (dir) =>
			[...contents.keys()].filter((path) => path.startsWith(`${dir}/`)),
		workspaces,
	};
}

describe("state-machine-scope", () => {
	it("reaches the built packages, the packages and files the skills name, and their workspace dependencies", () => {
		const reached = stateMachineReach(memoryTree());
		assert.ok(!("unscoped" in reached), JSON.stringify(reached));
		assert.deepEqual([...reached.packages].sort(), [
			"packages/broker",
			"packages/cd",
			"packages/ci",
			"packages/core",
			"packages/dispatcher",
			"packages/events",
			"packages/hobo",
			"packages/identity",
			"packages/pricing",
			"packages/runtime",
			"packages/storage-sqlite",
			"packages/wire",
		]);
		for (const file of [
			"scripts/verify-all-state-machines.sh",
			"scripts/verify-state-machine.sh",
			"scripts/run-it.sh",
			"scripts/lib/run-lib.sh",
			"scripts/lib/helper.sh",
			".agents/skills/verify-a/tests/lib/load.mts",
			"AGENTS.md",
		])
			assert.ok(reached.files.has(file), file);
		assert.deepEqual([...reached.dirs].sort(), ["scripts/fixtures"]);
	});

	it("needs verification for every input the skills exercise", () => {
		for (const path of [
			".agents/skills/verify-a/SKILL.md",
			".agents/skills/verify-new/tests/check.mts",
			"scripts/verify-all-state-machines.sh",
			"scripts/verify-state-machine.sh",
			"scripts/ci/state-machine-scope.mts",
			"scripts/ci/job-scope.mts",
			"scripts/ci/affected-lanes.mts",
			"scripts/run-it.sh",
			"scripts/lib/run-lib.sh",
			"scripts/fixtures/b.json",
			"package.json",
			"pnpm-lock.yaml",
			"pnpm-workspace.yaml",
			"turbo.json",
			"mise.toml",
			"mise.lock",
			"tsconfig.base.json",
			".github/workflows/hobo-ci.yml",
			".github/actions/turbo-cache/action.yml",
			".gitmodules",
			"tools/pins/siblings.json",
			"external/ts-autocode",
			"vitest.config.ts",
			"packages/cd/src/fanout/schedule.ts",
			"packages/wire/src/index.ts",
			"packages/pricing/README.md",
			"packages/core/src/index.ts",
			"AGENTS.md",
		])
			assert.equal(stateMachineScope([path], memoryTree()).needed, true, path);
	});

	it("skips when no changed path reaches the skills", () => {
		const scope = stateMachineScope(
			[
				"docs/ci/findings/0001-x.md",
				"site/src/pages/index.astro",
				".github/workflows/release-hobo.yml",
				".claude/skills/impeccable/SKILL.md",
				"packages/site/src/a.ts",
				"packages/providers/provider-x/src/a.ts",
				"scripts/ci/proven-tree.mts",
			],
			memoryTree(),
		);
		assert.equal(scope.needed, false, scope.reason);
	});

	it("needs verification whenever the walk cannot be sure", () => {
		assert.equal(stateMachineScope([], memoryTree()).needed, true, "empty");
		assert.equal(
			stateMachineScope(["packages/gone/src/a.ts"], memoryTree()).needed,
			true,
			"removed package",
		);
		const doubtful = {
			"unresolvable relative import": {
				".agents/skills/verify-a/tests/check.mts":
					"import { x } from './missing.mts';",
			},
			"import outside the repository": {
				".agents/skills/verify-a/tests/check.mts":
					"import { x } from '../../../../../x.mts';",
			},
			"unreadable driver": { "scripts/verify-state-machine.sh": undefined },
		} satisfies Record<string, Record<string, string | undefined>>;
		for (const [label, files] of Object.entries(doubtful))
			assert.equal(
				stateMachineScope(["docs/a.md"], memoryTree(files)).needed,
				true,
				label,
			);
		const withoutSkills = Object.fromEntries(
			Object.keys(baseFiles)
				.filter((path) => path.startsWith(".agents/"))
				.map((path) => [path, undefined]),
		);
		assert.equal(
			stateMachineScope(["docs/a.md"], memoryTree(withoutSkills)).needed,
			true,
			"no skills",
		);
		assert.equal(
			stateMachineScope(
				["docs/a.md"],
				memoryTree(
					{},
					baseWorkspaces.filter((ws) => ws.name !== "@hobo/runtime"),
				),
			).needed,
			true,
			"missing built package",
		);
	});

	it("widens a named path that is in no reached package to its nearest existing directory", () => {
		const tree = memoryTree({
			".agents/skills/verify-a/SKILL.md": "- `src/absent/thing.ts`",
		});
		const reached = stateMachineReach(tree);
		assert.ok(!("unscoped" in reached));
		assert.ok(reached.dirs.has("src"));
		assert.equal(stateMachineScope(["src/draft/x.ts"], tree).needed, true);
	});

	it("builds the packages the scope starts from", () => {
		const workflow = readFileSync(".github/workflows/hobo-ci.yml", "utf8");
		const start = workflow.indexOf("  state-machine-verification:\n");
		const end = workflow.indexOf("\n  pr-gate:", start);
		const job = workflow.slice(start, end);
		const build = job.slice(
			job.indexOf("name: Build verification dependencies"),
		);
		const filters = [...build.matchAll(/--filter=(\S+)/gu)].map(
			(match) => match[1],
		);
		assert.deepEqual([...filters].sort(), [...BUILT_PACKAGES].sort());
	});

	it("imports node builtins and the planning scripts only, so it runs before pnpm install", () => {
		const source = readFileSync("scripts/ci/state-machine-scope.mts", "utf8");
		const imports = [
			...source.matchAll(/^import [\s\S]*? from "([^"]+)";$/gm),
		].map((match) => match[1] ?? "");
		assert.deepEqual(
			imports.filter((name) => !name.startsWith("node:")).sort(),
			["../lib/read-stdin.mts", "./affected-lanes.mts", "./job-scope.mts"],
		);
	});

	it("prints whether verification is needed from the CLI", () => {
		const answer = (input: string) =>
			execFileSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--no-warnings",
					"scripts/ci/state-machine-scope.mts",
				],
				{ input, encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] },
			);
		assert.equal(answer("docs/a.md\n"), "false\n");
		assert.equal(answer("scripts/verify-state-machine.sh\n"), "true\n");
		assert.equal(answer(""), "true\n");
	});

	it("scopes the repository's own skills without giving up", () => {
		const tree = diskSkillTree();
		const reached = stateMachineReach(tree);
		assert.ok(!("unscoped" in reached), JSON.stringify(reached));
		const dirOf = new Map(tree.workspaces.map((ws) => [ws.name, ws.dir]));
		for (const name of BUILT_PACKAGES)
			assert.ok(reached.packages.has(dirOf.get(name) ?? name), name);
		const named = new Set<string>();
		for (const path of tree.list(".agents/skills"))
			if (/^\.agents\/skills\/verify-[^/]+\/SKILL\.md$/u.test(path))
				for (const match of (tree.read(path) ?? "").matchAll(
					/`(packages\/[^/`]+(?:\/[^/`]+)?)\//gu,
				)) {
					const prefix = match[1] ?? "";
					const ws = tree.workspaces.find(
						(entry) =>
							prefix === entry.dir || prefix.startsWith(`${entry.dir}/`),
					);
					if (ws) named.add(ws.dir);
				}
		assert.ok(named.size > 0);
		for (const dir of named) assert.ok(reached.packages.has(dir), dir);
		for (const [name, dir] of dirOf)
			if (reached.packages.has(dir)) {
				const ws = tree.workspaces.find((entry) => entry.name === name);
				for (const dependency of ws?.dependencies ?? []) {
					const target = dirOf.get(dependency);
					if (target)
						assert.ok(reached.packages.has(target), `${name} -> ${dependency}`);
				}
			}
		assert.equal(
			stateMachineScope(["docs/ci/ci-performance.md"], tree).needed,
			false,
		);
		assert.equal(
			stateMachineScope(["packages/cd/src/fanout/schedule.ts"], tree).needed,
			true,
		);
	});
});
