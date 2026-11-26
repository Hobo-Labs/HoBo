/**
 * A module directory under another name is not the submodule's own when
 * another live section carries that name. With section `lib` at
 * `external/lib` and section `external/lib` at `external/other`, the clone
 * git made under `modules/external/lib` is the second section's directory:
 * git's own update of `external/other` takes it over (its `core.worktree`
 * becomes that path), and the next pins run refuses the first path. The
 * rename rule ("git made it for this path") must not accept it, and the
 * printed fix moves the checkout aside instead of renaming a section onto a
 * directory that is spoken for.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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
const MOVE_ASIDE =
	"fix: mv external/lib external/lib.kept && git submodule update --init -- external/lib";

function section(name: string, path: string, url: string): string {
	return `[submodule "${name}"]\n\tpath = ${path}\n\turl = ${url}\n`;
}

/** The clone git made as `external/lib`, whose section is now `lib`, while `external/lib` names `external/other`. */
function setUp() {
	const dir = scratch("claimed");
	const remote = makeRemote(dir);
	const root = makeWork(dir, remote, 1);
	assert.equal(runBootstrap(root, []).status, 0);
	const lib = join(root, "external/lib");
	writeFileSync(join(lib, "README.md"), MINE);
	git(root, [
		"update-index",
		"--add",
		"--cacheinfo",
		`160000,${remote.shas[1]},external/other`,
	]);
	writeFileSync(
		join(root, ".gitmodules"),
		section("lib", "external/lib", remote.url) +
			section("external/lib", "external/other", remote.url),
	);
	return { root, lib, config: join(root, ".git/modules/external/lib/config") };
}

describe("a module directory another live section names", () => {
	it("status refuses it with a fix that moves the checkout aside, and fetch stops", () => {
		const { root, lib } = setUp();
		const status = runBootstrap(root, ["--status", "--offline"]);
		assert.equal(status.status, 1, status.stdout);
		assert.match(
			status.stdout,
			/is the module directory of the \.gitmodules section "external\/lib"/u,
		);
		assert.match(status.stdout, new RegExp(MOVE_ASIDE, "u"));
		assert.doesNotMatch(status.stdout, /rename-section|rm /u);
		const fetch = runBootstrap(root, ["--fetch", "lib"]);
		assert.equal(fetch.status, 1, `${fetch.stdout}${fetch.stderr}`);
		assert.match(fetch.stderr, /SUBMODULE_STATE: .*module directory of/u);
		assert.equal(readFileSync(join(lib, "README.md"), "utf8"), MINE);
	});

	it("the printed fix keeps the work and clones the submodule under its own name", () => {
		const { root, lib } = setUp();
		const fix =
			/fix: (.+?)(?: {3}\(|$)/mu.exec(
				runBootstrap(root, ["--status", "--offline"]).stdout,
			)?.[1] ?? "";
		assert.match(fix, /^mv /u, `fix: ${fix}`);
		execFileSync("sh", ["-c", fix], { cwd: root, env: gitEnv() });
		assert.equal(
			readFileSync(join(root, "external/lib.kept/README.md"), "utf8"),
			MINE,
		);
		assert.equal(runBootstrap(root, ["--status", "--offline"]).status, 0);
		assert.match(readFileSync(join(lib, ".git"), "utf8"), /modules\/lib\s*$/u);
	});

	it("that is why: git's own update of the other path takes the directory over", () => {
		const { root, config } = setUp();
		// Run after the pins: git's update rewrites core.worktree as a side effect.
		assert.equal(runBootstrap(root, ["--status", "--offline"]).status, 1);
		const own = spawnSync(
			"git",
			["submodule", "update", "--init", "--", "external/other"],
			{ cwd: root, env: gitEnv(), encoding: "utf8" },
		);
		assert.equal(own.status, 0, own.stderr);
		assert.match(
			git(root, ["config", "-f", config, "core.worktree"]),
			/external\/other$/u,
		);
	});
});
