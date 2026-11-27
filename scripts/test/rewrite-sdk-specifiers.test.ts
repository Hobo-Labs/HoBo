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
import { loadNpmScopeMap } from "../ci/npm-publish-scope.mts";
import {
	rewriteSdkSourceMap,
	rewriteSdkSpecifiers,
	rewriteStagedSdkDirectory,
} from "../ci/rewrite-sdk-specifiers.mts";
import { prepareSdkPackageManifest } from "../ci/stage-sdk-artifacts.mts";
import {
	loadReleaseHoboPullRequestPathFilters,
	pathMatchesReleaseHoboFilter,
} from "../lib/release-hobo-path-filters.mts";

describe("stage-sdk-artifacts", () => {
	it("shares one public dependency identity across rewritten packages", () => {
		const dir = mkdtempSync(join(tmpdir(), "hobo-sdk-identity-"));
		try {
			const dependency = join(dir, "node_modules", "@hobo-labs", "core");
			mkdirSync(dependency, { recursive: true });
			writeFileSync(join(dir, "package.json"), '{"type":"module"}');
			writeFileSync(
				join(dependency, "package.json"),
				'{"name":"@hobo-labs/core","type":"module","exports":"./index.js"}',
			);
			writeFileSync(
				join(dependency, "index.js"),
				"export class SharedError extends Error {};",
			);
			const map = loadNpmScopeMap();
			for (const name of ["first", "second"]) {
				const dist = join(dir, name);
				mkdirSync(dist);
				writeFileSync(
					join(dist, "index.js"),
					'export { SharedError } from "@hobo/core";',
				);
				rewriteStagedSdkDirectory(dist, map.packages);
			}
			const run = spawnSync(
				process.execPath,
				[
					"--input-type=module",
					"-e",
					'import { SharedError as A } from "./first/index.js"; import { SharedError as B } from "./second/index.js"; if (!(new A() instanceof B)) process.exit(1);',
				],
				{ cwd: dir, encoding: "utf8" },
			);
			expect(run.status, run.stderr).toBe(0);
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
			const manifest = prepareSdkPackageManifest(
				{
					name: "@hobo/bindles",
					dependencies: { "@hobo/core": "workspace:*" },
				},
				loadNpmScopeMap(),
				"0.0.0-alpha.1",
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
});
