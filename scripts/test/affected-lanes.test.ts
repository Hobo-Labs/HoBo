import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
	affectedLanes,
	mainGateScope,
	type ReadRootFile,
	workspaceGroups,
} from "../ci/affected-lanes.mts";

const present = (): boolean => true;
const noGroups: ReadonlySet<string> = new Set();
type RootVersions = {
	readonly base?: string;
	readonly head: string;
};

function rootReader(
	files: Readonly<Record<string, RootVersions>>,
): ReadRootFile {
	return (path, side) => {
		const versions = files[path];
		return side === "base" ? versions?.base : versions?.head;
	};
}

function lanesWithRoots(
	paths: readonly string[],
	files: Readonly<Record<string, RootVersions>>,
) {
	return affectedLanes(paths, present, noGroups, rootReader(files));
}

describe("affected-lanes", () => {
	it("skips when no package-lane input changed", () => {
		for (const path of [
			".github/workflows/hobo-ci.yml",
			".github/actions/setup-pnpm/action.yml",
			"scripts/dx-preflight.mts",
			"src/draft/technical-proofs/x/test/a.test.ts",
		])
			assert.equal(affectedLanes([path], present).mode, "skip");
		assert.equal(
			affectedLanes(["README.md", "docs/a.md"], present).mode,
			"skip",
		);
		assert.equal(
			affectedLanes([".changeset/brave-cats.md"], present).mode,
			"skip",
		);
	});

	for (const path of [
		"pnpm-workspace.yaml",
		"package.json",
		"turbo.json",
		"tsconfig.base.json",
		"biome.json",
		".npmrc",
		"mise.toml",
		"vendor/ts-autocode",
		"docs/../pnpm-lock.yaml",
	]) {
		it(`runs everything when ${path} changes`, () => {
			const lanes = affectedLanes(["README.md", path], present);
			assert.equal(lanes.mode, "all");
		});
	}

	it("runs everything for an empty diff instead of passing vacuously", () => {
		assert.equal(affectedLanes([], present).mode, "all");
		assert.equal(affectedLanes(["", "  "], present).mode, "all");
	});

	it("runs everything when a changed package was deleted", () => {
		const lanes = affectedLanes(["packages/gone/src/a.ts"], () => false);
		assert.equal(lanes.mode, "all");
	});

	it("runs everything when only pnpm-lock.yaml changes", () => {
		assert.equal(affectedLanes(["pnpm-lock.yaml"], present).mode, "all");
	});

	it("filters packages when pnpm-lock.yaml changes alongside them", () => {
		const lanes = affectedLanes(
			["pnpm-lock.yaml", "packages/ci/src/a.ts"],
			present,
		);
		assert.deepEqual(lanes, {
			mode: "filtered",
			filters: ["--filter=./packages/ci"],
		});
	});

	it("filters exactly the changed packages and examples", () => {
		const lanes = affectedLanes(
			["packages/ci/src/a.ts", "packages/ci/README.md", "examples/hello/x.ts"],
			present,
		);
		assert.deepEqual(lanes, {
			mode: "filtered",
			filters: ["--filter=./examples/hello", "--filter=./packages/ci"],
		});
	});

	it("filters a package inside a workspace group, not the whole workspace", () => {
		const lanes = affectedLanes(
			[
				"packages/providers/provider-neon/test/a.test.ts",
				"packages/iac/iac-pulumi/src/a.ts",
			],
			present,
		);
		assert.deepEqual(lanes, {
			mode: "filtered",
			filters: [
				"--filter=./packages/iac/iac-pulumi",
				"--filter=./packages/providers/provider-neon",
			],
		});
	});

	it("runs everything for a group-level file or a deleted grouped package", () => {
		assert.equal(
			affectedLanes(["packages/providers/README.md"], present).mode,
			"all",
		);
		const gone = affectedLanes(
			["packages/providers/provider-gone/src/a.ts"],
			(path) => path !== "packages/providers/provider-gone/package.json",
		);
		assert.equal(gone.mode, "all");
	});

	it("reads every packages/<group>/* entry of pnpm-workspace.yaml as a group", () => {
		const groups = workspaceGroups(
			readFileSync(
				new URL("../../pnpm-workspace.yaml", import.meta.url),
				"utf8",
			),
		);
		for (const group of [
			"packages/adapters",
			"packages/connectors",
			"packages/runtimes",
			"packages/providers",
			"packages/packs",
			"packages/iac",
		])
			assert.ok(groups.has(group), group);
		assert.ok(!groups.has("packages"));
		assert.ok(!groups.has("examples"));
		assert.ok(![...groups].some((group) => group.startsWith("src/")));
	});

	it("a package change is never dropped by an inert sibling", () => {
		const lanes = affectedLanes(
			["docs/x.md", "packages/hobo/src/a.ts"],
			present,
		);
		assert.equal(lanes.mode, "filtered");
	});

	it("filters a package alongside a scripts-only package.json change", () => {
		const files = {
			"package.json": {
				base: JSON.stringify({ name: "hobo", scripts: { "test:unit": "old" } }),
				head: JSON.stringify({ name: "hobo", scripts: { "test:unit": "new" } }),
			},
		};
		assert.deepEqual(
			lanesWithRoots(["package.json", "packages/cli/src/a.ts"], files),
			{ mode: "filtered", filters: ["--filter=./packages/cli"] },
		);
	});

	it("skips a scripts-only package.json change without package paths", () => {
		const files = {
			"package.json": {
				base: JSON.stringify({ scripts: { "test:unit:draft:0": "old" } }),
				head: JSON.stringify({ scripts: { "test:unit:draft:0": "new" } }),
			},
		};
		assert.equal(lanesWithRoots(["package.json"], files).mode, "skip");
	});

	it("runs everything when package.json devDependencies change", () => {
		const files = {
			"package.json": {
				base: JSON.stringify({ devDependencies: { tsx: "1" } }),
				head: JSON.stringify({ devDependencies: { tsx: "2" } }),
			},
		};
		assert.equal(lanesWithRoots(["package.json"], files).mode, "all");
	});

	it("does not widen for a turbo.json root task change", () => {
		const files = {
			"turbo.json": {
				base: JSON.stringify({
					tasks: { build: {}, "//#test:unit:root:0": { inputs: ["old"] } },
				}),
				head: JSON.stringify({
					tasks: { build: {}, "//#test:unit:root:0": { inputs: ["new"] } },
				}),
			},
		};
		assert.deepEqual(
			lanesWithRoots(["turbo.json", "packages/cli/src/a.ts"], files),
			{ mode: "filtered", filters: ["--filter=./packages/cli"] },
		);
	});

	it("does not widen for a turbo.json globalDependencies change", () => {
		const files = {
			"turbo.json": {
				base: JSON.stringify({ globalDependencies: ["turbo.json"] }),
				head: JSON.stringify({ globalDependencies: [] }),
			},
		};
		assert.equal(lanesWithRoots(["turbo.json"], files).mode, "skip");
	});

	it("runs everything when turbo.json globalEnv changes", () => {
		const files = {
			"turbo.json": {
				base: JSON.stringify({ globalEnv: [] }),
				head: JSON.stringify({ globalEnv: ["CI"] }),
			},
		};
		assert.equal(lanesWithRoots(["turbo.json"], files).mode, "all");
	});

	it("runs everything when a non-root turbo.json task changes", () => {
		const files = {
			"turbo.json": {
				base: JSON.stringify({ tasks: { test: { inputs: ["old"] } } }),
				head: JSON.stringify({ tasks: { test: { inputs: ["new"] } } }),
			},
		};
		assert.equal(lanesWithRoots(["turbo.json"], files).mode, "all");
	});

	it("runs everything for missing or unparsable root versions", () => {
		const cases: Readonly<Record<string, RootVersions>>[] = [
			{ "package.json": { head: JSON.stringify({ scripts: {} }) } },
			{ "package.json": { base: "{", head: JSON.stringify({ scripts: {} }) } },
			{ "turbo.json": { base: JSON.stringify({ tasks: {} }), head: "{" } },
		];
		for (const [index, files] of cases.entries()) {
			const path = index === 2 ? "turbo.json" : "package.json";
			assert.equal(lanesWithRoots([path], files).mode, "all");
		}
	});

	it("keeps this branch's root-script and root-task diff package-scoped", () => {
		const files = {
			"package.json": {
				base: JSON.stringify({ scripts: { "test:unit:draft:0": "0/4" } }),
				head: JSON.stringify({
					scripts: { "test:unit:draft:0": "0/9", "test:unit:draft:8": "8/9" },
				}),
			},
			"turbo.json": {
				base: JSON.stringify({
					globalDependencies: ["turbo.json"],
					tasks: {
						build: { dependsOn: ["^build"] },
						"//#test:unit:draft:0": { inputs: ["src/draft/**"] },
					},
				}),
				head: JSON.stringify({
					globalDependencies: [],
					tasks: {
						build: { dependsOn: ["^build"] },
						"//#test:unit:draft:0": { inputs: ["src/draft/epic-proofs/**"] },
						"//#test:unit:draft:8": { inputs: ["src/draft/projects/**"] },
					},
				}),
			},
		};
		assert.deepEqual(
			lanesWithRoots(
				[
					"package.json",
					"turbo.json",
					"packages/cli/src/a.ts",
					"packages/pricing/test/a.test.ts",
				],
				files,
			),
			{
				mode: "filtered",
				filters: ["--filter=./packages/cli", "--filter=./packages/pricing"],
			},
		);
	});

	it("CLI prints --filter=* for workspace-wide changes and nothing for inert ones", () => {
		const run = (input: string): string =>
			execFileSync(
				"node",
				[
					"--experimental-strip-types",
					"--no-warnings",
					"scripts/ci/affected-lanes.mts",
				],
				{
					encoding: "utf8",
					input,
					stdio: ["pipe", "pipe", "ignore"],
				},
			);
		assert.equal(run("pnpm-lock.yaml\n"), "--filter=*\n");
		assert.equal(run("package.json\n"), "--filter=*\n");
		assert.equal(run("turbo.json\n"), "--filter=*\n");
		assert.equal(run("README.md\n"), "");
		assert.equal(run("packages/ci/src/a.ts\n"), "--filter=./packages/ci\n");
	});
});

describe("main-gate scope", () => {
	it("is affected-only for package, script, doc and proof changes", () => {
		for (const paths of [
			["packages/ci/src/a.ts"],
			["scripts/run-tests.ts", "docs/a.md"],
			["src/draft/epic-proofs/x/features/a.feature", "cucumber.yaml"],
			[".github/workflows/hobo-ci.yml"],
			[".github/actions/turbo-cache/action.yml", "docs/ci/performance.md"],
		])
			assert.deepEqual(mainGateScope(paths, present), { mode: "affected" });
	});

	it("passes root readers through to affected-lane scoping", () => {
		const files = {
			"package.json": {
				base: JSON.stringify({ scripts: { "test:unit": "old" } }),
				head: JSON.stringify({ scripts: { "test:unit": "new" } }),
			},
		};
		assert.deepEqual(
			mainGateScope(["package.json"], present, rootReader(files)),
			{ mode: "affected" },
		);
	});

	for (const path of [
		"mise.lock",
		"mise.toml",
		"pnpm-lock.yaml",
		"package.json",
		"turbo.json",
	]) {
		it(`is repo-wide when ${path} changes`, () => {
			assert.equal(
				mainGateScope(["README.md", path], present).mode,
				"repo-wide",
			);
		});
	}

	it("is repo-wide for an empty diff or a deleted package", () => {
		assert.equal(mainGateScope([], present).mode, "repo-wide");
		assert.equal(
			mainGateScope(["packages/gone/src/a.ts"], () => false).mode,
			"repo-wide",
		);
	});

	it("CLI prints the scope", () => {
		const run = (input: string): string =>
			execFileSync(
				"node",
				[
					"--experimental-strip-types",
					"--no-warnings",
					"scripts/ci/affected-lanes.mts",
					"--main-gate",
				],
				{ encoding: "utf8", input, stdio: ["pipe", "pipe", "ignore"] },
			);
		assert.equal(run("packages/ci/src/a.ts\n"), "affected\n");
		assert.equal(run(".github/workflows/hobo-ci.yml\n"), "affected\n");
		assert.equal(run("mise.lock\n"), "repo-wide\n");
	});

	it("always checks generated-output drift on main pushes", () => {
		const workflow = readFileSync(".github/workflows/hobo-ci.yml", "utf8");
		const mainStart = workflow.indexOf("  main-gate:");
		const main = workflow.slice(
			mainStart,
			workflow.indexOf("  artifact-trust:", mainStart),
		);
		assert.match(
			main,
			/- name: Generated-output drift\n\s+if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\n\s+timeout-minutes: 8\n\s+run: >-\n\s+pnpm run codegen:check &&\n\s+pnpm --filter @hobo-draft\/s0-04-protobuf-cue-codegen test/u,
		);
	});

	it("a scoped turbo run leaves an unrelated package out", () => {
		const plan = execFileSync(
			"node_modules/.bin/turbo",
			["run", "test", "--filter=...{./packages/ci-dagger}", "--dry=json"],
			{ encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
		);
		const tasks = [...plan.matchAll(/"taskId":\s*"([^"]+)"/g)].map(
			(match) => match[1],
		);
		assert.ok(tasks.includes("@hobo/ci-dagger#test"));
		assert.ok(!tasks.includes("@hobo/storage-sqlite#test"));
	});
});
