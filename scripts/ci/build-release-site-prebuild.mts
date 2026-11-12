#!/usr/bin/env node
/**
 * Turbo build for release Pages: the whole hobo-site closure before the
 * examples:runtime prebuild.
 *
 * Always the whole closure, never "affected since origin/main": the job runs
 * on a fresh runner, so a package left out has no dist. The whole closure
 * (about 40 tasks) takes about 2 minutes there (run 43144784243). The affected form also broke outright
 * once main had moved past the commit under release: the checkout is shallow,
 * so there was no merge base (finding 125), and with full history a release
 * commit behind main would have selected nothing.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dirname, "..", "..");

/** Workspace packages site prebuild loads (try-site apps, bindles dist, hobo bin, WIT toolchain). */
export const RELEASE_SITE_PREBUILD_FILTER = "hobo-site...";

export function releaseSitePrebuildTurboArgs(): string[] {
	return [
		"exec",
		"turbo",
		"run",
		"build",
		`--filter=${RELEASE_SITE_PREBUILD_FILTER}`,
	];
}

function main(): void {
	const args = releaseSitePrebuildTurboArgs();
	const result = spawnSync("pnpm", args, { cwd: root, stdio: "inherit" });
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
