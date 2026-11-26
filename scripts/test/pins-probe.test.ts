/**
 * Asking a server whether it serves a commit must not change any repository
 * of the user's. `git fetch --dry-run` still downloads the pack and writes
 * `.git/shallow`, so the question is asked from a throwaway bare repository
 * under the cache, removed when the answer is in: the superproject and the
 * submodule (a full clone included) keep every object and their history.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { sweepPartials } from "../lib/pins-cache.ts";

import {
	git,
	makeRemote,
	makeWork,
	runBootstrap,
	scratch,
} from "./support/pins-support.ts";

/** What a fetch into `dir` would change: its objects, and whether it is shallow. */
function snapshot(dir: string) {
	const counts = git(dir, ["count-objects", "-v"])
		.split("\n")
		.filter((line) => /^(count|in-pack|packs):/u.test(line))
		.join(" ");
	const gitDir = git(dir, ["rev-parse", "--absolute-git-dir"]);
	return {
		counts,
		shallow: git(dir, ["rev-parse", "--is-shallow-repository"]),
		shallowFile: existsSync(join(gitDir, "shallow")),
	};
}

function probesLeft(work: string): string[] {
	const cache = join(work, ".cache/siblings");
	return existsSync(cache)
		? readdirSync(cache).filter((name) => name.startsWith(".probe-"))
		: [];
}

describe("asking the server changes no repository of the user's", () => {
	it("status --online leaves the superproject as it was", () => {
		const dir = scratch("probe-status");
		const remote = makeRemote(dir);
		// Pinned at the first commit: not the tip, so the server is asked.
		const work = makeWork(dir, remote, 0);
		assert.equal(runBootstrap(work, []).status, 0);
		const before = snapshot(work);
		assert.equal(before.shallow, "false");
		const run = runBootstrap(work, ["--status", "--online"]);
		assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
		assert.match(run.stdout, /lib {2}[0-9a-f]{7} {2}ok {2}\(main is at/u);
		assert.deepEqual(
			snapshot(work),
			before,
			"objects and shallowness unchanged",
		);
		assert.equal(existsSync(join(work, ".git/shallow")), false);
		assert.deepEqual(probesLeft(work), [], "the throwaway repository is gone");
	});

	it("bump of a full submodule clone keeps its history and objects", () => {
		const dir = scratch("probe-bump");
		const remote = makeRemote(dir);
		const work = makeWork(dir, remote, 2);
		assert.equal(runBootstrap(work, []).status, 0);
		const sub = join(work, "external/lib");
		// A developer's own full clone of the library.
		git(sub, ["fetch", "-q", "--unshallow", "origin"]);
		const before = snapshot(sub);
		const superBefore = snapshot(work);
		assert.equal(before.shallow, "false");
		const run = runBootstrap(work, ["--bump", "lib", remote.shas[1] ?? ""]);
		assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
		assert.equal(git(sub, ["rev-parse", "HEAD"]), remote.shas[1]);
		const after = snapshot(sub);
		assert.equal(after.shallow, "false", "still a full clone");
		assert.equal(after.shallowFile, false, "no .git/shallow was written");
		assert.equal(after.counts, before.counts, "no objects were added");
		assert.equal(
			git(sub, ["rev-list", "--count", remote.shas[2] ?? ""]),
			"3",
			"the whole history is still there",
		);
		assert.deepEqual(snapshot(work), superBefore, "nor in the superproject");
		assert.deepEqual(probesLeft(work), []);
	});
});

describe("a probe repository a killed run left", () => {
	it("is swept after an hour, and a young one is kept", async () => {
		const cache = join(scratch("probe-sweep"), "siblings");
		const old = join(cache, ".probe-AbCd12");
		const young = join(cache, ".probe-ZyXw98");
		for (const dir of [old, young])
			mkdirSync(join(dir, "objects"), { recursive: true });
		const hours = new Date(Date.now() - 2 * 3_600_000);
		utimesSync(old, hours, hours);
		const removed = await sweepPartials(cache);
		assert.deepEqual(removed, [old]);
		assert.equal(existsSync(young), true, "it may be a probe running now");
	});
});

describe("the probe's captured output", () => {
	it("is capped at 64 MiB: a git that writes more is stopped and refused", () => {
		const dir = scratch("probe-flood");
		const remote = makeRemote(dir);
		const work = makeWork(dir, remote, 0);
		assert.equal(runBootstrap(work, []).status, 0);
		const real = execFileSync("sh", ["-c", "command -v git"], {
			encoding: "utf8",
		}).trim();
		const bin = join(dir, "bin");
		mkdirSync(bin);
		writeFileSync(
			join(bin, "git"),
			`#!/bin/sh\ncase "$(pwd)" in */.probe-*) case " $* " in *" fetch "*) head -c 70000000 /dev/zero | tr '\\0' x >&2; exit 1;; esac;; esac\nexec '${real}' "$@"\n`,
			{ mode: 0o755 },
		);
		const run = runBootstrap(work, ["--status", "--online"], {
			PATH: `${bin}:${process.env.PATH ?? ""}`,
		});
		assert.equal(run.status, 1, run.stderr.slice(0, 500));
		assert.match(run.stderr, /GIT_FAILED: .*wrote more than 64 MiB/u);
		assert.ok(
			run.stderr.length < 10_000,
			`${run.stderr.length} bytes of error`,
		);
		assert.deepEqual(probesLeft(work), []);
	});
});
