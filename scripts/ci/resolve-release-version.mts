#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseReleaseRef } from "../lib/release-version.mts";

function main(): void {
	const ref = process.argv[2] ?? process.env.HOBO_RELEASE_VERSION ?? "";
	const githubEnv = process.argv.includes("--github-env");
	if (!ref.trim()) {
		console.error(
			"usage: node scripts/ci/resolve-release-version.mts <release-ref> [--github-env]",
		);
		process.exit(2);
	}
	const parsed = parseReleaseRef(ref);
	const lines = [
		`HOBO_RELEASE_SEMVER=${parsed.semver}`,
		`HOBO_RELEASE_NPM_DIST_TAG=${parsed.npmDistTag}`,
		`HOBO_RELEASE_GHCR_TAG=${parsed.ghcrTag}`,
		`HOBO_RELEASE_TRAIN=${parsed.train}`,
	];
	if (githubEnv) {
		const path = process.env.GITHUB_ENV;
		if (!path) {
			throw new Error("GITHUB_ENV is not set");
		}
		appendFileSync(path, `${lines.join("\n")}\n`, "utf8");
		return;
	}
	for (const line of lines) console.log(line);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
