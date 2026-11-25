import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	applyHoboMeshEnvHeaders,
	defaultHoboHome,
	HOBO_BINDLE_ENV_HEADER,
	HOBO_ENV_HEADER_PREFIX,
	resolvePrivateWasmGuest,
} from "../src/sandbox.js";

function project(...files: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-wasm-"));
	for (const file of files) {
		const path = join(dir, file);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "export const app = {};\n");
	}
	return dir;
}

const resolve = (projectDir: string, modulePath?: string) =>
	resolvePrivateWasmGuest({
		projectDir,
		resourceName: "api",
		...(modulePath !== undefined ? { modulePath } : undefined),
	});

describe("an explicit module path", () => {
	it("is used when it exists", () => {
		const dir = project("custom/entry.ts");
		expect(resolve(dir, "custom/entry.ts").appModulePath).toBe(
			join(dir, "custom/entry.ts"),
		);
	});

	it("beats a prebuilt wasm, because the caller said so", () => {
		const dir = project("custom/entry.ts", "dist/wasm/api.wasm");
		const resolved = resolve(dir, "custom/entry.ts");
		expect(resolved.appModulePath).toBe(join(dir, "custom/entry.ts"));
		expect(resolved.wasmPath).toBeNull();
	});

	it("accepts an absolute path", () => {
		const dir = project("custom/entry.ts");
		expect(resolve(dir, join(dir, "custom/entry.ts")).appModulePath).toBe(
			join(dir, "custom/entry.ts"),
		);
	});

	it("throws when it does not exist", () => {
		expect(() => resolve(project(), "custom/missing.ts")).toThrow(
			/modulePath not found/u,
		);
	});

	it("names the resource and the path in the error", () => {
		expect(() => resolve(project(), "custom/missing.ts")).toThrow(
			/resource 'api'/u,
		);
	});

	it("is ignored when empty, falling through to inference", () => {
		const dir = project("src/api.ts");
		expect(resolve(dir, "").appModulePath).toBe(join(dir, "src/api.ts"));
	});
});

describe("a prebuilt component", () => {
	it("is found under dist/wasm", () => {
		const dir = project("dist/wasm/api.wasm");
		expect(resolve(dir).wasmPath).toBe(join(dir, "dist/wasm/api.wasm"));
	});

	it("is found under src/wasm", () => {
		const dir = project("src/wasm/api.wasm");
		expect(resolve(dir).wasmPath).toBe(join(dir, "src/wasm/api.wasm"));
	});

	it("prefers dist over src", () => {
		const dir = project("src/wasm/api.wasm", "dist/wasm/api.wasm");
		expect(resolve(dir).wasmPath).toBe(join(dir, "dist/wasm/api.wasm"));
	});

	it("beats a source module, since it is already compiled", () => {
		const dir = project("dist/wasm/api.wasm", "src/api.ts");
		const resolved = resolve(dir);
		expect(resolved.wasmPath).toBeTruthy();
		expect(resolved.appModulePath).toBeNull();
	});

	it("beats a hand-written guest", () => {
		const dir = project("dist/wasm/api.wasm", "src/wasm/api-guest.mjs");
		const resolved = resolve(dir);
		expect(resolved.wasmPath).toBeTruthy();
		expect(resolved.guestSourcePath).toBeNull();
	});

	it("is not found under another resource's name", () => {
		expect(resolve(project("dist/wasm/other.wasm")).wasmPath).toBeNull();
	});
});

describe("a hand-written guest", () => {
	it.each([
		"src/wasm/api-guest.mjs",
		"src/wasm/api-guest.js",
	])("is found at %s", (file) => {
		const dir = project(file);
		expect(resolve(dir).guestSourcePath).toBe(join(dir, file));
	});

	it("prefers the .mjs spelling", () => {
		const dir = project("src/wasm/api-guest.js", "src/wasm/api-guest.mjs");
		expect(resolve(dir).guestSourcePath).toBe(
			join(dir, "src/wasm/api-guest.mjs"),
		);
	});

	it("is reported alongside an app module rather than instead of it", () => {
		const dir = project("src/wasm/api-guest.mjs", "src/api.ts");
		const resolved = resolve(dir);
		expect(resolved.guestSourcePath).toBeTruthy();
		expect(resolved.appModulePath).toBeTruthy();
	});
});

describe("the app module search", () => {
	it.each([
		"src/api.ts",
		"src/api.tsx",
		"src/api.mts",
		"src/api.js",
		"src/api.mjs",
		"src/api/index.ts",
		"src/api/index.tsx",
		"src/api/index.js",
		"src/api/index.mjs",
		"dist/api.js",
		"dist/api.mjs",
		"dist/api/index.js",
	])("finds %s", (file) => {
		const dir = project(file);
		expect(resolve(dir).appModulePath).toBe(join(dir, file));
	});

	it("prefers src/<name>.ts over every later candidate", () => {
		const dir = project("dist/api.js", "src/api/index.ts", "src/api.ts");
		expect(resolve(dir).appModulePath).toBe(join(dir, "src/api.ts"));
	});

	it("prefers a flat module over an index file", () => {
		const dir = project("src/api/index.ts", "src/api.js");
		expect(resolve(dir).appModulePath).toBe(join(dir, "src/api.js"));
	});

	it("prefers src over dist for a source module", () => {
		const dir = project("dist/api.js", "src/api.js");
		expect(resolve(dir).appModulePath).toBe(join(dir, "src/api.js"));
	});

	it("reports nothing found rather than throwing", () => {
		const resolved = resolve(project());
		expect(resolved.appModulePath).toBeNull();
		expect(resolved.wasmPath).toBeNull();
		expect(resolved.guestSourcePath).toBeNull();
	});

	it("carries the resource name and project dir through regardless", () => {
		const dir = project();
		const resolved = resolve(dir);
		expect(resolved.resourceName).toBe("api");
		expect(resolved.projectDir).toBe(dir);
	});
});

describe("applyHoboMeshEnvHeaders", () => {
	it("writes one header per key", () => {
		const headers = applyHoboMeshEnvHeaders(new Headers(), {
			DATABASE_URL: "postgres://x",
		});
		expect(headers.get(`${HOBO_ENV_HEADER_PREFIX}database_url`)).toBe(
			"postgres://x",
		);
	});

	it("lowercases the key, since the per-key lookup is not case-insensitive", () => {
		const headers = applyHoboMeshEnvHeaders(new Headers(), { MiXeD: "v" });
		expect(headers.get(`${HOBO_ENV_HEADER_PREFIX}mixed`)).toBe("v");
	});

	it("also writes the whole env as one JSON map", () => {
		const env = { A: "1", B: "2" };
		const headers = applyHoboMeshEnvHeaders(new Headers(), env);
		expect(JSON.parse(headers.get(HOBO_BINDLE_ENV_HEADER) ?? "{}")).toEqual(
			env,
		);
	});

	it("preserves headers it was given", () => {
		const headers = applyHoboMeshEnvHeaders(
			new Headers({ "x-request-id": "r1" }),
			{},
		);
		expect(headers.get("x-request-id")).toBe("r1");
	});

	it("does not mutate the headers it was given", () => {
		const original = new Headers();
		applyHoboMeshEnvHeaders(original, { A: "1" });
		expect(original.get(`${HOBO_ENV_HEADER_PREFIX}a`)).toBeNull();
	});

	it("writes an empty map for an empty env", () => {
		const headers = applyHoboMeshEnvHeaders(new Headers(), {});
		expect(headers.get(HOBO_BINDLE_ENV_HEADER)).toBe("{}");
	});

	it("overwrites a stale value from a previous hop", () => {
		const headers = applyHoboMeshEnvHeaders(
			new Headers({ [`${HOBO_ENV_HEADER_PREFIX}a`]: "old" }),
			{ A: "new" },
		);
		expect(headers.get(`${HOBO_ENV_HEADER_PREFIX}a`)).toBe("new");
	});
});

describe("defaultHoboHome", () => {
	it("prefers HOBO_HOME when set", () => {
		expect(defaultHoboHome({ HOBO_HOME: "/custom/home" })).toBe("/custom/home");
	});

	it("falls back to a dotfile under the user's home", () => {
		expect(defaultHoboHome({})).toMatch(/\.hobo$/u);
	});

	it("ignores an empty HOBO_HOME rather than returning an empty path", () => {
		expect(defaultHoboHome({ HOBO_HOME: "" })).toMatch(/\.hobo$/u);
	});
});
