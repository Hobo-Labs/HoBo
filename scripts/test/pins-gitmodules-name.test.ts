/**
 * A `.gitmodules` section whose name git refuses is refused by the pins too.
 * git (submodule-config.c, `check_submodule_name`) ignores a section whose
 * name is empty or has a `..` component, splitting on `/` and `\`, and warns
 * "ignoring suspicious submodule name". The pins build the submodule's own
 * repository directory, `<git dir>/modules/<name>`, from that name, so a
 * `../../../sibling/.git` would make another clone's repository pass as the
 * submodule's (status then read its HEAD; fetch and bump were stopped only by
 * its uncommitted changes). git itself is the oracle for which names those are.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
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

const NAMES = [
	"external/lib",
	"lib",
	"..a",
	"a..",
	"...",
	".",
	"a/./b",
	"",
	"..",
	"a/..",
	"../a",
	"a/../b",
	"a\\..\\b",
	"..\\a",
	"a\\..",
	"../../../sibling/.git",
];

const REFUSED = /which git ignores/u;

function modules(name: string, url: string): string {
	const quoted = name.replaceAll("\\", "\\\\");
	return `[submodule "${quoted}"]\n\tpath = external/lib\n\turl = ${url}\n`;
}

describe("a .gitmodules name git ignores", () => {
	it("is refused exactly when git itself ignores it", () => {
		const dir = scratch("gitmodules-name");
		const remote = makeRemote(dir);
		const work = makeWork(dir, remote, 1);
		for (const name of NAMES) {
			writeFileSync(join(work, ".gitmodules"), modules(name, remote.url));
			const own = spawnSync("git", ["submodule", "status"], {
				cwd: work,
				env: gitEnv(),
				encoding: "utf8",
			});
			const gitIgnores = own.stderr.includes(
				"ignoring suspicious submodule name",
			);
			const status = runBootstrap(work, ["--status", "--offline"]);
			const said = `${status.stdout}${status.stderr}`;
			assert.equal(REFUSED.test(said), gitIgnores, `[${name}]: ${said}`);
		}
	});

	it("cannot make another clone's repository pass as the submodule's", () => {
		const dir = scratch("gitmodules-name");
		const remote = makeRemote(dir);
		const work = makeWork(dir, remote, 1);
		assert.equal(runBootstrap(work, []).status, 0);
		const sibling = join(dir, "sibling");
		git(dir, ["clone", "-q", remote.dir, sibling]);
		const name = "../../../sibling/.git";
		writeFileSync(join(work, ".gitmodules"), modules(name, remote.url));
		writeFileSync(join(work, "external/lib/.git"), `gitdir: ${name}\n`);
		const state = () =>
			git(sibling, ["for-each-ref", "--format=%(refname) %(objectname)"]) +
			git(sibling, ["rev-parse", "HEAD"]) +
			git(sibling, ["symbolic-ref", "HEAD"]);
		const before = state();
		const status = runBootstrap(work, ["--status", "--offline"]);
		const said = `${status.stdout}${status.stderr}`;
		assert.equal(status.status, 1, said);
		assert.match(said, REFUSED);
		assert.doesNotMatch(said, /external\/lib is at|stash/u, said);
		for (const args of [
			["--fetch", "lib"],
			["--bump", "lib", remote.shas[2] ?? ""],
		]) {
			const run = runBootstrap(work, args);
			const out = `${run.stdout}${run.stderr}`;
			assert.equal(run.status, 1, `${args.join(" ")}: ${out}`);
			assert.match(out, /GITMODULES_AMBIGUOUS: .*which git ignores/u);
		}
		assert.equal(state(), before, "the sibling clone is untouched");
	});
});
