import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
import {
	DEPS_LAYER_BUCKET_SCRIPT_PATH,
	DEPS_LAYOUT,
	DEPS_LAYOUT_RECIPE_PATHS,
	type DepsKeyInputs,
	depsContextPaths,
	depsKeyForRoot,
	depsKeyFromInputs,
	depsLayoutRecipeSha256,
	listWorkspaceImporters,
	readDepsContextFiles,
} from "../lib/deps-key.mts";

const lockfile = `lockfileVersion: '9.0'
importers:
  packages/a:
    dependencies: {}
  .:
    devDependencies: {}
  packages/b:
    dependencies: {}
packages: {}
`;
const workspace = `packages:
  - "packages/*"
`;
const miseLock = `lockfile_version = 3
[[tools.node]]
version = "24.0.0"
[tools.node."platforms.linux-arm64"]
checksum = "sha256:node"
[[tools.pnpm]]
version = "10.0.0"
[tools.pnpm."platforms.linux-arm64"]
checksum = "sha256:pnpm"
[[tools.turbo]]
version = "2.0.0"
`;

function inputs(): DepsKeyInputs {
	return {
		lockfile,
		workspace,
		npmrc: "package-import-method=copy\n",
		pnpmfile: "module.exports = { hooks: {} };\n",
		patches: { "patches/a.patch": "patch a\n" },
		manifests: {
			"package.json": '{"name":"root"}\n',
			"packages/a/package.json": '{"name":"a"}\n',
			"packages/b/package.json": '{"name":"b"}\n',
		},
		platform: "linux/arm64",
		toolchainVersion: "v0123456789ab",
	};
}

describe("deps key", () => {
	it("sorts importers and emits a toolchain-qualified short digest", () => {
		assert.deepEqual(listWorkspaceImporters(lockfile), [
			".",
			"packages/a",
			"packages/b",
		]);
		assert.match(depsKeyFromInputs(inputs()), /^v0123456789ab-[0-9a-f]{16}$/);
	});

	it("accepts an explicit toolchain for the CLI key", () => {
		const root = join(import.meta.dirname, "..", "..");
		const toolchain = "v1123456789ab";
		const key = execFileSync(
			process.execPath,
			["--no-warnings", "scripts/ci/deps-key.mts", "--toolchain", toolchain],
			{ cwd: root, encoding: "utf8" },
		).trim();
		assert.match(key, /^v1123456789ab-[0-9a-f]{16}$/);
	});

	it("changes for every declared input", () => {
		const base = depsKeyFromInputs(inputs());
		const mutations = {
			lockfile: () => ({ ...inputs(), lockfile: `# changed\n${lockfile}` }),
			workspace: () => ({ ...inputs(), workspace: `${workspace}# changed\n` }),
			npmrc: () => ({ ...inputs(), npmrc: "fetch-retries=1\n" }),
			"absent npmrc": () => {
				const { npmrc, ...value } = inputs();
				void npmrc;
				return value;
			},
			pnpmfile: () => ({
				...inputs(),
				pnpmfile: "module.exports = { hooks: { readPackage: () => {} } };\n",
			}),
			"absent pnpmfile": () => {
				const { pnpmfile, ...value } = inputs();
				void pnpmfile;
				return value;
			},
			patch: () => ({
				...inputs(),
				patches: { "patches/a.patch": "patch b\n" },
			}),
			"new patch": () => ({
				...inputs(),
				patches: { ...inputs().patches, "patches/b.patch": "patch b\n" },
			}),
			"root manifest": () => ({
				...inputs(),
				manifests: {
					...inputs().manifests,
					"package.json": '{"name":"changed"}\n',
				},
			}),
			"first workspace manifest": () => ({
				...inputs(),
				manifests: {
					...inputs().manifests,
					"packages/a/package.json": '{"name":"changed"}\n',
				},
			}),
			"second workspace manifest": () => ({
				...inputs(),
				manifests: {
					...inputs().manifests,
					"packages/b/package.json": '{"name":"changed"}\n',
				},
			}),
			platform: () => ({ ...inputs(), platform: "linux/amd64" }),
			toolchain: () => ({ ...inputs(), toolchainVersion: "v1123456789ab" }),
		} satisfies Record<string, () => DepsKeyInputs>;
		for (const [name, mutate] of Object.entries(mutations))
			assert.notEqual(depsKeyFromInputs(mutate()), base, name);
	});

	it("changes for every dependency-layout manifest field", () => {
		const base = depsKeyFromInputs(inputs());
		const fields = {
			name: "changed",
			version: "1.0.0",
			dependencies: { "left-pad": "1.0.0" },
			devDependencies: { typescript: "5.0.0" },
			optionalDependencies: { esbuild: "0.25.0" },
			peerDependencies: { react: "19.0.0" },
			peerDependenciesMeta: { react: { optional: true } },
			dependenciesMeta: { esbuild: { injected: true } },
			bundleDependencies: ["left-pad"],
			bundledDependencies: ["left-pad"],
			bin: { hobo: "cli.js" },
			directories: { bin: "bin" },
			publishConfig: {
				directory: "dist",
				bin: { hobo: "dist/cli.js" },
				linkDirectory: true,
			},
			os: ["linux"],
			cpu: ["arm64"],
			libc: ["glibc"],
			engines: { node: ">=22" },
			devEngines: {
				runtime: { name: "node", version: "24.0.0", onFail: "download" },
			},
			packageManager: "pnpm@10.0.0",
			workspaces: ["packages/*"],
			overrides: { esbuild: "0.25.0" },
			resolutions: { esbuild: "0.25.0" },
			pnpm: { overrides: { esbuild: "0.25.0" } },
		};
		for (const [field, fieldValue] of Object.entries(fields)) {
			const value = inputs();
			assert.notEqual(
				depsKeyFromInputs({
					...value,
					manifests: {
						...value.manifests,
						"package.json": `${JSON.stringify({ name: "root", [field]: fieldValue })}\n`,
					},
				}),
				base,
				field,
			);
		}
	});

	it("ignores metadata and non-root pnpm fields", () => {
		const base = depsKeyFromInputs(inputs());
		const ignoredFields = {
			scripts: { prepare: "node prepare.js" },
			description: "changed",
			exports: { ".": "./index.js" },
			main: "./index.js",
			types: "./index.d.ts",
			files: ["dist"],
			keywords: ["changed"],
			repository: { type: "git", url: "https://example.test/repo.git" },
			license: "MIT",
			unlistedField: { dropped: true },
			publishConfig: { access: "public", executableFiles: ["dist/cli.js"] },
			directories: { lib: "lib" },
		};
		for (const [field, fieldValue] of Object.entries(ignoredFields)) {
			const value = inputs();
			assert.equal(
				depsKeyFromInputs({
					...value,
					manifests: {
						...value.manifests,
						"package.json": `${JSON.stringify({ name: "root", [field]: fieldValue })}\n`,
					},
				}),
				base,
				field,
			);
		}
		const value = inputs();
		assert.equal(
			depsKeyFromInputs({
				...value,
				manifests: {
					...value.manifests,
					"packages/a/package.json": `${JSON.stringify({ name: "a", pnpm: { overrides: { esbuild: "0.25.0" } } })}\n`,
				},
			}),
			base,
			"workspace pnpm",
		);
	});

	function writeFixture(root: string, value: DepsKeyInputs): void {
		if (!value.npmrc) throw new Error("fixture npmrc missing");
		if (!value.pnpmfile) throw new Error("fixture pnpmfile missing");
		const files = {
			"pnpm-lock.yaml": value.lockfile,
			"pnpm-workspace.yaml": value.workspace,
			"mise.lock": miseLock,
			".npmrc": value.npmrc,
			".pnpmfile.cjs": value.pnpmfile,
			[DEPS_LAYOUT_RECIPE_PATHS[0]]: "fetch and install\n",
			[DEPS_LAYOUT_RECIPE_PATHS[1]]: "build and verify\n",
			[DEPS_LAYOUT_RECIPE_PATHS[2]]: "partition layers\n",
			"scripts/ci/deps-layer.mts": "link and verify\n",
			...value.patches,
			...value.manifests,
		} satisfies Record<string, string>;
		for (const [path, text] of Object.entries(files)) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), text);
		}
	}

	function fixtureKey(
		root: string,
		platform = "linux/arm64",
		toolchainVersion = "v0123456789ab",
	): string {
		return depsKeyForRoot(root, platform, toolchainVersion);
	}

	it("does not change for an unrelated file", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-key-"));
		try {
			writeFixture(root, inputs());
			const before = fixtureKey(root);
			writeFileSync(join(root, "README.md"), "unrelated\n");
			assert.equal(fixtureKey(root), before);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not change for layout recipes, link verification, or mise tool edits", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-key-"));
		try {
			writeFixture(root, inputs());
			const before = fixtureKey(root);
			const mutations = [
				{
					name: "deps Dockerfile",
					path: DEPS_LAYOUT_RECIPE_PATHS[0],
					contents: "changed install\n",
				},
				{
					name: "deps build script",
					path: DEPS_LAYOUT_RECIPE_PATHS[1],
					contents: "changed build\n",
				},
				{
					name: "deps bucket generator",
					path: DEPS_LAYOUT_RECIPE_PATHS[2],
					contents: "changed partition\n",
				},
				{
					name: "deps link and check script",
					path: "scripts/ci/deps-layer.mts",
					contents: "changed link and check\n",
				},
				{
					name: "node mise entry",
					path: "mise.lock",
					contents: miseLock.replace("24.0.0", "24.0.1"),
				},
				{
					name: "pnpm mise entry",
					path: "mise.lock",
					contents: miseLock.replace("10.0.0", "10.0.1"),
				},
			];
			for (const mutation of mutations) {
				writeFileSync(join(root, mutation.path), mutation.contents);
				assert.equal(fixtureKey(root), before, mutation.name);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("changes for dependency, platform, and toolchain edits on disk", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-key-"));
		try {
			const value = inputs();
			const assertChanges = (name: string, mutate: () => void): void => {
				writeFixture(root, value);
				const before = fixtureKey(root);
				mutate();
				assert.notEqual(fixtureKey(root), before, name);
			};
			assertChanges("dependency field", () => {
				writeFileSync(
					join(root, "package.json"),
					'{"name":"root","dependencies":{"left-pad":"1.0.0"}}\n',
				);
			});
			assertChanges("lockfile", () => {
				writeFileSync(join(root, "pnpm-lock.yaml"), `# changed\n${lockfile}`);
			});
			assertChanges("workspace", () => {
				writeFileSync(
					join(root, "pnpm-workspace.yaml"),
					`${workspace}# changed\n`,
				);
			});
			assertChanges("npmrc", () => {
				writeFileSync(join(root, ".npmrc"), "fetch-retries=1\n");
			});
			assertChanges("patch", () => {
				writeFileSync(join(root, "patches/a.patch"), "patch b\n");
			});
			writeFixture(root, value);
			assert.notEqual(
				fixtureKey(root, "linux/amd64"),
				fixtureKey(root),
				"platform",
			);
			assert.notEqual(
				fixtureKey(root, "linux/arm64", "v1123456789ab"),
				fixtureKey(root),
				"toolchainVersion",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("stages the bucket script without the link verification script", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-key-"));
		try {
			writeFixture(root, inputs());
			const paths = depsContextPaths(root);
			const files = readDepsContextFiles(root);
			assert.ok(!paths.includes("scripts/ci/deps-layer.mts"));
			assert.ok(paths.includes(DEPS_LAYER_BUCKET_SCRIPT_PATH));
			assert.equal(files["scripts/ci/deps-layer.mts"], undefined);
			assert.equal(files[DEPS_LAYER_BUCKET_SCRIPT_PATH], "partition layers\n");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("pins the layout recipe digest and its bump-or-update rule", () => {
		const root = join(import.meta.dirname, "..", "..");
		assert.equal(
			depsLayoutRecipeSha256(root),
			DEPS_LAYOUT.recipeSha256,
			"Layout recipe changed: bump DEPS_LAYOUT.version when the edit changes image contents or paths (payload paths, install flags, rebuilt packages, or bucket assignment); otherwise update only DEPS_LAYOUT.recipeSha256.",
		);
	});

	it("keeps the key and staged context bytes stable for metadata edits", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-key-"));
		try {
			const value = inputs();
			writeFixture(root, value);
			const cli = join(import.meta.dirname, "..", "ci", "deps-key.mts");
			const run = (stage: string) =>
				execFileSync(
					process.execPath,
					[
						"--no-warnings",
						cli,
						"--toolchain",
						value.toolchainVersion,
						"--stage",
						stage,
					],
					{ cwd: root, encoding: "utf8" },
				).trim();
			const beforePaths = depsContextPaths(root);
			const before = run(join(root, "stage-before"));

			writeFileSync(
				join(root, "package.json"),
				`${JSON.stringify(
					{
						name: "root",
						scripts: { prepare: "node prepare.js" },
						description: "changed",
						exports: { ".": "./index.js" },
						publishConfig: { access: "public" },
						directories: { lib: "lib" },
					},
					null,
					2,
				)}\n`,
			);
			writeFileSync(
				join(root, "packages/a/package.json"),
				`${JSON.stringify(
					{
						name: "a",
						scripts: { postinstall: "node install.js" },
						description: "changed",
						exports: { ".": "./index.js" },
						pnpm: { overrides: { esbuild: "0.25.0" } },
					},
					null,
					2,
				)}\n`,
			);
			const afterPaths = depsContextPaths(root);
			const after = run(join(root, "stage-after"));

			assert.equal(after, before);
			assert.deepEqual(afterPaths, beforePaths);
			for (const path of beforePaths) {
				assert.deepEqual(
					readFileSync(join(root, "stage-after", path)),
					readFileSync(join(root, "stage-before", path)),
					path,
				);
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
