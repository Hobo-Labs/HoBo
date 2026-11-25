#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { assertReleasePagesBrowserRuntimeWit } from "../lib/release-pages-wit.mts";

const root = join(import.meta.dirname, "..", "..");

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
	const checkoutRef = process.env.HOBO_RELEASE_CHECKOUT_REF?.trim() || "HEAD";
	assertReleasePagesBrowserRuntimeWit(root, checkoutRef);
	const args = releaseSitePrebuildTurboArgs();
	const result = spawnSync("pnpm", args, { cwd: root, stdio: "inherit" });
	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
