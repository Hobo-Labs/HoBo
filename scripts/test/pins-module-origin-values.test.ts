/**
 * The origin the check compares is the one git fetches from. git reads
 * `remote.origin.url` through `[include]` and fetches from the first of
 * several values; `git config --get` answers the last and `-f <file>` does not
 * follow an include. With origin `[B, A]` the check saw A, accepted the clone
 * as this upstream's, and `git ls-remote origin` contacted B. The check now
 * reads every value, through includes, and accepts a single value that is the
 * repository `.gitmodules` names.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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

const MOVE_ASIDE =
	"fix: mv external/lib external/lib.kept && git submodule update --init -- external/lib";

/** external/lib cloned from A, its section renamed to `lib` (so the module directory is under another name). */
function setUp() {
	const dir = scratch("origin-values");
	const a = makeRemote(dir);
	const b = makeRemote(join(dir, "b"), "another upstream");
	const root = makeWork(dir, a, 1);
	assert.equal(runBootstrap(root, []).status, 0);
	writeFileSync(
		join(root, ".gitmodules"),
		`[submodule "lib"]\n\tpath = external/lib\n\turl = ${a.url}\n`,
	);
	writeFileSync(join(root, "tools/pins/siblings.json"), pinsJson(a.url));
	const config = join(root, ".git/modules/external/lib/config");
	return { dir, root, lib: join(root, "external/lib"), config, a, b };
}

function facts(lib: string) {
	return {
		head: git(lib, ["rev-parse", "HEAD"]),
		refs: git(lib, ["for-each-ref", "--format=%(refname) %(objectname)"]),
	};
}

/** The urls git would fetch `origin` from, first one first (through includes). */
function urlsGitReads(root: string, config: string): string[] {
	const run = spawnSync(
		"git",
		["config", "-f", config, "--includes", "--get-all", "remote.origin.url"],
		{ cwd: root, encoding: "utf8", env: gitEnv() },
	);
	return run.stdout.split("\n").filter(Boolean);
}

type Edit = (c: {
	root: string;
	dir: string;
	config: string;
	a: string;
	b: string;
}) => void;

const setUrls = (root: string, config: string, urls: readonly string[]) => {
	git(root, [
		"config",
		"-f",
		config,
		"--replace-all",
		"remote.origin.url",
		urls[0] ?? "",
	]);
	for (const url of urls.slice(1)) {
		git(root, ["config", "-f", config, "--add", "remote.origin.url", url]);
	}
};

/** An include of a file that sets origin's url to `url`, placed before or after the file's own sections. */
const include = (
	dir: string,
	config: string,
	url: string,
	where: "before" | "after",
): void => {
	const extra = join(dir, `extra-${where}.cfg`);
	writeFileSync(extra, `[remote "origin"]\n\turl = ${url}\n`);
	const block = `[include]\n\tpath = ${extra}\n`;
	const own = readFileSync(config, "utf8");
	writeFileSync(
		config,
		where === "before" ? `${block}${own}` : `${own}${block}`,
	);
};

interface Case {
	readonly label: string;
	readonly edit: Edit;
}

const ACCEPTED: readonly Case[] = [
	{ label: "one value, the same repository", edit: () => undefined },
	{
		label: "one value, set only through an include",
		edit: ({ root, dir, config, a }) => {
			git(root, ["config", "-f", config, "--unset", "remote.origin.url"]);
			include(dir, config, a, "after");
		},
	},
];

const REFUSED: readonly Case[] = [
	{
		label: "two values, the other upstream first ([B, A]): git fetches from B",
		edit: ({ root, config, a, b }) => setUrls(root, config, [b, a]),
	},
	{
		label: "two values, this upstream first ([A, B])",
		edit: ({ root, config, a, b }) => setUrls(root, config, [a, b]),
	},
	{
		label: "two values of the same repository",
		edit: ({ root, config, a }) => setUrls(root, config, [a, `${a}.git`]),
	},
	{
		label: "an include of the other upstream before the real value",
		edit: ({ dir, config, b }) => include(dir, config, b, "before"),
	},
	{
		label: "an include of the other upstream after the real value",
		edit: ({ dir, config, b }) => include(dir, config, b, "after"),
	},
	{
		label:
			"an include of this upstream after the real value (still two values)",
		edit: ({ dir, config, a }) => include(dir, config, a, "after"),
	},
];

describe("the origin read is the one git fetches from", () => {
	for (const one of ACCEPTED) {
		it(`accepted: ${one.label}`, () => {
			const made = setUp();
			one.edit({ ...made, a: made.a.url, b: made.b.url });
			const urls = urlsGitReads(made.root, made.config);
			assert.deepEqual(urls, [made.a.url], "git reads exactly this upstream");
			const status = runBootstrap(made.root, ["--status", "--offline"]);
			assert.equal(status.status, 0, `${status.stdout}${status.stderr}`);
		});
	}

	for (const many of REFUSED) {
		it(`refused: ${many.label}`, () => {
			const made = setUp();
			many.edit({ ...made, a: made.a.url, b: made.b.url });
			const before = facts(made.lib);
			const status = runBootstrap(made.root, ["--status", "--offline"]);
			assert.equal(status.status, 1, status.stdout);
			assert.match(status.stdout, /belongs to another repository/u);
			assert.match(status.stdout, new RegExp(MOVE_ASIDE, "u"));
			assert.doesNotMatch(status.stdout, /rename-section/u);
			assert.deepEqual(
				facts(made.lib),
				before,
				"status runs nothing in the clone",
			);
		});
	}

	it("[B, A]: fetch refuses and the clone is unchanged (git would have contacted B)", () => {
		const made = setUp();
		setUrls(made.root, made.config, [made.b.url, made.a.url]);
		assert.equal(urlsGitReads(made.root, made.config)[0], made.b.url);
		const before = facts(made.lib);
		const fetch = runBootstrap(made.root, ["--fetch", "lib"]);
		assert.equal(fetch.status, 1, `${fetch.stdout}${fetch.stderr}`);
		assert.match(
			fetch.stderr,
			/SUBMODULE_STATE: .*belongs to another repository/u,
		);
		assert.deepEqual(facts(made.lib), before);
	});
});
