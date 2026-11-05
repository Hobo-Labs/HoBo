#!/usr/bin/env node
/** Write HOBO_RELEASE_* to GITHUB_ENV from a tag ref or nbgv (main train). */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function main(): void {
	const mode = process.env.HOBO_RELEASE_VERSION_MODE ?? "tag-ref";
	const ref = process.env.HOBO_RELEASE_VERSION?.trim() ?? "";
	const commit = process.env.HOBO_RELEASE_CHECKOUT_REF?.trim() || "HEAD";
	const githubEnv = process.env.GITHUB_ENV;
	if (!githubEnv) throw new Error("GITHUB_ENV is not set");

	const script =
		mode === "nbgv"
			? "scripts/ci/compute-release-version.mts"
			: "scripts/ci/resolve-release-version.mts";
	const args =
		mode === "nbgv"
			? [script, commit, "--github-env"]
			: [script, ref, "--github-env"];
	const result = spawnSync("node", ["--no-warnings", ...args], {
		encoding: "utf8",
		stdio: "inherit",
	});
	process.exit(result.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
