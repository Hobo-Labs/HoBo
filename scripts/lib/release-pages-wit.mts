import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const RELEASE_PAGES_BROWSER_RUNTIME_WIT_DIR =
	"examples/browser-runtime/wit" as const;

export const RELEASE_PAGES_BROWSER_RUNTIME_WIT_FILE =
	"examples/browser-runtime/wit/station.wit" as const;

function gitBlobAtRef(repoRoot: string, ref: string, path: string): string {
	return execFileSync("git", ["rev-parse", `${ref}:${path}`], {
		cwd: repoRoot,
		encoding: "utf8",
	})
		.trim()
		.toLowerCase();
}

function hashOnDisk(repoRoot: string, relativePath: string): string {
	return execFileSync("git", ["hash-object", relativePath], {
		cwd: repoRoot,
		encoding: "utf8",
	})
		.trim()
		.toLowerCase();
}

export function assertReleasePagesBrowserRuntimeWit(
	repoRoot: string,
	ref = "HEAD",
): void {
	const witFile = RELEASE_PAGES_BROWSER_RUNTIME_WIT_FILE;
	const absolute = join(repoRoot, witFile);
	let size = 0;
	try {
		size = statSync(absolute).size;
	} catch {
		throw new Error(
			`release pages preflight: missing ${witFile} (sparse worktree did not materialize browser-runtime wit)`,
		);
	}
	if (size <= 0) {
		throw new Error(
			`release pages preflight: ${witFile} is empty (expected non-empty file at ${ref})`,
		);
	}
	let expected: string;
	try {
		expected = gitBlobAtRef(repoRoot, ref, witFile);
	} catch {
		throw new Error(
			`release pages preflight: ${witFile} not present at ${ref} in git`,
		);
	}
	const actual = hashOnDisk(repoRoot, witFile);
	if (actual !== expected) {
		throw new Error(
			`release pages preflight: ${witFile} on disk does not match ${ref} (have ${actual}, want ${expected}); stale or partial sparse checkout`,
		);
	}
	readFileSync(absolute);
}
