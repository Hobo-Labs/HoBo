#!/usr/bin/env node
/** Write HOBO_RELEASE_* to GITHUB_ENV from a tag ref or nbgv (main train). */
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
	parseReleaseRef,
	tryParseReleaseRef,
	type ParsedReleaseRef,
} from "../lib/release-version.mts";

/** Gate already computed `v0.0.0-alpha.N`; shallow publish checkouts must not re-run nbgv height. */
export function shouldTrustGateReleaseVersion(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if ((env.HOBO_RELEASE_VERSION_MODE ?? "tag-ref") !== "nbgv") {
		return false;
	}
	const ref = env.HOBO_RELEASE_VERSION?.trim() ?? "";
	if (!ref) return false;
	return tryParseReleaseRef(ref)?.train === "full";
}

export function releaseMaterializedEnvLines(
	parsed: ParsedReleaseRef,
): readonly string[] {
	return [
		`HOBO_RELEASE_VERSION=${parsed.ref}`,
		`HOBO_RELEASE_SEMVER=${parsed.semver}`,
		`HOBO_RELEASE_NPM_DIST_TAG=${parsed.npmDistTag}`,
		`HOBO_RELEASE_GHCR_TAG=${parsed.ghcrTag}`,
		`HOBO_RELEASE_TRAIN=${parsed.train}`,
	];
}

function appendGithubEnv(lines: readonly string[]): void {
	const path = process.env.GITHUB_ENV;
	if (!path) throw new Error("GITHUB_ENV is not set");
	appendFileSync(path, `${lines.join("\n")}\n`, "utf8");
}

function materializeFromParsedRef(ref: string): void {
	appendGithubEnv(releaseMaterializedEnvLines(parseReleaseRef(ref)));
}

function main(): void {
	const mode = process.env.HOBO_RELEASE_VERSION_MODE ?? "tag-ref";
	const ref = process.env.HOBO_RELEASE_VERSION?.trim() ?? "";
	const commit = process.env.HOBO_RELEASE_CHECKOUT_REF?.trim() || "HEAD";
	if (!process.env.GITHUB_ENV) throw new Error("GITHUB_ENV is not set");

	if (shouldTrustGateReleaseVersion(process.env)) {
		materializeFromParsedRef(ref);
		return;
	}

	if (mode === "tag-ref") {
		if (!ref) {
			console.error("HOBO_RELEASE_VERSION required for tag-ref materialize");
			process.exit(2);
		}
		materializeFromParsedRef(ref);
		return;
	}

	const result = spawnSync(
		"node",
		[
			"--no-warnings",
			"scripts/ci/compute-release-version.mts",
			commit,
			"--github-env",
		],
		{ encoding: "utf8", stdio: "inherit" },
	);
	process.exit(result.status ?? 1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
