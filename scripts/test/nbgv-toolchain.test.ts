import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	NBGV_MISE_DIR,
	NBGV_MISE_TOML,
	nbgvMiseExecEnv,
	nbgvMiseInstallArgv,
	nbgvMiseReleaseDir,
} from "../lib/nbgv-toolchain.mts";

const root = join(import.meta.dirname, "..", "..");

describe("nbgv toolchain scope", () => {
	it("installs with mise -C release --locked (not install --config)", () => {
		const releaseDir = nbgvMiseReleaseDir(root);
		expect(nbgvMiseInstallArgv(releaseDir)).toEqual([
			"-C",
			releaseDir,
			"install",
			"--locked",
		]);
		expect(nbgvMiseInstallArgv(releaseDir)).not.toContain("--config");
	});

	it("exec uses MISE_CONFIG_DIR from repo root (not exec --config)", () => {
		const releaseDir = join(root, NBGV_MISE_DIR);
		expect(nbgvMiseExecEnv(root)).toMatchObject({
			MISE_CONFIG_DIR: releaseDir,
		});
	});

	it("pins dotnet only under release/mise.toml (not CI runner contract)", () => {
		const rootToml = readFileSync(join(root, "mise.toml"), "utf8");
		const releaseToml = readFileSync(join(root, NBGV_MISE_TOML), "utf8");
		expect(rootToml).not.toMatch(/^dotnet\s*=/m);
		expect(releaseToml).toMatch(/^dotnet\s*=\s*"10\.0\.100"/m);
	});
});
