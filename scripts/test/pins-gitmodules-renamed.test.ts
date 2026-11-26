/**
 * A `.gitmodules` section renamed after the submodule was cloned. git keeps
 * using the existing clone (`modules/<old name>`, whose `core.worktree` is
 * this path), and so do the pins, for the same repository (a clone made for
 * another upstream is refused: `pins-module-origin.test.ts`): following every
 * printed fix in turn ends
 * with the uncommitted change, or the local commit, still there, and status
 * naming that work. Before, the second fix was `rm -rf <path> && git
 * submodule update --init`, and following it lost the change and left the
 * commit only in the orphaned module directory.
 *
 * No printed fix deletes a checkout: where the `.git` names a repository
 * that cannot be the submodule's, the fix moves the checkout aside
 * (`mv <path> <path>.kept`, or the first free `.kept.N`:
 * `pins-move-aside.test.ts`), so any work in it is kept; where it names a
 * module directory git made under another name, of the same repository, with
 * no `core.worktree` to say which path it was made for, the fix renames the
 * section to that name.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	git,
	gitEnv,
	makeRemote,
	makeWork,
	runBootstrap,
	scratch,
} from "./support/pins-support.ts";

const MINE = "MY UNCOMMITTED WORK\n";

function section(name: string, path: string, url: string): string {
	return `[submodule "${name}"]\n\tpath = ${path}\n\turl = ${url}\n`;
}

/** A checkout set up the ordinary way, then `work` done in external/lib. */
function setUp(work: "uncommitted" | "commit" | "none") {
	const dir = scratch("renamed");
	const remote = makeRemote(dir);
	const root = makeWork(dir, remote, 1);
	assert.equal(runBootstrap(root, []).status, 0);
	const lib = join(root, "external/lib");
	let commit = "";
	if (work === "uncommitted") writeFileSync(join(lib, "README.md"), MINE);
	if (work === "commit") {
		writeFileSync(join(lib, "mine.txt"), MINE);
		git(lib, ["add", "mine.txt"]);
		git(lib, ["commit", "-q", "-m", "local work"]);
		commit = git(lib, ["rev-parse", "HEAD"]);
	}
	return { dir, root, lib, url: remote.url, commit };
}

/** Status, then each printed `git config` or `mv` fix, run as printed, at most four times; answers every output. */
function followFixes(root: string): string[] {
	const said: string[] = [];
	for (let step = 0; step < 4; step += 1) {
		const run = runBootstrap(root, ["--status", "--offline"]);
		said.push(`exit ${run.status}\n${run.stdout}${run.stderr}`);
		const fix = /fix: (.+?)(?: {3}\(|$)/mu.exec(run.stdout)?.[1] ?? "";
		if (run.status === 0 || !/^(git config|mv) /u.test(fix)) break;
		execFileSync("sh", ["-c", fix], { cwd: root, env: gitEnv() });
	}
	return said;
}

const RENAMES: readonly [string, string][] = [
	["renamed, path as before", "external/lib"],
	["renamed, path spelled ./external/lib", "./external/lib"],
	["renamed, path spelled external/lib/", "external/lib/"],
];

describe("a section renamed after cloning keeps the clone and its work", () => {
	for (const [label, path] of RENAMES) {
		it(`${label}: an uncommitted change is kept, and status names it`, () => {
			const { root, lib, url } = setUp("uncommitted");
			writeFileSync(join(root, ".gitmodules"), section("lib", path, url));
			const said = followFixes(root);
			assert.doesNotMatch(said.join("\n"), /rm -rf/u);
			assert.equal(readFileSync(join(lib, "README.md"), "utf8"), MINE);
			assert.match(
				said.at(-1) ?? "",
				/external\/lib has uncommitted changes to tracked files/u,
			);
		});

		it(`${label}: a local commit stays checked out, and status names it`, () => {
			const { root, lib, url, commit } = setUp("commit");
			writeFileSync(join(root, ".gitmodules"), section("lib", path, url));
			const said = followFixes(root);
			assert.doesNotMatch(said.join("\n"), /rm -rf/u);
			assert.equal(git(lib, ["rev-parse", "HEAD"]), commit);
			assert.match(
				said.at(-1) ?? "",
				/external\/lib is at [0-9a-f]{7}, the pin is/u,
			);
		});
	}

	it("git's own update agrees: it uses the existing clone", () => {
		const { root, url } = setUp("none");
		writeFileSync(
			join(root, ".gitmodules"),
			section("lib", "external/lib", url),
		);
		assert.match(followFixes(root).at(-1) ?? "", /^exit 0\n/u);
		git(root, ["submodule", "update", "--init", "--", "external/lib"]);
		assert.equal(existsSync(join(root, ".git/modules/lib")), false);
	});
});

describe("where the clone cannot be taken as the submodule's, the fix keeps the work", () => {
	it("a module directory with no core.worktree: the section is renamed to its name", () => {
		const { root, lib, url } = setUp("uncommitted");
		const config = join(root, ".git/modules/external/lib/config");
		git(root, ["config", "-f", config, "--unset", "core.worktree"]);
		writeFileSync(
			join(root, ".gitmodules"),
			section("lib", "external/lib", url),
		);
		const said = followFixes(root);
		assert.match(
			said[0] ?? "",
			/fix: git config -f \.gitmodules --rename-section submodule\.lib submodule\.external\/lib\n/u,
		);
		assert.doesNotMatch(said.join("\n"), /rm -rf/u);
		assert.equal(readFileSync(join(lib, "README.md"), "utf8"), MINE);
		assert.match(
			said.at(-1) ?? "",
			/has uncommitted changes to tracked files/u,
		);
	});

	it("another clone's .git: the checkout is moved aside, with the change in it", () => {
		const { dir, root, lib, url } = setUp("uncommitted");
		git(dir, ["clone", "-q", url, join(dir, "sibling")]);
		writeFileSync(join(lib, ".git"), `gitdir: ${join(dir, "sibling/.git")}\n`);
		const said = followFixes(root);
		assert.match(
			said[0] ?? "",
			/fix: mv external\/lib external\/lib\.kept && git submodule update --init -- external\/lib {3}\(keeps/u,
		);
		assert.doesNotMatch(said.join("\n"), /rm -rf/u);
		assert.equal(
			readFileSync(join(root, "external/lib.kept/README.md"), "utf8"),
			MINE,
		);
		assert.match(said.at(-1) ?? "", /^exit 0\n/u);
	});
});
