/**
 * A submodule's `.git` that names the superproject's own repository is
 * refused before any git runs there: a `.git` link to `../../.git`, or a
 * `.git` file holding `gitdir: ../../.git`. git's top level is then the
 * submodule's path (so the R4 check passes) but the repository is the
 * superproject's: status used to report the superproject's commit as the
 * submodule's HEAD and advise `git -C <path> stash`, and fetch, following
 * that, wrote the library's branches into the superproject's refs.
 */
import assert from "node:assert/strict";
import {
	existsSync,
	readFileSync,
	rmSync,
	symlinkSync,
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

function superState(work: string) {
	return {
		head: git(work, ["rev-parse", "HEAD"]),
		branch: git(work, ["branch", "--show-current"]),
		refs: git(work, ["for-each-ref", "--format=%(refname) %(objectname)"]),
		objects: git(work, ["count-objects", "-v"]),
		index: git(work, ["ls-files", "-s"]),
		manifest: readFileSync(join(work, "tools/pins/siblings.json"), "utf8"),
	};
}

interface Pointed {
	readonly work: string;
	readonly remote: Remote;
}

/** An initialised checkout whose external/lib/.git names the superproject's. */
function pointedAtSuper(kind: "link" | "gitfile"): Pointed {
	const dir = scratch("dotgit");
	const remote = makeRemote(dir);
	const work = makeWork(dir, remote, 1);
	assert.equal(runBootstrap(work, []).status, 0);
	const dotgit = join(work, "external/lib/.git");
	rmSync(dotgit, { recursive: true, force: true });
	if (kind === "link") symlinkSync("../../.git", dotgit);
	else writeFileSync(dotgit, "gitdir: ../../.git\n");
	return { work, remote };
}

const REFUSED = {
	link: /external\/lib\/\.git is a symbolic link/u,
	gitfile: /external\/lib\/\.git names the superproject's own repository/u,
} as const;

describe("a submodule .git that names the superproject is refused", () => {
	for (const kind of ["link", "gitfile"] as const) {
		it(`${kind}: status --online, fetch, setup and bump refuse and change nothing`, () => {
			const { work, remote } = pointedAtSuper(kind);
			const before = superState(work);
			for (const args of [
				["--status", "--online"],
				["--fetch", "lib"],
				[],
				["--bump", "lib", remote.shas[2] ?? ""],
			]) {
				const run = runBootstrap(work, args);
				const out = `${run.stdout}${run.stderr}`;
				assert.equal(run.status, 1, `${args.join(" ")}: ${out}`);
				assert.match(out, REFUSED[kind], `${args.join(" ")}: ${out}`);
				assert.ok(out.includes(FIX), out);
				assert.doesNotMatch(
					out,
					/stash|is at [0-9a-f]{7}/u,
					"no advice that acts on the superproject",
				);
				assert.deepEqual(
					superState(work),
					before,
					`${args.join(" ")} changed nothing`,
				);
			}
		});
	}

	it("after someone ran the old advice (stash), fetch still writes nothing into the superproject", () => {
		const { work, remote } = pointedAtSuper("link");
		git(join(work, "external/lib"), ["stash"]);
		const origin = git(work, ["rev-parse", "refs/remotes/origin/main"]);
		const run = runBootstrap(work, ["--fetch", "lib"]);
		assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
		assert.match(run.stderr, REFUSED.link);
		assert.equal(git(work, ["rev-parse", "refs/remotes/origin/main"]), origin);
		assert.throws(
			() => git(work, ["cat-file", "-e", remote.shas[1] ?? ""]),
			"no library commit in the superproject's objects",
		);
		assert.equal(existsSync(join(work, "tools/pins/siblings.json")), true);
	});
});
