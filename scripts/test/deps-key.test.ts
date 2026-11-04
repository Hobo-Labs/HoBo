import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
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
		miseLock,
		platform: "linux/arm64",
		toolchainVersion: "v0123456789ab",
	};
}

describe("deps key", () => {
	it("sorts importers and emits a toolchain-qualified short digest", () => {
		expect(listWorkspaceImporters(lockfile)).toEqual([
			".",
			"packages/a",
			"packages/b",
		]);
		expect(depsKeyFromInputs(inputs())).toMatch(/^v0123456789ab-[0-9a-f]{16}$/);
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
			expect(depsKeyFromInputs(mutate()), name).not.toBe(base);
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
			expect(key()).toBe(before);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
