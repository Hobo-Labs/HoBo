import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { secretPolicyRefusal } from "../agent-secret-policy.mts";
import {
	gitLedger,
	MAX_OPEN_PULL_REQUESTS_PER_SESSION,
	OWNER_SUBMISSION_REFUSAL,
	PULL_REQUEST_LEDGER,
	type PullRequestRecord,
	type SessionContext,
	sessionPolicyRefusal,
	stopsOwnerSubmissionHolder,
	workstreamOf,
} from "../agent-session-policy.mts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const hook = join(root, "scripts/agent-secret-policy.mts");

const scratch: string[] = [];
after(() => {
	for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

const inherited = new Set([
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_COMMON_DIR",
]);
const env = {
	...Object.fromEntries(
		Object.entries(process.env).filter(([name]) => !inherited.has(name)),
	),
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_AUTHOR_NAME: "session-policy-test",
	GIT_AUTHOR_EMAIL: "session-policy-test@example.invalid",
	GIT_COMMITTER_NAME: "session-policy-test",
	GIT_COMMITTER_EMAIL: "session-policy-test@example.invalid",
};

function git(cwd: string, args: readonly string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8", env });
	assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

function memoryContext(
	branch = "claude/kind-ritchie-pcw0jk-grounding",
): SessionContext & { records: PullRequestRecord[] } {
	const records: PullRequestRecord[] = [];
	return {
		records,
		currentBranch: () => branch,
		commitOf: () => undefined,
		ledger: {
			open: (workstream) =>
				records.filter((entry) => entry.workstream === workstream),
			record: (entry) => {
				records.push(entry);
			},
		},
	};
}

function bash(command: string, context: SessionContext) {
	return sessionPolicyRefusal("Bash", undefined, [command], () => context);
}

describe("refusing to stop the process that holds an owner submission", () => {
	it("refuses kill, pkill and killall aimed at HoBo's MCP server or owner page", () => {
		for (const command of [
			"pkill -f hobo-mcp",
			"pkill -f 'hobo mcp'",
			"pkill -9 -f packages/hobo/src/bin/hobo-mcp.ts",
			"killall node",
			"pkill node",
			"sudo pkill -f tsx",
			"kill $(pgrep -f hobo-mcp)",
			"pgrep -f hobo-mcp | xargs kill -9",
			"git status && pkill -f mcp-owner-page",
			"kill -TERM $(pgrep -f 'node dist/bin/hobo.js mcp')",
			"taskkill /F /IM hobo-mcp.exe",
		]) {
			assert.ok(stopsOwnerSubmissionHolder(command), command);
			assert.equal(
				bash(command, memoryContext()),
				OWNER_SUBMISSION_REFUSAL,
				command,
			);
		}
	});

	it("allows reading about those processes and stopping unrelated ones", () => {
		for (const command of [
			"pgrep -fl hobo-mcp",
			"ps aux | grep hobo-mcp",
			"rg pkill packages/hobo/src/bin/hobo-mcp.ts",
			"cat hobo-mcp.log; kill 4242",
			"pkill -f vitest",
			"kill %1",
			"git log --grep 'pkill hobo-mcp'",
		])
			assert.equal(stopsOwnerSubmissionHolder(command), false, command);
	});

	it("tells the agent to let the form finish", () => {
		assert.match(OWNER_SUBMISSION_REFUSAL, /Let the form finish/u);
		assert.match(OWNER_SUBMISSION_REFUSAL, /hobo-setup skill/u);
	});
});

describe("refusing pull requests beyond one per workstream", () => {
	it("names a session by its branch without the last suffix", () => {
		assert.equal(
			workstreamOf("claude/kind-ritchie-pcw0jk-grounding"),
			"claude/kind-ritchie-pcw0jk",
		);
		assert.equal(
			workstreamOf("Hobo-Labs:claude/kind-ritchie-pcw0jk-ci"),
			"claude/kind-ritchie-pcw0jk",
		);
		assert.equal(workstreamOf("main"), "main");
	});

	it(`allows ${MAX_OPEN_PULL_REQUESTS_PER_SESSION} open pull requests per session and refuses the next`, () => {
		const context = memoryContext();
		const heads = ["grounding", "ci", "docs", "hooks"].map(
			(suffix) => `claude/kind-ritchie-pcw0jk-${suffix}`,
		);
		const answers = heads.map((head) =>
			sessionPolicyRefusal(
				"mcp__github__create_pull_request",
				head,
				[],
				() => context,
			),
		);
		assert.deepEqual(answers.slice(0, 3), [undefined, undefined, undefined]);
		assert.match(answers[3] ?? "", /one PR per workstream/u);
		assert.match(answers[3] ?? "", /CLAUDE\.md/u);
		assert.match(answers[3] ?? "", /kind-ritchie-pcw0jk-grounding/u);
		assert.equal(context.records.length, 3);
	});

	it("refuses gh pr create and gh api pulls POST once the session is full", () => {
		const context = memoryContext("claude/kind-ritchie-pcw0jk-fourth");
		for (const suffix of ["a", "b", "c"])
			context.records.push({
				head: `claude/kind-ritchie-pcw0jk-${suffix}`,
				workstream: "claude/kind-ritchie-pcw0jk",
			});
		for (const command of [
			"gh pr create --title t --body b",
			"gh pr create --head claude/kind-ritchie-pcw0jk-fifth --fill",
			"gh api repos/o/r/pulls -X POST -f head=claude/kind-ritchie-pcw0jk-sixth -f base=main",
			"gh api repos/o/r/pulls -f title=t -f head=claude/kind-ritchie-pcw0jk-seventh -f base=main",
			"gh api --method POST /repos/o/r/pulls --field=head=claude/kind-ritchie-pcw0jk-eighth",
		])
			assert.match(
				bash(command, context) ?? "",
				/one PR per workstream/u,
				command,
			);
	});

	it("allows reading pull requests, other sessions, and the same head again", () => {
		const context = memoryContext();
		for (const suffix of ["a", "b", "c"])
			context.records.push({
				head: `claude/kind-ritchie-pcw0jk-${suffix}`,
				workstream: "claude/kind-ritchie-pcw0jk",
			});
		for (const command of [
			"gh pr list --state open",
			"gh api repos/o/r/pulls",
			"gh api repos/o/r/pulls/12 -X PATCH -f title=t",
			"gh pr create --head claude/other-session-x9-ci --fill",
			"gh pr create --head claude/kind-ritchie-pcw0jk-a --fill",
		])
			assert.equal(bash(command, context), undefined, command);
	});

	it("speaks through the repository's pre-tool hook", () => {
		const repo = mkdtempSync(join(tmpdir(), "hobo-session-policy-"));
		scratch.push(repo);
		git(repo, ["init", "--quiet", "--initial-branch=main"]);
		for (const suffix of ["a", "b", "c", "d"]) {
			const result = spawnSync(
				process.execPath,
				["--experimental-strip-types", hook, "--format=claude"],
				{
					cwd: repo,
					env,
					encoding: "utf8",
					input: JSON.stringify({
						tool_name: "mcp__github__create_pull_request",
						tool_input: { head: `claude/session-k2-${suffix}`, base: "main" },
						cwd: repo,
					}),
				},
			);
			assert.equal(result.status, suffix === "d" ? 2 : 0, result.stderr);
		}
		const kill = spawnSync(
			process.execPath,
			["--experimental-strip-types", hook, "--format=claude"],
			{
				cwd: repo,
				env,
				encoding: "utf8",
				input: JSON.stringify({
					tool_name: "Bash",
					tool_input: { command: "pkill -f hobo-mcp" },
				}),
			},
		);
		assert.equal(kill.status, 2);
		assert.match(kill.stderr, /Let the form finish/u);
		assert.equal(
			secretPolicyRefusal({
				tool_name: "Bash",
				tool_input: { command: "git status" },
			}),
			undefined,
		);
	});
});

describe("the offline pull request ledger", () => {
	it("keeps entries in the shared git directory and clears one once its head lands on origin/main", () => {
		const repo = mkdtempSync(join(tmpdir(), "hobo-session-ledger-"));
		scratch.push(repo);
		git(repo, ["init", "--quiet", "--initial-branch=main"]);
		git(repo, [
			"commit",
			"--quiet",
			"--allow-empty",
			"--no-verify",
			"-m",
			"root",
		]);
		git(repo, ["checkout", "--quiet", "-b", "claude/s-k2-a"]);
		git(repo, ["commit", "--quiet", "--allow-empty", "--no-verify", "-m", "a"]);
		const landedHead = git(repo, ["rev-parse", "HEAD"]);
		const ledger = gitLedger(repo);
		ledger.record({
			head: "claude/s-k2-a",
			workstream: "claude/s-k2",
			commit: landedHead,
		});
		ledger.record({ head: "claude/s-k2-b", workstream: "claude/s-k2" });
		assert.deepEqual(
			ledger.open("claude/s-k2").map((entry) => entry.head),
			["claude/s-k2-a", "claude/s-k2-b"],
		);
		assert.match(
			readFileSync(join(repo, ".git", PULL_REQUEST_LEDGER), "utf8"),
			/claude\/s-k2-b/u,
		);
		git(repo, ["update-ref", "refs/remotes/origin/main", landedHead]);
		assert.deepEqual(
			ledger.open("claude/s-k2").map((entry) => entry.head),
			["claude/s-k2-b"],
		);
	});
});
