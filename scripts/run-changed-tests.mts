// `test:changed` lane: run only the Vitest-compatible test files that changed
// since the base ref. Replaces an `sh -c` one-liner so it works in Windows
// shells too. The base defaults to HEAD~1 and honors HOBO_CHECK_BASE.
import { spawnSync } from "node:child_process";

import { commandForPlatform, sanitizeNodeOptions } from "./lib/env.ts";
import { GIT_OUTPUT_MAX_BUFFER } from "./lib/git-output.ts";

const base = process.env.HOBO_CHECK_BASE ?? "HEAD~1";

const diff = spawnSync(
	"git",
	[
		"diff",
		"--name-only",
		`${base}...HEAD`,
		"--",
		"*.test.ts",
		"*.test.mts",
		"*.spec.ts",
		"*.spec.mts",
	],
	{ encoding: "utf8", maxBuffer: GIT_OUTPUT_MAX_BUFFER },
);

// Match the old shell behavior: on any git error (e.g. base ref missing in a
// shallow checkout) treat the change set as empty rather than failing.
const output = diff.status === 0 ? (diff.stdout ?? "") : "";
const files = output
	.split(/\r?\n/u)
	.map((line) => line.trim())
	.filter(Boolean);

if (files.length === 0) {
	console.log("No changed Vitest-compatible test files found; lane skipped.");
	process.exit(0);
}

const { command, args } = commandForPlatform("pnpm", [
	"exec",
	"vitest",
	"run",
	"--no-isolate",
	"--passWithNoTests",
	...files,
]);

const result = spawnSync(command, args, {
	stdio: "inherit",
	shell: false,
	env: sanitizeNodeOptions(),
});

process.exit(result.status ?? 1);
