import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	NBGV_MISE_DIR,
	NBGV_MISE_TOML,
	nbgvDotnetResolvable,
	nbgvMiseExecEnv,
	nbgvMiseInstallArgv,
	nbgvMiseReleaseDir,
} from "../lib/nbgv-toolchain.mts";

const root = join(import.meta.dirname, "..", "..");

describe("nbgv toolchain scope", () => {
	it("install argv ends with dotnet only", () => {
		const releaseDir = nbgvMiseReleaseDir(root);
		const argv = [...nbgvMiseInstallArgv(releaseDir)];
		expect(argv).toEqual(["-C", releaseDir, "install", "--locked", "dotnet"]);
		expect(argv.at(-1)).toBe("dotnet");
		expect(argv.filter((arg) => arg === "dotnet")).toEqual(["dotnet"]);
		expect(argv).not.toContain("--config");
		expect(argv).not.toContain("betterleaks");
		expect(argv).not.toContain("python");
		expect(argv).not.toContain("syft");
	});

	it("exec uses MISE_CONFIG_DIR from repo root (not exec --config)", () => {
		const releaseDir = join(root, NBGV_MISE_DIR);
		expect(nbgvMiseExecEnv(root, {})).toMatchObject({
			MISE_CONFIG_DIR: releaseDir,
		});
	});

	it("exec env ignores the repo root mise.toml", () => {
		const rootToml = resolve(root, "mise.toml");
		expect(nbgvMiseExecEnv(root, {}).MISE_IGNORED_CONFIG_PATHS).toBe(rootToml);
		expect(
			nbgvMiseExecEnv(root, { MISE_IGNORED_CONFIG_PATHS: "" })
				.MISE_IGNORED_CONFIG_PATHS,
		).toBe(rootToml);
		expect(
			nbgvMiseExecEnv(root, {
				MISE_IGNORED_CONFIG_PATHS: "/etc/mise/config.toml",
			}).MISE_IGNORED_CONFIG_PATHS,
		).toBe(`${rootToml}:/etc/mise/config.toml`);
	});

	it("exposes nbgvDotnetResolvable probe (no throw when dotnet missing)", () => {
		const logs: string[] = [];
		expect(() =>
			nbgvDotnetResolvable(root, (line) => logs.push(line)),
		).not.toThrow();
		expect(logs.some((l) => l.includes("probing mise which dotnet"))).toBe(
			true,
		);
	});

	it("pins dotnet only under release/mise.toml (not CI runner contract)", () => {
		const rootToml = readFileSync(join(root, "mise.toml"), "utf8");
		const releaseToml = readFileSync(join(root, NBGV_MISE_TOML), "utf8");
		expect(rootToml).not.toMatch(/^dotnet\s*=/m);
		expect(releaseToml).toMatch(/^dotnet\s*=\s*"10\.0\.100"/m);
	});

	it("root mise.toml lists tools that release/mise.toml does not", () => {
		const rootToml = readFileSync(join(root, "mise.toml"), "utf8");
		const releaseToml = readFileSync(join(root, NBGV_MISE_TOML), "utf8");
		const pins = (toml: string, name: string) =>
			new RegExp(`^${name}\\s*=`, "m").test(toml);
		expect(pins(rootToml, "betterleaks") || pins(rootToml, "python")).toBe(
			true,
		);
		expect(pins(releaseToml, "betterleaks")).toBe(false);
		expect(pins(releaseToml, "python")).toBe(false);
	});
});
