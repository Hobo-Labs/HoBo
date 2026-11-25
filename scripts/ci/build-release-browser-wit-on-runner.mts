#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";

import { assertReleasePagesBrowserRuntimeWit } from "../lib/release-pages-wit.mts";
import { releaseSitePrebuildTurboArgs } from "./build-release-site-prebuild.mts";

const root = path.join(import.meta.dirname, "..", "..");

function main(): void {
	const checkoutRef = process.env.HOBO_RELEASE_CHECKOUT_REF?.trim() || "HEAD";
	process.stderr.write(
		`browser-wit: release runner smoke HOBO_RELEASE_CHECKOUT_REF=${checkoutRef}\n`,
	);
	assertReleasePagesBrowserRuntimeWit(root, checkoutRef);
	const prebuild = spawnSync("pnpm", releaseSitePrebuildTurboArgs(), {
		cwd: root,
		stdio: "inherit",
		env: process.env,
	});
	if (prebuild.status !== 0) {
		process.exit(prebuild.status ?? 1);
	}
	const build = spawnSync(
		"pnpm",
		["--filter", "hobo-site", "run", "examples:runtime"],
		{ cwd: root, stdio: "inherit", env: process.env },
	);
	process.exit(build.status ?? 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
