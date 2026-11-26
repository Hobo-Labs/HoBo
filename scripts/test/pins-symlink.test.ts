/**
 * A submodule path that is (or passes through) a symbolic link is refused.
 * `external/lib -> ..` resolves to the superproject, whose top level is then
 * "the submodule's own": every git the pins ran there would act on the
 * superproject. The check is on the path as written (lstat of each part under
 * the superproject's root), and git's answer is compared against the path
 * under the root's real location, never the link's target.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, renameSync, rmSync, symlinkSync } from "node:fs";
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

function superState(work: string) {
	return {
		head: git(work, ["rev-parse", "HEAD"]),
		branch: git(work, ["branch", "--show-current"]),
		refs: git(work, ["for-each-ref", "--format=%(refname) %(objectname)"]),
		tree: git(work, ["ls-tree", "-r", "--name-only", "HEAD"]),
		manifest: existsSync(join(work, "tools/pins/siblings.json")),
	};
}

describe("a submodule path that is a symbolic link is refused", () => {
	it("external/lib -> ..: fetch, setup, bump and status --online leave the superproject alone", () => {
		const dir = scratch("symlink-path");
		const remote = makeRemote(dir);
		const work = makeWork(dir, remote, 1);
		assert.equal(runBootstrap(work, []).status, 0);
		rmSync(join(work, "external/lib"), { recursive: true, force: true });
		symlinkSync("..", join(work, "external/lib"));
		const before = superState(work);
		for (const args of [
			["--fetch", "lib"],
			[],
			["--bump", "lib", remote.shas[2] ?? ""],
			["--status", "--online"],
		]) {
			const run = runBootstrap(work, args);
			const out = `${run.stdout}${run.stderr}`;
			assert.equal(run.status, 1, `${args.join(" ")}: ${out}`);
			assert.match(out, /external\/lib is a symbolic link/u);
			assert.ok(
				out.includes(
					"fix: rm external/lib && git submodule update --init -- external/lib",
				),
				out,
			);
			assert.deepEqual(
				superState(work),
				before,
				`${args.join(" ")} changed nothing`,
			);
		}
		execFileSync(
			"sh",
			["-c", "rm external/lib && git submodule update --init -- external/lib"],
			{ cwd: work, env: gitEnv(), stdio: "pipe" },
		);
		const fixed = runBootstrap(work, ["--status", "--offline"]);
		assert.equal(fixed.status, 0, `the printed fix works: ${fixed.stdout}`);
	});

	it("a link in a parent directory of the path is refused too, naming that link", () => {
		const dir = scratch("symlink-parent");
		const remote = makeRemote(dir);
		const work = makeWork(dir, remote, 1);
		assert.equal(runBootstrap(work, []).status, 0);
		renameSync(join(work, "external"), join(work, "elsewhere"));
		symlinkSync("elsewhere", join(work, "external"));
		const run = runBootstrap(work, ["--status"]);
		assert.equal(run.status, 1, run.stdout);
		assert.match(run.stdout, /external is a symbolic link/u);
		assert.match(
			run.stdout,
			/fix: rm external && git checkout -- external && git submodule update --init -- external\/lib/u,
		);
		execFileSync(
			"sh",
			[
				"-c",
				"rm external && git checkout -- external && git submodule update --init -- external/lib",
			],
			{ cwd: work, env: gitEnv(), stdio: "pipe" },
		);
		const after = runBootstrap(work, ["--status", "--offline"]);
		assert.equal(after.status, 0, `the printed fix works: ${after.stdout}`);
	});
});
