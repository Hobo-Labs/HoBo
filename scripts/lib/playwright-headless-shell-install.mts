import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CI_RUNNER_PLAYWRIGHT_CHROMIUM } from "./ci-runner-contract.mts";
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

export function playwrightHeadlessShellInstallDir(
	browsersRoot = HOSTED_PLAYWRIGHT_BROWSERS_ROOT,
): string {
	return join(
		browsersRoot,
		`chromium_headless_shell-${CI_RUNNER_PLAYWRIGHT_CHROMIUM.revision}`,
	);
}

export function playwrightHeadlessShellInstalled(
	browsersRoot = HOSTED_PLAYWRIGHT_BROWSERS_ROOT,
): boolean {
	const dir = playwrightHeadlessShellInstallDir(browsersRoot);
	return (
		existsSync(join(dir, "INSTALLATION_COMPLETE")) &&
		statSync(join(dir, "INSTALLATION_COMPLETE")).isFile()
	);
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
	const marker = join(installDir, "INSTALLATION_COMPLETE");
	if (!existsSync(marker)) {
		throw new Error(
			`playwright headless-shell install incomplete at ${installDir}`,
		);
	}
	return installDir;
}

export function playwrightBrowsersCacheKeyInputs(): string {
	const lock = readFileSync("pnpm-lock.yaml", "utf8");
	const contract = readFileSync("scripts/lib/ci-runner-contract.mts", "utf8");
	const spec = headlessShellArchiveSpec(
		headlessShellArchFromHost(process.arch),
	);
	return `${lock}\n${contract}\n${spec.revision}\n${spec.digest}`;
}
