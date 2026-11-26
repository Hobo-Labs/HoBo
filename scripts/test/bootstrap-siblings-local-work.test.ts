/**
 * `setup` runs the git initialisation every time, so it must not quietly
 * abandon work done inside the submodule: ADR-0128's contribution workflow is
 * "edit inside external/ts-autocode, commit, push", and a commit made there on
 * a detached HEAD lives nowhere but the reflog once HEAD moves off it.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	git,
	makeReference,
	makeRemote,
	makeWork,
	type Remote,
	runBootstrap,
	scratch,
} from "./support/pins-support.ts";

interface Fixture {
	readonly remote: Remote;
	readonly work: string;
	readonly reference: string;
	readonly sub: string;
}

function fixture(pinned: number): Fixture {
	const dir = scratch("local-work");
	const remote = makeRemote(dir);
	const work = makeWork(dir, remote, pinned);
	return {
		remote,
		work,
		reference: makeReference(dir, remote),
		sub: join(work, "external/lib"),
	};
}

/** Initialise at the pin, then commit once inside the submodule on a detached HEAD. */
function withLocalCommit(f: Fixture): string {
	const first = runBootstrap(f.work, ["--reference", f.reference]);
	assert.equal(first.status, 0, first.stderr);
	git(f.sub, ["commit", "-q", "--allow-empty", "-m", "work in progress"]);
	return git(f.sub, ["rev-parse", "HEAD"]);
}

const short = (commit: string | undefined): string =>
	(commit ?? "").slice(0, 7);

describe("setup does not abandon work done inside the submodule", () => {
	it("refuses to move HEAD off a commit that is on no branch, naming it and the way out", () => {
		const f = fixture(1);
		const mine = withLocalCommit(f);
		const run = runBootstrap(f.work, ["--reference", f.reference]);
		assert.equal(run.status, 1, `${run.stdout}${run.stderr}`);
		assert.match(
			run.stderr,
			new RegExp(
				`SUBMODULE_STATE: external/lib is at ${short(mine)}, a commit on no branch or tag`,
			),
		);
		assert.match(
			run.stderr,
			new RegExp(
				`fix: git -C external/lib branch rescue-${short(mine)} ${mine}`,
			),
		);
		assert.match(run.stderr, /or re-run with --force/);
		assert.equal(git(f.sub, ["rev-parse", "HEAD"]), mine, "HEAD did not move");
	});

	it("--force moves it anyway and says which commit it left", () => {
		const f = fixture(1);
		const mine = withLocalCommit(f);
		const run = runBootstrap(f.work, ["--force", "--reference", f.reference]);
		assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
		assert.match(
			run.stdout,
			new RegExp(
				`lib {2}updated at ${short(f.remote.shas[1])} {2}\\(was ${short(mine)}`,
			),
		);
		assert.equal(git(f.sub, ["rev-parse", "HEAD"]), f.remote.shas[1]);
	});

	it("a commit on a local branch is not abandoned, so it is not in the way", () => {
		const f = fixture(1);
		assert.equal(runBootstrap(f.work, ["--reference", f.reference]).status, 0);
		git(f.sub, ["switch", "-q", "-c", "work"]);
		git(f.sub, ["commit", "-q", "--allow-empty", "-m", "on a branch"]);
		const mine = git(f.sub, ["rev-parse", "HEAD"]);
		const run = runBootstrap(f.work, ["--reference", f.reference]);
		assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
		assert.match(run.stdout, new RegExp(`\\(was ${short(mine)}`));
		assert.equal(
			git(f.sub, ["rev-parse", "work"]),
			mine,
			"the branch still holds the commit",
		);
	});

	it("moving from an earlier pin to a later one is not a loss, shallow clone or not", () => {
		const f = fixture(0);
		const first = runBootstrap(f.work, []);
		assert.equal(first.status, 0, first.stderr);
		assert.equal(git(f.sub, ["rev-parse", "--is-shallow-repository"]), "true");
		const old = f.remote.shas[0] ?? "";
		assert.equal(
			git(f.sub, ["rev-parse", `refs/pins/${old}`]),
			old,
			"the pin is kept under refs/pins",
		);
		git(f.work, [
			"update-index",
			"--cacheinfo",
			`160000,${f.remote.shas[2]},external/lib`,
		]);
		const run = runBootstrap(f.work, []);
		assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
		assert.match(
			run.stdout,
			new RegExp(
				`lib {2}updated at ${short(f.remote.shas[2])} {2}\\(was ${short(old)}`,
			),
		);
		assert.equal(git(f.sub, ["rev-parse", "HEAD"]), f.remote.shas[2]);
	});

	it("bump keeps the commit it checks out, so moving off it later is not a loss", () => {
		const f = fixture(1);
		assert.equal(runBootstrap(f.work, []).status, 0);
		const bump = runBootstrap(f.work, ["--bump", "lib", "main"]);
		assert.equal(bump.status, 0, `${bump.stdout}${bump.stderr}`);
		assert.equal(
			git(f.sub, ["rev-parse", `refs/pins/${f.remote.shas[2]}`]),
			f.remote.shas[2],
		);
	});

	it("--force belongs to the verbs that move a submodule, not to status", () => {
		const f = fixture(1);
		const run = runBootstrap(f.work, ["--status", "--force"]);
		assert.equal(run.status, 2);
		assert.match(run.stderr, /--force belongs to/);
	});
});
