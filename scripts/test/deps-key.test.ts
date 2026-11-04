import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
	DEPS_BUILD_RECIPE_PATHS,
	type DepsKeyInputs,
	depsKeyFromInputs,
	listWorkspaceImporters,
	readDepsInputs,
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
		buildRecipe: {
			[DEPS_BUILD_RECIPE_PATHS[0]]: "fetch and install\n",
			[DEPS_BUILD_RECIPE_PATHS[1]]: "build and verify\n",
			[DEPS_BUILD_RECIPE_PATHS[2]]: "partition layers\n",
		},
		miseLock,
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
			"deps Dockerfile": () => ({
				...inputs(),
				buildRecipe: {
					...inputs().buildRecipe,
					[DEPS_BUILD_RECIPE_PATHS[0]]: "changed install\n",
				},
			}),
			"deps build script": () => ({
				...inputs(),
				buildRecipe: {
					...inputs().buildRecipe,
					[DEPS_BUILD_RECIPE_PATHS[1]]: "changed build\n",
				},
			}),
			"deps bucket generator": () => ({
				...inputs(),
				buildRecipe: {
					...inputs().buildRecipe,
					[DEPS_BUILD_RECIPE_PATHS[2]]: "changed partition\n",
				},
			}),
			node: () => ({
				...inputs(),
				miseLock: miseLock.replace("24.0.0", "24.0.1"),
			}),
			pnpm: () => ({
				...inputs(),
				miseLock: miseLock.replace("10.0.0", "10.0.1"),
			}),
			platform: () => ({ ...inputs(), platform: "linux/amd64" }),
			toolchain: () => ({ ...inputs(), toolchainVersion: "v1123456789ab" }),
		} satisfies Record<string, () => DepsKeyInputs>;
		for (const [name, mutate] of Object.entries(mutations))
			assert.notEqual(depsKeyFromInputs(mutate()), base, name);
	});

	it("does not change for an unrelated file", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-deps-key-"));
		try {
			const value = inputs();
			if (!value.npmrc) throw new Error("fixture npmrc missing");
			if (!value.pnpmfile) throw new Error("fixture pnpmfile missing");
			const files = {
				"pnpm-lock.yaml": value.lockfile,
				"pnpm-workspace.yaml": value.workspace,
				"mise.lock": value.miseLock,
				".npmrc": value.npmrc,
				".pnpmfile.cjs": value.pnpmfile,
				...value.patches,
				...value.manifests,
				...value.buildRecipe,
			} satisfies Record<string, string>;
			for (const [path, text] of Object.entries(files)) {
				mkdirSync(dirname(join(root, path)), { recursive: true });
				writeFileSync(join(root, path), text);
			}
			const key = () =>
				depsKeyFromInputs({
					...readDepsInputs(root, "linux/arm64"),
					toolchainVersion: "v0123456789ab",
				});
			const before = key();
			writeFileSync(join(root, "README.md"), "unrelated\n");
			assert.equal(key(), before);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
