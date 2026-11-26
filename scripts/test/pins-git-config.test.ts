/**
 * `git submodule update` takes `submodule.<name>.url` from every scope git
 * reads: the system and global files (and the files they include), this
 * clone's `.git/config`, a worktree's `config.worktree`, and the command line
 * (`git -c`, which reaches a child git as `GIT_CONFIG_COUNT` or
 * `GIT_CONFIG_PARAMETERS`), the command line winning. The stale-URL refusal
 * reads the same set with an unscoped `git config --get`, so a URL from any of
 * them is compared before anything is cloned, and the fix names where it came
 * from. Each fix is run here as printed, as the user would run it. GIT_CONFIG,
 * which would redirect that read to another file, is dropped from the
 * environment (as git does for a submodule).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
	type GitConfig,
	git,
	gitEnv,
	makeRemote,
	makeWork,
	runBootstrap,
	scratch,
} from "./support/pins-support.ts";

const KEY = "submodule.external/lib.url";

/** The printed fix, its alternative after "or:", or dropping the command-line key. */
type Repair = "fix" | "alternative" | "drop";

interface Source {
	readonly label: string;
	/** Puts the stale URL where this source keeps it; answers how to run the script. */
	readonly arrange: (
		dir: string,
		work: string,
		stale: string,
	) => { env: NodeJS.ProcessEnv; more: GitConfig };
	/** What status says about the URL, and the fix it gives. */
	readonly said: RegExp;
	readonly fix: RegExp;
	readonly repair: Repair;
}

/** A file holding the stale URL, for another configuration to include. */
function includedFile(dir: string, stale: string): string {
	const file = join(dir, "included.cfg");
	writeFileSync(file, `[submodule "external/lib"]\n\turl = ${stale}\n`);
	return file;
}

const INCLUDED =
	/the file .*\/included\.cfg \(included from .*\) sets the URL for external\/lib to .*stale/u;
const UNSET_INCLUDED =
	/fix: git config -f .*\/included\.cfg --unset-all submodule\.external\/lib\.url\n/u;

function globalFile(dir: string, body: string): NodeJS.ProcessEnv {
	const file = join(dir, "global.cfg");
	writeFileSync(file, body);
	return { GIT_CONFIG_GLOBAL: file };
}

const SOURCES: readonly Source[] = [
	{
		label: "this clone's .git/config, with GIT_CONFIG pointing elsewhere",
		arrange: (dir, work, stale) => {
			git(work, ["submodule", "init", "--", "external/lib"]);
			git(work, ["config", KEY, stale]);
			const empty = join(dir, "empty.cfg");
			writeFileSync(empty, "");
			return { env: { GIT_CONFIG: empty }, more: [] };
		},
		said: /this clone's configured URL for external\/lib is .*stale/u,
		fix: /fix: git submodule sync -- external\/lib\n/u,
		repair: "fix",
	},
	{
		label: "this worktree's config.worktree",
		arrange: (_dir, work, stale) => {
			git(work, ["config", "extensions.worktreeConfig", "true"]);
			git(work, ["config", "--worktree", KEY, stale]);
			return { env: {}, more: [] };
		},
		said: /this worktree's configured URL for external\/lib \(config\.worktree\) is .*stale/u,
		fix: /fix: git config --worktree --unset-all submodule\.external\/lib\.url\n/u,
		repair: "fix",
	},
	{
		label: "the command line (git -c, GIT_CONFIG_COUNT)",
		arrange: (_dir, _work, stale) => ({ env: {}, more: [[KEY, stale]] }),
		said: /the command line \(git -c, GIT_CONFIG_COUNT or GIT_CONFIG_PARAMETERS\) sets the URL for external\/lib to .*stale/u,
		fix: /fix: drop submodule\.external\/lib\.url from git -c, GIT_CONFIG_COUNT or GIT_CONFIG_PARAMETERS/u,
		repair: "drop",
	},
	{
		label: "a global config file (GIT_CONFIG_GLOBAL)",
		arrange: (dir, _work, stale) => ({
			env: globalFile(dir, `[submodule "external/lib"]\n\turl = ${stale}\n`),
			more: [],
		}),
		said: /the global git config sets the URL for external\/lib to .*stale/u,
		fix: /fix: git submodule sync -- external\/lib {3}\(this clone's URL then overrides it; or: git config -f .*\/global\.cfg --unset-all submodule\.external\/lib\.url\)/u,
		repair: "fix",
	},
	{
		label: "a file the global config includes, removed where it is set",
		arrange: (dir, _work, stale) => {
			const included = join(dir, "included.cfg");
			writeFileSync(included, `[submodule "external/lib"]\n\turl = ${stale}\n`);
			return {
				env: globalFile(dir, `[include]\n\tpath = ${included}\n`),
				more: [],
			};
		},
		said: /the global git config sets the URL for external\/lib to .*stale/u,
		fix: /or: git config -f .*\/included\.cfg --unset-all submodule\.external\/lib\.url\)/u,
		repair: "alternative",
	},
	{
		label: "a file this clone's .git/config includes after its section",
		arrange: (dir, work, stale) => {
			git(work, ["submodule", "init", "--", "external/lib"]);
			const included = includedFile(dir, stale);
			appendFileSync(
				join(work, ".git/config"),
				`[include]\n\tpath = ${included}\n`,
			);
			return { env: {}, more: [] };
		},
		said: INCLUDED,
		fix: UNSET_INCLUDED,
		repair: "fix",
	},
	{
		label: "a file config.worktree includes",
		arrange: (dir, work, stale) => {
			git(work, ["config", "extensions.worktreeConfig", "true"]);
			git(work, [
				"config",
				"--worktree",
				"include.path",
				includedFile(dir, stale),
			]);
			return { env: {}, more: [] };
		},
		said: INCLUDED,
		fix: UNSET_INCLUDED,
		repair: "fix",
	},
	{
		label: "a file the command line includes (git -c include.path)",
		arrange: (dir, _work, stale) => ({
			env: {},
			more: [["include.path", includedFile(dir, stale)]],
		}),
		said: INCLUDED,
		fix: UNSET_INCLUDED,
		repair: "fix",
	},
	{
		label: "the key set twice in this clone's .git/config",
		arrange: (_dir, work, stale) => {
			git(work, ["submodule", "init", "--", "external/lib"]);
			git(work, ["config", "--add", KEY, stale]);
			return { env: {}, more: [] };
		},
		said: /this clone's configured URL for external\/lib is .*stale, not .* \(set 2 times in \.git\/config\)/u,
		fix: /fix: git config --unset-all submodule\.external\/lib\.url && git submodule sync -- external\/lib\n/u,
		repair: "fix",
	},
	{
		label: "the key set twice in the global file, removed there",
		arrange: (dir, _work, stale) => ({
			env: globalFile(
				dir,
				`[submodule "external/lib"]\n\turl = ${dir}/remote\n\turl = ${stale}\n`,
			),
			more: [],
		}),
		said: /the global git config sets the URL for external\/lib to .*stale/u,
		fix: /or: git config -f .*\/global\.cfg --unset-all submodule\.external\/lib\.url\)/u,
		repair: "alternative",
	},
];

/** Runs what status printed, in the user's environment; answers the command line after it. */
function runRepair(
	repair: Repair,
	said: string,
	work: string,
	env: NodeJS.ProcessEnv,
	more: GitConfig,
): GitConfig {
	if (repair === "drop") return more.filter(([key]) => key !== KEY);
	const fix = /fix: (.+)/u.exec(said)?.[1] ?? "";
	const command =
		repair === "fix" ? fix.split("   (")[0] : /or: (.+)\)$/u.exec(fix)?.[1];
	assert.ok(command !== undefined && command !== "", said);
	execFileSync("sh", ["-c", command], { cwd: work, env: gitEnv(env, more) });
	return more;
}

describe("a stale submodule URL from any scope git reads", () => {
	for (const { label, arrange, said, fix, repair } of SOURCES) {
		it(`${label}: refused by status and by fetch, before anything is cloned; the printed fix works`, () => {
			const dir = scratch("gitconfig");
			const remote = makeRemote(dir);
			const work = makeWork(dir, remote, 1);
			const stale = join(dir, "stale");
			git(dir, ["clone", "-q", "--bare", remote.dir, stale]);
			const { env, more } = arrange(dir, work, stale);
			const status = runBootstrap(work, ["--status", "--offline"], env, more);
			assert.equal(status.status, 1, status.stdout);
			assert.match(status.stdout, said);
			assert.match(status.stdout, fix);
			const fetch = runBootstrap(work, ["--fetch", "lib"], env, more);
			assert.equal(fetch.status, 1, `${fetch.stdout}${fetch.stderr}`);
			assert.match(fetch.stderr, /SUBMODULE_STATE: /u);
			assert.match(fetch.stderr, said);
			assert.equal(
				existsSync(join(work, "external/lib/.git")),
				false,
				"nothing was cloned",
			);
			const fixed = runRepair(repair, status.stdout, work, env, more);
			const after = runBootstrap(work, ["--status", "--offline"], env, fixed);
			assert.doesNotMatch(after.stdout, /URL for external\/lib/u, "fixed");
			const again = runBootstrap(work, ["--fetch", "lib"], env, fixed);
			assert.equal(again.status, 0, `${again.stdout}${again.stderr}`);
			const origin = git(join(work, "external/lib"), [
				"config",
				"remote.origin.url",
			]);
			assert.equal(origin, remote.url, "cloned from the .gitmodules URL");
		});
	}
});
