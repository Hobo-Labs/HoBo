/**
 * Fixtures for the tests of a git ended by a signal: a stand-in `git` first on
 * PATH that ends itself the way the test says, and a way to run a small
 * program that calls the pins' git primitives with it.
 */
import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT, scratch } from "./pins-support.ts";

export const REAL_GIT = spawnSync("sh", ["-c", "command -v git"], {
	encoding: "utf8",
}).stdout.trim();

/**
 * A directory holding a `git` that does `STANDIN_ACTION` (`kill:<SIG>` or
 * `exit:<n>`), else runs the real one. It gives up its own core file first:
 * a test that looks for the core file of the wrapper must not find the
 * stand-in's.
 */
export function standIn(dir: string): string {
	const bin = join(dir, "bin");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "git"),
		`#!/bin/sh
ulimit -c 0 2>/dev/null
case "$STANDIN_ACTION" in
  kill:SIG*) kill -s "\${STANDIN_ACTION#kill:SIG}" $$ ;;
  exit:*) exit "\${STANDIN_ACTION#exit:}" ;;
esac
exec '${REAL_GIT}' "$@"
`,
	);
	chmodSync(join(bin, "git"), 0o755);
	return bin;
}

/** The file URL of a library module, as a JSON string for a program's `import()`. */
export const lib = (name: string): string =>
	JSON.stringify(pathToFileURL(join(REPO_ROOT, "scripts/lib", name)).href);

export interface Ran {
	readonly dir: string;
	readonly run: SpawnSyncReturns<string>;
}

/**
 * `program` (an ES module) under node, in a scratch directory, with the
 * stand-in git first on PATH doing `action`. With `core` the shell that starts
 * node first raises the core-file limit to unlimited.
 */
export function runWithStandIn(
	program: string,
	action: string,
	core = false,
): Ran {
	const dir = scratch("signal");
	const node = [
		process.execPath,
		"--experimental-strip-types",
		"--input-type=module",
		"-e",
		program,
	];
	const [command, args] = core
		? ["sh", ["-c", 'ulimit -c unlimited && exec "$@"', "sh", ...node]]
		: [node[0] ?? "", node.slice(1)];
	const run = spawnSync(command, args, {
		cwd: dir,
		encoding: "utf8",
		env: {
			...process.env,
			NODE_OPTIONS: "",
			NODE_NO_WARNINGS: "1",
			PATH: `${standIn(dir)}:${process.env.PATH ?? ""}`,
			STANDIN_ACTION: action,
		},
	});
	return { dir, run };
}
