/** Release-scoped mise toolchain for Nerdbank.GitVersioning (not in CI runner image). */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export const NBGV_MISE_TOML = "release/mise.toml";
export const NBGV_MISE_DIR = "release";

export function nbgvMiseConfigPath(repoRoot: string): string {
	return join(repoRoot, NBGV_MISE_TOML);
}

export function nbgvMiseReleaseDir(repoRoot: string): string {
	return join(repoRoot, NBGV_MISE_DIR);
}

/** argv for `mise -C <releaseDir> install --locked` (not deprecated `install --config`). */
export function nbgvMiseInstallArgv(releaseDir: string): readonly string[] {
	return ["-C", releaseDir, "install", "--locked"];
}

/**
 * Env for `mise exec` from repo root with `release/mise.toml` tools (dotnet).
 * `-C release` would chdir into `release/` and break root `pnpm exec nbgv`.
 */
export function nbgvMiseExecEnv(
	repoRoot: string,
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	return { ...base, MISE_CONFIG_DIR: nbgvMiseReleaseDir(repoRoot) };
}

export function ensureNbgvToolchain(repoRoot: string): void {
	const config = nbgvMiseConfigPath(repoRoot);
	const releaseDir = nbgvMiseReleaseDir(repoRoot);
	const trust = spawnSync("mise", ["trust", config], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	if (trust.status !== 0) {
		throw new Error(
			`mise trust ${NBGV_MISE_TOML} failed: ${trust.stderr || trust.stdout}`,
		);
	}
	const install = spawnSync("mise", [...nbgvMiseInstallArgv(releaseDir)], {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: "inherit",
	});
	if (install.status !== 0) {
		throw new Error(`mise install (${NBGV_MISE_TOML}) failed`);
	}
}
