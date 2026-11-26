/**
 * A git hook runs with the repository named in its environment: in a linked
 * worktree git exports GIT_DIR and GIT_INDEX_FILE to pre-commit, GIT_DIR to
 * pre-push. Those variables beat the working directory, so every git the pins
 * run would act on the superproject instead of the submodule or the probe.
 * The pins scrub the repository-locating variables from every git they run:
 * each verb behaves exactly as it does without them.
 */
import assert from "node:assert/strict";
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

/** What a run must not change in the superproject. */
function superState(work: string) {
	return {
		head: git(work, ["rev-parse", "HEAD"]),
		branch: git(work, ["branch", "--show-current"]),
		shallow: git(work, ["rev-parse", "--is-shallow-repository"]),
		objects: git(work, ["count-objects"]).split(",")[0],
		refs: git(work, ["for-each-ref", "--format=%(refname) %(objectname)"]),
	};
}

/** The environment a pre-commit hook in that worktree would see. */
function hookEnv(work: string): NodeJS.ProcessEnv {
	return {
		GIT_DIR: join(work, ".git"),
		GIT_WORK_TREE: work,
		GIT_INDEX_FILE: join(work, ".git/index"),
	};
}

/** Commit ids and scratch paths differ between two fixtures; the rest must not. */
function comparable(text: string, work: string, remote: Remote): string {
	return text
		.replaceAll(work, "<work>")
		.replaceAll(remote.dir, "<remote>")
		.replace(/[0-9a-f]{40}/gu, "<id>")
		.replace(/[0-9a-f]{7}/gu, "<id>");
}

interface Twin {
	readonly work: string;
	readonly remote: Remote;
}

function twin(label: string, initialise: boolean): Twin {
	const dir = scratch(label);
	const remote = makeRemote(dir);
	const work = makeWork(dir, remote, 1);
	if (initialise) assert.equal(runBootstrap(work, []).status, 0);
	return { work, remote };
}

describe("a verb run from a git hook acts on the submodule, not the superproject", () => {
	const verbs: readonly [string, boolean, (remote: Remote) => string[]][] = [
		["setup", false, () => []],
		["fetch", false, () => ["--fetch", "lib"]],
		["status --offline", true, () => ["--status", "--offline"]],
		["status --online", true, () => ["--status", "--online"]],
		["bump", true, (remote) => ["--bump", "lib", remote.shas[2] ?? ""]],
	];
	for (const [label, initialise, args] of verbs) {
		it(`${label} with GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE exported`, () => {
			const plain = twin("hookenv-plain", initialise);
			const hooked = twin("hookenv-hook", initialise);
			const expected = runBootstrap(plain.work, args(plain.remote));
			const before = superState(hooked.work);
			const run = runBootstrap(
				hooked.work,
				args(hooked.remote),
				hookEnv(hooked.work),
			);
			assert.equal(run.status, expected.status, `${run.stdout}${run.stderr}`);
			assert.equal(
				comparable(run.stdout, hooked.work, hooked.remote),
				comparable(expected.stdout, plain.work, plain.remote),
			);
			const after = superState(hooked.work);
			assert.deepEqual(
				{ ...after, refs: undefined },
				{ ...before, refs: undefined },
				"HEAD, branch, shallowness and objects unchanged",
			);
			assert.equal(after.refs, before.refs, "no ref of the superproject moved");
			const head = (work: string): string =>
				git(join(work, "external/lib"), ["rev-parse", "HEAD"]);
			const index = plain.remote.shas.indexOf(head(plain.work));
			assert.ok(index >= 0);
			assert.equal(
				head(hooked.work),
				hooked.remote.shas[index],
				"the submodule moved exactly as without the variables",
			);
		});
	}
});
