/**
 * Where the origin is NOT compared, as ADR-0169 says it plainly: the check
 * against `.gitmodules` runs for a module directory under another name. A
 * section pointed at another upstream at the same path still ends with
 * `fetch` exiting 0 in the two places below, with the clone's `origin` the old
 * upstream and the new upstream's commit checked out:
 *
 *  - the section's own `modules/<name>` after `git submodule deinit`
 *    (`submodule.<name>.url` is gone, so the stale-URL check has nothing to
 *    compare, the path is empty, and `git submodule update` reactivates the
 *    module directory; moving a checkout aside would isolate nothing);
 *  - a clone the person made by hand into a separate git directory, with no
 *    `git submodule init`.
 *
 * These pin the documented limit, not a wish. While `submodule.<name>.url` is
 * set, the stale-URL check refuses both. If a later change compares the origin
 * here too, these are the tests to turn around, with the ADR.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	git,
	gitEnv,
	makeRemote,
	makeWork,
	pinsJson,
	runBootstrap,
	scratch,
} from "./support/pins-support.ts";

function setUp() {
	const dir = scratch("origin-scope");
	const a = makeRemote(dir);
	const b = makeRemote(join(dir, "b"), "another upstream");
	const root = makeWork(dir, a, 1);
	return { dir, root, lib: join(root, "external/lib"), a, b };
}

/** The superproject's side: the section `external/lib` names B, pinned at B's second commit. */
function pointAtB(root: string, b: { url: string; shas: readonly string[] }) {
	writeFileSync(
		join(root, ".gitmodules"),
		`[submodule "external/lib"]\n\tpath = external/lib\n\turl = ${b.url}\n`,
	);
	writeFileSync(join(root, "tools/pins/siblings.json"), pinsJson(b.url));
	git(root, [
		"update-index",
		"--cacheinfo",
		`160000,${b.shas[1]},external/lib`,
	]);
}

describe("the origin of a module directory that is not under another name is not compared", () => {
	it("the section's own module directory after git submodule deinit: fetch exits 0, origin still the old upstream", () => {
		const { root, lib, a, b } = setUp();
		assert.equal(runBootstrap(root, []).status, 0);
		const deinit = spawnSync(
			"git",
			["submodule", "deinit", "-f", "--", "external/lib"],
			{ cwd: root, env: gitEnv(), encoding: "utf8" },
		);
		assert.equal(deinit.status, 0, deinit.stderr);
		assert.equal(
			existsSync(join(lib, ".git")),
			false,
			"deinit empties the path",
		);
		pointAtB(root, b);
		const fetch = runBootstrap(root, ["--fetch", "lib"]);
		assert.equal(fetch.status, 0, `${fetch.stdout}${fetch.stderr}`);
		const module = join(root, ".git/modules/external/lib/config");
		assert.equal(
			git(root, ["config", "-f", module, "remote.origin.url"]),
			a.url,
		);
		assert.equal(git(lib, ["rev-parse", "HEAD"]), b.shas[1]);
	});

	it("the same change while submodule.<name>.url is set is the stale-URL check's: refused, nothing fetched", () => {
		const { root, lib, a, b } = setUp();
		assert.equal(runBootstrap(root, []).status, 0);
		pointAtB(root, b);
		const status = runBootstrap(root, ["--status", "--offline"]);
		assert.equal(status.status, 1, status.stdout);
		assert.match(
			status.stdout,
			/this clone's configured URL for external\/lib/u,
		);
		const fetch = runBootstrap(root, ["--fetch", "lib"]);
		assert.equal(fetch.status, 1, `${fetch.stdout}${fetch.stderr}`);
		assert.equal(git(lib, ["config", "remote.origin.url"]), a.url);
	});

	it("a hand-made --separate-git-dir clone with no git submodule init: fetch exits 0, origin still the old upstream", () => {
		const { dir, root, lib, a, b } = setUp();
		const clone = spawnSync(
			"git",
			["clone", "-q", "--separate-git-dir", join(dir, "sep.git"), a.url, lib],
			{ env: gitEnv(), encoding: "utf8" },
		);
		assert.equal(clone.status, 0, clone.stderr);
		git(lib, ["checkout", "-q", a.shas[1] ?? ""]);
		pointAtB(root, b);
		const fetch = runBootstrap(root, ["--fetch", "lib"]);
		assert.equal(fetch.status, 0, `${fetch.stdout}${fetch.stderr}`);
		assert.equal(git(lib, ["config", "remote.origin.url"]), a.url);
		assert.equal(git(lib, ["rev-parse", "HEAD"]), b.shas[1]);
	});

	it("the same hand-made clone after git submodule init is the stale-URL check's: refused", () => {
		const { dir, root, lib, a, b } = setUp();
		const clone = spawnSync(
			"git",
			["clone", "-q", "--separate-git-dir", join(dir, "sep.git"), a.url, lib],
			{ env: gitEnv(), encoding: "utf8" },
		);
		assert.equal(clone.status, 0, clone.stderr);
		git(lib, ["checkout", "-q", a.shas[1] ?? ""]);
		git(root, ["submodule", "init", "--", "external/lib"]);
		pointAtB(root, b);
		const status = runBootstrap(root, ["--status", "--offline"]);
		assert.equal(status.status, 1, status.stdout);
		assert.match(
			status.stdout,
			/this clone's configured URL for external\/lib/u,
		);
		const fetch = runBootstrap(root, ["--fetch", "lib"]);
		assert.equal(fetch.status, 1, `${fetch.stdout}${fetch.stderr}`);
		assert.equal(git(lib, ["config", "remote.origin.url"]), a.url);
	});
});
