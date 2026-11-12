#!/usr/bin/env node
/**
 * Stage a verified headless-shell zip for docker build context (runner base).
 */
import { copyFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	ensurePlaywrightHeadlessShellArchive,
	headlessShellArchFromHost,
	headlessShellArchiveSpec,
} from "../lib/playwright-headless-shell-archive.mts";

const root = join(import.meta.dirname, "..", "..");
const arch = headlessShellArchFromHost(process.env.TARGETARCH ?? process.arch);
const hostCache =
	process.env.HOBO_CI_PLAYWRIGHT_CACHE?.trim() ||
	join(process.env.HOME ?? "/tmp", ".cache", "hobo-ci", "playwright");
const staging = join(
	root,
	"packages/ci-gh-actions/deploy/ci-runner/base/playwright-cache",
);

mkdirSync(staging, { recursive: true });
for (const name of readdirSync(staging)) {
	if (name === ".gitkeep") continue;
	rmSync(join(staging, name), { force: true });
}

const spec = headlessShellArchiveSpec(arch);
const archive = ensurePlaywrightHeadlessShellArchive({
	cacheDir: hostCache,
	arch,
});
const dest = join(staging, spec.cacheName);
copyFileSync(archive, dest);
console.error(`staged playwright archive ${dest} (host cache ${hostCache})`);
