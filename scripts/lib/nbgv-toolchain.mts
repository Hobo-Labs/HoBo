/** Release-scoped mise toolchain for Nerdbank.GitVersioning (not in CI runner image). */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

export const NBGV_MISE_TOML = "release/mise.toml";

export function nbgvMiseConfigPath(repoRoot: string): string {
	return join(repoRoot, NBGV_MISE_TOML);
}

/** mise 2026.11+ dropped `install --config`; use global `-C` to the config directory. */
export function nbgvMiseInstallArgs(repoRoot: string): readonly string[] {
	const config = nbgvMiseConfigPath(repoRoot);
	return ["-C", dirname(config), "install", "--locked"];
}

export function ensureNbgvToolchain(repoRoot: string): void {
	const config = nbgvMiseConfigPath(repoRoot);
	const trust = spawnSync("mise", ["trust", config], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	if (trust.status !== 0) {
		throw new Error(
			`mise trust ${NBGV_MISE_TOML} failed: ${trust.stderr || trust.stdout}`,
		);
	}
	const install = spawnSync("mise", [...nbgvMiseInstallArgs(repoRoot)], {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: "inherit",
	});
	if (install.status !== 0) {
		throw new Error(`mise install (${NBGV_MISE_TOML}) failed`);
	}
}
