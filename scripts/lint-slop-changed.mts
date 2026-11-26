#!/usr/bin/env node
/**
 * anti-slop changed-file lane: runs the vendored Oxlint plugin
 * (tools/oxlint/anti-slop, configured in oxlint.config.ts) on just the files a
 * commit or PR touches, so the pre-existing repo-wide backlog does not block
 * commits but no new violations slip in. `--deny-warnings` keeps changed files
 * warning-clean as well (unused vars, useless spreads, …). Directory ignores
 * stay owned by oxlint.config.ts — explicitly passed paths still honor its
 * ignorePatterns.
 *
 * Usage:
 *   node --import tsx scripts/lint-slop-changed.mts --staged
 *   node --import tsx scripts/lint-slop-changed.mts --base=origin/main
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";

import { reachRemedy } from "./lib/base-ref.ts";
import {
	type CommandInvocation,
	commandForPlatform,
	sanitizeNodeOptions,
	withoutPackageManager,
} from "./lib/env.ts";

const LINTABLE = /\.(?:[cm]?[jt]s|[jt]sx)$/u;
const CHUNK_SIZE = 200;

/** git's output, or `undefined` when git failed: a failure is not "no output". */
function git(args: string[]): string | undefined {
	const result = spawnSync("git", args, {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
		env: sanitizeNodeOptions(),
	});
	if (result.error || result.status !== 0) return undefined;
	return result.stdout.trim();
}

/**
 * The changed files, or a refusal. When git cannot list them (an unknown or
 * unfetched base, a shallow clone, no repository) the lane used to read the
 * failure as an empty diff and report itself clean, so a gate that never saw a
 * file passed. It fails closed instead.
 */
function changedFiles(staged: boolean, base: string): string[] {
	const diffArgs = ["diff", "--name-only", "--diff-filter=ACMR"];
	const listed = staged
		? git([...diffArgs, "--cached"])
		: git([...diffArgs, git(["merge-base", base, "HEAD"]) || base, "HEAD"]);
	if (listed === undefined) {
		console.error(
			staged
				? "fail  lint:slop:changed — git could not list the staged files, so nothing was linted."
				: `fail  lint:slop:changed — git could not diff against ${base}, so nothing was linted. ${reachRemedy(base)}`,
		);
		process.exit(2);
	}
	return listed.split(/\r?\n/).filter(Boolean);
}

const args = process.argv.slice(2);
const staged = args.includes("--staged");
const baseFlag = args.find((arg) => arg.startsWith("--base="));
const base =
	baseFlag === undefined ? "HEAD~1" : baseFlag.slice("--base=".length);

function cannotLint(why: string): void {
	console.error(`fail  lint:slop:changed — ${why}`);
}

/** Oxlint over `chunk`, or a refusal when it cannot run without pnpm. */
function oxlint(chunk: string[]): CommandInvocation {
	try {
		const direct = withoutPackageManager("pnpm", [
			"exec",
			"oxlint",
			"--deny-warnings",
			"--no-error-on-unmatched-pattern",
			...chunk,
		]);
		return commandForPlatform(direct.command, direct.args);
	} catch (cause) {
		cannotLint(
			`${cause instanceof Error ? cause.message : String(cause)}, so nothing was linted.`,
		);
		return process.exit(2);
	}
}

const files = changedFiles(staged, base)
	.filter((file) => LINTABLE.test(file))
	.filter((file) => existsSync(file));

if (files.length === 0) {
	console.log("ok  lint:slop:changed — no changed lintable files.");
	process.exit(0);
}

let failure = 0;
for (let index = 0; index < files.length; index += CHUNK_SIZE) {
	const chunk = files.slice(index, index + CHUNK_SIZE);
	const invocation = oxlint(chunk);
	const result = spawnSync(invocation.command, invocation.args, {
		stdio: "inherit",
		env: sanitizeNodeOptions(),
	});
	if (result.error) {
		cannotLint(
			`could not start ${invocation.command}: ${result.error.message}`,
		);
	}
	if (result.status !== 0) failure = result.status ?? 1;
}

if (failure !== 0) {
	console.error(
		`fail  lint:slop:changed — anti-slop/warning findings in changed files (${files.length} file(s) linted).`,
	);
	process.exit(failure);
}
console.log(
	`ok  lint:slop:changed — ${files.length} changed file(s) clean under anti-slop rules.`,
);
