import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadNpmScopeMap } from "../ci/npm-publish-scope.mts";
import { SDK_PACKAGES } from "../ci/sdk-package-list.mts";

import {
	assertCompleteSdkManifest,
	checkDependencyProtocols,
	packOfflineDependency,
	verifyCliProvenance,
	verifyCliSdkArtifacts,
} from "../ci/verify-cli-sdk-artifacts.mts";

test("rejects missing CLI and unsafe artifact names before installation", async () => {
	const root = await mkdtemp(join(tmpdir(), "hobo-cli-verify-"));
	try {
		await writeFile(
			join(root, "MANIFEST.json"),
			JSON.stringify({ version: "1.0.0", packages: [] }),
		);
		await assert.rejects(verifyCliSdkArtifacts(root, root), /no CLI archive/);
		await writeFile(
			join(root, "MANIFEST.json"),
			JSON.stringify({
				version: "1.0.0",
				packages: [
					{
						workspace: "@hobo/cli",
						public: "@hobo-labs/cli",
						file: "../bad.tgz",
					},
				],
			}),
		);
		await assert.rejects(
			verifyCliSdkArtifacts(root, root),
			/Unsafe SDK artifact name/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects archive asset bytes that differ from the source", async () => {
	const root = await mkdtemp(join(tmpdir(), "hobo-cli-verify-"));
	try {
		const workspace = join(root, "workspace");
		const source = join(workspace, "packages/patterns");
		const packageDir = join(root, "candidate");
		const stage = join(root, "stage");
		for (const name of ["patterns", "atoms", "vocabulary"])
			await mkdir(join(source, name), { recursive: true });
		await mkdir(join(packageDir, "patterns"), { recursive: true });
		await mkdir(stage);
		await writeFile(join(source, "patterns", "data.txt"), "original");
		await writeFile(join(packageDir, "patterns", "data.txt"), "tampered");
		await writeFile(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@hobo-labs/cli",
				version: "1.0.0",
				files: ["patterns", "BUNDLE-PROVENANCE.json"],
			}),
		);
		await writeFile(
			join(packageDir, "BUNDLE-PROVENANCE.json"),
			JSON.stringify({
				assets: {
					"patterns/data.txt": createHash("sha256")
						.update("original")
						.digest("hex"),
				},
			}),
		);
		const packed = JSON.parse(
			execFileSync(
				"npm",
				[
					"pack",
					"--json",
					"--ignore-scripts",
					"--offline",
					"--pack-destination",
					stage,
				],
				{ cwd: packageDir, encoding: "utf8" },
			),
		);
		await writeFile(
			join(stage, "MANIFEST.json"),
			JSON.stringify({
				version: "1.0.0",
				packages: [
					{
						workspace: "@hobo/cli",
						public: "@hobo-labs/cli",
						file: packed[0].filename,
					},
				],
			}),
		);
		await assert.rejects(
			verifyCliSdkArtifacts(stage, workspace),
			/archive asset bytes differ/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects remote dependency transports but accepts registry aliases", () => {
	for (const spec of [
		"https://bad.test/a.tgz",
		"git+https://bad.test/a",
		"ssh://bad.test/a",
		"npm:foo@https://bad.test/a.tgz",
		"file:../other",
	]) {
		assert.throws(
			() =>
				checkDependencyProtocols({
					name: "fixture",
					version: "1.0.0",
					dependencies: { dep: spec },
				}),
			/non-registry dependency/,
		);
	}
	assert.doesNotThrow(() =>
		checkDependencyProtocols({
			name: "fixture",
			version: "1.0.0",
			dependencies: { a: "^1.0.0 || ^2.0.0", b: "npm:@hobo-labs/core@1.0.0" },
		}),
	);
});

test("offline dependency packing never runs package lifecycle scripts", async () => {
	const root = await mkdtemp(join(tmpdir(), "hobo-cli-pack-"));
	try {
		const source = join(root, "source");
		const packs = join(root, "packs");
		const cache = join(root, "cache");
		await mkdir(source);
		await mkdir(packs);
		await mkdir(cache);
		await writeFile(
			join(source, "package.json"),
			JSON.stringify({
				name: "unsafe-lifecycle-fixture",
				version: "1.0.0",
				scripts: {
					prepare: "node -e \"throw new Error('lifecycle executed')\"",
				},
			}),
		);
		await writeFile(join(source, "index.js"), "export default 1;\n");
		const archive = await packOfflineDependency(source, packs, cache);
		assert.ok(archive.length > 0);
		const file = join(root, "package.tgz");
		await writeFile(file, archive);
		const packed = JSON.parse(
			execFileSync("tar", ["-xOzf", file, "package/package.json"], {
				encoding: "utf8",
			}),
		);
		assert.equal(packed.scripts, undefined);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("rejects a direct remote dependency in the staged CLI archive", async () => {
	const root = await mkdtemp(join(tmpdir(), "hobo-cli-verify-"));
	try {
		const packageDir = join(root, "candidate");
		const stage = join(root, "stage");
		await mkdir(packageDir);
		await mkdir(stage);
		await writeFile(
			join(packageDir, "package.json"),
			JSON.stringify({
				name: "@hobo-labs/cli",
				version: "1.0.0",
				dependencies: { rogue: "https://bad.test/a.tgz" },
			}),
		);
		const packed = JSON.parse(
			execFileSync(
				"npm",
				[
					"pack",
					"--json",
					"--ignore-scripts",
					"--offline",
					"--pack-destination",
					stage,
				],
				{ cwd: packageDir, encoding: "utf8" },
			),
		);
		await writeFile(
			join(stage, "MANIFEST.json"),
			JSON.stringify({
				version: "1.0.0",
				packages: [
					{
						workspace: "@hobo/cli",
						public: "@hobo-labs/cli",
						file: packed[0].filename,
					},
				],
			}),
		);
		await assert.rejects(
			verifyCliSdkArtifacts(stage, root),
			/non-registry dependency/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("requires the complete SDK allowlist and public names before install", () => {
	const map = loadNpmScopeMap();
	const packages = SDK_PACKAGES.map((workspace, i) => ({
		workspace,
		public: map.packages[workspace] ?? "",
		file: `package-${i}.tgz`,
	}));
	assert.doesNotThrow(() =>
		assertCompleteSdkManifest({ version: "1.0.0", packages }),
	);
	assert.throws(
		() =>
			assertCompleteSdkManifest({
				version: "1.0.0",
				packages: packages.slice(0, -1),
			}),
		/complete ordered SDK allowlist/,
	);
	assert.throws(
		() =>
			assertCompleteSdkManifest({
				version: "1.0.0",
				packages: [...packages, packages[0]!],
			}),
		/complete ordered SDK allowlist/,
	);
	assert.throws(
		() =>
			assertCompleteSdkManifest({
				version: "1.0.0",
				packages: packages.map((p, i) =>
					i === 0 ? { ...p, public: "@hobo-labs/wrong" } : p,
				),
			}),
		/public name mismatch/,
	);
	assert.throws(
		() =>
			assertCompleteSdkManifest({
				version: "1.0.0",
				packages: packages.map((p, i) =>
					i === 0 ? { ...p, file: packages[1]!.file } : p,
				),
			}),
		/Duplicate SDK artifact filename/,
	);
});

test("rejects changed source, declarations, output, license and unrecorded dist files", async () => {
	const root = await mkdtemp(join(tmpdir(), "hobo-cli-provenance-"));
	const workspace = join(root, "workspace");
	const sibling = join(workspace, "external/ts-autocode");
	const packageRoot = join(workspace, "packages/cli");
	const staged = join(root, "staged");
	const git = (cwd: string, args: string[]) =>
		execFileSync("git", ["-C", cwd, ...args], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		}).trim();
	const hash = (value: string) =>
		createHash("sha256").update(value).digest("hex");
	try {
		await mkdir(join(packageRoot, "dist"), { recursive: true });
		await mkdir(sibling, { recursive: true });
		await mkdir(join(staged, "dist"), { recursive: true });
		await writeFile(join(workspace, "LICENSE"), "license");
		await writeFile(
			join(packageRoot, "package.json"),
			JSON.stringify({ name: "@hobo/cli", license: "MIT" }),
		);
		await writeFile(join(packageRoot, "input.ts"), "input");
		await writeFile(
			join(packageRoot, "dist/input.d.ts"),
			"declare const item: string;",
		);
		await writeFile(join(staged, "dist/index.js"), "export const item = 1;");
		await writeFile(join(staged, "LICENSE"), "license");
		git(workspace, ["init", "-q"]);
		git(workspace, ["add", "LICENSE", "packages"]);
		git(workspace, [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-qm",
			"fixture",
		]);
		git(sibling, ["init", "-q"]);
		await writeFile(join(sibling, "fixture"), "fixture");
		git(sibling, ["add", "fixture"]);
		git(sibling, [
			"-c",
			"user.name=Test",
			"-c",
			"user.email=test@example.invalid",
			"commit",
			"-qm",
			"fixture",
		]);
		const provenance = {
			revisions: {
				hobo: git(workspace, ["rev-parse", "HEAD"]),
				tsAutocode: git(sibling, ["rev-parse", "HEAD"]),
			},
			packages: {
				"@hobo/cli": { path: "packages/cli", license: hash("license") },
			},
			sourceHashes: { "packages/cli/input.ts": hash("input") },
			declarationPackages: {
				"@hobo/cli": { path: "packages/cli", license: hash("license") },
			},
			declarationSources: {
				"packages/cli/dist/input.d.ts": hash("declare const item: string;"),
			},
			outputs: { "dist/index.js": hash("export const item = 1;") },
			assets: {},
		};
		await verifyCliProvenance(workspace, staged, provenance);
		await writeFile(join(packageRoot, "input.ts"), "changed");
		await assert.rejects(
			verifyCliProvenance(workspace, staged, provenance),
			/source hash mismatch/,
		);
		await writeFile(join(packageRoot, "input.ts"), "input");
		await writeFile(join(packageRoot, "dist/input.d.ts"), "changed");
		await assert.rejects(
			verifyCliProvenance(workspace, staged, provenance),
			/declaration hash mismatch/,
		);
		await writeFile(
			join(packageRoot, "dist/input.d.ts"),
			"declare const item: string;",
		);
		await writeFile(join(staged, "dist/index.js"), "changed");
		await assert.rejects(
			verifyCliProvenance(workspace, staged, provenance),
			/output hash mismatch/,
		);
		await writeFile(join(staged, "dist/index.js"), "export const item = 1;");
		await writeFile(join(staged, "dist/unrecorded.js"), "extra");
		await assert.rejects(
			verifyCliProvenance(workspace, staged, provenance),
			/dist files differ/,
		);
		await rm(join(staged, "dist/unrecorded.js"));
		await writeFile(join(workspace, "LICENSE"), "changed");
		await assert.rejects(
			verifyCliProvenance(workspace, staged, provenance),
			/license hash mismatch/,
		);
		await writeFile(join(workspace, "LICENSE"), "license");
		await writeFile(join(staged, "LICENSE"), "changed");
		await assert.rejects(
			verifyCliProvenance(workspace, staged, provenance),
			/packed license hash mismatch/,
		);
		await writeFile(join(staged, "LICENSE"), "license");
		await assert.rejects(
			verifyCliProvenance(workspace, staged, {
				...provenance,
				sourceHashes: { "packages/cli/../../LICENSE": hash("license") },
			}),
			/Unsafe CLI provenance path/,
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("offline repack isolates inherited npm credentials, configs and proxies", async () => {
	const root = await mkdtemp(join(tmpdir(), "hobo-cli-npm-env-"));
	const keys = [
		"PATH",
		"HOBO_TEST_SENTINEL",
		"NPM_CONFIG_USERCONFIG",
		"NPM_CONFIG_GLOBALCONFIG",
		"npm_config_registry",
		"HTTPS_PROXY",
	] as const;
	const prior = new Map(keys.map((key) => [key, process.env[key]]));
	try {
		const bin = join(root, "bin");
		const source = join(root, "source");
		const packs = join(root, "packs");
		const cache = join(root, "cache");
		await Promise.all([bin, source, packs, cache].map((dir) => mkdir(dir)));
		await writeFile(
			join(source, "package.json"),
			JSON.stringify({ name: "fixture", version: "1.0.0" }),
		);
		const fakeNpm = join(bin, "npm");
		await writeFile(
			fakeNpm,
			`#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
for (const key of ["HOME", "HOBO_TEST_SENTINEL", "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_GLOBALCONFIG", "npm_config_registry", "HTTPS_PROXY"]) {
  if (Object.hasOwn(process.env, key)) process.exit(31);
}
const args = process.argv.slice(2);
const value = (key) => args[args.indexOf(key) + 1];
const user = value("--userconfig");
const global = value("--globalconfig");
if (!user || !global || user === global || fs.readFileSync(user, "utf8") !== "" || fs.readFileSync(global, "utf8") !== "" || !args.includes("--offline")) process.exit(32);
fs.writeFileSync(path.join(value("--pack-destination"), "fixture.tgz"), "archive");
process.stdout.write(JSON.stringify([{ filename: "fixture.tgz" }]));
`,
		);
		await chmod(fakeNpm, 0o755);
		process.env.PATH = `${bin}:${prior.get("PATH") ?? ""}`;
		process.env.HOBO_TEST_SENTINEL = "must-not-reach-subprocess";
		process.env.NPM_CONFIG_USERCONFIG = join(root, "host-user.npmrc");
		process.env.NPM_CONFIG_GLOBALCONFIG = join(root, "host-global.npmrc");
		process.env.npm_config_registry = "https://registry.invalid";
		process.env.HTTPS_PROXY = "http://127.0.0.1:1";
		assert.equal(
			(await packOfflineDependency(source, packs, cache)).toString(),
			"archive",
		);
	} finally {
		for (const key of keys) {
			const value = prior.get(key);
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	}
});
