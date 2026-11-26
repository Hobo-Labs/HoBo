/**
 * The `.git` checks compare repositories by identity (device and inode), walk
 * parent directories by identity, and compare the name `.git` without case.
 * Comparing the path strings realpathSync gives was not enough: it resolves
 * symbolic links and `..`, but a bind mount, or `gitdir: ../../.GIT` on a
 * case-insensitive filesystem (macOS, Windows), names the same directory
 * under another path, and the superproject's own repository then passed as
 * some other one (status read its HEAD as the submodule's).
 *
 * What each test proves, given what can be built without privileges:
 * - Directories cannot be hard-linked, so the comparison itself is shown on
 *   a file: two hard links are one inode that realpathSync keeps apart as two
 *   paths, and `sameFile` calls them one (a copy it does not).
 * - A `.GIT` directory stands in for the case-insensitive spelling. On Linux
 *   it is a directory of its own; it is refused as another working tree's
 *   repository, which is what it is where `.GIT` and `.git` are one.
 * - The bind mount itself runs where an unprivileged user and mount namespace
 *   can be made (`unshare --user --map-root-user --mount`; the mount ends with
 *   the namespace), and is skipped with the reason where it cannot.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	cpSync,
	linkSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import { inside, sameFile } from "../lib/pins-file-identity.ts";
import {
	git,
	makeRemote,
	makeWork,
	type Remote,
	runBootstrap,
	scratch,
	scriptCall,
} from "./support/pins-support.ts";

describe("identity, not path strings", () => {
	it("two hard links are one file; a copy, or a missing path, is not", () => {
		const dir = scratch("identity");
		const [one, two, copy] = ["one", "two", "copy"].map((n) => join(dir, n));
		writeFileSync(one ?? "", "x");
		linkSync(one ?? "", two ?? "");
		copyFileSync(one ?? "", copy ?? "");
		assert.notEqual(realpathSync(one ?? ""), realpathSync(two ?? ""));
		assert.equal(sameFile(one ?? "", two ?? ""), true);
		assert.equal(sameFile(one ?? "", copy ?? ""), false);
		assert.equal(sameFile(join(dir, "gone"), join(dir, "gone")), false);
	});

	it("inside is the directory itself or below it, never a name sharing its prefix", () => {
		const dir = scratch("identity");
		mkdirSync(join(dir, "x/y"), { recursive: true });
		mkdirSync(join(dir, "xy"));
		assert.equal(inside(join(dir, "x/y"), join(dir, "x")), true);
		assert.equal(inside(join(dir, "x"), join(dir, "x")), true);
		assert.equal(inside(join(dir, "xy"), join(dir, "x")), false);
		assert.equal(inside(dir, join(dir, "x")), false);
		assert.equal(inside(join(dir, "x/y"), join(dir, "gone")), false);
	});
});

interface Fixture {
	readonly dir: string;
	readonly remote: Remote;
	readonly work: string;
	readonly lib: string;
}

function fixture(): Fixture {
	const dir = scratch("identity");
	const remote = makeRemote(dir);
	const work = makeWork(dir, remote, 1);
	assert.equal(runBootstrap(work, []).status, 0);
	return { dir, remote, work, lib: join(work, "external/lib") };
}

function pointAt(lib: string, gitdir: string): void {
	rmSync(join(lib, ".git"), { recursive: true, force: true });
	writeFileSync(join(lib, ".git"), `gitdir: ${gitdir}\n`);
}

/** HEAD, refs and index of the repository a work tree uses. */
function stateOf(work: string): string {
	const index = readFileSync(join(work, ".git/index"));
	return [
		git(work, ["rev-parse", "HEAD"]),
		git(work, ["for-each-ref", "--format=%(refname) %(objectname)"]),
		createHash("sha256").update(index).digest("hex"),
	].join("\n");
}

const VERBS = (f: Fixture): string[][] => [
	["--status", "--offline"],
	["--fetch", "lib"],
	["--bump", "lib", f.remote.shas[2] ?? ""],
];

describe("a .git spelled in another case", () => {
	it("is refused as another working tree's repository", () => {
		const f = fixture();
		const sibling = join(f.dir, "sibling");
		git(f.dir, ["clone", "-q", f.remote.dir, sibling]);
		renameSync(join(sibling, ".git"), join(sibling, ".GIT"));
		pointAt(f.lib, join(sibling, ".GIT"));
		const before = readFileSync(join(sibling, ".GIT/HEAD"), "utf8");
		for (const args of VERBS(f)) {
			const run = runBootstrap(f.work, args);
			const out = `${run.stdout}${run.stderr}`;
			assert.equal(run.status, 1, `${args.join(" ")}: ${out}`);
			assert.match(
				out,
				/is the repository of another working tree \(.*\/sibling\)/u,
			);
			assert.doesNotMatch(out, /external\/lib is at/u);
		}
		assert.equal(readFileSync(join(sibling, ".GIT/HEAD"), "utf8"), before);
	});
});

const probe = spawnSync(
	"unshare",
	["--user", "--map-root-user", "--mount", "true"],
	{ encoding: "utf8" },
);
const noNamespace =
	probe.status === 0
		? false
		: `no user and mount namespace here: ${probe.error?.message ?? probe.stderr.trim()}`;

/** The script, run where `from` is bind-mounted at `to`. */
function bound(work: string, from: string, to: string, args: string[]) {
	const call = scriptCall(work, args, {}, []);
	const mount = 'mount --bind "$1" "$2" && shift 2 && exec "$@"';
	const run = spawnSync(
		"unshare",
		["--user", "--map-root-user", "--mount", "sh", "-c", mount, "sh"].concat([
			from,
			to,
			process.execPath,
			...call.argv,
		]),
		{ cwd: work, env: call.env, encoding: "utf8" },
	);
	return `exit ${run.status}\n${run.stdout}${run.stderr}`;
}

const BOUND: readonly [
	string,
	(f: Fixture, alias: string) => string,
	RegExp,
][] = [
	[
		"the superproject's .git, mounted at another path",
		(_f, alias) => alias,
		/names the superproject's own repository/u,
	],
	[
		"a directory inside it, reached through the mount",
		(f, alias) => {
			const stray = join(f.work, ".git/modules/stray");
			cpSync(join(f.work, ".git/modules/external/lib"), stray, {
				recursive: true,
			});
			git(f.work, [
				"config",
				"-f",
				join(stray, "config"),
				"--unset",
				"core.worktree",
			]);
			return join(alias, "modules/stray");
		},
		/is inside the superproject's git directory but is not this submodule's/u,
	],
];

describe("a bind mount of the superproject's .git", {
	skip: noNamespace,
}, () => {
	for (const [label, arrange, reason] of BOUND) {
		it(`${label}: refused by status, fetch and bump, nothing changed`, () => {
			const f = fixture();
			const alias = join(f.dir, "alias.git");
			mkdirSync(alias);
			pointAt(f.lib, arrange(f, alias));
			const before = stateOf(f.work);
			for (const args of VERBS(f)) {
				const said = bound(f.work, join(f.work, ".git"), alias, args);
				assert.match(said, /^exit 1\n/u, `${args.join(" ")}: ${said}`);
				assert.match(said, reason, `${args.join(" ")}: ${said}`);
			}
			assert.equal(stateOf(f.work), before);
		});
	}
});
