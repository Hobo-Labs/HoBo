import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import type { JsonValue } from "../lib/inspectable.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPT = "scripts/ensure-hooks-path.sh";
const tag = Object.prototype.toString;

function isRecord(
	value: JsonValue | undefined,
): value is { readonly [key: string]: JsonValue } {
	return tag.call(value) === "[object Object]";
}

function isText(value: JsonValue | undefined): value is string {
	return tag.call(value) === "[object String]";
}

/** Follows object keys and array indexes through a JSON document. */
function walk(
	value: JsonValue | undefined,
	path: readonly (string | number)[],
) {
	let at = value;
	for (const step of path) {
		if (Array.isArray(at) && Number.isInteger(step)) at = at[Number(step)];
		else if (isRecord(at) && isText(step)) at = at[step];
		else return undefined;
	}
	return at;
}

/** The session-start command an agent's checked-in config runs. */
function configured(file: string, path: readonly (string | number)[]): string {
	const config: JsonValue = JSON.parse(readFileSync(join(root, file), "utf8"));
	const command = walk(config, path);
	if (!isText(command)) assert.fail(`${file} has no session-start command`);
	return command;
}

const AGENTS = [
	{
		agent: "Claude Code",
		command: () =>
			configured(".claude/settings.json", [
				"hooks",
				"SessionStart",
				0,
				"hooks",
				0,
				"command",
			]),
	},
	{
		agent: "Codex",
		command: () =>
			configured(".codex/hooks.json", [
				"hooks",
				"SessionStart",
				0,
				"hooks",
				0,
				"command",
			]),
	},
	{
		agent: "Cursor",
		command: () =>
			configured(".cursor/hooks.json", ["hooks", "sessionStart", 0, "command"]),
	},
	{
		agent: "Copilot",
		command: () =>
			configured(".github/hooks/git-hooks-path.json", [
				"hooks",
				"sessionStart",
				0,
				"bash",
			]),
	},
] as const;

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hobo-session-hooks-"));
	scratch.push(dir);
	return dir;
}

// Only the fixture repository's own config counts: no global or system file,
// no CI marker and no opt-out inherited from whoever runs the suite, and no
// repository either (run from a git hook, GIT_DIR would point every fixture
// at the outer one).
const globalConfig = join(tempDir(), "gitconfig");
writeFileSync(globalConfig, "");
const inherited = new Set([
	"CI",
	"HOBO_SKIP_HOOKS",
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
]);
const env = Object.fromEntries(
	Object.entries(process.env).filter(([name]) => !inherited.has(name)),
);
Object.assign(env, {
	GIT_CONFIG_GLOBAL: globalConfig,
	GIT_CONFIG_NOSYSTEM: "1",
});

function git(cwd: string, args: string[]) {
	return spawnSync("git", args, { cwd, encoding: "utf8", env });
}

/** Gives a checkout the two things the script looks for. */
function furnish(dir: string): string {
	mkdirSync(join(dir, ".githooks"), { recursive: true });
	mkdirSync(join(dir, "scripts"), { recursive: true });
	copyFileSync(join(root, SCRIPT), join(dir, SCRIPT));
	return dir;
}

/** A repository (no commits) shaped like this one. */
function checkout(): string {
	const dir = tempDir();
	assert.equal(git(dir, ["init", "--quiet"]).status, 0);
	return furnish(dir);
}

/**
 * Adds a linked worktree on a new branch. `worktree add --orphan` needs git
 * 2.42, newer than the bookworm git (2.39) the CI runner image ships, so the
 * branch starts from an empty root commit instead.
 */
function linkWorktree(repo: string, path: string) {
	const root = git(repo, [
		"-c",
		"user.name=hooks-path-test",
		"-c",
		"user.email=hooks-path-test@example.invalid",
		"commit",
		"--quiet",
		"--allow-empty",
		"--no-verify",
		"-m",
		"root",
	]);
	assert.equal(root.status, 0, root.stderr);
	return git(repo, ["worktree", "add", "--quiet", "-b", "side", path]);
}

function hooksPath(repo: string): string {
	return git(repo, [
		"config",
		"--file",
		".git/config",
		"--get",
		"core.hooksPath",
	]).stdout.trim();
}

/** Runs a shell command the way an agent's hook runner does: from the checkout. */
function sh(command: string, cwd: string, extra: Record<string, string> = {}) {
	return spawnSync("sh", ["-c", command], {
		cwd,
		encoding: "utf8",
		env: { ...env, ...extra, CLAUDE_PROJECT_DIR: cwd },
	});
}

const script = (dir: string, extra: Record<string, string> = {}) =>
	sh(`sh ${SCRIPT}`, dir, extra);

// Commits in agent sessions met no hook: core.hooksPath is set only by the
// root `prepare` script, which an install without lifecycle scripts (or a
// worktree sharing another checkout's node_modules) never runs. Each agent's
// session-start hook runs scripts/ensure-hooks-path.sh to close that, and it
// must never get in a session's way doing it.
describe("scripts/ensure-hooks-path.sh", () => {
	it("points an unset core.hooksPath at .githooks, silently", () => {
		const repo = checkout();
		const result = script(repo);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout + result.stderr, "");
		assert.equal(hooksPath(repo), ".githooks");
	});

	it("is idempotent", () => {
		const repo = checkout();
		script(repo);
		const again = script(repo);
		assert.equal(again.status, 0, again.stderr);
		assert.equal(hooksPath(repo), ".githooks");
	});

	it("writes the shared config from a worktree", () => {
		const repo = checkout();
		const worktree = join(tempDir(), "wt");
		const added = linkWorktree(repo, worktree);
		assert.equal(added.status, 0, added.stderr);
		assert.equal(script(furnish(worktree)).status, 0);
		assert.equal(hooksPath(repo), ".githooks");
	});

	it("never replaces a hooks path someone already chose", () => {
		const repo = checkout();
		git(repo, ["config", "core.hooksPath", "my-hooks"]);
		assert.equal(script(repo).status, 0);
		assert.equal(hooksPath(repo), "my-hooks");
	});

	it("honours the opt-outs scripts/install-hooks.mts honours", () => {
		for (const optOut of [
			{ HOBO_SKIP_HOOKS: "1" },
			{ HOBO_SKIP_HOOKS: "TRUE" },
			{ CI: "true" },
			{ CI: "yes" },
		]) {
			const repo = checkout();
			assert.equal(script(repo, optOut).status, 0);
			assert.equal(hooksPath(repo), "", JSON.stringify(optOut));
		}
	});

	it("reads the opt-outs as booleans, so 0 and false do not opt out", () => {
		for (const value of [{ HOBO_SKIP_HOOKS: "0" }, { CI: "false" }]) {
			const repo = checkout();
			assert.equal(script(repo, value).status, 0);
			assert.equal(hooksPath(repo), ".githooks", JSON.stringify(value));
		}
	});

	it("never writes the config of a repository it is merely inside", () => {
		// A copy of this checkout with no .git of its own (vendored, or a
		// tarball unpacked into a dotfiles repository) must leave the enclosing
		// repository alone: a hooks path there would silence its own hooks.
		const outer = checkout();
		const inner = furnish(join(outer, "vendor", "hobo"));
		const result = script(inner);
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout + result.stderr, "");
		assert.equal(hooksPath(outer), "");
	});

	it("ignores a GIT_DIR or GIT_COMMON_DIR it inherits", () => {
		// Git exports an absolute GIT_DIR to hooks in a linked worktree, and a
		// shell or IDE may export one too. Followed, it sends the write to that
		// repository, silencing its own hooks, and leaves this one unset.
		const other = checkout();
		const linked = join(tempDir(), "linked");
		const added = linkWorktree(other, linked);
		assert.equal(added.status, 0, added.stderr);
		for (const inherited of [
			{ GIT_DIR: join(other, ".git") },
			{ GIT_DIR: join(other, ".git", "worktrees", "linked") },
			{ GIT_COMMON_DIR: join(other, ".git") },
			{ GIT_DIR: join(other, ".git"), GIT_WORK_TREE: other },
		]) {
			const repo = checkout();
			const result = script(repo, inherited);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(hooksPath(other), "", JSON.stringify(inherited));
			assert.equal(hooksPath(repo), ".githooks", JSON.stringify(inherited));
		}
	});

	it("succeeds silently outside a repository", () => {
		const result = script(furnish(tempDir()));
		assert.equal(result.status, 0, result.stderr);
		assert.equal(result.stdout + result.stderr, "");
	});
});

describe("each agent's session-start hook", () => {
	for (const { agent, command } of AGENTS) {
		it(`runs the shared script for ${agent}`, () => {
			const repo = checkout();
			const result = sh(command(), repo);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stdout + result.stderr, "");
			assert.equal(hooksPath(repo), ".githooks");
		});
	}

	it("still succeeds, silently, when the script is missing", () => {
		for (const { command } of AGENTS) {
			const repo = tempDir();
			git(repo, ["init", "--quiet"]);
			const result = sh(command(), repo);
			assert.equal(result.status, 0, result.stderr);
			assert.equal(result.stdout + result.stderr, "");
		}
	});
});
