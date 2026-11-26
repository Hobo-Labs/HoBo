/**
 * A module directory git made under another name (the section was renamed
 * after the submodule was cloned) is the submodule's own only when it was
 * made for the same repository. `core.worktree` says which path git made it
 * for and nothing about whose repository it is: with the section renamed and
 * its URL changed to another upstream at the same path, the old rule adopted
 * the old upstream's clone, fetch exited 0, and the clone ended at the new
 * upstream's commit with its `origin` still the old one.
 *
 * Which URLs name one repository is `sameRepo`'s call (scheme and host
 * without case, `.git` and a trailing slash dropped, the path with its case);
 * the table below pins both sides of it for a clone's `remote.origin.url`.
 * An ssh form is not an https form: the stale-URL check treats them as two
 * repositories as well, and the cost of the stricter reading is a checkout
 * moved aside and cloned again, with nothing lost.
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
	pinsJson,
	type Remote,
	runBootstrap,
	scratch,
} from "./support/pins-support.ts";

const MINE = "MY UNCOMMITTED WORK\n";
const MOVE_ASIDE =
	"fix: mv external/lib external/lib.kept && git submodule update --init -- external/lib";

function section(name: string, path: string, url: string): string {
	return `[submodule "${name}"]\n\tpath = ${path}\n\turl = ${url}\n`;
}

interface Setup {
	readonly dir: string;
	readonly root: string;
	readonly lib: string;
	readonly remote: Remote;
	/** A second upstream: no commit in common with `remote`. */
	readonly other: Remote;
}

/** external/lib cloned from `remote` the ordinary way, then optionally changed. */
function setUp(work: "uncommitted" | "none"): Setup {
	const dir = scratch("origin");
	const remote = makeRemote(dir);
	const other = makeRemote(join(dir, "b"), "another upstream");
	const root = makeWork(dir, remote, 1);
	assert.equal(runBootstrap(root, []).status, 0);
	const lib = join(root, "external/lib");
	if (work === "uncommitted") writeFileSync(join(lib, "README.md"), MINE);
	return { dir, root, lib, remote, other };
}

/** The superproject's side: section `name` at the path, naming `url`, pinned at `commit`. */
function point(
	root: string,
	name: string,
	url: string,
	commit: string | null,
): void {
	writeFileSync(join(root, ".gitmodules"), section(name, "external/lib", url));
	writeFileSync(join(root, "tools/pins/siblings.json"), pinsJson(url));
	if (commit !== null) {
		git(root, ["update-index", "--cacheinfo", `160000,${commit},external/lib`]);
	}
}

/** What a fetch must not change in the clone. */
function facts(lib: string) {
	return {
		origin: spawnSync("git", ["config", "remote.origin.url"], {
			cwd: lib,
			encoding: "utf8",
			env: gitEnv(),
		}).stdout.trim(),
		head: git(lib, ["rev-parse", "HEAD"]),
		refs: git(lib, ["for-each-ref", "--format=%(refname) %(objectname)"]),
	};
}

const WORK: readonly ("none" | "uncommitted")[] = ["none", "uncommitted"];

describe("a section renamed and pointed at another upstream", () => {
	for (const work of WORK) {
		it(`${work}: status says the clone is another repository's, with a fix that moves it aside`, () => {
			const { root, lib, other } = setUp(work);
			const before = facts(lib);
			point(root, "other", other.url, other.shas[1] ?? "");
			const status = runBootstrap(root, ["--status", "--offline"]);
			assert.equal(status.status, 1, status.stdout);
			assert.match(status.stdout, /belongs to another repository/u);
			assert.match(status.stdout, new RegExp(MOVE_ASIDE, "u"));
			assert.doesNotMatch(status.stdout, /rename-section|rm /u);
			assert.deepEqual(facts(lib), before, "status runs nothing in the clone");
		});

		it(`${work}: fetch refuses, and the clone's origin, HEAD and refs are unchanged`, () => {
			const { root, lib, other } = setUp(work);
			const before = facts(lib);
			point(root, "other", other.url, other.shas[1] ?? "");
			const fetch = runBootstrap(root, ["--fetch", "lib"]);
			assert.equal(fetch.status, 1, `${fetch.stdout}${fetch.stderr}`);
			assert.match(
				fetch.stderr,
				/SUBMODULE_STATE: .*belongs to another repository/u,
			);
			assert.deepEqual(facts(lib), before, "origin, HEAD and refs unchanged");
			if (work === "uncommitted") {
				assert.equal(readFileSync(join(lib, "README.md"), "utf8"), MINE);
			}
		});
	}

	it("the printed fix keeps the old checkout and clones the new upstream beside it", () => {
		const { root, lib, other } = setUp("uncommitted");
		point(root, "other", other.url, other.shas[1] ?? "");
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
		assert.equal(git(lib, ["config", "remote.origin.url"]), other.url);
		assert.equal(git(lib, ["rev-parse", "HEAD"]), other.shas[1]);
		assert.equal(runBootstrap(root, ["--status", "--offline"]).status, 0);
	});

	it("a module directory with no core.worktree for another upstream is not offered the rename", () => {
		// The directory is `modules/external/lib`; the section is `lib`. Renaming the
		// section to `external/lib` would make it the section's own directory, which is
		// accepted with no origin check.
		const { root, lib, other } = setUp("uncommitted");
		const config = join(root, ".git/modules/external/lib/config");
		git(root, ["config", "-f", config, "--unset", "core.worktree"]);
		const before = facts(lib);
		point(root, "lib", other.url, other.shas[1] ?? "");
		const status = runBootstrap(root, ["--status", "--offline"]);
		assert.equal(status.status, 1, status.stdout);
		assert.match(status.stdout, /belongs to another repository/u);
		assert.match(status.stdout, new RegExp(MOVE_ASIDE, "u"));
		assert.doesNotMatch(status.stdout, /rename-section/u);
		const fetch = runBootstrap(root, ["--fetch", "lib"]);
		assert.equal(fetch.status, 1, `${fetch.stdout}${fetch.stderr}`);
		assert.deepEqual(facts(lib), before);
	});
});

interface Spelling {
	readonly label: string;
	/** The clone's remote.origin.url; null removes it. */
	readonly origin: ((u: string) => string) | null;
	/** What `.gitmodules` names for the path. */
	readonly modules: (u: string) => string;
	/** The manifest's repository: what `.gitmodules` must name too. */
	readonly repo: (u: string) => string;
}

const same = (u: string) => u;
const HTTPS = "https://git.example.com/Org/Repo.git";

const ACCEPTED: readonly Spelling[] = [
	{ label: "the same URL", origin: same, modules: same, repo: same },
	{
		label: "origin with .git",
		origin: (u) => `${u}.git`,
		modules: same,
		repo: same,
	},
	{
		label: "origin with a trailing slash",
		origin: (u) => `${u}/`,
		modules: same,
		repo: same,
	},
	{
		label: "origin as a path, no file://",
		origin: (u) => u.replace("file://", ""),
		modules: same,
		repo: same,
	},
	{
		label: "https: host and scheme in another case, .git, trailing slash",
		origin: () => "HTTPS://Git.Example.COM/Org/Repo/",
		modules: () => "https://git.example.com/Org/Repo.git",
		repo: () => HTTPS,
	},
];

const REFUSED: readonly Spelling[] = [
	{
		label: "ssh, scp-like, for the same https repository",
		origin: () => "git@git.example.com:Org/Repo.git",
		modules: () => HTTPS,
		repo: () => HTTPS,
	},
	{
		label: "ssh://, for the same https repository",
		origin: () => "ssh://git@git.example.com/Org/Repo.git",
		modules: () => HTTPS,
		repo: () => HTTPS,
	},
	{
		label: "https, the path in another case",
		origin: () => "https://git.example.com/org/repo.git",
		modules: () => HTTPS,
		repo: () => HTTPS,
	},
	{
		label: "https, another host",
		origin: () => "https://git.example.org/Org/Repo.git",
		modules: () => HTTPS,
		repo: () => HTTPS,
	},
	{
		label: "https with credentials in the clone's origin",
		origin: () => "https://user:token@git.example.com/Org/Repo.git",
		modules: () => HTTPS,
		repo: () => HTTPS,
	},
	{
		label: "no origin at all",
		origin: null,
		modules: () => HTTPS,
		repo: () => HTTPS,
	},
];

/** The section renamed, the clone's origin and the URLs set as `spelling` says. */
function renamedWith(spelling: Spelling) {
	const made = setUp("none");
	const config = join(made.root, ".git/modules/external/lib/config");
	if (spelling.origin === null) {
		git(made.root, ["config", "-f", config, "--unset", "remote.origin.url"]);
	} else {
		git(made.root, [
			"config",
			"-f",
			config,
			"remote.origin.url",
			spelling.origin(made.remote.url),
		]);
	}
	writeFileSync(
		join(made.root, ".gitmodules"),
		section("lib", "external/lib", spelling.modules(made.remote.url)),
	);
	writeFileSync(
		join(made.root, "tools/pins/siblings.json"),
		pinsJson(spelling.repo(made.remote.url)),
	);
	return made;
}

describe("which origin is the same repository as the one .gitmodules names", () => {
	for (const spelling of ACCEPTED) {
		it(`accepted: ${spelling.label}`, () => {
			const { root } = renamedWith(spelling);
			const status = runBootstrap(root, ["--status", "--offline"]);
			assert.equal(status.status, 0, `${status.stdout}${status.stderr}`);
		});
	}
	for (const spelling of REFUSED) {
		it(`refused: ${spelling.label}`, () => {
			const { root, lib } = renamedWith(spelling);
			const before = facts(lib);
			const status = runBootstrap(root, ["--status", "--offline"]);
			assert.equal(status.status, 1, status.stdout);
			assert.match(status.stdout, /belongs to another repository/u);
			assert.match(status.stdout, new RegExp(MOVE_ASIDE, "u"));
			assert.deepEqual(facts(lib), before, "status runs nothing in the clone");
		});
	}
});
