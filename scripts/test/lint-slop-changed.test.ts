import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const lane = join(root, "scripts/lint-slop-changed.mts");

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function emptyDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-slop-lane-"));
	scratch.push(dir);
	return dir;
}

/** A repository with no commits and nothing staged. */
function emptyRepo(): string {
	const dir = emptyDir();
	const init = spawnSync("git", ["init", "--quiet"], { cwd: dir });
	assert.equal(init.status, 0, String(init.stderr));
	return dir;
}

const fixtureEnv = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.invalid",
	GIT_COMMITTER_NAME: "fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

function git(cwd: string, args: string[]) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
		env: fixtureEnv,
	});
	assert.equal(result.status, 0, result.stderr);
}

/** A repository with a staged TypeScript file and the given oxlint stand-in. */
function stagedRepo(oxlint: string | undefined): string {
	const dir = emptyRepo();
	writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
	git(dir, ["add", "a.ts"]);
	if (oxlint !== undefined) {
		mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
		writeFileSync(join(dir, "node_modules", ".bin", "oxlint"), oxlint, {
			mode: 0o644,
		});
	}
	return dir;
}

function runLane(cwd: string, flag: string) {
	return spawnSync(
		process.execPath,
		["--experimental-strip-types", "--no-warnings", lane, flag],
		{ cwd, encoding: "utf8" },
	);
}

// The lane is the only anti-slop gate a commit meets, so it must never report
// itself clean for a diff it could not read. It used to: a git failure became
// an empty file list, and the lane printed "ok". Nothing here reaches oxlint;
// every case is decided by whether git could list the changed files.
describe("lint:slop:changed when git cannot list the changed files", () => {
	it("fails, naming the base, when the base does not resolve", () => {
		const result = runLane(emptyRepo(), "--base=origin/no-such-branch");
		assert.equal(result.status, 2, result.stdout + result.stderr);
		assert.match(
			result.stderr,
			/could not diff against origin\/no-such-branch/u,
		);
		assert.doesNotMatch(result.stdout, /^ok /mu);
	});

	it("fails outside a git work tree", () => {
		const result = runLane(emptyDir(), "--staged");
		assert.equal(result.status, 2, result.stdout + result.stderr);
		assert.match(result.stderr, /could not list the staged files/u);
	});

	it("names deepening, not fetching, for HEAD~1 in a depth-1 clone", () => {
		const source = emptyRepo();
		for (const index of [0, 1]) {
			writeFileSync(join(source, `file-${index}.txt`), `${index}\n`);
			git(source, ["add", "."]);
			git(source, ["commit", "--quiet", "--no-verify", "-m", `${index}`]);
		}
		const clone = join(emptyDir(), "clone");
		git(source, ["clone", "--quiet", "--depth=1", `file://${source}`, clone]);
		const result = runLane(clone, "--base=HEAD~1");
		assert.equal(result.status, 2, result.stdout + result.stderr);
		assert.match(result.stderr, /git fetch --deepen=1/u);
	});

	it("still passes an empty but readable diff", () => {
		// The control: nothing staged in a real repository is a genuine "nothing
		// to lint", not a failure to look.
		const result = runLane(emptyRepo(), "--staged");
		assert.equal(result.status, 0, result.stdout + result.stderr);
		assert.match(result.stdout, /no changed lintable files/u);
	});
});

// A lint that never ran is not a clean lint, and the person committing has to
// be told why it did not run: an exec it could not resolve used to crash with
// a stack trace, and a binary that would not start printed nothing.
describe("lint:slop:changed when oxlint cannot start", () => {
	it("says oxlint is not installed, without a stack trace", () => {
		const result = runLane(stagedRepo(undefined), "--staged");
		assert.equal(result.status, 2, result.stdout + result.stderr);
		assert.match(
			result.stderr,
			/fail {2}lint:slop:changed — pnpm exec oxlint: node_modules\/\.bin\/oxlint is not installed/u,
		);
		assert.doesNotMatch(result.stderr, /^\s+at /mu);
	});

	it("says why an installed oxlint could not start", () => {
		// Present but not executable: the spawn itself fails (EACCES).
		const result = runLane(stagedRepo("#!/bin/sh\nexit 0\n"), "--staged");
		assert.notEqual(result.status, 0, result.stdout + result.stderr);
		assert.match(
			result.stderr,
			/fail {2}lint:slop:changed — could not start .*oxlint: .*EACCES/u,
		);
	});
});
