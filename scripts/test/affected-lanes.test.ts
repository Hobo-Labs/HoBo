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

	for (const { change, base, head } of [
		{
			change: "added",
			base: { globalDependencies: [] },
			head: { globalDependencies: ["ci.json"] },
		},
		{
			change: "removed",
			base: { globalDependencies: ["turbo.json"] },
			head: { globalDependencies: [] },
		},
	]) {
		it(`runs everything when a turbo.json globalDependencies entry is ${change}`, () => {
			const files = {
				"turbo.json": {
					base: JSON.stringify(base),
					head: JSON.stringify(head),
				},
			};
			assert.deepEqual(lanesWithRoots(["turbo.json"], files), {
				mode: "all",
				reason: "workspace-wide input changed: turbo.json",
			});
			assert.deepEqual(
				mainGateScope(["turbo.json"], present, rootReader(files)),
				{
					mode: "repo-wide",
					reason: "workspace-wide input changed: turbo.json",
				},
			);
		});
	}

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

	const branchDiffPaths = [
		"package.json",
		"turbo.json",
		"packages/cli/src/a.ts",
		"packages/pricing/test/a.test.ts",
	];

	function branchDiffFiles(globalDependencies?: {
		readonly base: readonly string[];
		readonly head: readonly string[];
	}) {
		return {
			"package.json": {
				base: JSON.stringify({ scripts: { "test:unit:draft:0": "0/4" } }),
				head: JSON.stringify({
					scripts: { "test:unit:draft:0": "0/9", "test:unit:draft:8": "8/9" },
				}),
			},
			"turbo.json": {
				base: JSON.stringify({
					globalDependencies: globalDependencies?.base,
					tasks: {
						build: { dependsOn: ["^build"] },
						"//#test:unit:draft:0": { inputs: ["src/draft/**"] },
					},
				}),
				head: JSON.stringify({
					globalDependencies: globalDependencies?.head,
					tasks: {
						build: { dependsOn: ["^build"] },
						"//#test:unit:draft:0": { inputs: ["src/draft/epic-proofs/**"] },
						"//#test:unit:draft:8": { inputs: ["src/draft/projects/**"] },
					},
				}),
			},
		};
	}

	it("widens this branch's diff for its globalDependencies removal", () => {
		assert.deepEqual(
			lanesWithRoots(
				branchDiffPaths,
				branchDiffFiles({ base: ["turbo.json"], head: [] }),
			),
			{ mode: "all", reason: "workspace-wide input changed: turbo.json" },
		);
	});

	it("keeps this branch's scripts and root tasks scoped without the globalDependencies edit", () => {
		assert.deepEqual(lanesWithRoots(branchDiffPaths, branchDiffFiles()), {
			mode: "filtered",
			filters: ["--filter=./packages/cli", "--filter=./packages/pricing"],
		});
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

	describe("toolchain pins", () => {
		const TOML = [
			"[tools]",
			'cue = "0.14.0"',
			'gitleaks = "8.22.1"',
			'node = "24"',
			'pnpm = "10.33.4"',
			'shellcheck = "0.10.0"',
			'turbo = "2.11.10"',
			"",
			"[env]",
			'HOBO_MISE = "1"',
			"",
		].join("\n");
		const LOCK = [
			"lockfile_version = 3",
			"",
			"[[tools.node]]",
			'version = "24.22.2"',
			'backend = "core:node"',
			"",
			'[tools.node."platforms.linux-x64"]',
			'checksum = "sha256:aaaa"',
			"",
			"[[tools.turbo]]",
			'version = "2.11.10"',
			"",
		].join("\n");
		const SYFT_LOCK = [
			"[[tools.syft]]",
			'version = "1.56.0"',
			'backend = "aqua:anchore/syft"',
			"",
			'[tools.syft."platforms.linux-x64"]',
			'checksum = "sha256:bbbb"',
			"",
		].join("\n");
		const withSyft = TOML.replace(
			'shellcheck = "0.10.0"',
			'shellcheck = "0.10.0"\nsyft = "1.56.0"',
		);
		const lanes = (head: string, paths = ["mise.toml"]) =>
			lanesWithRoots(paths, { "mise.toml": { base: TOML, head } });

		it("does not run the workspace for a pin no package task runs", () => {
			assert.equal(lanes(withSyft).mode, "skip");
			assert.deepEqual(lanes(withSyft, ["mise.toml", "packages/ci/src/a.ts"]), {
				mode: "filtered",
				filters: ["--filter=./packages/ci"],
			});
			// Bumping or dropping one is the same kind of edit.
			assert.equal(
				lanes(TOML.replace('gitleaks = "8.22.1"', 'gitleaks = "8.23.0"')).mode,
				"skip",
			);
			assert.equal(
				lanes(TOML.replace('shellcheck = "0.10.0"\n', "")).mode,
				"skip",
			);
		});

		it("runs the workspace when a tool package tasks run changes", () => {
			for (const head of [
				TOML.replace('node = "24"', 'node = "26"'),
				TOML.replace('pnpm = "10.33.4"', 'pnpm = "10.34.0"'),
				TOML.replace('turbo = "2.11.10"', 'turbo = "2.12.0"'),
				TOML.replace('cue = "0.14.0"', 'cue = "0.15.0"'),
			])
				assert.equal(lanes(head).mode, "all");
		});

		it("runs the workspace for an unlisted tool, another section or a missing side", () => {
			assert.equal(
				lanes(TOML.replace("[env]", 'zig = "0.13.0"\n\n[env]')).mode,
				"all",
			);
			assert.equal(
				lanes(withSyft.replace('HOBO_MISE = "1"', 'HOBO_MISE = "0"')).mode,
				"all",
			);
			// A CI-only name outside [tools] is not a pin.
			assert.equal(lanes(`${TOML}\n[env]\nsyft = "1"\n`).mode, "all");
			assert.equal(
				lanesWithRoots(["mise.toml"], {
					"mise.toml": { head: withSyft },
				}).mode,
				"all",
			);
			assert.equal(affectedLanes(["mise.toml"], present).mode, "all");
		});

		it("keeps the main gate affected-only for a CI-only lock entry", () => {
			const scope = (head: string, toml = withSyft) =>
				mainGateScope(
					["mise.lock", "mise.toml"],
					present,
					rootReader({
						"mise.toml": { base: TOML, head: toml },
						"mise.lock": { base: LOCK, head },
					}),
				).mode;
			assert.equal(
				scope(LOCK.replace("[[tools.turbo]]", `${SYFT_LOCK}\n[[tools.turbo]]`)),
				"affected",
			);
			assert.equal(scope(LOCK.replace("24.22.2", "24.23.0")), "repo-wide");
			assert.equal(
				scope(LOCK.replace("sha256:aaaa", "sha256:cccc")),
				"repo-wide",
			);
			// The lock is CI-only but the manifest moved a real tool.
			assert.equal(
				scope(LOCK, TOML.replace('node = "24"', 'node = "26"')),
				"repo-wide",
			);
		});

		it("ends a CI-only block at a commented header and reads a quoted name whole", () => {
			const scope = (base: string, head: string) =>
				mainGateScope(
					["mise.lock"],
					present,
					rootReader({ "mise.lock": { base, head } }),
				).mode;
			// The node block follows syft's; its header carries a comment.
			const commented = `${SYFT_LOCK}\n${LOCK.replace("[[tools.node]]", "[[tools.node]] # pinned")}`;
			assert.equal(
				scope(commented, commented.replace("24.22.2", "24.23.0")),
				"repo-wide",
			);
			// `syft.plugin` is another tool, not syft.
			const plugin = `${LOCK}\n[[tools."syft.plugin"]]\nversion = "1"\n`;
			assert.equal(
				scope(plugin, plugin.replace('version = "1"', 'version = "2"')),
				"repo-wide",
			);
			// [tools] ends at `[env] # shell`: the key below it is an env var.
			const env = `${TOML.replace("[env]", "[env] # shell")}syft = "1"\n`;
			assert.equal(
				lanesWithRoots(["mise.toml"], {
					"mise.toml": {
						base: env,
						head: env.replace('syft = "1"', 'syft = "2"'),
					},
				}).mode,
				"all",
			);
		});
	});

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

	it("checks affected generated-output drift on main pushes", () => {
		const workflow = readFileSync(".github/workflows/hobo-ci.yml", "utf8");
		const mainStart = workflow.indexOf("  main-gate:");
		const main = workflow.slice(
			mainStart,
			workflow.indexOf("  artifact-trust:", mainStart),
		);
		assert.match(
			main,
			/- name: Generated-output drift\n\s+if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\n\s+timeout-minutes: 8\n\s+run: >-\n\s+pnpm run codegen:check:affected &&\n\s+pnpm exec turbo run test --filter=@hobo-draft\/s0-04-protobuf-cue-codegen --concurrency=100%/u,
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
