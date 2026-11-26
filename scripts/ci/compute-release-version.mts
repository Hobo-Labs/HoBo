#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/** Emit HOBO_RELEASE_* from Nerdbank.GitVersioning (fixed alpha train). */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { computeFixedTrainReleaseFromGit } from "../lib/nbgv-release-version.mts";

const root = join(import.meta.dirname, "..", "..");

function gitRevParse(rev: string): string {
	const result = spawnSync("git", ["rev-parse", rev], {
		cwd: root,
		encoding: "utf8",
	});
	if (result.status !== 0) {
		throw new Error(
			`git rev-parse ${rev} failed: ${result.stderr || result.stdout}`,
		);
	}
	return (result.stdout ?? "").trim();
}

function main(): void {
	const commitIsh = process.argv[2]?.trim() || "HEAD";
	const githubEnv = process.argv.includes("--github-env");
	const githubOutputArg = process.argv.indexOf("--github-output");
	const githubOutput =
		githubOutputArg >= 0 ? process.argv[githubOutputArg + 1] : undefined;
	const commitSha = gitRevParse(commitIsh);
	const parsed = computeFixedTrainReleaseFromGit({
		repoRoot: root,
		commitIsh: commitSha,
	});
	const lines = [
		`HOBO_RELEASE_VERSION=${parsed.ref}`,
		`HOBO_RELEASE_SEMVER=${parsed.semver}`,
		`HOBO_RELEASE_NPM_DIST_TAG=${parsed.npmDistTag}`,
		`HOBO_RELEASE_GHCR_TAG=${parsed.ghcrTag}`,
		`HOBO_RELEASE_TRAIN=${parsed.train}`,
	];
	if (githubOutput) {
		appendFileSync(
			githubOutput,
			`run=true\nrelease_ref=${parsed.ref}\nrelease_sha=${commitSha}\n`,
			"utf8",
		);
	}
	if (githubEnv) {
		const path = process.env.GITHUB_ENV;
		if (!path) throw new Error("GITHUB_ENV is not set");
		appendFileSync(path, `${lines.join("\n")}\n`, "utf8");
		return;
	}
	for (const line of lines) console.log(line);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
