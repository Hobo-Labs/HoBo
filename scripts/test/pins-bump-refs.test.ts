/**
 * `pins:bump <name> <ref>` resolves a tag or a branch whose name looks like a
 * commit id (`beefcafe`, `20241013`) as the tag or branch it is: a short id
 * this clone (or the --reference clone) has comes first, then
 * `refs/tags/<name>^{commit}` on the server, then `refs/heads/<name>`.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	git,
	makeRemote,
	makeWork,
	runBootstrap,
	scratch,
} from "./support/pins-support.ts";

describe("bump to a ref whose name is all hex", () => {
	it("an annotated tag and a branch named like commit ids move the pin", () => {
		const dir = scratch("refs-hex");
		const remote = makeRemote(dir);
		git(remote.dir, [
			"tag",
			"-a",
			"-m",
			"a tag",
			"beefcafe",
			remote.shas[0] ?? "",
		]);
		git(remote.dir, ["branch", "20241013", remote.shas[1] ?? ""]);
		const work = makeWork(dir, remote, 2);
		assert.equal(runBootstrap(work, []).status, 0);
		for (const [ref, want] of [
			["beefcafe", remote.shas[0]],
			["20241013", remote.shas[1]],
		] as const) {
			const run = runBootstrap(work, ["--bump", "lib", ref]);
			assert.equal(run.status, 0, `${ref}: ${run.stdout}${run.stderr}`);
			assert.equal(
				git(join(work, "external/lib"), ["rev-parse", "HEAD"]),
				want,
			);
			assert.match(
				git(work, ["ls-files", "-s", "external/lib"]),
				new RegExp(`^160000 ${want} `, "u"),
			);
		}
	});

	it("an all-hex name that is neither a commit here nor a ref there names the ways out", () => {
		const dir = scratch("refs-none");
		const remote = makeRemote(dir);
		const work = makeWork(dir, remote, 2);
		assert.equal(runBootstrap(work, []).status, 0);
		const run = runBootstrap(work, ["--bump", "lib", "facade42"]);
		assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
		assert.match(
			run.stderr,
			/cannot resolve facade42 to a commit: give a full 40-character id, a branch or a tag/u,
		);
		assert.equal(git(work, ["diff", "--cached", "--name-only"]), "");
	});
});

describe("bump of a full submodule clone", () => {
	it("fetches without --depth, so the clone stays full", () => {
		const dir = scratch("refs-full");
		const remote = makeRemote(dir);
		git(remote.dir, ["branch", "side", remote.shas[1] ?? ""]);
		const work = makeWork(dir, remote, 2);
		assert.equal(runBootstrap(work, []).status, 0);
		const sub = join(work, "external/lib");
		git(sub, ["fetch", "-q", "--unshallow", "origin"]);
		const run = runBootstrap(work, ["--bump", "lib", "side"]);
		assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
		assert.equal(git(sub, ["rev-parse", "HEAD"]), remote.shas[1]);
		assert.equal(git(sub, ["rev-parse", "--is-shallow-repository"]), "false");
		assert.equal(git(sub, ["rev-list", "--count", remote.shas[2] ?? ""]), "3");
	});
});

describe("fetch of a full submodule clone", () => {
	it("moves it to a new gitlink without --depth, so the clone stays full", () => {
		const dir = scratch("fetch-full");
		const remote = makeRemote(dir);
		const work = makeWork(dir, remote, 0);
		const sub = join(work, "external/lib");
		// A developer's own full clone of the library, at the pin.
		git(work, ["submodule", "update", "--init", "--", "external/lib"]);
		assert.equal(git(sub, ["rev-parse", "--is-shallow-repository"]), "false");
		// Someone else moves the pin to a commit this clone has not fetched.
		git(remote.dir, ["commit", "-q", "--allow-empty", "-m", "four"]);
		const four = git(remote.dir, ["rev-parse", "HEAD"]);
		git(work, ["update-index", "--cacheinfo", `160000,${four},external/lib`]);
		git(work, ["commit", "-q", "-m", "bump"]);
		const run = runBootstrap(work, ["--fetch", "lib"]);
		assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
		assert.equal(git(sub, ["rev-parse", "HEAD"]), four);
		assert.equal(git(sub, ["rev-parse", "--is-shallow-repository"]), "false");
		assert.equal(git(sub, ["rev-list", "--count", "HEAD"]), "4");
	});
});
