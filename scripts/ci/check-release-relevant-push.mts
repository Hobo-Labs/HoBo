#!/usr/bin/env node
/**
 * Whether the main train has something to release.
 *
 * `--since-last-release` asks "did a release path change since the last
 * release tag in this commit's history?". The older `--from <rev>` form asked
 * only about one range, usually `head^..head`: a commit whose CI run was
 * cancelled by the next push, or that reached `main` behind another in one
 * merge-queue batch, was never asked about again, so its change never shipped
 * unless a later commit happened to touch a release path too.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	anyPathMatchesReleaseHoboFilters,
	loadReleaseHoboPullRequestPathFilters,
} from "../lib/release-hobo-path-filters.mts";

const root = join(import.meta.dirname, "..", "..");

/** Release tags the main train writes (`v0.0.0-alpha.N`); not the `sdk-v`/`cli-v` lines. */
export const RELEASE_TAG_MATCH = "v[0-9]*";

export interface ReleaseScope {
	readonly run: boolean;
	readonly reason: string;
	/** The commit the change set was measured from; undefined when there is no earlier release. */
	readonly from?: string;
}

function git(cwd: string, args: readonly string[]) {
	return spawnSync("git", args, { cwd, encoding: "utf8" });
}

function gitDiffNameOnly(cwd: string, from: string, to: string): string[] {
	const result = git(cwd, ["diff", "--name-only", from, to]);
	if (result.status !== 0) {
		throw new Error(
			`git diff --name-only ${from} ${to}: ${result.stderr || result.stdout}`,
		);
	}
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/** The newest release tag reachable from `to`, or undefined when there is none. */
export function lastReleaseTag(cwd: string, to: string): string | undefined {
	// describe says "no names found" before it reads the revision, so a bad
	// one would read as "never released" without this.
	const commit = git(cwd, [
		"rev-parse",
		"--verify",
		"--quiet",
		`${to}^{commit}`,
	]);
	if (commit.status !== 0) {
		throw new Error(`git describe ${to}: not a commit`);
	}
	const result = git(cwd, [
		"describe",
		"--tags",
		"--abbrev=0",
		"--match",
		RELEASE_TAG_MATCH,
		to,
	]);
	if (result.status === 0) return result.stdout.trim() || undefined;
	// describe exits 128 with "No names found" / "No tags can describe" when
	// nothing matches; anything else (a bad revision, a broken repo) is real.
	if (/no (names found|tags can describe)/iu.test(result.stderr)) {
		return undefined;
	}
	throw new Error(`git describe ${to}: ${result.stderr || result.stdout}`);
}

/** Decide from what changed between `from` and `to`. */
export function releaseScopeBetween(
	cwd: string,
	from: string,
	to: string,
	filters: readonly string[],
): ReleaseScope {
	const relevant = anyPathMatchesReleaseHoboFilters(
		gitDiffNameOnly(cwd, from, to),
		[...filters],
	);
	return {
		run: relevant,
		from,
		reason: relevant
			? `release paths changed between ${from} and ${to}`
			: `no release path changed between ${from} and ${to}`,
	};
}

/** Decide from what changed since the last release tag in `to`'s history. */
export function releaseScopeSinceLastRelease(
	cwd: string,
	to: string,
	filters: readonly string[],
): ReleaseScope {
	const tag = lastReleaseTag(cwd, to);
	if (tag === undefined) {
		return {
			run: true,
			reason: `no release tag (${RELEASE_TAG_MATCH}) in the history of ${to}`,
		};
	}
	const scope = releaseScopeBetween(cwd, `${tag}^{commit}`, to, filters);
	return {
		...scope,
		from: tag,
		reason: scope.run
			? `release paths changed since ${tag}`
			: `no release path changed since ${tag}`,
	};
}

function parseArgs(argv: readonly string[]) {
	let from = "";
	let to = "HEAD";
	let sinceLastRelease = false;
	let githubOutput: string | undefined;
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--from") from = argv[++i] ?? "";
		else if (arg === "--to") to = argv[++i] ?? "HEAD";
		else if (arg === "--since-last-release") sinceLastRelease = true;
		else if (arg === "--github-output") githubOutput = argv[++i];
	}
	if (!from.trim() && !sinceLastRelease) {
		console.error(
			"usage: check-release-relevant-push.mts (--from <rev> | --since-last-release) [--to <rev>] [--github-output <path>]",
		);
		process.exit(2);
	}
	return { from, to, sinceLastRelease, githubOutput };
}

function main(): void {
	const { from, to, sinceLastRelease, githubOutput } = parseArgs(process.argv);
	const filters = loadReleaseHoboPullRequestPathFilters(root);
	const scope = sinceLastRelease
		? releaseScopeSinceLastRelease(root, to, filters)
		: releaseScopeBetween(root, from, to, filters);
	if (githubOutput) {
		console.log(scope.reason);
		appendFileSync(
			githubOutput,
			`run=${scope.run ? "true" : "false"}\n`,
			"utf8",
		);
		return;
	}
	console.log(scope.run ? "release-relevant" : "not-release-relevant");
	console.log(scope.reason);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
