/**
 * Pinned Playwright chromium headless-shell zip: cache on disk, bounded CDN fetch.
 * Shared by runner base Dockerfile (via install script), build.sh, hosted-toolchain.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CI_RUNNER_PLAYWRIGHT_CHROMIUM } from "./ci-runner-contract.mts";

export type HeadlessShellArch = "amd64" | "arm64";

export type HeadlessShellArchiveSpec = Readonly<{
	url: string;
	digest: string;
	revision: string;
	browsersPath: string;
	cacheName: string;
}>;

export function headlessShellArchFromHost(
	unameMachine: string,
): HeadlessShellArch {
	const m = unameMachine.trim().toLowerCase();
	if (m === "aarch64" || m === "arm64") return "arm64";
	return "amd64";
}

export function headlessShellArchiveSpec(
	arch: HeadlessShellArch,
): HeadlessShellArchiveSpec {
	const revision = CI_RUNNER_PLAYWRIGHT_CHROMIUM.revision;
	const digest =
		arch === "arm64"
			? CI_RUNNER_PLAYWRIGHT_CHROMIUM.sha256.arm64
			: CI_RUNNER_PLAYWRIGHT_CHROMIUM.sha256.amd64;
	const url =
		arch === "arm64"
			? `https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${revision}/chromium-headless-shell-linux-arm64.zip`
			: `https://cdn.playwright.dev/builds/cft/${CI_RUNNER_PLAYWRIGHT_CHROMIUM.browserVersion}/linux64/chrome-headless-shell-linux64.zip`;
	return {
		url,
		digest,
		revision,
		browsersPath: CI_RUNNER_PLAYWRIGHT_CHROMIUM.browsersPath,
		cacheName: `chromium-headless-shell-${arch}-${digest}.zip`,
	};
}

export type EnsureArchiveOptions = Readonly<{
	cacheDir: string;
	arch: HeadlessShellArch;
	/** Max attempts per URL (primary then primary again with backoff cap). */
	maxAttempts?: number;
	connectTimeoutSeconds?: number;
	perAttemptMaxSeconds?: number;
	initialBackoffMs?: number;
	maxBackoffMs?: number;
	/** Wall-clock budget for all download attempts. */
	totalBudgetMs?: number;
}>;

function sha256File(path: string): string {
	const hash = createHash("sha256");
	hash.update(readFileSync(path));
	return hash.digest("hex");
}

function verifyDigest(path: string, digest: string): boolean {
	try {
		return sha256File(path) === digest.toLowerCase();
	} catch {
		return false;
	}
}

export function cachedArchivePath(
	cacheDir: string,
	spec: HeadlessShellArchiveSpec,
): string {
	return join(cacheDir, spec.cacheName);
}

/**
 * Return a verified zip on disk, fetching from CDN only when the cache miss
 * and env HOBO_CI_SKIP_PLAYWRIGHT_DOWNLOAD is unset.
 */
export function ensurePlaywrightHeadlessShellArchive(
	options: EnsureArchiveOptions,
): string {
	const spec = headlessShellArchiveSpec(options.arch);
	const cacheDir = options.cacheDir;
	mkdirSync(cacheDir, { recursive: true });
	const dest = cachedArchivePath(cacheDir, spec);
	if (
		statSync(dest, { throwIfNoEntry: false })?.isFile() &&
		verifyDigest(dest, spec.digest)
	) {
		return dest;
	}
	if (process.env.HOBO_CI_SKIP_PLAYWRIGHT_DOWNLOAD === "1") {
		throw new Error(
			`playwright headless-shell archive missing at ${dest} and HOBO_CI_SKIP_PLAYWRIGHT_DOWNLOAD=1`,
		);
	}
	const maxAttempts = options.maxAttempts ?? 4;
	const connectTimeout = options.connectTimeoutSeconds ?? 15;
	const perAttempt = options.perAttemptMaxSeconds ?? 90;
	const initialBackoff = options.initialBackoffMs ?? 2_000;
	const maxBackoff = options.maxBackoffMs ?? 30_000;
	const totalBudget = options.totalBudgetMs ?? 240_000;
	const tmp = `${dest}.partial`;
	const started = Date.now();
	let backoff = initialBackoff;
	let lastErr = "";
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		if (Date.now() - started > totalBudget) {
			throw new Error(
				`playwright headless-shell download exceeded ${totalBudget}ms budget (last: ${lastErr})`,
			);
		}
		const result = spawnSync(
			"curl",
			[
				"-fsSL",
				"--connect-timeout",
				String(connectTimeout),
				"--max-time",
				String(perAttempt),
				spec.url,
				"-o",
				tmp,
			],
			{ encoding: "utf8" },
		);
		if (result.status === 0 && verifyDigest(tmp, spec.digest)) {
			copyFileSync(tmp, dest);
			try {
				writeFileSync(
					join(cacheDir, `${spec.cacheName}.ok`),
					`${Date.now()}\n`,
				);
			} catch {
				// cache marker is best-effort
			}
			return dest;
		}
		lastErr =
			result.stderr?.trim() ||
			result.stdout?.trim() ||
			`curl exit ${result.status ?? "unknown"}`;
		if (attempt < maxAttempts) {
			const sleepMs = Math.min(
				backoff,
				maxBackoff,
				totalBudget - (Date.now() - started),
			);
			if (sleepMs > 0) spawnSync("sleep", [String(Math.ceil(sleepMs / 1000))]);
			backoff = Math.min(maxBackoff, backoff * 2);
		}
	}
	throw new Error(
		`playwright headless-shell download failed after ${maxAttempts} attempts: ${lastErr}`,
	);
}
