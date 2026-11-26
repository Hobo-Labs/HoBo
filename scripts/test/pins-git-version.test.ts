/**
 * The pins need git 2.31 or newer (`git rev-parse --path-format=absolute`;
 * `git config --show-scope`, which the stale-URL read uses, is 2.26). An older
 * git is refused once, up front, with a message that says so. And a git that
 * cannot answer the stale-URL read (it exits with anything but 0, a value,
 * or 1, nothing set) is a problem, never "nothing is configured": before,
 * a git without `--show-scope` read nothing, the check passed, and fetch
 * cloned from a stale URL.
 *
 * Both are shown with a stand-in `git` first on PATH that runs the real one
 * for everything but the one thing an old git does differently.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	git,
	makeRemote,
	makeWork,
	runBootstrap,
	scratch,
} from "./support/pins-support.ts";

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], {
	encoding: "utf8",
}).trim();

/** A directory holding `git`: `when` decides which calls it answers itself. */
function standIn(dir: string, when: string): string {
	const bin = join(dir, "old-git");
	mkdirSync(bin);
	writeFileSync(
		join(bin, "git"),
		`#!/bin/sh\n${when}\nexec ${REAL_GIT} "$@"\n`,
	);
	chmodSync(join(bin, "git"), 0o755);
	return bin;
}

const NO_SHOW_SCOPE = `for a in "$@"; do
  if [ "$a" = "--show-scope" ]; then echo "error: unknown option \\\`show-scope'" >&2; exit 129; fi
done`;

const OLD_VERSION = `if [ "$1" = "--version" ]; then echo "git version 2.25.1"; exit 0; fi`;

const BEFORE_SPARSE_SET_CONE = `if [ "$1" = "--version" ]; then echo "git version 2.33.0"; exit 0; fi`;

/** The URL read dies by a signal, as an OOM kill or a sandbox's SIGSYS would end it. */
const KILLED_ON_READ = `case "$*" in *--show-scope*submodule.*.url*) kill -KILL $$ ;; esac`;

function setUp(when: string, sparse: readonly string[] | null = null) {
	const dir = scratch("git-version");
	const remote = makeRemote(dir);
	const work = makeWork(dir, remote, 1, { sparse });
	const stale = join(dir, "stale");
	git(dir, ["clone", "-q", "--bare", remote.dir, stale]);
	git(work, ["submodule", "init", "--", "external/lib"]);
	git(work, ["config", "submodule.external/lib.url", stale]);
	const env = { PATH: `${standIn(dir, when)}:${process.env.PATH ?? ""}` };
	return { work, env };
}

describe("a git older than the pins need", () => {
	it("a stale-URL read git cannot answer is a problem, not an empty answer", () => {
		const { work, env } = setUp(NO_SHOW_SCOPE);
		const status = runBootstrap(work, ["--status", "--offline"], env);
		assert.equal(status.status, 1, status.stdout);
		assert.match(
			status.stdout,
			/cannot read the URL git's configuration gives external\/lib \(git config exited 129: error: unknown option `show-scope'\)/u,
		);
		const fetch = runBootstrap(work, ["--fetch", "lib"], env);
		assert.equal(fetch.status, 1, `${fetch.stdout}${fetch.stderr}`);
		assert.match(fetch.stderr, /SUBMODULE_STATE: cannot read the URL/u);
		assert.equal(existsSync(join(work, "external/lib/.git")), false);
	});

	it("a git that says it is older than 2.31 is refused before anything runs", () => {
		const { work, env } = setUp(OLD_VERSION);
		for (const args of [["--status", "--offline"], ["--fetch", "lib"], []]) {
			const run = runBootstrap(work, args, env);
			const out = `${run.stdout}${run.stderr}`;
			assert.equal(run.status, 1, `${args.join(" ")}: ${out}`);
			assert.match(
				run.stderr,
				/GIT_FAILED: git version 2\.25\.1 is older than 2\.31, which the pins need/u,
			);
		}
		assert.equal(existsSync(join(work, "external/lib/.git")), false);
	});

	it("a stale-URL read killed by a signal is a problem, not an empty answer", () => {
		const { work, env } = setUp(KILLED_ON_READ);
		const status = runBootstrap(work, ["--status", "--offline"], env);
		assert.equal(status.status, 1, status.stdout);
		assert.match(
			status.stdout,
			/cannot read the URL git's configuration gives external\/lib \(git config was killed by SIGKILL\)/u,
		);
		for (const args of [["--fetch", "lib"], []]) {
			const run = runBootstrap(work, args, env);
			assert.equal(
				run.status,
				1,
				`${args.join(" ")}: ${run.stdout}${run.stderr}`,
			);
			assert.match(run.stderr, /SUBMODULE_STATE: cannot read the URL/u);
		}
		assert.equal(existsSync(join(work, "external/lib/.git")), false);
	});

	it("a pin with a sparse cone needs git 2.35 (sparse-checkout set --cone); without one, 2.31 is enough", () => {
		const sparse = setUp(BEFORE_SPARSE_SET_CONE, ["packages/a"]);
		for (const args of [["--status", "--offline"], ["--fetch", "lib"], []]) {
			const run = runBootstrap(sparse.work, args, sparse.env);
			assert.equal(
				run.status,
				1,
				`${args.join(" ")}: ${run.stdout}${run.stderr}`,
			);
			assert.match(
				run.stderr,
				/GIT_FAILED: git version 2\.33\.0 is older than 2\.35, which the pins need/u,
			);
		}
		assert.equal(existsSync(join(sparse.work, "external/lib/.git")), false);
		const full = setUp(BEFORE_SPARSE_SET_CONE);
		const status = runBootstrap(full.work, ["--status", "--offline"], full.env);
		assert.doesNotMatch(`${status.stdout}${status.stderr}`, /GIT_FAILED/u);
		assert.match(
			status.stdout,
			/this clone's configured URL for external\/lib/u,
		);
	});
});
