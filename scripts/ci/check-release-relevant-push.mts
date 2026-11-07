#!/usr/bin/env node
import { spawnSync } from "node:child_process";
/** True when a commit range touches release-hobo pull_request path filters. */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	anyPathMatchesReleaseHoboFilters,
	loadReleaseHoboPullRequestPathFilters,
} from "../lib/release-hobo-path-filters.mts";

const root = join(import.meta.dirname, "..", "..");

function parseArgs(argv: string[]) {
	let from = "";
	let to = "HEAD";
	let githubOutput: string | undefined;
	for (let i = 2; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		if (arg === "--from") from = argv[++i] ?? "";
		else if (arg === "--to") to = argv[++i] ?? "HEAD";
		else if (arg === "--github-output") githubOutput = argv[++i];
	}
	if (!from.trim()) {
		console.error(
			"usage: check-release-relevant-push.mts --from <rev> [--to <rev>] [--github-output <path>]",
		);
		process.exit(2);
	}
	return { from, to, githubOutput };
}

function gitDiffNameOnly(from: string, to: string): string[] {
	const result = spawnSync("git", ["diff", "--name-only", from, to], {
		cwd: root,
		encoding: "utf8",
	});
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

function main(): void {
	const { from, to, githubOutput } = parseArgs(process.argv);
	const filters = loadReleaseHoboPullRequestPathFilters(root);
	const changed = gitDiffNameOnly(from, to);
	const relevant = anyPathMatchesReleaseHoboFilters(changed, filters);
	if (githubOutput) {
		appendFileSync(
			githubOutput,
			`run=${relevant ? "true" : "false"}\n`,
			"utf8",
		);
		return;
	}
	console.log(relevant ? "release-relevant" : "not-release-relevant");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	main();
}
