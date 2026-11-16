#!/usr/bin/env node
/**
 * Pre-commit secret scan: runs Betterleaks (the gitleaks successor, pinned in
 * mise.toml) over the staged changes with the repo's `.betterleaks.toml`, so a
 * credential is refused before it reaches history rather than after CI's
 * main-gate scan finds it there.
 *
 * Betterleaks is found on PATH, else through `mise which`. A missing scanner
 * fails closed with one line saying how to install it.
 */
import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const STAGED_ARGS = [
	"git",
	"--pre-commit",
	"--staged",
	"--config",
	".betterleaks.toml",
	"--redact",
	"--no-banner",
	"--exit-code",
	"1",
] as const;

export function findBetterleaks(
	run: typeof spawnSync = spawnSync,
): string | undefined {
	const onPath = run("betterleaks", ["version"], { encoding: "utf8" });
	if (onPath.status === 0) return "betterleaks";
	const viaMise = run("mise", ["which", "betterleaks"], { encoding: "utf8" });
	const path = viaMise.status === 0 ? viaMise.stdout.trim() : "";
	return path || undefined;
}

function main(): number {
	const bin = findBetterleaks();
	if (!bin) {
		console.error(
			"secrets:staged: betterleaks is not installed; run `mise install` (it is pinned in mise.toml), or set HOBO_SKIP_HOOKS=1 to commit without this hook.",
		);
		return 1;
	}
	const result = spawnSync(bin, [...STAGED_ARGS], { stdio: "inherit" });
	if (result.status !== 0) {
		console.error(
			"secrets:staged: betterleaks found a secret in the staged changes (redacted above); unstage it, rotate it if it is real, or mark a false positive with a `gitleaks:allow` comment.",
		);
	}
	return result.status ?? 1;
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href)
	process.exit(main());
