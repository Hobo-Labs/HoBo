import { spawnSync } from "node:child_process";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode, encode } from "@jridgewell/sourcemap-codec";
import { describe, expect, it } from "vitest";
import {
	applyScopeToManifest,
	loadNpmScopeMap,
} from "../ci/npm-publish-scope.mts";
import {
	rewriteSdkSourceMap,
	rewriteSdkSpecifiers,
	rewriteStagedSdkDirectory,
} from "../ci/rewrite-sdk-specifiers.mts";
import {
	bundleExternalSdkWorkspaces,
	orderedSdkTarballPaths,
	readExternalSdkWorkspaceVersions,
	releaseSdkTurboBuildArgv,
	SDK_PACKAGES,
} from "../ci/stage-sdk-artifacts.mts";
import {
	loadReleaseHoboPullRequestPathFilters,
	pathMatchesReleaseHoboFilter,
} from "../lib/release-hobo-path-filters.mts";

describe("stage-sdk-artifacts", () => {
	it("stages the complete provider-neutral financial dependency graph in order", () => {
		const root = join(import.meta.dirname, "..", "..");
		const map = loadNpmScopeMap();
		const sdkNames: readonly string[] = SDK_PACKAGES;
		const directories = [
			"packages/pricing",
			"packages/fleet",
			"packages/backend-routing",
			"packages/data-core",
			"packages/providers/provider-cedar",
			"packages/providers/provider-opa",
			"packages/broker",
			"packages/dispatcher",
		];
		for (const directory of directories) {
			const manifest = JSON.parse(
				readFileSync(join(root, directory, "package.json"), "utf8"),
			);
			const index = sdkNames.indexOf(manifest.name);
			expect(index).toBeGreaterThanOrEqual(0);
			expect(manifest.private).not.toBe(true);
			expect(manifest.files).toContain("LICENSE");
			expect(readFileSync(join(root, directory, "LICENSE"), "utf8")).toContain(
				"MIT License",
			);
			const staged = applyScopeToManifest(manifest, map, { version: "1.0.0" });
			for (const dependency of Object.keys(manifest.dependencies ?? {})) {
				if (!dependency.startsWith("@hobo/")) continue;
				expect(map.packages[dependency]).toBeDefined();
				expect(staged.dependencies?.[map.packages[dependency] ?? ""]).toBe(
					"1.0.0",
				);
				expect(sdkNames.indexOf(dependency)).toBeGreaterThanOrEqual(0);
				expect(sdkNames.indexOf(dependency)).toBeLessThan(index);
			}
		}
	});
	it("stages Alchemy and Rivet packages with their public dependency names", () => {
		const root = join(import.meta.dirname, "..", "..");
		const map = loadNpmScopeMap();
		const packages = [
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
		] as const;
		for (const [name, directory, published] of packages) {
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
			expect(map.packages[name]).toBe(published);
			const staged = applyScopeToManifest(manifest, map, { version: "1.0.0" });
			expect(staged.name).toBe(published);
			for (const [dependency, range] of Object.entries(
				manifest.dependencies ?? {},
			))
				if (dependency.startsWith("@hobo/")) {
					expect(map.packages[dependency]).toBeDefined();
					expect(staged.dependencies?.[map.packages[dependency] ?? ""]).toBe(
						"1.0.0",
					);
					expect(range).toBe("workspace:*");
				}
		}
	});
	it("packs pinned sibling dependencies so an offline consumer can import them", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-sdk-bundle-"));
		try {
			const sibling = join(dir, "external/ts-autocode/packages/grounding");
			const child = join(dir, "child");
			const staged = join(dir, "staged");
			const consumer = join(dir, "consumer");
			mkdirSync(join(sibling, "dist"), { recursive: true });
			mkdirSync(child, { recursive: true });
			mkdirSync(join(staged, "dist"), { recursive: true });
			mkdirSync(consumer, { recursive: true });
			writeFileSync(join(dir, "external/ts-autocode/LICENSE"), "MIT fixture");
			writeFileSync(
				join(sibling, "package.json"),
				JSON.stringify({
					name: "ts-autocode-grounding",
					version: "0.1.0",
					type: "module",
					main: "dist/index.js",
					dependencies: { "fixture-child": "1.0.0" },
				}),
			);
			writeFileSync(
				join(sibling, "dist/index.js"),
				'export { value } from "fixture-child";\n',
			);
			writeFileSync(
				join(child, "package.json"),
				JSON.stringify({
					name: "fixture-child",
					version: "1.0.0",
					type: "module",
					main: "index.js",
				}),
			);
			writeFileSync(join(child, "index.js"), "export const value = 42;\n");
			writeFileSync(
				join(staged, "dist/index.js"),
				'export { value } from "ts-autocode-grounding";\n',
			);
			const bundled: string[] = [];
			const manifest = {
				name: "sdk-demo",
				version: "1.0.0",
				type: "module",
				main: "dist/index.js",
				files: ["dist"],
				dependencies: { "ts-autocode-grounding": "0.1.0" },
				bundleDependencies: bundled,
			};
			bundleExternalSdkWorkspaces(dir, staged, manifest, {
				"ts-autocode-grounding": "0.1.0",
			});
			expect(manifest.dependencies).toMatchObject({ "fixture-child": "1.0.0" });
			writeFileSync(join(staged, "package.json"), JSON.stringify(manifest));
			const packed = spawnSync(
				"npm",
				[
					"pack",
					"--json",
					"--ignore-scripts",
					"--cache",
					join(dir, "cache"),
					"--pack-destination",
					dir,
				],
				{ cwd: staged, encoding: "utf8" },
			);
			expect(packed.status, packed.stderr).toBe(0);
			const archive = join(dir, JSON.parse(packed.stdout)[0].filename);
			const childPacked = spawnSync(
				"npm",
				[
					"pack",
					"--json",
					"--ignore-scripts",
					"--cache",
					join(dir, "cache"),
					"--pack-destination",
					dir,
				],
				{ cwd: child, encoding: "utf8" },
			);
			expect(childPacked.status, childPacked.stderr).toBe(0);
			const childArchive = join(
				dir,
				JSON.parse(childPacked.stdout)[0].filename,
			);
			writeFileSync(
				join(consumer, "package.json"),
				'{"name":"consumer","version":"1.0.0","type":"module"}',
			);
			const installed = spawnSync(
				"npm",
				[
					"install",
					"--offline",
					"--ignore-scripts",
					"--package-lock=false",
					"--cache",
					join(dir, "cache"),
					archive,
					childArchive,
				],
				{ cwd: consumer, encoding: "utf8" },
			);
			expect(installed.status, installed.stderr).toBe(0);
			const imported = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					'import { value } from "sdk-demo"; if (value !== 42) process.exit(1);',
				],
				{ cwd: consumer, encoding: "utf8" },
			);
			expect(imported.status, imported.stderr).toBe(0);
			expect(
				readFileSync(
					join(
						consumer,
						"node_modules/sdk-demo/node_modules/ts-autocode-grounding/LICENSE",
					),
					"utf8",
				),
			).toBe("MIT fixture");
			expect(() =>
				bundleExternalSdkWorkspaces(
					dir,
					staged,
					{
						dependencies: {
							"ts-autocode-grounding": "0.1.0",
							"fixture-child": "2.0.0",
						},
					},
					{ "ts-autocode-grounding": "0.1.0" },
				),
			).toThrow("conflicting SDK bundled dependency");
			expect(() =>
				bundleExternalSdkWorkspaces(dir, staged, manifest, {
					"ts-autocode-grounding": "0.2.0",
				}),
			).toThrow("invalid SDK bundled dependency");
			writeFileSync(
				join(sibling, "package.json"),
				JSON.stringify({ name: "ts-autocode-grounding", version: "0.2.0" }),
			);
			expect(() =>
				bundleExternalSdkWorkspaces(dir, staged, manifest, {
					"ts-autocode-grounding": "0.1.0",
				}),
			).toThrow("invalid SDK bundled dependency");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("reads exact external SDK versions from pinned sibling manifests", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-sdk-sibling-"));
		try {
			for (const name of ["grounding", "training"]) {
				const path = join(dir, "external", "ts-autocode", "packages", name);
				mkdirSync(path, { recursive: true });
				writeFileSync(
					join(path, "package.json"),
					JSON.stringify({ name: `ts-autocode-${name}`, version: "0.1.0" }),
				);
			}
			expect(readExternalSdkWorkspaceVersions(dir)).toEqual({
				"ts-autocode-grounding": "0.1.0",
				"ts-autocode-training": "0.1.0",
			});
			for (const privateValue of [true, "true"]) {
				writeFileSync(
					join(
						dir,
						"external",
						"ts-autocode",
						"packages",
						"grounding",
						"package.json",
					),
					JSON.stringify({
						name: "ts-autocode-grounding",
						version: "0.1.0",
						private: privateValue,
					}),
				);
				expect(() => readExternalSdkWorkspaceVersions(dir)).toThrow(
					"invalid pinned SDK dependency manifest",
				);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("runs release checks when the specifier rewrite changes", () => {
		const filters = loadReleaseHoboPullRequestPathFilters(
			join(import.meta.dirname, "..", ".."),
		);
		expect(
			filters.some((filter) =>
				pathMatchesReleaseHoboFilter(
					"scripts/ci/rewrite-sdk-specifiers.mts",
					filter,
				),
			),
		).toBe(true);
	});
	it("keeps checkout bootstrap independent of installed npm dependencies", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-sdk-bootstrap-"));
		try {
			const root = join(import.meta.dirname, "..", "..");
			for (const name of ["scripts/ci", "scripts/lib"]) {
				cpSync(join(root, name), join(dir, name), {
					recursive: true,
					filter: (path) => !path.split(/[\\/]/u).includes("node_modules"),
				});
			}
			writeFileSync(join(dir, "package.json"), '{"type":"module"}');
			const run = spawnSync(
				process.execPath,
				[
					"--experimental-strip-types",
					"--input-type=module",
					"-e",
					'await import("./scripts/ci/checkout-cone.mts")',
				],
				{ cwd: dir, encoding: "utf8", env: { ...process.env, NODE_PATH: "" } },
			);
			expect(run.status, run.stderr).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
	it("rewrites staged runtime and type imports without rewriting unrelated strings", () => {
		const map = loadNpmScopeMap();
		const source =
			'import { value } from "@hobo/core";\nexport { value } from "@hobo/core/total-access";\nconst text = "@hobo/core";\nconst lazy = import("@hobo/core");\nconst resolved = import.meta.resolve("@hobo/core");\nconst config = { runtimeModule: "@hobo/runtime" };\n';
		const rewritten = rewriteSdkSpecifiers("entry.js", source, map.packages);
		expect(rewritten.text).toContain('from "@hobo-labs/core"');
		expect(rewritten.text).toContain('from "@hobo-labs/core/total-access"');
		expect(rewritten.text).toContain('import("@hobo-labs/core")');
		expect(rewritten.text).toContain('import.meta.resolve("@hobo-labs/core")');
		expect(rewritten.text).toContain('const text = "@hobo/core"');
		expect(rewritten.text).toContain('runtimeModule: "@hobo-labs/runtime"');
		expect(
			rewriteSdkSpecifiers(
				"entry.js",
				'import "@hobo/unreleased";',
				map.packages,
			).text,
		).toBe('import "@hobo/unreleased";');
		const types = rewriteSdkSpecifiers(
			"entry.d.ts",
			'/// <reference types="@hobo/core" />\nexport type X = import("@hobo/core").X;\n',
			map.packages,
		);
		expect(types.text).toContain('import("@hobo-labs/core")');
		expect(types.text).toContain('<reference types="@hobo-labs/core" />');
		const commonjs = rewriteSdkSpecifiers(
			"entry.cjs",
			'const a = require("@hobo/core"); const b = require.resolve("@hobo/core");',
			map.packages,
		);
		expect(commonjs.text).toContain('require("@hobo-labs/core")');
		expect(commonjs.text).toContain('require.resolve("@hobo-labs/core")');
		expect(() =>
			rewriteSdkSpecifiers(
				"entry.js",
				'function require(id) { return id; } require("@hobo/core");',
				map.packages,
			),
		).toThrow("ambiguous SDK require binding");
	});
	it("keeps source-map columns aligned after a package name changes", () => {
		const source = 'import "@hobo/core"; import "@hobo/wit"; const next = 1;';
		const rewritten = rewriteSdkSpecifiers(
			"entry.js",
			source,
			loadNpmScopeMap().packages,
		);
		const column = source.indexOf("const");
		const map = JSON.stringify({
			version: 3,
			sources: ["entry.ts"],
			names: [],
			mappings: encode([
				[
					[0, 0, 0, 0],
					[column, 0, 0, column],
				],
			]),
		});
		const updated: { mappings: string } = JSON.parse(
			rewriteSdkSourceMap(map, rewritten.edits),
		);
		expect(decode(updated.mappings)[0]?.[1]?.[0]).toBe(
			rewritten.text.indexOf("const"),
		);
		expect(() =>
			rewriteSdkSourceMap('{"version":3,"sections":[]}', rewritten.edits),
		).toThrow("unsupported SDK source map");
	});
	it("loads a staged package with only the public dependency installed", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-sdk-scope-"));
		try {
			const dependency = join(dir, "node_modules", "@hobo-labs", "core");
			const dist = join(dir, "dist");
			mkdirSync(dependency, { recursive: true });
			mkdirSync(dist);
			const manifest = applyScopeToManifest(
				{
					name: "@hobo/bindles",
					dependencies: { "@hobo/core": "workspace:*" },
				},
				loadNpmScopeMap(),
				{ version: "0.0.0-alpha.1" },
			);
			writeFileSync(
				join(dir, "package.json"),
				JSON.stringify({ ...manifest, type: "module" }),
			);
			expect(manifest.dependencies).toEqual({
				"@hobo-labs/core": "0.0.0-alpha.1",
			});
			writeFileSync(
				join(dependency, "package.json"),
				'{"name":"@hobo-labs/core","type":"module","exports":"./index.js"}',
			);
			writeFileSync(join(dependency, "index.js"), 'export const value = "ok";');
			writeFileSync(
				join(dist, "index.js"),
				'import { value } from "@hobo/core"; console.log(value);',
			);
			writeFileSync(
				join(dist, "index.d.mts"),
				'export type X = import("@hobo/core").X;',
			);
			rewriteStagedSdkDirectory(dist, loadNpmScopeMap().packages);
			const run = spawnSync(process.execPath, [join(dist, "index.js")], {
				cwd: dir,
				encoding: "utf8",
			});
			expect(run.status, run.stderr).toBe(0);
			expect(run.stdout.trim()).toBe("ok");
			expect(readFileSync(join(dist, "index.js"), "utf8")).toContain(
				'"@hobo-labs/core"',
			);
			expect(readFileSync(join(dist, "index.d.mts"), "utf8")).toContain(
				'"@hobo-labs/core"',
			);
			writeFileSync(
				join(dist, "inline.js"),
				'import "@hobo/core";\n//# sourceMappingURL=data:application/json;base64,e30=',
			);
			expect(() =>
				rewriteStagedSdkDirectory(dist, loadNpmScopeMap().packages),
			).toThrow("unsupported SDK source map reference");
		} finally {
			rmSync(dir, { recursive: true, force: true });
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
});
