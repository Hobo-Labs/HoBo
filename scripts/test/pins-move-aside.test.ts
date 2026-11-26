/**
 * The fix for a checkout whose repository cannot be used moves it aside
 * (`mv <path> <path>.kept`), so no printed fix deletes work. When
 * `<path>.kept` is already taken, a plain `mv` either nests the checkout in
 * it (an empty directory, a symlink to a directory) or fails (a directory
 * with content, a file) and status then prints the same fix again. The name is
 * chosen when the fix is printed: the first of `<path>.kept`,
 * `<path>.kept.1`, `<path>.kept.2`, ... with nothing at it, a link included.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	git,
	gitEnv,
	makeRemote,
	makeWork,
	REPO_ROOT,
	runBootstrap,
	scratch,
} from "./support/pins-support.ts";

const MINE = "MY UNCOMMITTED WORK\n";

/** external/lib cloned, changed, and made to name another clone's `.git`: the checkout must be moved aside. */
function setUp() {
	const dir = scratch("aside");
	const remote = makeRemote(dir);
	const root = makeWork(dir, remote, 1);
	assert.equal(runBootstrap(root, []).status, 0);
	const lib = join(root, "external/lib");
	writeFileSync(join(lib, "README.md"), MINE);
	git(dir, ["clone", "-q", remote.url, join(dir, "sibling")]);
	writeFileSync(join(lib, ".git"), `gitdir: ${join(dir, "sibling/.git")}\n`);
	return { dir, root };
}

/** The fix `status` prints, and the name it says the checkout goes to. */
interface PrintedFix {
	readonly fix: string;
	readonly target: string;
}

function printedFix(root: string): PrintedFix {
	const run = runBootstrap(root, ["--status", "--offline"]);
	assert.equal(run.status, 1, run.stdout);
	const fix =
		/fix: (.+?) {3}\(keeps the old checkout, and any work in it, at (\S+)\)/mu.exec(
			run.stdout,
		);
	assert.ok(fix, `no move-aside fix in:\n${run.stdout}`);
	return { fix: fix[1] ?? "", target: fix[2] ?? "" };
}

/** What was at `<path>.kept` before, and how to tell it is untouched. */
interface Taken {
	readonly label: string;
	readonly make: (kept: string, dir: string) => void;
	readonly untouched: (kept: string, dir: string) => boolean;
}

const TAKEN: readonly Taken[] = [
	{
		label: "an empty directory",
		make: (kept) => mkdirSync(kept),
		untouched: (kept) => readdirSync(kept).length === 0,
	},
	{
		label: "a directory already holding lib/",
		make: (kept) => {
			mkdirSync(join(kept, "lib"), { recursive: true });
			writeFileSync(join(kept, "lib/old.txt"), "OLD\n");
		},
		untouched: (kept) =>
			readFileSync(join(kept, "lib/old.txt"), "utf8") === "OLD\n" &&
			readdirSync(kept).join() === "lib",
	},
	{
		label: "a regular file",
		make: (kept) => writeFileSync(kept, "OLD FILE\n"),
		untouched: (kept) => readFileSync(kept, "utf8") === "OLD FILE\n",
	},
	{
		label: "a symlink to a directory",
		make: (kept, dir) => {
			mkdirSync(join(dir, "elsewhere"));
			symlinkSync(join(dir, "elsewhere"), kept);
		},
		untouched: (kept, dir) =>
			readlinkSync(kept) === join(dir, "elsewhere") &&
			readdirSync(join(dir, "elsewhere")).length === 0,
	},
	{
		label: "a dangling symlink",
		make: (kept, dir) => symlinkSync(join(dir, "nowhere"), kept),
		untouched: (kept, dir) => readlinkSync(kept) === join(dir, "nowhere"),
	},
];

describe("the move-aside fix when <path>.kept is taken", () => {
	it("absent: the fix names <path>.kept, and the checkout is there with its change", () => {
		const { root } = setUp();
		const { fix, target } = printedFix(root);
		assert.equal(target, "external/lib.kept");
		assert.match(fix, /^mv external\/lib external\/lib\.kept && git /u);
		execFileSync("sh", ["-c", fix], { cwd: root, env: gitEnv() });
		assert.equal(readFileSync(join(root, target, "README.md"), "utf8"), MINE);
		assert.equal(runBootstrap(root, ["--status", "--offline"]).status, 0);
	});

	for (const taken of TAKEN) {
		it(`${taken.label}: the fix names <path>.kept.1, it works as printed, and what was there is untouched`, () => {
			const { dir, root } = setUp();
			const kept = join(root, "external/lib.kept");
			taken.make(kept, dir);
			const { fix, target } = printedFix(root);
			assert.equal(target, "external/lib.kept.1");
			assert.match(fix, /^mv external\/lib external\/lib\.kept\.1 && git /u);
			execFileSync("sh", ["-c", fix], { cwd: root, env: gitEnv() });
			assert.equal(
				readFileSync(join(root, target, "README.md"), "utf8"),
				MINE,
				"the checkout and its change are at the printed name",
			);
			assert.equal(
				taken.untouched(kept, dir),
				true,
				"the old entry is as it was",
			);
			assert.equal(lstatSync(join(root, "external/lib")).isDirectory(), true);
			assert.equal(runBootstrap(root, ["--status", "--offline"]).status, 0);
		});
	}

	it("<path>.kept and <path>.kept.1 taken: the fix names <path>.kept.2", () => {
		const { root } = setUp();
		writeFileSync(join(root, "external/lib.kept"), "ONE\n");
		mkdirSync(join(root, "external/lib.kept.1"));
		const { fix, target } = printedFix(root);
		assert.equal(target, "external/lib.kept.2");
		execFileSync("sh", ["-c", fix], { cwd: root, env: gitEnv() });
		assert.equal(readFileSync(join(root, target, "README.md"), "utf8"), MINE);
		assert.deepEqual(readdirSync(join(root, "external/lib.kept.1")), []);
	});

	it("this repository's .gitignore keeps a moved-aside checkout out of git add -A", () => {
		// Left in the tree, a checkout with a .git file is an embedded repository
		// that `git add -A` stages; it is local and machine-specific scratch.
		for (const name of [
			"external/ts-autocode.kept",
			"external/ts-autocode.kept.1",
			"external/ts-autocode.kept.12",
		]) {
			const run = spawnSync("git", ["check-ignore", "--no-index", name], {
				cwd: REPO_ROOT,
				encoding: "utf8",
				env: gitEnv(),
			});
			assert.equal(run.status, 0, `${name} is not ignored`);
		}
		const kept = spawnSync(
			"git",
			["check-ignore", "--no-index", "external/ts-autocode"],
			{
				cwd: REPO_ROOT,
				encoding: "utf8",
				env: gitEnv(),
			},
		);
		assert.equal(kept.status, 1, "the submodule itself is not ignored");
	});
});
