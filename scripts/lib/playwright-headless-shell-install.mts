import { spawnSync } from "node:child_process";
import {
	accessSync,
	constants,
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	CI_RUNNER_PLAYWRIGHT_CHROMIUM,
	playwrightHeadlessShellExecutables,
} from "./ci-runner-contract.mts";
import {
	ensurePlaywrightHeadlessShellArchive,
	headlessShellArchFromHost,
	headlessShellArchiveSpec,
} from "./playwright-headless-shell-archive.mts";

export const HOSTED_PLAYWRIGHT_BROWSERS_ROOT = join(
	process.env.HOME ?? "/tmp",
	".cache",
	"hobo-ci",
	"pw-browsers",
);

export const PLAYWRIGHT_BROWSERS_CACHE_HASH_INPUTS = [
	"pnpm-lock.yaml",
	"scripts/lib/ci-runner-contract.mts",
	"scripts/lib/playwright-headless-shell-install.mts",
	"scripts/lib/playwright-headless-shell-archive.mts",
	"scripts/ci/install-hosted-playwright-browser.mts",
] as const;

export function playwrightHeadlessShellInstallDir(
	browsersRoot = HOSTED_PLAYWRIGHT_BROWSERS_ROOT,
): string {
	return join(
		browsersRoot,
		`chromium_headless_shell-${CI_RUNNER_PLAYWRIGHT_CHROMIUM.revision}`,
	);
}

function headlessShellExecutableOnDisk(
	browsersRoot: string,
): string | undefined {
	for (const candidate of playwrightHeadlessShellExecutables(browsersRoot)) {
		if (!existsSync(candidate)) continue;
		try {
			const st = statSync(candidate);
			if (!st.isFile()) continue;
			accessSync(candidate, constants.X_OK);
			return candidate;
		} catch {
			continue;
		}
	}
	return undefined;
}

export function playwrightHeadlessShellInstalled(
	browsersRoot = HOSTED_PLAYWRIGHT_BROWSERS_ROOT,
): boolean {
	return headlessShellExecutableOnDisk(browsersRoot) !== undefined;
}

export function unzipPlaywrightHeadlessShellArchive(
	archive: string,
	installDir: string,
): void {
	mkdirSync(installDir, { recursive: true });
	const result = spawnSync("unzip", ["-q", "-o", archive, "-d", installDir], {
		encoding: "utf8",
	});
	if (result.status !== 0) {
		const detail =
			result.stderr?.trim() || result.stdout?.trim() || "unzip failed";
		throw new Error(`playwright headless-shell unzip failed: ${detail}`);
	}
	writeFileSync(join(installDir, "INSTALLATION_COMPLETE"), `${Date.now()}\n`);
	writeFileSync(join(installDir, "DEPENDENCIES_VALIDATED"), `${Date.now()}\n`);
	const browsersRoot = join(installDir, "..");
	const executable = headlessShellExecutableOnDisk(browsersRoot);
	if (executable === undefined) {
		throw new Error(
			`playwright headless-shell install missing executable under ${installDir}`,
		);
	}
	try {
		accessSync(executable, constants.X_OK);
	} catch {
		const mode = spawnSync("chmod", ["+x", executable], { encoding: "utf8" });
		if (mode.status !== 0) {
			throw new Error(
				`playwright headless-shell executable is not runnable: ${executable}`,
			);
		}
	}
}

export type InstallHostedPlaywrightOptions = Readonly<{
	browsersRoot?: string;
	cacheDir?: string;
	arch?: ReturnType<typeof headlessShellArchFromHost>;
}>;

export function installHostedPlaywrightHeadlessShell(
	options: InstallHostedPlaywrightOptions = {},
): string {
	const browsersRoot = options.browsersRoot ?? HOSTED_PLAYWRIGHT_BROWSERS_ROOT;
	const installDir = playwrightHeadlessShellInstallDir(browsersRoot);
	if (playwrightHeadlessShellInstalled(browsersRoot)) return installDir;
	const arch = options.arch ?? headlessShellArchFromHost(process.arch);
	const cacheDir =
		options.cacheDir ??
		join(process.env.HOME ?? "/tmp", ".cache", "hobo-ci", "playwright");
	const archive = ensurePlaywrightHeadlessShellArchive({ cacheDir, arch });
	unzipPlaywrightHeadlessShellArchive(archive, installDir);
	if (!playwrightHeadlessShellInstalled(browsersRoot)) {
		throw new Error(
			`playwright headless-shell install incomplete at ${installDir}`,
		);
	}
	return installDir;
}

export function playwrightBrowsersCacheKeyInputs(): string {
	const parts = PLAYWRIGHT_BROWSERS_CACHE_HASH_INPUTS.map((rel) =>
		readFileSync(rel, "utf8"),
	);
	const spec = headlessShellArchiveSpec(
		headlessShellArchFromHost(process.arch),
	);
	return `${parts.join("\n")}\n${spec.revision}\n${spec.digest}`;
}
