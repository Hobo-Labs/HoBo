import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Live-lane toolchain paths.
 *
 * Both entries honour their environment variable first (`CELLD_BIN`,
 * `CELLD_ESBUILD` — both listed in `turbo.json` `globalPassThroughEnv`, so they
 * reach tasks) and otherwise resolve something that exists on this machine.
 * A missing binary remains a **failure, not a skip**: these helpers only decide
 * *where* to look, never whether to run.
 */

const repoRoot = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"..",
	"..",
	"..",
	"..",
);

/** Where `scripts/fetch-celld.mts` installs the pinned binary. */
export const DEFAULT_CELLD_BIN = "/tmp/hobo-live/bin/celld";

export function celldBinPath(): string {
	const fromEnv = process.env.CELLD_BIN;
	return fromEnv !== undefined && fromEnv !== "" ? fromEnv : DEFAULT_CELLD_BIN;
}

function esbuildPlatformDir(): string | undefined {
	const arch = process.arch === "x64" ? "x64" : process.arch;
	return process.platform === "linux" || process.platform === "darwin"
		? `${process.platform}-${arch}`
		: undefined;
}

/**
 * `celld deploy` bundles with esbuild and takes its path from `CELLD_ESBUILD`.
 * The workspace already installs the native binary as a transitive dependency
 * of vite, so the live lane uses that rather than requiring a separate install.
 */
export function esbuildPath(): string {
	const fromEnv = process.env.CELLD_ESBUILD;
	if (fromEnv !== undefined && fromEnv !== "") return fromEnv;

	const platform = esbuildPlatformDir();
	const store = join(repoRoot, "node_modules", ".pnpm");
	if (platform !== undefined && existsSync(store)) {
		const prefix = `@esbuild+${platform}@`;
		const candidates = readdirSync(store)
			.filter((entry) => entry.startsWith(prefix))
			.sort((left, right) => left.localeCompare(right, "en", { numeric: true }))
			.map((entry) =>
				join(
					store,
					entry,
					"node_modules",
					"@esbuild",
					platform,
					"bin",
					"esbuild",
				),
			)
			.filter((candidate) => existsSync(candidate));
		const newest = candidates.at(-1);
		if (newest !== undefined) return newest;
	}
	return join(repoRoot, "node_modules", ".bin", "esbuild");
}

/**
 * A missing binary is a failure, not a skip (see the package README). Throwing
 * from `describe` turns the whole live file red, which is the intended policy.
 */
export function requireCelldBin(): void {
	const binPath = celldBinPath();
	if (!existsSync(binPath)) {
		throw new Error(
			`celld live test requires ${binPath} (set CELLD_BIN, or run \`pnpm run fetch:celld\`). Missing binary is a failure.`,
		);
	}
}
