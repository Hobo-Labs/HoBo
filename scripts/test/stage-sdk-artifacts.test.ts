import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadNpmScopeMap } from "../ci/npm-publish-scope.mts";
import {
	findPackageDir,
	orderedSdkTarballPaths,
	prepareSdkPackageManifest,
	releaseSdkTurboBuildArgv,
	runBoundedSdkTasks,
	runCliSdkBundleSync,
	SDK_PACKAGES,
	sdkPackageWorkerLimit,
	stageSdkArtifactsDir,
	verifyStagedSdkArtifacts,
} from "../ci/stage-sdk-artifacts.mts";

describe("stage-sdk-artifacts", () => {
	it("packs starter gitignore templates", { timeout: 60_000 }, () => {
		const cache = mkdtempSync(join(tmpdir(), "hobo-patterns-pack-cache-"));
		try {
			const result = spawnSync(
				"npm",
				["pack", "--dry-run", "--json", "--ignore-scripts", "--cache", cache],
				{ cwd: findPackageDir("@hobo/patterns"), encoding: "utf8" },
			);
			expect(result.status, result.stderr).toBe(0);
			const files = JSON.parse(result.stdout)[0].files.map(
				(file: { path: string }) => file.path,
			);
			for (const starter of ["agent", "api", "fullstack", "todo"])
				expect(files).toContain(
					`patterns/starter/cli/${starter}/project/.gitignore.tpl`,
				);
		} finally {
			rmSync(cache, { recursive: true, force: true });
		}
	});
	it("orders each staged runtime workspace dependency before its consumer", () => {
		const map = loadNpmScopeMap();
		const names: readonly string[] = SDK_PACKAGES;
		for (const [index, name] of names.entries()) {
			const manifest = JSON.parse(
				readFileSync(join(findPackageDir(name), "package.json"), "utf8"),
			);
			expect(manifest.name).toBe(name);
			expect(manifest.private).not.toBe(true);
			expect(map.packages[name]).toBeDefined();
			for (const field of ["dependencies", "optionalDependencies"] as const) {
				for (const [dependency, range] of Object.entries(
					manifest[field] ?? {},
				)) {
					if (!dependency.startsWith("@hobo/")) continue;
					expect(range).toBe("workspace:*");
					expect(names.indexOf(dependency)).toBeGreaterThanOrEqual(0);
					expect(names.indexOf(dependency)).toBeLessThan(index);
					expect(map.packages[dependency]).toBeDefined();
				}
			}
		}
	});

	it("stages the financial dependency graph in dependency order", () => {
		const root = join(import.meta.dirname, "..", "..");
		const map = loadNpmScopeMap();
		const names: readonly string[] = SDK_PACKAGES;
		for (const directory of [
			"packages/pricing",
			"packages/fleet",
			"packages/backend-routing",
			"packages/data-core",
			"packages/providers/provider-cedar",
			"packages/providers/provider-opa",
			"packages/broker",
			"packages/dispatcher",
		]) {
			const manifest = JSON.parse(
				readFileSync(join(root, directory, "package.json"), "utf8"),
			);
			const index = names.indexOf(manifest.name);
			expect(index).toBeGreaterThanOrEqual(0);
			expect(manifest.private).not.toBe(true);
			expect(manifest.files).toContain("LICENSE");
			expect(readFileSync(join(root, directory, "LICENSE"), "utf8")).toContain(
				"MIT License",
			);
			const staged = prepareSdkPackageManifest(manifest, map, "1.0.0");
			for (const dependency of Object.keys(manifest.dependencies ?? {})) {
				if (!dependency.startsWith("@hobo/")) continue;
				expect(staged.dependencies?.[map.packages[dependency] ?? ""]).toBe(
					"1.0.0",
				);
				expect(staged.dependencies?.[dependency]).toBeUndefined();
				expect(names.indexOf(dependency)).toBeGreaterThanOrEqual(0);
				expect(names.indexOf(dependency)).toBeLessThan(index);
			}
		}
	});

	it("stages the Alchemy and Rivet SDK packages with public dependencies", () => {
		const root = join(import.meta.dirname, "..", "..");
		const map = loadNpmScopeMap();
		for (const [name, directory, published] of [
			[
				"@hobo/runtime-rivet",
				"packages/runtimes/runtime-rivet",
				"@hobo-labs/runtime-rivet",
			],
			[
				"@hobo/iac-alchemy",
				"packages/iac/iac-alchemy",
				"@hobo-labs/iac-alchemy",
			],
			[
				"@hobo/alchemy-rivet",
				"packages/extension-alchemy-rivet",
				"@hobo-labs/alchemy-rivet",
			],
		] as const) {
			const manifest = JSON.parse(
				readFileSync(join(root, directory, "package.json"), "utf8"),
			);
			expect(manifest.name).toBe(name);
			expect(manifest.private).not.toBe(true);
			expect(manifest.files).toContain("LICENSE");
			expect(readFileSync(join(root, directory, "LICENSE"), "utf8")).toContain(
				"MIT License",
			);
			expect(SDK_PACKAGES).toContain(name);
			const staged = prepareSdkPackageManifest(manifest, map, "1.0.0");
			expect(staged.name).toBe(published);
			for (const dependency of Object.keys(manifest.dependencies ?? {}))
				if (dependency.startsWith("@hobo/")) {
					expect(map.packages[dependency]).toBeDefined();
					expect(staged.dependencies?.[map.packages[dependency] ?? ""]).toBe(
						"1.0.0",
					);
					expect(staged.dependencies?.[dependency]).toBeUndefined();
				}
		}
	});

	it("rewrites package imports before the pack worker runs", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-sdk-pack-scope-"));
		try {
			const bin = join(dir, "bin");
			const pkg = join(dir, "pkg");
			const out = join(dir, "out");
			mkdirSync(bin);
			mkdirSync(join(pkg, "dist"), { recursive: true });
			mkdirSync(join(out, ".staging"), { recursive: true });
			writeFileSync(
				join(pkg, "package.json"),
				'{"name":"fixture","version":"1.0.0"}',
			);
			writeFileSync(join(pkg, "dist", "index.js"), 'import "@hobo/core";');
			writeFileSync(
				join(bin, "npm"),
				'#!/bin/sh\ngrep -q "@hobo-labs/core" dist/index.js || exit 8\nprintf content > "$3/fixture.tgz"\nprintf \'[{"filename":"fixture.tgz"}]\'\n',
			);
			chmodSync(join(bin, "npm"), 0o755);
			const staged = [
				{
					workspaceName: "@hobo/core",
					pkgDir: pkg,
					staged: { name: "fixture", version: "1.0.0" },
				},
			];
			const result = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--no-warnings",
					join(import.meta.dirname, "../ci/stage-sdk-artifacts.mts"),
					"--pack-all",
					out,
					JSON.stringify(staged),
				],
				{
					env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
					encoding: "utf8",
				},
			);
			expect(result.status, result.stderr).toBe(0);
			expect(existsSync(join(out, "fixture.tgz"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("runs package lifecycle scripts serially", () => {
		expect(sdkPackageWorkerLimit([{ scripts: { build: "build" } }, {}])).toBe(
			4,
		);
		for (const hook of [
			"prepack",
			"prepare",
			"postpack",
			"preprepare",
			"postprepare",
		])
			expect(sdkPackageWorkerLimit([{ scripts: { [hook]: "run" } }])).toBe(1);
	});

	it("preserves input order while running tasks in parallel", async () => {
		const starts: number[] = [];
		const result = await runBoundedSdkTasks(4, 2, async (index) => {
			starts.push(index);
			await new Promise((resolve) => setTimeout(resolve, index === 0 ? 10 : 1));
			return index * 2;
		});
		expect(starts.slice(0, 2)).toEqual([0, 1]);
		expect(result).toEqual([0, 2, 4, 6]);
	});

	it("drains active workers and stops scheduling after failure", async () => {
		const started: number[] = [];
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let drained = false;
		const result = runBoundedSdkTasks(5, 2, async (index) => {
			started.push(index);
			if (index === 0) throw new Error("pack failed");
			await gate;
			drained = true;
			return index;
		});
		await new Promise((resolve) => setImmediate(resolve));
		expect(started).toEqual([0, 1]);
		release();
		await expect(result).rejects.toThrow("pack failed");
		expect(drained).toBe(true);
	});

	it("rejects duplicate worker tarball names before publishing either", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-sdk-pack-collision-"));
		try {
			const bin = join(dir, "bin");
			const pkg = join(dir, "pkg");
			const out = join(dir, "out");
			mkdirSync(bin);
			mkdirSync(pkg);
			mkdirSync(join(pkg, "dist"));
			mkdirSync(join(out, ".staging"), { recursive: true });
			writeFileSync(
				join(pkg, "package.json"),
				'{"name":"fixture","version":"1.0.0"}',
			);
			writeFileSync(
				join(bin, "npm"),
				'#!/bin/sh\nprintf content > "$3/fixture.tgz"\nprintf \'[{"filename":"fixture.tgz"}]\'\n',
			);
			chmodSync(join(bin, "npm"), 0o755);
			const staged = ["@hobo/core", "@hobo/policy"].map((workspaceName) => ({
				workspaceName,
				pkgDir: pkg,
				staged: { name: "fixture", version: "1.0.0" },
			}));
			const result = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--no-warnings",
					join(import.meta.dirname, "../ci/stage-sdk-artifacts.mts"),
					"--pack-all",
					out,
					JSON.stringify(staged),
				],
				{
					env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
					encoding: "utf8",
				},
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("duplicate tarball names");
			expect(existsSync(join(out, "fixture.tgz"))).toBe(false);
			expect(existsSync(join(out, ".staging", "results.json"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("fails closed when an npm pack worker fails", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-sdk-pack-failure-"));
		try {
			const bin = join(dir, "bin");
			const pkg = join(dir, "pkg");
			const out = join(dir, "out");
			mkdirSync(bin);
			mkdirSync(pkg);
			mkdirSync(join(pkg, "dist"));
			mkdirSync(join(out, ".staging"), { recursive: true });
			writeFileSync(
				join(pkg, "package.json"),
				'{"name":"fixture","version":"1.0.0"}',
			);
			writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 7\n");
			chmodSync(join(bin, "npm"), 0o755);
			const staged = [
				{
					workspaceName: "@hobo/core",
					pkgDir: pkg,
					staged: { name: "fixture", version: "1.0.0" },
				},
			];
			const result = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--no-warnings",
					join(import.meta.dirname, "../ci/stage-sdk-artifacts.mts"),
					"--pack-all",
					out,
					JSON.stringify(staged),
				],
				{
					env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
					encoding: "utf8",
				},
			);
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("SDK package staging failed");
			expect(existsSync(join(out, "MANIFEST.json"))).toBe(false);
			expect(existsSync(join(out, ".staging", "results.json"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("invalidates a prior manifest when preflight fails", () => {
		const outDir = mkdtempSync(join(tmpdir(), "hobo-sdk-preflight-fail-"));
		const original = process.env.HOBO_RELEASE_SEMVER;
		try {
			writeFileSync(join(outDir, "MANIFEST.json"), "{}");
			process.env.HOBO_RELEASE_SEMVER = "not-a-semver";
			expect(() => stageSdkArtifactsDir(outDir)).toThrow();
			expect(existsSync(join(outDir, "MANIFEST.json"))).toBe(false);
		} finally {
			if (original === undefined) delete process.env.HOBO_RELEASE_SEMVER;
			else process.env.HOBO_RELEASE_SEMVER = original;
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	it("removes the manifest when the actual acceptance verifier rejects it", () => {
		const outDir = mkdtempSync(join(tmpdir(), "hobo-sdk-verification-fail-"));
		try {
			writeFileSync(join(outDir, "MANIFEST.json"), "{}");
			expect(() => verifyStagedSdkArtifacts(outDir)).toThrow(
				/SDK artifact verification failed/,
			);
			expect(existsSync(join(outDir, "MANIFEST.json"))).toBe(false);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	it("orders tarballs using MANIFEST pack order (core before bindles)", () => {
		const map = loadNpmScopeMap();
		const outDir = mkdtempSync(join(tmpdir(), "hobo-sdk-order-"));
		try {
			const packages = SDK_PACKAGES.map((workspace) => {
				const file = `${map.packages[workspace]!.replace("@", "").replace("/", "-")}-0.0.0-alpha.2.tgz`;
				writeFileSync(join(outDir, file), "fake", "utf8");
				return {
					workspace,
					public: map.packages[workspace]!,
					file,
				};
			});
			writeFileSync(
				join(outDir, "MANIFEST.json"),
				JSON.stringify({ version: "0.0.0-alpha.2", packages }),
			);
			const paths = orderedSdkTarballPaths(outDir);
			expect(paths.map((p) => p.split("/").pop())).toEqual(
				packages.map((p) => p.file),
			);
			const coreIdx = packages.findIndex((p) => p.workspace === "@hobo/core");
			const bindlesIdx = packages.findIndex(
				(p) => p.workspace === "@hobo/bindles",
			);
			expect(coreIdx).toBeLessThan(bindlesIdx);
		} finally {
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	it("passes HOBO_TURBO_CONCURRENCY through the SDK allowlist turbo build", () => {
		expect(releaseSdkTurboBuildArgv({ HOBO_TURBO_CONCURRENCY: "1" })).toContain(
			"--concurrency=1",
		);
		const unset = { ...process.env, HOBO_TURBO_CONCURRENCY: undefined };
		expect(releaseSdkTurboBuildArgv(unset)).toContain("--concurrency=100%");
	});

	it("includes @hobo/policy in the SDK allowlist before contracts", () => {
		expect(SDK_PACKAGES.indexOf("@hobo/policy")).toBeGreaterThan(
			SDK_PACKAGES.indexOf("@hobo/core"),
		);
		expect(SDK_PACKAGES.indexOf("@hobo/policy")).toBeLessThan(
			SDK_PACKAGES.indexOf("@hobo/contracts"),
		);
	});
	it("prepares only the explicit bundled dependencies and rejects unknown workspace packages", () => {
		const fullMap = loadNpmScopeMap();
		const map = {
			...fullMap,
			packages: Object.fromEntries(
				SDK_PACKAGES.map((name) => [name, fullMap.packages[name]!]),
			),
		};
		const runtime = JSON.parse(
			readFileSync(join("packages/runtime/package.json"), "utf8"),
		);
		const sqlite = JSON.parse(
			readFileSync(join("packages/storage-sqlite/package.json"), "utf8"),
		);
		const stagedRuntime = prepareSdkPackageManifest(
			runtime,
			map,
			"0.0.0-proof.1",
		);
		const stagedSqlite = prepareSdkPackageManifest(
			sqlite,
			map,
			"0.0.0-proof.1",
		);
		expect(
			stagedRuntime.dependencies?.["ts-autocode-grounding"],
		).toBeUndefined();
		expect(stagedRuntime.dependencies?.typescript).toBe("^5.9.3");
		expect(
			stagedSqlite.dependencies?.["@hobo/backend-routing"],
		).toBeUndefined();
		expect(stagedSqlite.dependencies?.["@hobo-labs/core"]).toBe(
			"0.0.0-proof.1",
		);
		expect(stagedSqlite.dependencies?.["@hobo/core"]).toBeUndefined();
		const cli = JSON.parse(
			readFileSync(join("packages/cli/package.json"), "utf8"),
		);
		const stagedCli = prepareSdkPackageManifest(cli, map, "0.0.0-proof.1");
		expect(stagedCli.dependencies?.["@hobo-labs/core"]).toBe("0.0.0-proof.1");
		expect(stagedCli.dependencies?.["@hobo/core"]).toBeUndefined();
		expect(stagedCli.dependencies?.["@hobo/cd"]).toBeUndefined();
		expect(() =>
			prepareSdkPackageManifest(
				{
					...cli,
					dependencies: {
						...cli.dependencies,
						"@hobo/unpublished-proof": "workspace:*",
					},
				},
				map,
				"0.0.0-proof.1",
			),
		).toThrow(/unexpected direct dependencies/);
	});
	it("propagates CLI bundle subprocess failures", () => {
		const root = mkdtempSync(join(tmpdir(), "hobo-cli-runner-failure-"));
		try {
			expect(() => runCliSdkBundleSync(root, join(root, "out"))).toThrow(
				/CLI SDK bundle failed/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
