/**
 * Which repository a submodule's `.git` may name.
 *
 * git puts a submodule's repository at `<superproject git dir>/modules/<name>`,
 * also when the superproject was cloned with `--separate-git-dir`, is a
 * linked worktree, or is itself a submodule; an older git, or a person, keeps
 * it in the path's own `.git` directory; a hand-made `git clone
 * --separate-git-dir` keeps it in a directory that serves no other work tree
 * (no core.worktree naming another directory: that decides git's top level,
 * which is checked first).
 * Those are used. A `.git` file naming anything else (another working
 * clone's `.git`, a linked worktree of another repository, some other
 * directory inside the superproject's git dir) is refused before any git
 * runs there, with the fix to clone it again. Before, status advised a
 * `stash` in it and fetch then detached the other clone.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	git,
	makeRemote,
	makeWork,
	type Remote,
	runBootstrap,
	scratch,
} from "./support/pins-support.ts";

const FIX =
	"fix: mv external/lib external/lib.kept && git submodule update --init -- external/lib";

interface Fixture {
	readonly dir: string;
	readonly remote: Remote;
	readonly work: string;
	readonly lib: string;
}

/** A checkout set up the ordinary way: external/lib at the pin, shas[1]. */
function fixture(): Fixture {
	const dir = scratch("gitdir");
	const remote = makeRemote(dir);
	const work = makeWork(dir, remote, 1);
	assert.equal(runBootstrap(work, []).status, 0);
	return { dir, remote, work, lib: join(work, "external/lib") };
}

/** Everything a run could change in the repository at `gitDir`. */
function repositoryState(gitDir: string) {
	const index = join(gitDir, "index");
	return {
		head: readFileSync(join(gitDir, "HEAD"), "utf8"),
		refs: git(gitDir, [
			"--git-dir",
			gitDir,
			"for-each-ref",
			"--format=%(refname) %(objectname)",
		]),
		objects: git(gitDir, ["--git-dir", gitDir, "count-objects", "-v"]),
		index: existsSync(index)
			? createHash("sha256").update(readFileSync(index)).digest("hex")
			: "",
	};
}

function pointAt(lib: string, gitdir: string): void {
	rmSync(join(lib, ".git"), { recursive: true, force: true });
	writeFileSync(join(lib, ".git"), `gitdir: ${gitdir}\n`);
}

interface Elsewhere {
	readonly label: string;
	/** Points external/lib/.git elsewhere; answers the git dir it names. */
	readonly arrange: (setup: Fixture) => string;
	readonly reason: RegExp;
}

const ELSEWHERE: readonly Elsewhere[] = [
	{
		label: "another working clone's .git",
		arrange: ({ dir, remote, lib }) => {
			git(dir, ["clone", "-q", remote.dir, join(dir, "sibling")]);
			pointAt(lib, "../../../sibling/.git");
			return join(dir, "sibling/.git");
		},
		reason: /is the repository of another working tree \(.*\/sibling\)/u,
	},
	{
		label: "a linked worktree of another clone",
		arrange: ({ dir, remote, lib }) => {
			const sibling = join(dir, "sibling");
			git(dir, ["clone", "-q", remote.dir, sibling]);
			git(sibling, ["worktree", "add", "-q", "-b", "side", join(dir, "side")]);
			const linked = join(sibling, ".git/worktrees/side");
			pointAt(lib, linked);
			return linked;
		},
		reason: /is a linked worktree of the repository at .*\/sibling\/\.git/u,
	},
	{
		label: "another directory in the superproject's git dir",
		arrange: ({ work, lib }) => {
			const stray = join(work, ".git/modules/stray");
			cpSync(join(work, ".git/modules/external/lib"), stray, {
				recursive: true,
			});
			git(work, [
				"config",
				"--file",
				join(stray, "config"),
				"--unset",
				"core.worktree",
			]);
			pointAt(lib, "../../.git/modules/stray");
			return stray;
		},
		reason:
			/is inside the superproject's git directory but is not this submodule's \(.*\/\.git\/modules\/external\/lib\)/u,
	},
];

describe("a submodule .git that names another repository is refused", () => {
	it("a separate git dir whose core.worktree names another directory", () => {
		const { dir, remote, work, lib } = fixture();
		const other = join(dir, "other");
		git(work, [
			"clone",
			"-q",
			"--separate-git-dir",
			join(dir, "lib.git"),
			remote.dir,
			other,
		]);
		git(work, [
			"config",
			"--file",
			join(dir, "lib.git/config"),
			"core.worktree",
			other,
		]);
		pointAt(lib, join(dir, "lib.git"));
		const before = repositoryState(join(dir, "lib.git"));
		for (const args of [
			["--status", "--offline"],
			["--fetch", "lib"],
		]) {
			const run = runBootstrap(work, args);
			const out = `${run.stdout}${run.stderr}`;
			assert.equal(run.status, 1, out);
			assert.match(out, /git answers for .*\/other instead/u);
			assert.ok(out.includes(FIX), out);
		}
		assert.deepEqual(repositoryState(join(dir, "lib.git")), before);
	});

	for (const { label, arrange, reason } of ELSEWHERE) {
		it(`${label}: status, fetch, setup and bump refuse and change nothing`, () => {
			const setup = fixture();
			const named = arrange(setup);
			const before = repositoryState(named);
			const status = runBootstrap(setup.work, ["--status", "--offline"]);
			const said = `${status.stdout}${status.stderr}`;
			assert.equal(status.status, 1, said);
			assert.match(said, reason);
			assert.ok(said.includes(FIX), said);
			assert.doesNotMatch(said, /stash/u);
			for (const args of [
				["--fetch", "lib"],
				[],
				["--bump", "lib", setup.remote.shas[2] ?? ""],
			]) {
				const run = runBootstrap(setup.work, args);
				const out = `${run.stdout}${run.stderr}`;
				assert.equal(run.status, 1, `${args.join(" ")}: ${out}`);
				assert.match(out, reason, args.join(" "));
			}
			assert.deepEqual(repositoryState(named), before);
		});
	}
});

interface Layout {
	readonly label: string;
	/** Rearranges external/lib; answers the checkout to run the pins in. */
	readonly arrange: (setup: Fixture) => string;
}

const LAYOUTS: readonly Layout[] = [
	{
		label: "the modules directory submodule update makes",
		arrange: ({ work, lib }) => {
			assert.equal(
				readFileSync(join(lib, ".git"), "utf8"),
				"gitdir: ../../.git/modules/external/lib\n",
			);
			return work;
		},
	},
	{
		label: "a .git directory in the path",
		arrange: ({ remote, work, lib }) => {
			rmSync(lib, { recursive: true, force: true });
			git(work, ["clone", "-q", remote.dir, lib]);
			git(lib, ["checkout", "-q", remote.shas[1] ?? ""]);
			return work;
		},
	},
	{
		label: "a hand-made clone with --separate-git-dir",
		arrange: ({ dir, remote, work, lib }) => {
			rmSync(lib, { recursive: true, force: true });
			git(work, [
				"clone",
				"-q",
				"--separate-git-dir",
				join(dir, "lib.git"),
				remote.dir,
				lib,
			]);
			git(lib, ["checkout", "-q", remote.shas[1] ?? ""]);
			return work;
		},
	},
	{
		label: "a superproject that is a linked worktree",
		arrange: ({ dir, work }) => {
			const linked = join(dir, "linked");
			git(work, ["worktree", "add", "-q", "-b", "side", linked]);
			assert.equal(runBootstrap(linked, []).status, 0);
			assert.equal(
				readFileSync(join(linked, "external/lib/.git"), "utf8"),
				"gitdir: ../../../work/.git/worktrees/linked/modules/external/lib\n",
			);
			return linked;
		},
	},
];

describe("the layouts git and people make are used", () => {
	for (const { label, arrange } of LAYOUTS) {
		it(`${label}: status and fetch succeed`, () => {
			const checkout = arrange(fixture());
			for (const args of [
				["--status", "--offline"],
				["--fetch", "lib"],
			]) {
				const run = runBootstrap(checkout, args);
				const out = `${run.stdout}${run.stderr}`;
				assert.equal(run.status, 0, `${args.join(" ")}: ${out}`);
				assert.doesNotMatch(out, /SUBMODULE_STATE|not a usable/u);
			}
		});
	}
});
