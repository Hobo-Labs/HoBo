/**
 * The script acts in a submodule only when git answers for that submodule.
 * An empty `.git` directory under the path, or a `.git` file whose module
 * directory was deleted, makes git walk up (or give up); either way it is a
 * refusal that names the way back, never a command run in the superproject.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
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

const REMEDY =
	"mv external/lib external/lib.kept && git submodule update --init -- external/lib";

function superState(work: string) {
	return {
		head: git(work, ["rev-parse", "HEAD"]),
		branch: git(work, ["branch", "--show-current"]),
		tree: git(work, ["ls-tree", "--name-only", "HEAD"]),
		pins: git(work, ["for-each-ref", "refs/pins", "--format=%(refname)"]),
		staged: git(work, ["diff", "--cached", "--name-only"]),
	};
}

describe("a submodule path git does not answer for is refused", () => {
	it("an empty .git directory: bump, fetch, init and status leave the superproject alone", () => {
		const dir = scratch("subrepo-empty");
		const remote = makeRemote(dir);
		const work = makeWork(dir, remote, 1);
		mkdirSync(join(work, "external/lib/.git"), { recursive: true });
		const before = superState(work);
		for (const args of [
			["--bump", "lib", remote.shas[2] ?? ""],
			["--fetch", "lib"],
			[],
		]) {
			const run = runBootstrap(work, args);
			assert.equal(
				run.status,
				1,
				`${args.join(" ")}: ${run.stdout}${run.stderr}`,
			);
			assert.match(
				run.stderr,
				/SUBMODULE_STATE: external\/lib\/\.git is not a usable repository of its own/u,
			);
			assert.ok(run.stderr.includes(`fix: ${REMEDY}`), run.stderr);
			assert.deepEqual(
				superState(work),
				before,
				`${args.join(" ")} changed nothing`,
			);
		}
		const status = runBootstrap(work, ["--status"]);
		assert.equal(status.status, 1, status.stdout);
		assert.match(status.stdout, /lib {2}[0-9a-f]{7} {2}FAIL/u);
		assert.ok(status.stdout.includes(REMEDY), status.stdout);
		assert.doesNotMatch(
			status.stdout,
			/pins:bump lib/u,
			"it never offers the superproject's commit",
		);
		assert.equal(existsSync(join(work, "tools/pins/siblings.json")), true);
	});

	it("a deleted .git/modules: the refusal prints the command that restores it, and it does", () => {
		const dir = scratch("subrepo-modules");
		const remote = makeRemote(dir);
		const work = makeWork(dir, remote, 1);
		assert.equal(runBootstrap(work, []).status, 0);
		rmSync(join(work, ".git/modules"), { recursive: true, force: true });
		const fetch = runBootstrap(work, ["--fetch", "lib"]);
		assert.equal(fetch.status, 1, `${fetch.stdout}${fetch.stderr}`);
		assert.ok(fetch.stderr.includes(`fix: ${REMEDY}`), fetch.stderr);
		const status = runBootstrap(work, ["--status"]);
		assert.equal(status.status, 1);
		assert.ok(status.stdout.includes(REMEDY), status.stdout);
		execFileSync("sh", ["-c", REMEDY], {
			cwd: work,
			env: gitEnv(),
			stdio: "pipe",
		});
		const after = runBootstrap(work, ["--status", "--offline"]);
		assert.equal(after.status, 0, `${after.stdout}${after.stderr}`);
		assert.match(after.stdout, /lib {2}[0-9a-f]{7} {2}ok/u);
	});
});
