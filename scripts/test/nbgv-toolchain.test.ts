import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NBGV_MISE_TOML, nbgvMiseInstallArgs } from "../lib/nbgv-toolchain.mts";

const root = join(import.meta.dirname, "..", "..");

describe("nbgv toolchain scope", () => {
	it("pins dotnet only under release/mise.toml (not CI runner contract)", () => {
		const rootToml = readFileSync(join(root, "mise.toml"), "utf8");
		const releaseToml = readFileSync(join(root, NBGV_MISE_TOML), "utf8");
		expect(rootToml).not.toMatch(/^dotnet\s*=/m);
		expect(releaseToml).toMatch(/^dotnet\s*=\s*"10\.0\.100"/m);
	});

	it("installs with mise -C release/ (install --config removed in mise 2026.11+)", () => {
		expect(nbgvMiseInstallArgs(root)).toEqual([
			"-C",
			join(root, "release"),
			"install",
			"--locked",
		]);
	});
});
