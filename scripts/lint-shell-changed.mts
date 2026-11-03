#!/usr/bin/env node
/**
 * bash -n + shellcheck on changed shell scripts (release/CI paths).
 *
 * Usage:
 *   node --import tsx scripts/lint-shell-changed.mts --staged
 *   node --import tsx scripts/lint-shell-changed.mts --base=origin/main
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";

import { reachRemedy } from "./lib/base-ref.ts";
import { sanitizeNodeOptions } from "./lib/env.ts";

const SHELL = /\.sh$/u;

function git(args: string[]): string | undefined {
	const result = spawnSync("git", args, {
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
		env: sanitizeNodeOptions(),
	});
	if (result.error || result.status !== 0) return undefined;
	return result.stdout.trim();
}

function changedFiles(staged: boolean, base: string): string[] {
	const diffArgs = ["diff", "--name-only", "--diff-filter=ACMR"];
	const listed = staged
		? git([...diffArgs, "--cached"])
		: git([...diffArgs, git(["merge-base", base, "HEAD"]) || base, "HEAD"]);
	if (listed === undefined) {
		console.error(
			staged
				? "fail  lint:shell:changed — git could not list staged files"
				: `fail  lint:shell:changed — git could not diff against ${base}. ${reachRemedy(base)}`,
		);
		process.exit(2);
	}
	return listed.split(/\r?\n/).filter((file) => SHELL.test(file));
}

function run(cmd: string, args: string[]): number {
	const result = spawnSync(cmd, args, { stdio: "inherit" });
	return result.status ?? 1;
}

function lintShell(file: string): void {
	if (!existsSync(file)) {
		console.error(`fail  lint:shell:changed — missing ${file}`);
		process.exit(1);
	}
	if (run("bash", ["-n", file]) !== 0) {
		console.error(`fail  lint:shell:changed — bash -n ${file}`);
		process.exit(1);
	}
	const shellcheck = spawnSync("shellcheck", ["--version"], {
		encoding: "utf8",
	});
	if (shellcheck.status !== 0) {
		if (process.env.CI || process.env.GITHUB_ACTIONS) {
			console.error(
				"fail  lint:shell:changed — shellcheck required in CI but not on PATH",
			);
			process.exit(1);
		}
		console.warn(
			"warn  lint:shell:changed — shellcheck not installed; bash -n only",
		);
		return;
	}
	if (run("shellcheck", ["-x", file]) !== 0) {
		console.error(`fail  lint:shell:changed — shellcheck ${file}`);
		process.exit(1);
	}
}

const args = process.argv.slice(2);
const staged = args.includes("--staged");
const baseFlag = args.find((arg) => arg.startsWith("--base="));
const base =
	baseFlag === undefined ? "HEAD~1" : baseFlag.slice("--base=".length);

const files = changedFiles(staged, base);
if (files.length === 0) {
	console.log("ok  lint:shell:changed — no changed shell scripts");
	process.exit(0);
}

for (const file of files) {
	lintShell(file);
}
console.log(`ok  lint:shell:changed — ${files.length} script(s)`);
