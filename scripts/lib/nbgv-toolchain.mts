/** Release-scoped mise toolchain for Nerdbank.GitVersioning (not in CI runner image). */
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

export type NbgvToolchainLog = (line: string) => void;

const defaultLog: NbgvToolchainLog = (line) => {
	process.stderr.write(`${line}\n`);
};

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

/** True when `mise which dotnet` resolves using `release/mise.toml`. */
export function nbgvDotnetResolvable(
	repoRoot: string,
	log: NbgvToolchainLog = defaultLog,
): boolean {
	log("nbgv-toolchain: probing mise which dotnet (release scope)");
	const which = spawnSync("mise", ["which", "dotnet"], {
		cwd: repoRoot,
		encoding: "utf8",
		env: nbgvMiseExecEnv(repoRoot),
	});
	if (which.status === 0 && (which.stdout ?? "").trim()) {
		log(`nbgv-toolchain: dotnet already on path: ${which.stdout.trim()}`);
		return true;
	}
	return false;
}

export type EnsureNbgvToolchainOptions = {
	timeoutMs?: number;
	log?: NbgvToolchainLog;
};

function trustReleaseMise(repoRoot: string, log: NbgvToolchainLog): void {
	const config = nbgvMiseConfigPath(repoRoot);
	log(`nbgv-toolchain: trusting ${NBGV_MISE_TOML}`);
	const trust = spawnSync("mise", ["trust", config], {
		cwd: repoRoot,
		encoding: "utf8",
	});
	if (trust.status !== 0) {
		throw new Error(
			`mise trust ${NBGV_MISE_TOML} failed: ${trust.stderr || trust.stdout}`,
		);
	}
}

function runMiseInstallSync(
	repoRoot: string,
	releaseDir: string,
	timeoutMs: number,
	log: NbgvToolchainLog,
): void {
	const argv = [...nbgvMiseInstallArgv(releaseDir)];
	log(`nbgv-toolchain: mise ${argv.join(" ")} (timeout ${timeoutMs} ms)`);
	const install = spawnSync("mise", argv, {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: "inherit",
		env: nbgvMiseExecEnv(repoRoot),
		timeout: timeoutMs,
	});
	if (
		install.error &&
		"code" in install.error &&
		install.error.code === "ETIMEDOUT"
	) {
		throw new Error(
			`mise install (${NBGV_MISE_TOML}) timed out after ${timeoutMs} ms`,
		);
	}
	if (install.status !== 0) {
		throw new Error(`mise install (${NBGV_MISE_TOML}) failed`);
	}
	log("nbgv-toolchain: mise install finished");
}

function runMiseInstallWithHeartbeat(
	repoRoot: string,
	releaseDir: string,
	timeoutMs: number,
	log: NbgvToolchainLog,
): Promise<void> {
	const argv = [...nbgvMiseInstallArgv(releaseDir)];
	log(
		`nbgv-toolchain: mise ${argv.join(" ")} (heartbeat 15s, timeout ${timeoutMs} ms)`,
	);
	return new Promise((resolve, reject) => {
		const child = spawn("mise", argv, {
			cwd: repoRoot,
			stdio: "inherit",
			env: nbgvMiseExecEnv(repoRoot),
		});
		const start = Date.now();
		const heartbeat = setInterval(() => {
			const elapsed = Math.round((Date.now() - start) / 1000);
			log(`nbgv-toolchain: mise install still running (${elapsed}s elapsed)`);
		}, 15_000);
		const timer = setTimeout(() => {
			log("nbgv-toolchain: install timeout — sending SIGTERM to mise");
			child.kill("SIGTERM");
		}, timeoutMs);
		child.on("error", (err) => {
			clearInterval(heartbeat);
			clearTimeout(timer);
			reject(err);
		});
		child.on("exit", (code, signal) => {
			clearInterval(heartbeat);
			clearTimeout(timer);
			if (code === 0) {
				log("nbgv-toolchain: mise install finished");
				resolve();
				return;
			}
			if (signal) {
				reject(
					new Error(
						`mise install (${NBGV_MISE_TOML}) timed out or was killed (${signal})`,
					),
				);
				return;
			}
			reject(
				new Error(`mise install (${NBGV_MISE_TOML}) failed with exit ${code}`),
			);
		});
	});
}

export async function ensureNbgvToolchainAsync(
	repoRoot: string,
	options: EnsureNbgvToolchainOptions = {},
): Promise<void> {
	const log = options.log ?? defaultLog;
	const timeoutMs = options.timeoutMs ?? 180_000;
	if (nbgvDotnetResolvable(repoRoot, log)) {
		return;
	}
	trustReleaseMise(repoRoot, log);
	await runMiseInstallWithHeartbeat(
		repoRoot,
		nbgvMiseReleaseDir(repoRoot),
		timeoutMs,
		log,
	);
	if (!nbgvDotnetResolvable(repoRoot, log)) {
		throw new Error(
			`dotnet still not resolvable after mise install (${NBGV_MISE_TOML})`,
		);
	}
}

export function ensureNbgvToolchain(
	repoRoot: string,
	options: EnsureNbgvToolchainOptions = {},
): void {
	const log = options.log ?? defaultLog;
	const timeoutMs = options.timeoutMs ?? 180_000;
	if (nbgvDotnetResolvable(repoRoot, log)) {
		return;
	}
	trustReleaseMise(repoRoot, log);
	runMiseInstallSync(repoRoot, nbgvMiseReleaseDir(repoRoot), timeoutMs, log);
	if (!nbgvDotnetResolvable(repoRoot, log)) {
		throw new Error(
			`dotnet still not resolvable after mise install (${NBGV_MISE_TOML})`,
		);
	}
}
