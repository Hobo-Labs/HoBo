#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	anyPathMatchesReleaseHoboFilters,
	loadReleaseHoboPullRequestPathFilters,
} from "../lib/release-hobo-path-filters.mts";

const root = join(import.meta.dirname, "..", "..");

export const RELEASE_TAG_MATCH = "v[0-9]*";

export interface ReleaseScope {
	readonly run: boolean;
	readonly reason: string;
	readonly from?: string;
}

function git(cwd: string, args: readonly string[]) {
	return spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: { ...process.env, LC_ALL: "C" },
	});
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

export function lastReleaseTag(cwd: string, to: string): string | undefined {
	const shallow = git(cwd, ["rev-parse", "--is-shallow-repository"]);
	if (shallow.status !== 0 || shallow.stdout.trim() !== "false") {
		throw new Error(
			"release scope: the checkout is shallow (or not a repository); it needs full history and tags",
		);
	}
	const commit = git(cwd, [
		"rev-parse",
		"--verify",
		"--quiet",
		`${to}^{commit}`,
	]);
	if (commit.status !== 0) {
		throw new Error(`release scope: not a commit: ${to}`);
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
	if (/no (names found|tags can describe)/iu.test(result.stderr)) {
		return undefined;
	}
	throw new Error(`git describe ${to}: ${result.stderr || result.stdout}`);
}

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
			`run=${scope.run ? "true" : "false"}\nfrom=${scope.from ?? ""}\n`,
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
